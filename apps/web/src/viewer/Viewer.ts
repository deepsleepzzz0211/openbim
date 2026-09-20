import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { acceleratedRaycast } from "three-mesh-bvh";
import { DEFAULT_MAX_RESIDENT_BYTES, planEvictions, type ChunkResident } from "./chunkPlanning";
import { elementAt, hitAccepted, makeNdcRectFromCorners, pointInSection, selectionNdcPoints, uniqueSelection, type NdcRect } from "./picking";
import { lodNearDistance, parseProxyBoxes, planLodLoads, type LodChunk, type ProxyBox } from "./proxyLod";
import { BvhManager, type BvhTransport } from "./bvhManager";
import { createBvhWorkerTransport } from "./bvhWorkerTransport";

// three's Raycaster ignores Mesh.visible and scans triangles linearly; swap
// in the boundsTree-aware raycast (ticket 07). Geometries without a
// boundsTree transparently keep the original linear path.
(THREE.Mesh.prototype as unknown as { raycast: unknown }).raycast = acceleratedRaycast;

/** Mirror of the server's meta.json bucket/range schema (subset). */
export interface SpatialNodeLike {
  guid: string;
  expressID: number;
  type: string;
  name: string;
  children: SpatialNodeLike[];
}

export interface BucketRange {
  expressID: number;
  start: number;
  count: number;
}
export interface BucketMeta {
  storeyExpressID: number | null;
  color: [number, number, number, number];
  transparent: boolean;
  ranges: BucketRange[];
}

/** One entry of the version manifest (ticket 05) as needed by the viewer. */
export interface ChunkDescriptor {
  id: number;
  storeyExpressID: number | null;
  bytes: number;
  /** GLB-local bounds, used by the auto-LOD planner (ticket 08). */
  bbox: [number, number, number, number, number, number];
  /** Relative API url for the chunk GLB download. */
  url: string;
}

export interface FederationModel {
  versionId: string;
  buckets: BucketMeta[];
  origin?: [number, number, number] | null;
  /** Single-format artifact: whole-scene GLB bytes. */
  buffer?: ArrayBuffer;
  /** Chunked artifact (ticket 06): manifest chunks fetched lazily. */
  chunks?: ChunkDescriptor[];
  download?: (url: string) => Promise<ArrayBuffer>;
}

interface BucketMesh {
  mesh: THREE.Mesh;
  bucketIndex: number;
  ranges: BucketRange[];
  versionId: string;
}

interface ChunkState {
  cacheKey: string;
  versionId: string;
  bytes: number;
  meshes: THREE.Mesh[];
  touched: number;
}

const HIGHLIGHT_COLOR = 0xffd666;
const BOX_HIGHLIGHT_COLOR = 0x69b1ff;
const CHUNK_LOAD_CONCURRENCY = 3;

export interface SelectionItem {
  versionId: string;
  expressID: number;
}

/**
 * Imperative three.js BIM viewer. React only mounts the canvas and wires UI
 * events; all scene logic lives here (single-owner, no r3f indirection).
 */
export class BimViewer {
  readonly scene = new THREE.Scene();
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private bucketMeshes: BucketMesh[] = [];
  private highlightMeshes: THREE.Mesh[] = [];
  private measurePoints: THREE.Vector3[] = [];
  private measureGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointerStart: { x: number; y: number } | null = null;
  private marqueeRect: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private marqueeEl: HTMLDivElement | null = null;
  private bvhWorker = createBvhWorkerTransport();
  private bvh: BvhManager;
  private sectionPlanes: THREE.Plane[] = [];
  private disposed = false;
  /** last loadFederation inputs, replayed on WebGL context restore */
  private models: FederationModel[] = [];
  private versionGroups = new Map<string, THREE.Group>();
  private chunkStates = new Map<string, ChunkState>();
  private visibleKeys = new Set<string>();
  private residentBytes = 0;
  private touchCounter = 0;
  private loadSeq = 0;
  private budget: number;
  /** AABB proxy overview (ticket 08). */
  private proxyBoxes: ProxyBox[] = [];
  private proxyMesh: THREE.InstancedMesh | null = null;
  /** Box of each live instance, indexed by raycast instanceId. */
  private proxyInstances: ProxyBox[] = [];
  private storeyIdByGuid = new Map<string, Map<string, number>>();
  private wantedChunks = new Map<string, string>();
  private displayMode: "proxy" | "auto" | "full" = "auto";
  private lodTimer: number | null = null;
  private visibilityBusy = false;
  private visibilityAgain = false;

  /** Called with the picked element expressID (null = cleared). */
  onSelect: ((sel: SelectionItem | null) => void) | null = null;
  /** Called after a box select with every element touched (ticket 07). */
  onBoxSelect: ((items: SelectionItem[]) => void) | null = null;
  /** Called with measured length in metres. */
  onMeasure: ((info: { length: number; active: boolean }) => void) | null = null;
  /** Chunk download/parse failure notice (UI toast hook). */
  onWarning: ((message: string) => void) | null = null;
  measureMode = false;
  /** When true, a drag draws a selection rectangle instead of orbiting. */
  boxSelectMode = false;

  constructor(private canvas: HTMLCanvasElement, opts: { maxResidentBytes?: number; bvhTransport?: BvhTransport } = {}) {
    this.budget = opts.maxResidentBytes ?? DEFAULT_MAX_RESIDENT_BYTES;
    this.bvh = new BvhManager(opts.bvhTransport ?? this.bvhWorker.transport);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x101418);
    this.renderer.localClippingEnabled = true;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
    this.camera.position.set(12, 10, 14);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", this.onControlsChange);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(8, 14, 6);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xdfe8ff, 0.7);
    dir2.position.set(-6, 8, -8);
    this.scene.add(dir2);

    const grid = new THREE.GridHelper(50, 50, 0x334455, 0x223344);
    grid.name = "ground-grid";
    this.scene.add(grid);
    this.scene.add(this.measureGroup);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerCancel);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    window.addEventListener("resize", this.resize);
    this.resize();
    this.renderer.setAnimationLoop(this.render);
    // diagnostics handle (also used by automated tests)
    (window as unknown as { __bimViewer?: BimViewer }).__bimViewer = this;
  }

  private render = (): void => {
    if (this.disposed) return;
    this.controls.update();
    this.resize();
    this.renderer.render(this.scene, this.camera);
  };

  /** Auto-LOD re-plans shortly after the camera settles, not every frame. */
  private onControlsChange = (): void => {
    if (this.displayMode !== "auto" || this.lodTimer !== null) return;
    this.lodTimer = window.setTimeout(() => {
      this.lodTimer = null;
      if (!this.disposed) void this.setVisibleStoreyKeys(this.visibleKeys);
    }, 350);
  };

  private resize = (): void => {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.width !== w || size.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  };

  // ---- model loading ------------------------------------------------------

  async loadFederation(models: FederationModel[]): Promise<void> {
    // drop the previously loaded model (version switching must not stack models)
    this.loadSeq++;
    this.clearSceneModels();
    this.chunkStates.clear();
    this.residentBytes = 0;
    this.versionGroups.clear();
    this.models = models;
    // drop proxy boxes of versions that are no longer in the federation
    const keptVersions = new Set(models.map((m) => m.versionId));
    this.proxyBoxes = this.proxyBoxes.filter((b) => keptVersions.has(b.versionId));
    for (const v of [...this.storeyIdByGuid.keys()]) if (!keptVersions.has(v)) this.storeyIdByGuid.delete(v);
    this.wantedChunks = this.computeWantedChunks();
    this.rebuildProxyMesh();

    // Federation: each version's GLB lives in its own shifted frame (true
    // world = glb + origin). Place members relative to the primary model so
    // same-site buildings sit at their real mutual offsets.
    const primary = models[0]?.origin ?? [0, 0, 0];
    for (const model of models) {
      const group = new THREE.Group();
      group.name = `federation:${model.versionId}`;
      const origin = model.origin ?? [0, 0, 0];
      group.position.set(origin[0] - primary[0], origin[1] - primary[1], origin[2] - primary[2]);
      this.scene.add(group);
      this.versionGroups.set(model.versionId, group);
      if (model.buffer) await this.parseSingle(model, group);
      // chunked models render through setVisibleStoreyKeys -> loadChunk
    }
  }

  private async parseSingle(model: FederationModel, group: THREE.Group): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    // snapshot: scene.add() below re-parents nodes out of gltf.scene.children
    const gltf = await loader.parseAsync(model.buffer!.slice(0), "");
    this.attachGltfBuckets(gltf, model, group, `${model.versionId}:single`);
  }

  private attachGltfBuckets(
    gltf: { scene: THREE.Object3D },
    model: FederationModel,
    group: THREE.Group,
    stateKey: string
  ): THREE.Mesh[] {
    const attached: THREE.Mesh[] = [];
    for (const node of [...gltf.scene.children]) {
      const bucketIndex = (node.userData as { bucket?: number }).bucket;
      if (bucketIndex === undefined) continue;
      const mesh = (node as THREE.Mesh).isMesh ? (node as THREE.Mesh) : null;
      const bucket = model.buckets[bucketIndex];
      if (!mesh || !bucket) continue;
      mesh.userData.bucketIndex = bucketIndex;
      mesh.userData.versionId = model.versionId;
      mesh.userData.chunkKey = stateKey;
      mesh.userData.ranges = bucket.ranges;
      mesh.material = this.makeMaterial(bucket);
      this.bucketMeshes.push({ mesh, bucketIndex, ranges: bucket.ranges, versionId: model.versionId });
      group.add(mesh);
      attached.push(mesh);
      // Kick off the picking acceleration structure off-thread; picks keep
      // working (slower) until it lands, and reloads reuse the cached build.
      void this.bvh
        .ensure(`${stateKey}:${bucketIndex}`, mesh.geometry, () => mesh.parent !== null)
        .catch((err: Error) => this.onWarning?.(`拾取加速构建失败：${err.message}`));
    }
    return attached;
  }

  private async loadChunk(model: FederationModel, chunk: ChunkDescriptor): Promise<void> {
    const cacheKey = `${model.versionId}:${chunk.id}`;
    if (this.chunkStates.has(cacheKey)) return;
    const seq = this.loadSeq;
    const state: ChunkState = {
      cacheKey,
      versionId: model.versionId,
      bytes: chunk.bytes,
      meshes: [],
      touched: ++this.touchCounter,
    };
    this.chunkStates.set(cacheKey, state);
    const group = this.versionGroups.get(model.versionId);
    if (!group || !model.download) {
      this.chunkStates.delete(cacheKey);
      return;
    }
    try {
      const buffer = await model.download(chunk.url);
      if (seq !== this.loadSeq || !this.chunkStates.has(cacheKey)) return; // rebuilt meanwhile
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(buffer.slice(0), "");
      if (seq !== this.loadSeq) return;
      state.meshes = this.attachGltfBuckets(gltf, model, group, cacheKey);
      this.residentBytes += chunk.bytes;
    } catch (err) {
      if (this.chunkStates.get(cacheKey) === state) this.chunkStates.delete(cacheKey);
      this.onWarning?.(`块 ${chunk.id} 加载失败：${(err as Error).message}`);
    }
  }

  /**
   * Manifest-driven visibility (tickets 06 + 08): real geometry is only
   * wanted for chunks whose storey is visible AND that the display mode
   * allows (full = all, auto = camera-near, proxy = none). Wanted chunks are
   * loaded (bounded concurrency); hidden resident chunks are LRU-evicted
   * under the byte budget; everything not covered by geometry falls back to
   * the AABB proxy layer, which is rebuilt to match.
   */
  async setVisibleStoreyKeys(keys: Set<string>): Promise<void> {
    this.visibleKeys = new Set(keys);
    if (this.visibilityBusy) {
      this.visibilityAgain = true;
      return;
    }
    this.visibilityBusy = true;
    try {
      do {
        this.visibilityAgain = false;
        await this.applyVisibility();
      } while (this.visibilityAgain);
    } finally {
      this.visibilityBusy = false;
    }
  }

  private async applyVisibility(): Promise<void> {
    const seq = this.loadSeq;
    const hadVisible = this.bucketMeshes.some((b) => b.mesh.visible);
    this.wantedChunks = this.computeWantedChunks();

    for (const st of this.chunkStates.values()) {
      if (this.wantedChunks.has(st.cacheKey)) st.touched = ++this.touchCounter;
    }
    const candidates: Array<[FederationModel, ChunkDescriptor]> = [];
    for (const model of this.models) {
      for (const chunk of model.chunks ?? []) {
        const cacheKey = `${model.versionId}:${chunk.id}`;
        if (this.wantedChunks.has(cacheKey) && !this.chunkStates.has(cacheKey)) candidates.push([model, chunk]);
      }
    }
    for (let i = 0; i < candidates.length; i += CHUNK_LOAD_CONCURRENCY) {
      if (seq !== this.loadSeq) return; // superseded by a rebuild
      await Promise.all(
        candidates.slice(i, i + CHUNK_LOAD_CONCURRENCY).map(([m, c]) => this.loadChunk(m, c))
      );
    }
    if (seq !== this.loadSeq) return;

    for (const b of this.bucketMeshes) {
      b.mesh.visible = this.wantedChunks.has(b.mesh.userData.chunkKey as string);
    }
    this.rebuildProxyMesh();
    const resident: ChunkResident[] = [...this.chunkStates.values()].map((st) => ({
      key: st.cacheKey,
      bytes: st.bytes,
      touched: st.touched,
      needed: this.wantedChunks.has(st.cacheKey),
    }));
    for (const evictKey of planEvictions(resident, this.residentBytes, this.budget)) {
      const st = this.chunkStates.get(evictKey);
      if (st) this.unloadChunk(st);
    }
    if (!hadVisible && this.bucketMeshes.some((b) => b.mesh.visible)) this.fitAll();
  }

  /** chunk key -> storey key for every chunk that should show real geometry now. */
  private computeWantedChunks(): Map<string, string> {
    const wanted = new Map<string, string>();
    if (this.displayMode === "proxy") return wanted;
    const cam = this.camera.position;
    const lodCandidates: LodChunk[] = [];
    const lodStoreyByKey = new Map<string, string>();
    for (const model of this.models) {
      if (!model.chunks) {
        wanted.set(`${model.versionId}:single`, `${model.versionId}:single`);
        continue;
      }
      const group = this.versionGroups.get(model.versionId);
      const offset: [number, number, number] = group
        ? [group.position.x, group.position.y, group.position.z]
        : [0, 0, 0];
      for (const chunk of model.chunks) {
        const key = `${model.versionId}:${chunk.id}`;
        const storeyKey = `${model.versionId}:${chunk.storeyExpressID}`;
        if (!this.visibleKeys.has(storeyKey)) continue;
        if (this.displayMode === "full") wanted.set(key, storeyKey);
        else {
          lodCandidates.push({ key, storeyKey, bbox: chunk.bbox, offset });
          lodStoreyByKey.set(key, storeyKey);
        }
      }
    }
    if (lodCandidates.length) {
      for (const key of planLodLoads(lodCandidates, { x: cam.x, y: cam.y, z: cam.z }, this.lodDistance(), this.visibleKeys)) {
        const storeyKey = lodStoreyByKey.get(key);
        if (storeyKey) wanted.set(key, storeyKey);
      }
    }
    return wanted;
  }

  /** Auto-LOD radius, scaled to the loaded chunked models' extent. */
  private lodDistance(): number {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    const push = (x: number, y: number, z: number) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    };
    for (const model of this.models) {
      const group = this.versionGroups.get(model.versionId);
      const ox = group?.position.x ?? 0, oy = group?.position.y ?? 0, oz = group?.position.z ?? 0;
      for (const c of model.chunks ?? []) {
        push(c.bbox[0] + ox, c.bbox[1] + oy, c.bbox[2] + oz);
        push(c.bbox[3] + ox, c.bbox[4] + oy, c.bbox[5] + oz);
      }
    }
    const diagonal = Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 0;
    return lodNearDistance(diagonal);
  }

  /**
   * Feed the overview layer for one version: AABB tuples from
   * `/versions/:id/proxy`. Boxes follow the floor tree (storeyGuid mapped to
   * expressID through the spatial map) and drop away per chunk as real
   * geometry loads in front of them.
   */
  setProxyBoxes(versionId: string, tuples: readonly unknown[], storeyIdByGuid: ReadonlyMap<string, number>): void {
    this.storeyIdByGuid.set(versionId, new Map(storeyIdByGuid));
    this.proxyBoxes = this.proxyBoxes.filter((b) => b.versionId !== versionId);
    this.proxyBoxes.push(...parseProxyBoxes(versionId, tuples));
    this.rebuildProxyMesh();
  }

  /** storey visibility key (floor-tree identity) that owns this proxy box. */
  private proxyStoreyKey(box: ProxyBox): string {
    const storeyId =
      box.storeyGuid === null ? null : this.storeyIdByGuid.get(box.versionId)?.get(box.storeyGuid) ?? null;
    return `${box.versionId}:${storeyId}`;
  }

  private rebuildProxyMesh(): void {
    this.disposeProxyMesh();
    const live = this.proxyBoxes.filter(
      (b) =>
        this.visibleKeys.has(this.proxyStoreyKey(b)) &&
        !this.wantedChunks.has(b.chunkId === null ? `${b.versionId}:single` : `${b.versionId}:${b.chunkId}`)
    );
    if (live.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x7fa8d9,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        clippingPlanes: this.sectionPlanes,
      }),
      live.length
    );
    const matrix = new THREE.Matrix4();
    const node = new THREE.Object3D(); // scratch to compose offset + scale
    live.forEach((box, i) => {
      const offset = this.versionGroups.get(box.versionId)?.position ?? new THREE.Vector3();
      node.position.set(
        offset.x + (box.min[0] + box.max[0]) / 2,
        offset.y + (box.min[1] + box.max[1]) / 2,
        offset.z + (box.min[2] + box.max[2]) / 2
      );
      node.scale.set(
        Math.max(box.max[0] - box.min[0], 1e-4),
        Math.max(box.max[1] - box.min[1], 1e-4),
        Math.max(box.max[2] - box.min[2], 1e-4)
      );
      node.updateMatrix();
      matrix.copy(node.matrix);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = "proxy-overview";
    mesh.renderOrder = 5;
    this.proxyMesh = mesh;
    this.proxyInstances = live;
    this.scene.add(mesh);
  }

  private disposeProxyMesh(): void {
    if (!this.proxyMesh) return;
    this.scene.remove(this.proxyMesh);
    this.proxyMesh.geometry.dispose();
    (this.proxyMesh.material as THREE.Material).dispose();
    this.proxyMesh = null;
    this.proxyInstances = [];
  }

  /** Three display states (ticket 08): boxes only, distance-driven, or all geometry. */
  setDisplayMode(mode: "proxy" | "auto" | "full"): void {
    if (this.displayMode === mode) return;
    this.displayMode = mode;
    void this.setVisibleStoreyKeys(this.visibleKeys);
  }

  get currentDisplayMode(): "proxy" | "auto" | "full" {
    return this.displayMode;
  }

  private unloadChunk(state: ChunkState): void {
    this.clearSelection();
    for (const mesh of state.meshes) {
      mesh.parent?.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      mesh.geometry.dispose();
      const i = this.bucketMeshes.findIndex((b) => b.mesh === mesh);
      if (i >= 0) this.bucketMeshes.splice(i, 1);
    }
    this.chunkStates.delete(state.cacheKey);
    this.residentBytes -= state.bytes;
  }

  /** Currently resident chunk bytes (diagnostics / tests). */
  get residentChunkBytes(): number {
    return this.residentBytes;
  }

  private clearSceneModels(): void {
    for (const b of this.bucketMeshes) {
      this.scene.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
      b.mesh.geometry.dispose();
    }
    this.bucketMeshes = [];
    for (const g of this.versionGroups.values()) this.scene.remove(g);
    this.clearSelection();
    this.clearMeasurement();
  }

  private makeMaterial(bucket: BucketMeta): THREE.MeshStandardMaterial {
    const [r, g, b, a] = bucket.color;
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(r, g, b),
      transparent: bucket.transparent,
      opacity: bucket.transparent ? Math.max(a, 0.25) : 1,
      side: THREE.DoubleSide,
      metalness: 0.05,
      roughness: 0.85,
      clippingPlanes: this.sectionPlanes,
    });
  }

  // ---- picking -------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerStart = { x: e.clientX, y: e.clientY };
    if (this.boxSelectMode && !this.measureMode && e.button === 0) {
      this.marqueeRect = { minX: e.clientX, minY: e.clientY, maxX: e.clientX, maxY: e.clientY };
      this.controls.enabled = false; // drag selects instead of orbiting
      // keep the drag alive when the pointer crosses the canvas edge
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported: marquee still works inside the canvas */
      }
      this.showMarquee(this.marqueeRect);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.marqueeRect) return;
    this.marqueeRect.maxX = e.clientX;
    this.marqueeRect.maxY = e.clientY;
    this.showMarquee(this.marqueeRect);
  };

  /** An abandoned drag must never leave orbit disabled or a stuck marquee. */
  private onPointerCancel = (): void => {
    if (!this.marqueeRect) return;
    this.marqueeRect = null;
    this.pointerStart = null;
    this.hideMarquee();
    this.controls.enabled = true;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointerStart) return;
    const dx = e.clientX - this.pointerStart.x;
    const dy = e.clientY - this.pointerStart.y;
    this.pointerStart = null;
    if (this.marqueeRect) {
      const rect = this.marqueeRect;
      this.marqueeRect = null;
      this.hideMarquee();
      this.controls.enabled = true;
      if (Math.hypot(dx, dy) > 5) {
        this.runBoxSelect(rect);
        return;
      }
      // a tiny drag in box mode still acts as a single click pick below
    }
    if (Math.hypot(dx, dy) > 5) return; // drag, not a click

    const hit = this.pick(e);
    if (this.measureMode) {
      if (hit) this.addMeasurePoint(hit.point);
      return;
    }
    if (!hit) {
      this.clearSelection();
      this.onSelect?.(null);
      return;
    }
    const item = this.selectionAt(hit);
    if (item) {
      this.clearSelection();
      this.highlightHit(hit, item);
      this.onSelect?.(item);
    }
  };

  /** First raycast hit the user can actually see (ticket 07 visibility gate). */
  private pick(e: PointerEvent): THREE.Intersection | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    return this.raycastVisible(ndc)[0] ?? null;
  }

  /**
   * Rays are cast only against visible meshes (the raw raycaster ignores
   * Mesh.visible) and hits inside a section cut are rejected, so picks match
   * what is rendered: hidden storeys and clipped-away geometry never win.
   */
  private raycastVisible(ndc: THREE.Vector2): THREE.Intersection[] {
    this.raycaster.setFromCamera(ndc, this.camera);
    this.raycaster.firstHitOnly = true;
    const meshes: THREE.Object3D[] = this.bucketMeshes.filter((b) => b.mesh.visible).map((b) => b.mesh);
    if (this.proxyMesh) meshes.push(this.proxyMesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.filter(
      (h) =>
        h.faceIndex != null &&
        hitAccepted({
          meshVisible: (h.object as THREE.Mesh).visible,
          storeyVisible: true, // hidden storeys are not in the mesh/instance set at all
          inSection: pointInSection(h.point, this.sectionPlanes),
        })
    );
  }

  /** Resolve a filtered hit to the element it represents (geometry or proxy). */
  private selectionAt(hit: THREE.Intersection): SelectionItem | null {
    if (hit.object === this.proxyMesh) {
      const box = hit.instanceId != null ? this.proxyInstances[hit.instanceId] : undefined;
      return box ? { versionId: box.versionId, expressID: box.expressID } : null;
    }
    const mesh = hit.object as THREE.Mesh;
    const expressID = this.expressIdAt(hit.faceIndex, mesh);
    return expressID === null ? null : { versionId: mesh.userData.versionId as string, expressID };
  }

  private highlightHit(hit: THREE.Intersection, item: SelectionItem, color = HIGHLIGHT_COLOR): void {
    if (hit.object === this.proxyMesh) {
      const box = hit.instanceId != null ? this.proxyInstances[hit.instanceId] : undefined;
      if (box) this.highlightProxyBox(box, color);
      return;
    }
    this.highlight(item.expressID, hit.object as THREE.Mesh, color);
  }

  private highlightProxyBox(box: ProxyBox, color: number): void {
    const offset = this.versionGroups.get(box.versionId)?.position ?? new THREE.Vector3();
    const size = new THREE.Vector3(
      Math.max(box.max[0] - box.min[0], 1e-4),
      Math.max(box.max[1] - box.min[1], 1e-4),
      Math.max(box.max[2] - box.min[2], 1e-4)
    );
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.9 })
    );
    mesh.position.set(
      offset.x + (box.min[0] + box.max[0]) / 2,
      offset.y + (box.min[1] + box.max[1]) / 2,
      offset.z + (box.min[2] + box.max[2]) / 2
    );
    mesh.renderOrder = 11;
    this.highlightMeshes.push(mesh);
    this.scene.add(mesh);
  }

  private runBoxSelect(clientRect: { minX: number; minY: number; maxX: number; maxY: number }): void {
    const bounds = this.canvas.getBoundingClientRect();
    const toNdc = (x: number, y: number) => ({
      x: ((x - bounds.left) / bounds.width) * 2 - 1,
      y: -((y - bounds.top) / bounds.height) * 2 + 1,
    });
    const a = toNdc(Math.min(clientRect.minX, clientRect.maxX), Math.max(clientRect.minY, clientRect.maxY));
    const b = toNdc(Math.max(clientRect.minX, clientRect.maxX), Math.min(clientRect.minY, clientRect.maxY));
    const rect: NdcRect = makeNdcRectFromCorners(a, b);
    const items: SelectionItem[] = [];
    const hitByItem = new Map<string, THREE.Intersection>();
    for (const p of selectionNdcPoints(rect, bounds.width, bounds.height)) {
      const hit = this.raycastVisible(new THREE.Vector2(p.x, p.y))[0];
      if (!hit) continue;
      const item = this.selectionAt(hit);
      if (!item) continue;
      const key = `${item.versionId}:${item.expressID}`;
      if (!hitByItem.has(key)) hitByItem.set(key, hit);
      items.push(item);
    }
    const selected = uniqueSelection(items);
    this.clearSelection();
    for (const item of selected) {
      const hit = hitByItem.get(`${item.versionId}:${item.expressID}`);
      if (hit) this.highlightHit(hit, item, BOX_HIGHLIGHT_COLOR);
    }
    this.onBoxSelect?.(selected);
  }

  private showMarquee(rect: { minX: number; minY: number; maxX: number; maxY: number }): void {
    const el = (this.marqueeEl ??= document.createElement("div"));
    if (!el.parentElement) document.body.appendChild(el);
    el.style.cssText =
      "position:fixed;z-index:30;pointer-events:none;border:1px solid #69b1ff;background:rgba(105,177,255,0.15);" +
      `left:${Math.min(rect.minX, rect.maxX)}px;top:${Math.min(rect.minY, rect.maxY)}px;` +
      `width:${Math.abs(rect.maxX - rect.minX)}px;height:${Math.abs(rect.maxY - rect.minY)}px;`;
  }

  private hideMarquee(): void {
    this.marqueeEl?.remove();
  }

  private expressIdAt(faceIndex: number | null | undefined, mesh: THREE.Mesh): number | null {
    const ranges = mesh.userData.ranges as BucketRange[] | undefined;
    if (faceIndex == null) return null;
    return ranges ? elementAt(ranges, faceIndex) : null;
  }

  // ---- selection highlight ---------------------------------------------------

  private highlight(expressID: number, mesh: THREE.Mesh, color = HIGHLIGHT_COLOR): void {
    const highlightMesh = this.buildHighlightMesh(mesh, expressID, color);
    if (!highlightMesh) return;
    this.highlightMeshes.push(highlightMesh);
    this.scene.add(highlightMesh);
  }

  private buildHighlightMesh(mesh: THREE.Mesh, expressID: number, color: number): THREE.Mesh | null {
    const ranges = mesh.userData.ranges as BucketRange[];
    const range = ranges.find((r) => r.expressID === expressID);
    if (!range) return null;
    const geometry = mesh.geometry;
    const sub = new THREE.BufferGeometry();
    sub.setAttribute("position", geometry.getAttribute("position"));
    sub.setAttribute("normal", geometry.getAttribute("normal"));
    sub.setDrawRange(range.start, range.count);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      depthTest: true,
      clippingPlanes: this.sectionPlanes,
    });
    // reuse the same index buffer; drawRange selects the element's triangles
    sub.setIndex(geometry.getIndex());
    const highlight = new THREE.Mesh(sub, material);
    highlight.applyMatrix4(mesh.matrixWorld);
    highlight.renderOrder = 10;
    return highlight;
  }

  /** Highlight an element of a specific loaded version by expressID (clash results). */
  highlightByExpressID(versionId: string, expressID: number, color = 0xffd666): boolean {
    const entry = this.bucketMeshes.find(
      (b) => b.versionId === versionId && b.ranges.some((r) => r.expressID === expressID)
    );
    if (!entry) return false;
    const mesh = this.buildHighlightMesh(entry.mesh, expressID, color);
    if (!mesh) return false;
    this.highlightMeshes.push(mesh);
    this.scene.add(mesh);
    return true;
  }

  /** Aim the orbit target at a world point, keeping the current view direction. */
  focusOnPoint(point: { x: number; y: number; z: number }): void {
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const p = new THREE.Vector3(point.x, point.y, point.z);
    this.controls.target.copy(p);
    this.camera.position.copy(p).add(dir.multiplyScalar(6));
    this.controls.update();
  }

  clearSelection(): void {
    for (const mesh of this.highlightMeshes) {
      this.scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      mesh.geometry.dispose();
    }
    this.highlightMeshes = [];
  }

  // ---- storey visibility -----------------------------------------------------

  private onContextLost = (e: Event): void => {
    e.preventDefault(); // allow the browser to hand us a fresh context
  };

  private onContextRestored = (): void => {
    // All GPU objects are gone; rebuild the scene from retained sources. Chunk
    // downloads were dropped with the old states, so replaying the current
    // visibility keys refetches exactly what is on screen.
    void this.loadFederation(this.models).then(() => this.setVisibleStoreyKeys(this.visibleKeys));
  };

  // ---- section ----------------------------------------------------------------

  setSection(axis: "x" | "y" | "z" | null, value: number, flip = false): void {
    this.sectionPlanes.forEach((p) => (p.constant = 0));
    this.sectionPlanes.length = 0;
    if (axis) {
      const normal = new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
      if (flip) normal.negate();
      this.sectionPlanes.push(new THREE.Plane(normal, flip ? -value : value));
    }
    for (const b of this.bucketMeshes) {
      (b.mesh.material as THREE.MeshStandardMaterial).clippingPlanes = this.sectionPlanes;
    }
    for (const mesh of this.highlightMeshes) {
      (mesh.material as THREE.MeshBasicMaterial).clippingPlanes = this.sectionPlanes;
    }
  }

  // ---- measurement -------------------------------------------------------------

  private addMeasurePoint(point: THREE.Vector3): void {
    this.measurePoints.push(point.clone());
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x69b1ff })
    );
    marker.position.copy(point);
    this.measureGroup.add(marker);
    if (this.measurePoints.length === 2) {
      const [a, b] = this.measurePoints;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({ color: 0x69b1ff })
      );
      this.measureGroup.add(line);
      const length = a.distanceTo(b);
      this.measureGroup.add(this.makeLabel(`${length.toFixed(3)} m`, a.clone().add(b).multiplyScalar(0.5)));
      this.measurePoints = [];
      this.onMeasure?.({ length, active: false });
    } else {
      this.onMeasure?.({ length: 0, active: true });
    }
  }

  private makeLabel(text: string, position: THREE.Vector3): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "rgba(9, 30, 66, 0.85)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.font = "28px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(1.6, 0.4, 1);
    sprite.position.copy(position);
    sprite.renderOrder = 20;
    return sprite;
  }

  clearMeasurement(): void {
    for (const child of [...this.measureGroup.children]) {
      this.measureGroup.remove(child);
    }
    this.measurePoints = [];
    this.onMeasure?.({ length: 0, active: false });
  }

  // ---- camera ---------------------------------------------------------------

  fitAll(): void {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let empty = true;
    for (const b of this.bucketMeshes) {
      if (!b.mesh.visible) continue;
      box.expandByObject(b.mesh);
      empty = false;
    }
    // the overview alone must frame correctly before any chunk has loaded
    for (const b of this.proxyInstances) {
      const off = this.versionGroups.get(b.versionId)?.position ?? new THREE.Vector3();
      box.expandByPoint(new THREE.Vector3(b.min[0] + off.x, b.min[1] + off.y, b.min[2] + off.z));
      box.expandByPoint(new THREE.Vector3(b.max[0] + off.x, b.max[1] + off.y, b.max[2] + off.z));
      empty = false;
    }
    if (empty) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.8));
    this.camera.near = Math.max(size / 1000, 0.01);
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // ---- lifecycle -------------------------------------------------------------

  // ---- camera & snapshots ---------------------------------------------------

  /** Current camera state, sufficient to restore the exact view later. */
  getCameraState(): { position: [number, number, number]; target: [number, number, number]; fov: number } {
    const p = this.camera.position.toArray() as [number, number, number];
    const t = this.controls.target.toArray() as [number, number, number];
    return { position: p, target: t, fov: this.camera.fov };
  }

  /** Restore a camera state previously captured by getCameraState (or a BCF viewpoint). */
  setCameraState(state: {
    position?: [number, number, number];
    target?: [number, number, number];
    viewPoint?: [number, number, number];
    viewUp?: [number, number, number];
    viewDirection?: [number, number, number];
    fieldOfView?: number;
    fov?: number;
  }): void {
    if (state.viewPoint) {
      // BCF viewpoint: position + direction + up, aim at viewPoint + direction
      const vp = state.viewPoint;
      this.camera.position.set(vp[0], vp[1], vp[2]);
      const dir = state.viewDirection ?? [0, 0, -1];
      const target = new THREE.Vector3(vp[0] + dir[0] * 10, vp[1] + dir[1] * 10, vp[2] + dir[2] * 10);
      if (state.viewUp) this.camera.up.set(state.viewUp[0], state.viewUp[1], state.viewUp[2]);
      this.controls.target.copy(target);
      if (state.fieldOfView && state.fieldOfView > 5 && state.fieldOfView < 170) {
        this.camera.fov = state.fieldOfView;
      }
    } else if (state.position && state.target) {
      const p = state.position;
      const t = state.target;
      this.camera.position.set(p[0], p[1], p[2]);
      this.controls.target.set(t[0], t[1], t[2]);
      const fov = state.fov;
      if (fov && fov > 5 && fov < 170) this.camera.fov = fov;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Render the current frame and return it as PNG bytes (base64 without prefix). */
  captureSnapshot(maxWidth = 1280): string | null {
    this.renderer.render(this.scene, this.camera);
    const canvas = this.renderer.domElement;
    const dataUrl = canvas.toDataURL("image/png");
    void maxWidth;
    if (dataUrl === "data:,") return null;
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerCancel);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    window.removeEventListener("resize", this.resize);
    this.controls.removeEventListener("change", this.onControlsChange);
    if (this.lodTimer !== null) {
      window.clearTimeout(this.lodTimer);
      this.lodTimer = null;
    }
    this.disposeProxyMesh();
    this.controls.enabled = true;
    this.hideMarquee();
    this.bvhWorker.dispose();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
