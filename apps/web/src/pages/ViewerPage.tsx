import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Card, Collapse, Descriptions, Empty, Input, InputNumber, Layout, List, Modal, Popconfirm, Select, Segmented, Slider,
  Space, Spin, Switch, Tag, Tooltip, Tree, Typography, Upload, App as AntApp,
} from "antd";
import {
  AimOutlined, ExpandOutlined, EyeOutlined, ExportOutlined, ScissorOutlined, SelectOutlined, UndoOutlined,
  UploadOutlined, WarningOutlined, ThunderboltOutlined, DiffOutlined,
} from "@ant-design/icons";
import { Link, useParams, useSearchParams } from "react-router";
import { api, apiClash, apiDiff, apiElementsLookup, apiManifest, apiProxy, DiffResult, downloadBinary, downloadToFile, importBcfZip, subscribeVersions, VersionManifest, ClashResult, ElementSummary } from "../api/client";
import { BimViewer, BucketMeta, FederationModel, SpatialNodeLike } from "../viewer/Viewer";

interface VersionRow {
  id: string;
  versionNumber: number;
  status: string;
  progress: number;
  schema: string | null;
  statsJson: string | null;
}

interface MetaJson {
  schema: string;
  units: { sourceName: string; sourcePrefix: string | null; scaleToMetre: number };
  /** World metres subtracted by the conversion (absent on legacy artifacts). */
  origin?: [number, number, number] | null;
  crs?: { source: string; name: string | null; epsg: number | null; mapConversion: { x0: number; y0: number } | null };
  buckets: BucketMeta[];
  spatial: SpatialNodeLike;
  elements: Record<string, { guid: string; type: string; name: string; storeyExpressID: number | null; storeyGuid: string | null }>;
}

interface IssueRow {
  id: string;
  guid: string;
  title: string;
  description: string;
  status: "OPEN" | "CLOSED";
  priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  viewpointJson: string | null;
  author: { name: string };
  createdAt: string;
}

/** A version loaded into the federated scene. */
interface LoadedVersion {
  versionId: string;
  label: string;
  meta: MetaJson;
  manifest: VersionManifest;
  /** Single-format artifacts keep the GLB bytes; chunked ones fetch lazily. */
  buffer?: ArrayBuffer;
}

function toFederationModel(i: LoadedVersion): FederationModel {
  return {
    versionId: i.versionId,
    buckets: i.meta.buckets,
    origin: i.meta.origin ?? i.manifest.origin,
    buffer: i.buffer,
    chunks: i.manifest.chunks?.map((c) => ({ id: c.id, storeyExpressID: c.storeyExpressID, bytes: c.bytes, bbox: c.bbox, url: c.url })),
    download: (url: string) => downloadBinary(url.replace(/^\/api\/v1/, "")),
  };
}

export default function ViewerPage() {
  const { projectId, modelId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = AntApp.useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<BimViewer | null>(null);
  const versionIdRef = useRef<string | null>(null);

  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [versionId, setVersionId] = useState<string | null>(searchParams.get("version"));
  /** federation: every version currently rendered (first = primary) */
  const [loaded, setLoaded] = useState<LoadedVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ElementSummary | null>(null);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureInfo, setMeasureInfo] = useState("未测量");
  const [boxSelectMode, setBoxSelectMode] = useState(false);
  const [boxInfo, setBoxInfo] = useState<{ count: number; versionId: string } | null>(null);
  const [displayMode, setDisplayMode] = useState<"proxy" | "auto" | "full">("auto");
  const [section, setSection] = useState<"x" | "y" | "z" | null>(null);
  const [sectionValue, setSectionValue] = useState(0);
  const [sectionFlip, setSectionFlip] = useState(false);
  const [visibleStoreys, setVisibleStoreys] = useState<Set<string>>(new Set());

  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [issueModal, setIssueModal] = useState(false);
  const [issueTitle, setIssueTitle] = useState("");
  const [issueDesc, setIssueDesc] = useState("");
  const [issuePriority, setIssuePriority] = useState<IssueRow["priority"]>("NORMAL");
  const [creatingIssue, setCreatingIssue] = useState(false);

  const [clashOpen, setClashOpen] = useState(false);
  const [clashTarget, setClashTarget] = useState<string | undefined>();
  const [clashTolerance, setClashTolerance] = useState(0.01);
  const [clashRunning, setClashRunning] = useState(false);
  const [clashResult, setClashResult] = useState<ClashResult | null>(null);

  const [diffOpen, setDiffOpen] = useState(false);
  const [diffTarget, setDiffTarget] = useState<string | undefined>();
  const [diffRunning, setDiffRunning] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);

  // ---- lifecycle -----------------------------------------------------------
  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new BimViewer(canvasRef.current);
    viewerRef.current = viewer;
    viewer.onSelect = async (sel) => {
      if (!sel || !sel.versionId) {
        setSelected(null);
        return;
      }
      try {
        // batch element API (server-side index) — no dependence on a resident
        // meta.json elements table, which chunked modes drop from memory
        const data = await apiElementsLookup(sel.versionId, { expressIDs: [sel.expressID] });
        setSelected(data.elements[0] ?? null);
      } catch {
        setSelected(null);
      }
    };
    viewer.onWarning = (msg) => message.warning(msg);
    viewer.onBoxSelect = async (items) => {
      setBoxInfo(items.length > 0 ? { count: items.length, versionId: items[0].versionId } : null);
      const first = items[0];
      if (!first) {
        setSelected(null);
        return;
      }
      try {
        // batch lookup covers every box-selected element of the primary hit
        // version in one request (no full meta.json needed client-side)
        const ids = items.filter((i) => i.versionId === first.versionId).map((i) => i.expressID).slice(0, 200);
        const data = await apiElementsLookup(first.versionId, { expressIDs: ids });
        setSelected(data.elements[0] ?? null);
      } catch {
        setSelected(null);
      }
    };
    viewer.onMeasure = (info) =>
      setMeasureInfo(info.active ? "请点击第二个点" : info.length ? `测量结果：${info.length.toFixed(3)} m` : "未测量");
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // ---- version list + SSE ----------------------------------------------------
  const loadVersions = useCallback(async () => {
    const data = await api.get<{ versions: VersionRow[] }>(`/models/${modelId}/versions`);
    setVersions(data.versions);
    if (!versionIdRef.current && data.versions.length > 0) {
      const ready = data.versions.find((v) => v.status === "READY") ?? data.versions[0];
      versionIdRef.current = ready.id; // only the first auto-pick; later loads follow the URL/user
      setVersionId(ready.id);
    }
    return data.versions;
  }, [modelId]);

  /** Other models in the project (buildings / disciplines) with a READY version, for federation. */
  const [foreignVersions, setForeignVersions] = useState<Array<{ versionId: string; label: string }>>([]);
  useEffect(() => {
    if (!projectId) return;
    void (async () => {
      try {
        const data = await api.get<{ models: Array<{ id: string; name: string; versions: VersionRow[] }> }>(`/projects/${projectId}/models`);
        const rows: Array<{ versionId: string; label: string }> = [];
        for (const m of data.models) {
          if (m.id === modelId) continue;
          for (const v of m.versions ?? []) {
            if (v.status === "READY") rows.push({ versionId: v.id, label: `${m.name} · v${v.versionNumber}` });
          }
        }
        setForeignVersions(rows);
      } catch {
        setForeignVersions([]);
      }
    })();
  }, [projectId, modelId]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    void (async () => {
      const rows = await loadVersions().catch(() => [] as VersionRow[]);
      const ids = rows.map((v) => v.id);
      // live status/progress; fall back silently if SSE is blocked
      unsub = subscribeVersions(ids, (update) => {
        setVersions((prev) =>
          prev.map((v) => (v.id === update.versionId ? { ...v, status: update.status, progress: update.progress } : v))
        );
      });
    })();
    return () => {
      unsub?.();
    };
  }, [loadVersions]);

  // ---- load federated models -------------------------------------------------
  const loadedRef = useRef<LoadedVersion[]>([]);
  loadedRef.current = loaded;

  /** Stable label cache so version numbers don't refetch on every render. */
  const labelCache = useRef(new Map<string, string>());
  /** Artifact revision cache: updatedAt doubles as a cache-busting fingerprint
   *  so a reconvert (same URL, new bytes) is never shadowed by HTTP caches. */
  const revCache = useRef(new Map<string, string>());
  const artifactUrl = (vid: string, file: "glTF" | "meta"): string => {
    const rev = revCache.current.get(vid);
    return `/versions/${vid}/file/${file}${rev ? `?v=${encodeURIComponent(rev)}` : ""}`;
  };
  const fetchLabel = async (vid: string): Promise<string> => {
    const cached = labelCache.current.get(vid);
    if (cached) return cached;
    const version = await api.get<{ version: VersionRow & { updatedAt?: string } }>(`/versions/${vid}`);
    const label = `v${version.version.versionNumber}`;
    labelCache.current.set(vid, label);
    if (version.version.updatedAt) revCache.current.set(vid, version.version.updatedAt);
    return label;
  };

  /** Fetch manifest + meta (+ GLB when single-format) for one version. */
  const fetchVersionItem = async (vid: string): Promise<LoadedVersion> => {
    const label = await fetchLabel(vid); // also seeds the artifact rev cache
    const manifest = await apiManifest(vid);
    const metaBuf = await downloadBinary(artifactUrl(vid, "meta"));
    const metaJson = JSON.parse(new TextDecoder().decode(metaBuf)) as MetaJson;
    if (manifest.artifactFormat === "chunked") {
      // geometry arrives per chunk; the element table stays server-side
      metaJson.elements = {};
    }
    const buffer = manifest.artifactFormat === "single" ? await downloadBinary(artifactUrl(vid, "glTF")) : undefined;
    return { versionId: vid, label, meta: metaJson, manifest, buffer };
  };

  /** Storey keys to show on first paint: every storey + the unassigned bucket. */
  const initialKeys = (items: LoadedVersion[]): Set<string> => {
    const keys = new Set<string>();
    for (const item of items) {
      collectStoreys(item.versionId, item.meta.spatial, keys);
      keys.add(`${item.versionId}:null`);
    }
    return keys;
  };

  /**
   * Fetch the AABB overview for every version (ticket 08). Fire-and-forget:
   * the proxy layer pops in as payloads land; failures just mean no boxes.
   */
  const applyProxy = (items: LoadedVersion[]): void => {
    void (async () => {
      for (const item of items) {
        try {
          const storeyIdByGuid = new Map<string, number>();
          collectStoreyGuids(item.meta.spatial, storeyIdByGuid);
          const { boxes } = await apiProxy(item.versionId);
          viewerRef.current?.setProxyBoxes(item.versionId, boxes, storeyIdByGuid);
        } catch {
          /* overview is optional; real geometry path is unaffected */
        }
      }
    })();
  };

  /** Load the primary version; keep any previously added federation members. */
  useEffect(() => {
    if (!versionId) return;
    versionIdRef.current = versionId; // marks auto-pick as done and mirrors the active version
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setSelected(null);
      try {
        const version = await api.get<{ version: VersionRow }>(`/versions/${versionId}`);
        if (version.version.status !== "READY") return;
        const wanted = [versionId, ...loadedRef.current.map((l) => l.versionId).filter((id) => id !== versionId)];
        const items: LoadedVersion[] = [];
        for (const vid of wanted) {
          items.push(await fetchVersionItem(vid));
          if (cancelled) return;
        }
        await viewerRef.current?.loadFederation(items.map(toFederationModel));
        applyProxy(items); // overview first, geometry follows per mode/LOD
        const keys = initialKeys(items);
        await viewerRef.current?.setVisibleStoreyKeys(keys);
        if (cancelled) return;
        setLoaded(items);
        setVisibleStoreys(keys);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  /** Add one more version to the federated scene without reloading the rest. */
  const addToFederation = async (vid: string): Promise<void> => {
    if (!vid || loadedRef.current.some((l) => l.versionId === vid)) return;
    setLoading(true);
    try {
      const item = await fetchVersionItem(vid);
      const items = [...loadedRef.current, item];
      await viewerRef.current?.loadFederation(items.map(toFederationModel));
      applyProxy([item]);
      const keys = new Set(visibleStoreys);
      collectStoreys(item.versionId, item.meta.spatial, keys);
      keys.add(`${item.versionId}:null`);
      await viewerRef.current?.setVisibleStoreyKeys(keys);
      setLoaded(items);
      setVisibleStoreys(keys);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  /** Remove a federation member (primary version cannot be removed). */
  const removeFromFederation = (vid: string): void => {
    const kept = loadedRef.current.filter((l) => l.versionId !== vid);
    if (kept.length === loadedRef.current.length) return;
    void (async () => {
      await viewerRef.current?.loadFederation(kept.map(toFederationModel));
      const keys = new Set([...visibleStoreys].filter((k) => !k.startsWith(`${vid}:`)));
      await viewerRef.current?.setVisibleStoreyKeys(keys);
      setLoaded(kept);
      setVisibleStoreys(keys);
    })();
  };

  // ---- tree / visibility ------------------------------------------------------
  const storeyInfo = useMemo(() => {
    // counts derive from bucket ranges (kept in both formats), not the
    // elements table, which chunked versions drop from browser memory
    const counts = new Map<string, number>();
    for (const item of loaded) {
      for (const b of item.meta.buckets) {
        if (b.storeyExpressID === null) continue;
        const key = `${item.versionId}:${b.storeyExpressID}`;
        counts.set(key, (counts.get(key) ?? 0) + b.ranges.length);
      }
    }
    return counts;
  }, [loaded]);

  const treeData = useMemo(
    () => loaded.map((item) => buildTreeData(item.versionId, item.meta.spatial, storeyInfo)).filter((n) => n !== null),
    [loaded, storeyInfo]
  );

  const applyStoreyVisibility = (checked: string[]): void => {
    void viewerRef.current?.setVisibleStoreyKeys(new Set(checked));
  };

  const currentVersion = versions.find((v) => v.id === versionId);

  /** Federation members declaring different projected CRSs: relative placement is only a best effort. */
  const crsMismatch = useMemo(() => {
    if (loaded.length < 2) return false;
    const codes = new Set(loaded.map((l) => l.meta.crs?.epsg ?? null));
    return codes.size > 1;
  }, [loaded]);

  // ---- issues -------------------------------------------------------------------
  const loadIssues = useCallback(async () => {
    if (!projectId) return;
    const data = await api.get<{ issues: IssueRow[] }>(`/projects/${projectId}/issues`);
    setIssues(data.issues);
  }, [projectId]);

  useEffect(() => {
    void loadIssues().catch(() => undefined);
  }, [loadIssues]);

  const createIssue = async () => {
    const viewer = viewerRef.current;
    if (!viewer || !issueTitle.trim()) return;
    setCreatingIssue(true);
    try {
      const camera = viewer.getCameraState();
      const snapshotBase64 = viewer.captureSnapshot();
      await api.post(`/projects/${projectId}/issues`, {
        title: issueTitle.trim(),
        description: issueDesc,
        priority: issuePriority,
        viewpoint: {
          camera: {
            viewPoint: camera.position,
            viewUp: [0, 1, 0],
            viewDirection: directionFromCamera(camera.position, camera.target),
            fieldOfView: camera.fov,
          },
        },
        snapshotBase64,
      });
      setIssueModal(false);
      setIssueTitle("");
      setIssueDesc("");
      message.success("问题已创建（含当前视图快照）");
      await loadIssues();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setCreatingIssue(false);
    }
  };

  const locateIssue = (issue: IssueRow): void => {
    if (!issue.viewpointJson) return;
    try {
      const vp = JSON.parse(issue.viewpointJson) as { camera: { viewPoint: number[]; viewUp?: number[]; viewDirection?: number[]; fieldOfView?: number } };
      viewerRef.current?.setCameraState({
        viewPoint: vp.camera.viewPoint as [number, number, number],
        viewUp: vp.camera.viewUp as [number, number, number] | undefined,
        viewDirection: vp.camera.viewDirection as [number, number, number] | undefined,
        fieldOfView: vp.camera.fieldOfView,
      });
    } catch {
      message.error("视图数据损坏");
    }
  };

  // ---- clash / diff ----------------------------------------------------------------
  const runClash = async () => {
    if (!versionId || !clashTarget) return;
    setClashRunning(true);
    try {
      const result = await apiClash(versionId, clashTarget, clashTolerance);
      setClashResult(result);
      message.success(`检测完成：${result.summary.clashes} 处碰撞`);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setClashRunning(false);
    }
  };

  const runDiff = async () => {
    if (!versionId || !diffTarget) return;
    setDiffRunning(true);
    try {
      const result = await apiDiff(versionId, diffTarget);
      setDiffResult(result);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setDiffRunning(false);
    }
  };

  return (
    <Layout style={{ height: "100vh" }}>
      <Layout.Header style={{ background: "#0b1622", display: "flex", alignItems: "center", gap: 16, padding: "0 16px" }}>
        <Link to="/" style={{ color: "#fff" }}>OpenBIM Hub</Link>
        <Select
          size="small"
          style={{ minWidth: 200 }}
          placeholder="选择版本"
          value={versionId ?? undefined}
          onChange={(id) => {
            setVersionId(id);
            setSearchParams({ version: id });
          }}
          options={versions.map((v) => ({
            value: v.id,
            label: `v${v.versionNumber} ${v.status === "READY" ? "" : v.status === "PROCESSING" ? `(${v.progress}%)` : `(${v.status})`}`,
          }))}
        />
        {loaded.length > 0 && (
          <Tooltip title="叠加其它版本（联邦查看）">
            <Select
              size="small"
              mode="multiple"
              maxTagCount={2}
              placeholder="叠加版本…"
              style={{ minWidth: 160 }}
              value={loaded.slice(1).map((l) => l.versionId)}
              onChange={(ids: string[]) => {
                for (const id of ids) {
                  if (!loaded.some((l) => l.versionId === id)) void addToFederation(id);
                }
                for (const l of loaded.slice(1)) {
                  if (!ids.includes(l.versionId)) removeFromFederation(l.versionId);
                }
              }}
              options={[
                {
                  label: "当前模型",
                  options: versions
                    .filter((v) => v.status === "READY" && v.id !== versionId)
                    .map((v) => ({ value: v.id, label: `v${v.versionNumber}` })),
                },
                ...(foreignVersions.length > 0
                  ? [
                      {
                        label: "项目内其他模型（联邦）",
                        options: foreignVersions
                          .filter((f) => !loaded.some((l) => l.versionId === f.versionId))
                          .map((f) => ({ value: f.versionId, label: f.label })),
                      },
                    ]
                  : []),
              ]}
            />
          </Tooltip>
        )}
        {loaded.length > 0 && (
          <Typography.Text style={{ color: "#9fb3c8" }}>
            {loaded.length} 个模型 · {loaded.reduce((s, l) => s + (l.manifest.stats?.elements ?? Object.keys(l.meta.elements).length), 0)}+ 构件
          </Typography.Text>
        )}
        {crsMismatch && (
          <Tooltip title="各模型的坐标系声明不一致，相对位置仅作尽力对齐">
            <Tag color="orange" icon={<WarningOutlined />}>坐标系不一致</Tag>
          </Tooltip>
        )}
        <div style={{ flex: 1 }} />
        <Space>
          <Tooltip title="显示模式：仅代理=只画全模型盒体概览；自动=近处才加载真实几何；全几何=可见楼层全部加载">
            <Segmented
              size="small"
              value={displayMode}
              onChange={(v) => {
                const mode = v as "proxy" | "auto" | "full";
                setDisplayMode(mode);
                viewerRef.current?.setDisplayMode(mode);
              }}
              options={[
                { value: "proxy", label: "仅代理" },
                { value: "auto", label: "自动" },
                { value: "full", label: "全几何" },
              ]}
            />
          </Tooltip>
          <Tooltip title="适应视图">
            <Button icon={<ExpandOutlined />} onClick={() => viewerRef.current?.fitAll()} />
          </Tooltip>
          <Tooltip title="显示全部楼层">
            <Button
              icon={<EyeOutlined />}
              onClick={() => {
                if (!loaded.length) return;
                const all = initialKeys(loaded);
                setVisibleStoreys(all);
                void viewerRef.current?.setVisibleStoreyKeys(all);
              }}
            />
          </Tooltip>
          <Tooltip title="碰撞检测">
            <Button icon={<ThunderboltOutlined />} onClick={() => setClashOpen(true)} />
          </Tooltip>
          <Tooltip title="版本对比">
            <Button icon={<DiffOutlined />} onClick={() => { setDiffResult(null); setDiffOpen(true); }} />
          </Tooltip>
          <Tooltip title="测量（点击两点量距）">
            <Button
              type={measureMode ? "primary" : "default"}
              icon={<AimOutlined />}
              onClick={() => {
                const next = !measureMode;
                setMeasureMode(next);
                if (viewerRef.current) {
                  viewerRef.current.measureMode = next;
                  if (next) {
                    setBoxSelectMode(false);
                    viewerRef.current.boxSelectMode = false;
                  }
                }
              }}
            />
          </Tooltip>
          <Tooltip title="框选（拖出矩形多选构件）">
            <Button
              type={boxSelectMode ? "primary" : "default"}
              icon={<SelectOutlined />}
              onClick={() => {
                const next = !boxSelectMode;
                setBoxSelectMode(next);
                if (viewerRef.current) {
                  viewerRef.current.boxSelectMode = next;
                  if (next) {
                    setMeasureMode(false);
                    viewerRef.current.measureMode = false;
                  }
                }
              }}
            />
          </Tooltip>
          <Popconfirm title="清除测量标记？" onConfirm={() => viewerRef.current?.clearMeasurement()}>
            <Button icon={<UndoOutlined />} />
          </Popconfirm>
        </Space>
      </Layout.Header>

      <Layout>
        <Layout.Sider width={300} theme="light" style={{ borderRight: "1px solid #eee", overflow: "auto" }}>
          <Card size="small" title="空间结构（联邦）" style={{ margin: 8 }}>
            {treeData.length > 0 ? (
              <Tree
                checkable
                defaultExpandAll
                checkedKeys={[...visibleStoreys]}
                onCheck={(checked) => {
                  const keys = (Array.isArray(checked) ? checked : checked.checked) as string[];
                  setVisibleStoreys(new Set(keys));
                  applyStoreyVisibility(keys);
                }}
                treeData={treeData as never[]}
              />
            ) : (
              <Typography.Text type="secondary">等待模型加载…</Typography.Text>
            )}
          </Card>
          <Card size="small" title="截面剖切" style={{ margin: 8 }}>
            <Space direction="vertical" style={{ width: "100%" }}>
              <Space>
                <ScissorOutlined />
                <Select
                  size="small"
                  style={{ width: 100 }}
                  value={section ?? "off"}
                  onChange={(v) => setSection(v === "off" ? null : (v as "x" | "y" | "z"))}
                  options={[
                    { value: "off", label: "关闭" },
                    { value: "x", label: "X 轴" },
                    { value: "y", label: "Y 轴" },
                    { value: "z", label: "Z 轴" },
                  ]}
                />
                {section && <Switch checkedChildren="反向" unCheckedChildren="正向" checked={sectionFlip} onChange={setSectionFlip} />}
              </Space>
              {section && (
                <>
                  <Slider min={-20} max={20} step={0.1} value={sectionValue} onChange={setSectionValue} />
                  <Typography.Text type="secondary">拖动滑杆移动剖面位置</Typography.Text>
                </>
              )}
            </Space>
          </Card>
        </Layout.Sider>

        <Layout.Content style={{ position: "relative", background: "#101418" }}>
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
          {loading && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Spin size="large" tip="加载模型…" />
            </div>
          )}
          {error && (
            <Alert type="error" message="模型加载失败" description={error} style={{ position: "absolute", top: 16, left: 16, maxWidth: 480 }} closable />
          )}
          {currentVersion && currentVersion.status !== "READY" && (
            <Alert
              type={currentVersion.status === "FAILED" ? "error" : "info"}
              message={
                currentVersion.status === "FAILED"
                  ? "转换失败，可回到模型页重试"
                  : `转换中 ${currentVersion.progress}%（SSE 实时推送）`
              }
              style={{ position: "absolute", top: 16, left: 16, maxWidth: 480 }}
            />
          )}
          {measureMode && (
            <Tag color="blue" style={{ position: "absolute", top: 16, right: 16 }}>
              测量模式 · {measureInfo}
            </Tag>
          )}
          {boxSelectMode && (
            <Tag color="purple" style={{ position: "absolute", top: measureMode ? 48 : 16, right: 16 }}>
              框选模式 · {boxInfo ? `上次选中 ${boxInfo.count} 个构件` : "拖拽画出选框"}
            </Tag>
          )}
          <div style={{ position: "absolute", bottom: 12, right: 16 }}>
            <Button icon={<ExpandOutlined />} onClick={() => viewerRef.current?.fitAll()} />
          </div>
        </Layout.Content>

        <Layout.Sider width={340} theme="light" style={{ borderLeft: "1px solid #eee", overflow: "auto" }}>
          <Card
            size="small"
            title="构件属性"
            extra={
              <Button size="small" type="primary" icon={<WarningOutlined />} onClick={() => setIssueModal(true)}>
                报个问题
              </Button>
            }
            style={{ margin: 8 }}
          >
            {selected ? (
              <>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="名称">{selected.name}</Descriptions.Item>
                  <Descriptions.Item label="类型"><Tag>{selected.type}</Tag></Descriptions.Item>
                  <Descriptions.Item label="GlobalId">
                    <Typography.Text copyable style={{ fontSize: 12 }}>{selected.guid}</Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="expressID">{selected.expressID}</Descriptions.Item>
                </Descriptions>
                <Collapse
                  size="small"
                  style={{ marginTop: 8 }}
                  items={Object.entries(selected.psets).map(([psetName, props]) => ({
                    key: psetName,
                    label: psetName,
                    children: (
                      <Descriptions size="small" column={1}>
                        {Object.entries(props).map(([k, v]) => (
                          <Descriptions.Item key={k} label={k}>{String(v)}</Descriptions.Item>
                        ))}
                      </Descriptions>
                    ),
                  }))}
                />
              </>
            ) : (
              <Typography.Text type="secondary">在模型中点击构件查看属性；点击楼层可显隐。</Typography.Text>
            )}
          </Card>

          <Card
            size="small"
            title={`问题 (${issues.length})`}
            style={{ margin: 8 }}
            extra={
              <Space size="small">
                <Upload
                  showUploadList={false}
                  accept=".bcfzip"
                  beforeUpload={async (file) => {
                    try {
                      const result = await importBcfZip(projectId!, file);
                      message.success(`BCF 导入完成：新增 ${result.imported}，跳过 ${result.skipped}`);
                      await loadIssues();
                    } catch (err) {
                      message.error(`导入失败：${(err as Error).message}`);
                    }
                    return false;
                  }}
                >
                  <Button size="small" icon={<UploadOutlined />}>导入 BCF</Button>
                </Upload>
                <Button
                  size="small"
                  icon={<ExportOutlined />}
                  onClick={() => downloadToFile(`/projects/${projectId}/issues/export.bcfzip`, "issues.bcfzip")}
                >
                  导出
                </Button>
              </Space>
            }
          >
            {issues.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无问题" />
            ) : (
              <List
                size="small"
                dataSource={issues}
                renderItem={(issue) => (
                  <List.Item
                    actions={issue.viewpointJson ? [
                      <Button key="locate" size="small" onClick={() => locateIssue(issue)}>定位</Button>,
                    ] : undefined}
                  >
                    <List.Item.Meta
                      title={
                        <Space size="small">
                          <Typography.Text strong style={{ fontSize: 13 }}>{issue.title}</Typography.Text>
                          <Tag color={issue.status === "OPEN" ? "orange" : "green"}>{issue.status}</Tag>
                          {issue.priority !== "NORMAL" && <Tag color={issue.priority === "CRITICAL" ? "red" : "blue"}>{issue.priority}</Tag>}
                        </Space>
                      }
                      description={issue.description || undefined}
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Layout.Sider>
      </Layout>

      <Modal
        title="⚡ 碰撞检测（基于元素包围盒）"
        open={clashOpen}
        onCancel={() => setClashOpen(false)}
        footer={null}
        width={640}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Space wrap>
            <Typography.Text>基准：当前版本</Typography.Text>
            <Typography.Text type="secondary">对比：</Typography.Text>
            <Select
              size="small"
              style={{ minWidth: 140 }}
              placeholder="选择版本"
              value={clashTarget}
              onChange={setClashTarget}
              options={versions.filter((v) => v.status === "READY").map((v) => ({ value: v.id, label: `v${v.versionNumber}` }))}
            />
            <Typography.Text type="secondary">容差(m)：</Typography.Text>
            <InputNumber size="small" min={0} max={5} step={0.01} value={clashTolerance} onChange={(v) => setClashTolerance(v ?? 0.01)} style={{ width: 80 }} />
            <Button
              type="primary"
              size="small"
              loading={clashRunning}
              disabled={!clashTarget}
              onClick={() => void runClash()}
            >
              运行检测
            </Button>
          </Space>
          {clashResult && (
            <>
              <Alert
                type={clashResult.summary.clashes > 0 ? "warning" : "success"}
                message={`共 ${clashResult.summary.clashes} 处碰撞（检查 ${clashResult.summary.checkedA} × ${clashResult.summary.checkedB} 个构件，容差 ${clashResult.summary.tolerance} m）`}
              />
              <List
                size="small"
                dataSource={clashResult.clashes}
                style={{ maxHeight: 320, overflow: "auto" }}
                renderItem={(c) => (
                  <List.Item
                    onClick={() => {
                      viewerRef.current?.clearSelection();
                      viewerRef.current?.highlightByExpressID(versionId!, c.a.expressID, 0xffd666);
                      if (clashTarget && clashTarget !== versionId) {
                        viewerRef.current?.highlightByExpressID(clashTarget, c.b.expressID, 0xff7875);
                      }
                      viewerRef.current?.focusOnPoint({ x: c.center[0], y: c.center[1], z: c.center[2] });
                    }}
                    style={{ cursor: "pointer" }}
                  >
                    <Space size="small" wrap>
                      <Tag color="gold">{c.a.name}</Tag>
                      <span>×</span>
                      <Tag color="red">{c.b.name}</Tag>
                      <Typography.Text type="secondary">{c.volume.toFixed(4)} m³</Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </Space>
      </Modal>

      <Modal
        title="版本对比（按 GlobalId）"
        open={diffOpen}
        onCancel={() => setDiffOpen(false)}
        footer={null}
        width={640}
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Space wrap>
            <Typography.Text>基准：当前版本 → 对比：</Typography.Text>
            <Select
              size="small"
              style={{ minWidth: 140 }}
              placeholder="选择版本"
              value={diffTarget}
              onChange={setDiffTarget}
              options={versions.filter((v) => v.status === "READY" && v.id !== versionId).map((v) => ({ value: v.id, label: `v${v.versionNumber}` }))}
            />
            <Button type="primary" size="small" loading={diffRunning} disabled={!diffTarget} onClick={() => void runDiff()}>
              对比
            </Button>
          </Space>
          {diffResult && (
            <>
              <Alert
                type={diffResult.added.total + diffResult.removed.total + diffResult.changed.total > 0 ? "warning" : "success"}
                message={`新增 ${diffResult.added.total} · 删除 ${diffResult.removed.total} · 变更 ${diffResult.changed.total} · 不变 ${diffResult.unchanged}`}
              />
              <List
                size="small"
                style={{ maxHeight: 320, overflow: "auto" }}
                dataSource={[
                  ...diffResult.added.items.map((i) => ({ kind: "新增" as const, color: "green" as const, text: i.b?.name ?? i.guid, type: i.b?.type })),
                  ...diffResult.removed.items.map((i) => ({ kind: "删除" as const, color: "red" as const, text: i.a?.name ?? i.guid, type: i.a?.type })),
                  ...diffResult.changed.items.map((i) => ({ kind: `变更(${i.changes.join(",")})` as string, color: "orange" as const, text: `${i.a?.name ?? i.guid} → ${i.b?.name ?? ""}`, type: i.b?.type })),
                ]}
                renderItem={(row) => (
                  <List.Item>
                    <Space size="small">
                      <Tag color={row.color}>{row.kind}</Tag>
                      <Typography.Text style={{ fontSize: 13 }}>{row.text}</Typography.Text>
                      {row.type && <Typography.Text type="secondary">{row.type}</Typography.Text>}
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
        </Space>
      </Modal>

      <Modal
        title="报个问题（自动附当前视图快照）"
        open={issueModal}
        onCancel={() => setIssueModal(false)}
        confirmLoading={creatingIssue}
        onOk={() => void createIssue()}
        okText="创建"
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Input
            value={issueTitle}
            onChange={(e) => setIssueTitle(e.target.value)}
            placeholder="问题标题，例：二层玻璃墙与门碰撞"
            maxLength={200}
          />
          <Input.TextArea
            value={issueDesc}
            onChange={(e) => setIssueDesc(e.target.value)}
            placeholder="补充说明（可留空）"
            rows={3}
            maxLength={5000}
          />
          <Select
            value={issuePriority}
            onChange={setIssuePriority}
            style={{ width: 160 }}
            options={[
              { value: "LOW", label: "低" },
              { value: "NORMAL", label: "普通" },
              { value: "HIGH", label: "高" },
              { value: "CRITICAL", label: "紧急" },
            ]}
          />
          <Typography.Text type="secondary">
            提交时将自动截取当前三维视图并记录相机位置，BCF 导出时会包含视角与快照。
          </Typography.Text>
        </Space>
      </Modal>
    </Layout>
  );
}

// ---- helpers ------------------------------------------------------------------

function directionFromCamera(position: [number, number, number], target: [number, number, number]): [number, number, number] {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  return [dx / len, dy / len, dz / len];
}

function collectStoreys(versionId: string, node: SpatialNodeLike, out: Set<string>): void {
  if (node.type === "IFCBUILDINGSTOREY") out.add(`${versionId}:${node.expressID}`);
  for (const c of node.children) collectStoreys(versionId, c, out);
}

/** storey GUID → expressID map, so proxy boxes can follow the floor tree. */
function collectStoreyGuids(node: SpatialNodeLike, out: Map<string, number>): void {
  if (node.type === "IFCBUILDINGSTOREY") out.set(node.guid, node.expressID);
  for (const c of node.children) collectStoreyGuids(c, out);
}

function buildTreeData(
  versionId: string,
  node: SpatialNodeLike | null,
  storeyCounts: Map<string, number>
): TreeNodeLike | null {
  if (!node) return null;
  const label =
    node.type === "IFCBUILDINGSTOREY"
      ? `${node.name}${storeyCounts.get(`${versionId}:${node.expressID}`) ? `（${storeyCounts.get(`${versionId}:${node.expressID}`)} 构件）` : ""}`
      : node.name;
  return {
    key: `${versionId}:${node.type === "IFCBUILDINGSTOREY" ? node.expressID : `n${node.expressID}`}`,
    title: label,
    checkable: node.type === "IFCBUILDINGSTOREY",
    selectable: false,
    children: node.children.map((c) => buildTreeData(versionId, c, storeyCounts)).filter((n): n is TreeNodeLike => n !== null),
  };
}

interface TreeNodeLike {
  key: string;
  title: string;
  checkable: boolean;
  selectable: boolean;
  children: TreeNodeLike[];
}
