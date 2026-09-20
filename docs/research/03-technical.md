# 技术调研报告 3：Web BIM 查看器与服务端技术实现

> 调研日期：2026-09-03。本文所有 web-ifc API 签名均直接核对 npm 包 `web-ifc@0.0.77` 的 `.d.ts` 源码（`web-ifc-api.d.ts` / `web-ifc-api-node.d.ts`），非二手资料。版本号通过 npm registry 实时查询。

## 1. web-ifc 引擎（npm `web-ifc@0.0.77`）

### 1.1 版本与发行物

npm registry 实测最新版 **0.0.77**（ThatOpen 维护，MPL-2.0）。包内包含：

| 文件 | 用途 |
|---|---|
| `web-ifc-api.js` / `web-ifc-api.d.ts` | 浏览器入口（ESM） |
| `web-ifc-api-node.js` / `web-ifc-api-node.d.ts` | Node 入口（内置单/双 WASM 模块） |
| `web-ifc.wasm` | 浏览器单线程 WASM |
| `web-ifc-mt.wasm` | 浏览器多线程 WASM（SharedArrayBuffer） |
| `web-ifc-node.wasm` | Node 专用 WASM |
| `ifc-schema.d.ts` | 全量 IFC 实体类（`IFCWALL`、`IFCRELAGGREGATES`…，含类型常量） |
| `helpers/properties.d.ts` | `Properties` 辅助类（getItemProperties / getSpatialStructure） |

注意：**包名仍是 `web-ifc`；`@thatopen/components`（v3.4.8）是其上层的查看器组件库**。自研系统建议直接依赖底层 `web-ifc`，避免 components 库大版本迁移（v1→v3 破坏性变更史）带来的锁定。

### 1.2 初始化与 WASM 加载（实测签名）

```ts
import { IfcAPI, LoaderSettings } from "web-ifc";
const ifcapi = new IfcAPI();
// 签名：Init(customLocateFileHandler?: LocateFileHandlerFn, forceSingleThread?: boolean)
await ifcapi.Init();
// 签名：SetWasmPath(path: string, absolute?: boolean)  —— Init 前调用
ifcapi.SetWasmPath("/wasm/", true);
```

- Node 端 `web-ifc-api-node.js` 内部对单线程用 `web-ifc-node.wasm`、`forceSingleThread=false` 时尝试 `web-ifc-mt.wasm`（见源码 4538/225 行附近）。默认 `locateFile` 基于 Emscripten `scriptDirectory`，**在打包器（esbuild/rollup）产物中会失效**，生产做法是二选一：
  1. 构建时把 `web-ifc-node.wasm` 拷贝到产物目录，`SetWasmPath(dir, true)` 指绝对路径；
  2. `Init((path, prefix) => require.resolve(...))` 自定义 `LocateFileHandlerFn: (path, prefix) => string`。
- 浏览器端通过 Vite：`import wasmUrl from "web-ifc/web-ifc.wasm?url"` + 自定义 locateFile 返回该 URL 最稳。
- 多线程 WASM 需要 COOP/COEP 响应头（SharedArrayBuffer），单线程无此要求；服务端转换场景建议 `forceSingleThread` 或直接用 node wasm 避免复杂性。

### 1.3 核心解析 API（实测签名，来自 0.0.77 d.ts）

```ts
OpenModel(data: Uint8Array, settings?: LoaderSettings): number;   // 返回 modelID
OpenModels(dataSets: Array<Uint8Array>, settings?: LoaderSettings): Array<number>;
GetModelSchema(modelID: number): string;                          // "IFC4" | "IFC2X3" | ...
CloseModel(modelID: number): void;                                // 必须调用，防内存泄漏
CloseAllModels(): void;

interface LoaderSettings {
  COORDINATE_TO_ORIGIN?: boolean;   // 平移到原点（推荐 true）
  CIRCLE_SEGMENTS?: number;         // 圆弧细分段数
  MEMORY_LIMIT?: number; TAPE_SIZE?: number;
  // …若干布尔/三角化容差参数
}

// 几何流式提取
StreamAllMeshes(modelID: number,
  meshCallback: (mesh: FlatMesh, index: number, total: number) => void): void;
StreamAllMeshesWithTypes(modelID: number, types: Array<number>,
  meshCallback: (mesh: FlatMesh, index: number, total: number) => void): void;

interface FlatMesh { geometries: Vector<PlacedGeometry>; expressID: number; delete(): void; }
interface PlacedGeometry {
  color: Color;                    // {x,y,z,w} RGB+透明度
  geometryExpressID: number;       // 几何数据的 expressID（供 GetGeometry）
  flatTransformation: Array<number>; // 16 元素列主序矩阵
}
GetGeometry(modelID: number, geometryExpressID: number): IfcGeometry;
interface IfcGeometry {
  GetVertexData(): number; GetVertexDataSize(): number;   // WASM 堆内指针
  GetIndexData(): number;  GetIndexDataSize(): number;
  delete(): void;
}
GetVertexArray(ptr: number, size: number): Float32Array;  // 拷贝为 JS 视图
GetIndexArray(ptr: number, size: number): Uint32Array;    // 同上（用完调 ifcapi.wasmModule 之外的 free）

// 属性/关系提取
GetLine(modelID: number, expressID: number, flatten?: boolean,
        inverse?: boolean, inversePropKey?: string | null): any;
GetLineIDsWithType(modelID: number, type: number, includeInherited?: boolean): Vector<number>;
GetRawLineData(modelID: number, expressID: number): RawLineData;  // {ID, type, arguments[]}
```

典型几何提取循环（服务端转换管线骨架）：

```ts
await ifcapi.Init();
ifcapi.SetWasmPath(wasmDir, true);
const modelID = ifcapi.OpenModel(new Uint8Array(ifcBuffer), { COORDINATE_TO_ORIGIN: true });
const schema = ifcapi.GetModelSchema(modelID);          // 决定 Pset 映射差异
ifcapi.StreamAllMeshes(modelID, (mesh) => {
  const placed = mesh.geometries;
  for (let i = 0; i < placed.size(); i++) {
    const g = placed.get(i);
    const geom = ifcapi.GetGeometry(modelID, g.geometryExpressID);
    const verts = ifcapi.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const idx = ifcapi.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
    // verts 布局为 [px,py,pz,nx,ny,nz]×N（6 stride），g.flatTransformation 为列主序矩阵
    geom.delete();
  }
});
ifcapi.CloseModel(modelID);
```

### 1.4 属性与空间结构提取

- **空间树**：`GetLineIDsWithType(modelID, IFCRELAGGREGATES)` 遍历 `IfcRelAggregates`（Project→Site→Building→Storey→Space 链），再遍历 `IFCRELCONTAINEDINSPATIALSTRUCTURE` 把构件挂到 Storey/Space。`GetLine(id, true)`（flatten=true 展开引用）可直接拿 `RelatingObject/RelatedElements` 的 expressID。
- **Pset 属性**：构件 → `IfcRelDefinesByProperties.RelatingPropertyDefinition`（`IFCPROPERTYSET`）→ `HasProperties`（`IFCPROPERTYSINGLEVALUE`，值类型 NominalValue+Name）。0.0.77 的 `helpers/properties.ts` 提供 `getSpatialStructure` / `getItemProperties` 封装，但其逐条 `GetLine` 在大模型上较慢，**生产管线建议一次性扫 `IFCRELDEFINESBYPROPERTIES` 建索引**。
- **变换矩阵**：`flatTransformation` 是列主序 4×4；three.js `Matrix4.fromArray()` 直接兼容（three 也用列主序）。
- **颜色**：`PlacedGeometry.color.{x,y,z,w}` = RGB + Alpha（w<1 表示透明，如玻璃）。

### 1.5 已知坑位

1. `OpenModel` 后必须 `CloseModel`，否则 WASM 堆持续增长（转换 worker 长驻时致命）。
2. `GetGeometry` 返回的 `IfcGeometry` 指针用完必须 `.delete()`。
3. `GetVertexArray` 拷出的 Float32Array 是 WASM 堆的拷贝，但生命周期到下一次调用前，**应立即 slice 复制**再继续循环。
4. IFC2x3 与 IFC4 的部分实体字段序号不同（如 IfcPropertySingleValue 一致，但 IfcWall 标准属性不同），schema 无关处理要靠 `GetModelSchema` 分支。
5. 单位：几何已按 IfcProject 单位换算到「项目单位」数值；常见导出器（Revit）输出毫米。**应在转换时归一化到米**（读 `IFCPROJECT` 的 UnitsInContext，mm→×0.001）。

## 2. three.js 大模型渲染性能方案

three.js 当前版本 **0.185.x**（2026-09，npm 实测 0.185.1）。BIM 模型（10万+ 三角面、数万构件）的关键优化：

### 2.1 几何组织

| 技术 | 说明 | 建议用法 |
|---|---|---|
| `BufferGeometryUtils.mergeGeometries()` | 把多 mesh 合并成一个（原名 mergeBufferGeometries，位于 `three/examples/jsm/utils/BufferGeometryUtils.js`） | 同材质同色构件合并，DrawCall 从数万降到几十 |
| `InstancedMesh` | 一个几何 + N 个实例矩阵 | 门窗/设备（IfcRepresentationMap 实例化场景） |
| `THREE.Group` 树 | 与空间树同构的场景图 | 按楼层 hide/isolate |
| Web Worker 解析 | glTF 用 GLTFLoader（自带异步）+ 原生 Worker 解析元数据 | 主线程只做渲染 |

**推荐架构：服务端预合并 + 按 storey 分块**。转换管线按「storey × 材质桶」合并三角形输出 glTF，浏览器每楼层一个 mesh，显隐切换 O(1)，拾取通过 expressID↔mesh 映射表回查。

### 2.2 拾取（Picking）

- `Raycaster` 对合并大 mesh 昂射可行（BVH 加速可用 `three-mesh-bvh`），但 BIM 需要「点谁得构件」：
  - 方案 A：每个 storey-mesh 一个 draw，`raycast` 命中后用 faceIndex → 三角形区间映射回 expressID（转换时写入 mapping）；
  - 方案 B：GPU picking（颜色编码 pass，离屏渲染读像素），十万级构件仍 O(1)，实现成本较高。
  - **建议 A**（实现简单、足够快），后续升级 BVH。

### 2.3 截面、剖切与显示控制

- `renderer.localClippingEnabled = true` + 材质 `clippingPlanes: [THREE.Plane]`，配合 `clipIntersection`；6 面盒剖切用 6 个 plane。
- 隐藏/隔离：直接 `mesh.visible`，配合空间树 UI。
- 透明构件（玻璃 w<1）：`material.transparent=true; depthWrite=false` 有排序问题，BIM 惯例是「默认半透明显示，聚焦时切换不透明」。
- 相机：`OrbitControls`（`three/examples/jsm/controls/OrbitControls.js`）；大模型常用「按住 Shift 平移、滚轮缩放」与楼层剖切联动。

### 2.4 glTF 加载

`GLTFLoader`（`three/examples/jsm/loaders/GLTFLoader.js`）：

```ts
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);       // KHR_meshopt_compression
// loader.setDRACOLoader(dracoLoader);          // KHR_draco_compression
```

- **meshopt 优于 Draco 的场景**：解压快 1 个数量级（WASM SIMD ~1GB/s）、支持逐 bufferView 压缩、可与 gzip/brotli 叠加、量化后视觉无损。BIM 建筑静态模型首选 `KHR_meshopt_compression` + `KHR_mesh_quantization`。
- three.js 不解析 `EXT_structural_metadata`（CesiumJS 才原生支持），因此**属性走自定义 JSON sidecar 是当前最务实方案**（该结论在报告 02 有同样建议）。

## 3. IFC→glTF 服务端转换管线

### 3.1 服务端 vs 浏览器端转换

| 维度 | 服务端转换（上传时一次性） | 浏览器端转换（每次打开） |
|---|---|---|
| 首开速度 | 快（直接下 glTF+meshopt） | 慢（要下载原 IFC + WASM 解析 10s-数分钟） |
| 重复观看 | 0 成本 | 每次重复解析 |
| 服务器成本 | 一次性 CPU | 几乎 0 |
| 失败定位 | 转换失败可异步重试/报错 | 用户端机器差异大，难排障 |
| 端侧体验 | 移动端可看 | 移动端基本不可用 |

**结论：生产级系统必须服务端转换**（BIMserver/Speckle/3drepo.io 均如此），浏览器端解析只作为降级路径。异步任务队列兜底大文件。

### 3.2 输出物设计（我们采用）

```
models/{modelId}/v{version}/
  model.glb          # meshopt 压缩 glTF-Binary，按 storey 分组 + expressID 存 node.name/extras
  meta.json          # { elements: { expressID: { guid, type, name, storey, attributes, psets } },
                        spatial: treeJson, units, schema }
  original.ifc       # 原始文件归档（可再导出/审计）
```

- glb 用 `node.name = expressID` 或 `node.extras.expressID` 承载 ID 映射（GLTFLoader 可读 `extras`）。
- `meta.json` 服务端也可直接用于 API 查询（属性检索、空间树接口），兼做 DB 的导入源。

### 3.3 转换器实现要点（Node + web-ifc）

1. **进程隔离**：web-ifc WASM 是大块内存消费者且可能被脏数据打崩，转换放进独立进程（`worker_threads` 或 `child_process`）+ 队列（BullMQ worker），主 API 进程永不加载 WASM。
2. **合并策略**：`Map<storeyId, Map<colorKey, {positions[], normals[], indices[], expressRanges[]}>>`，同桶 append；记录每段三角形区间对应 expressID（拾取回查）。
3. **坐标**：`COORDINATE_TO_ORIGIN: true` 让模型原点在原点；北向/坐标系统信息另存 meta（`IfcMapConversion`）。
4. **单位**：读 `IFCPROJECT.UnitsInContext`，长度单位前缀（MILLI→1e-3）统一乘到几何。
5. **内存控制**：StreamAllMeshes 逐 mesh 消费 + 即时 `delete()`；单模型 >500MB 时可考虑 `OpenModelFromCallback` 流式读。

## 4. BIMserver 与 Speckle 架构借鉴

### 4.1 BIMserver（开源界唯一对象级 IFC 模型服务器，AGPL-3.0）

- **插件式 Serializer/Deserializer**：IFC↔内部对象模型↔JSON/binary 多向转换，值得借鉴——我们用「IFC→glTF+meta.json 一次归一化」实现同样效果，复杂度低一个量级。
- **低层数据库 + 事务**（eClass/对象投影）：支持增量改单个对象，但实现复杂度极高，v2 重写多年未发布。**结论：不学它的对象库，学它的「版本即不可变快照」语义**。
- 教训：Java 单体 + 自研 RPC 部署重；核心作者精力转向商业 BIM.works，社区维护弱。

### 4.2 Speckle（Apache-2.0，版本管理最先进）

- **branch/commit 模型**：数据流 = stream → branch（main/dev）→ commit（不可变快照），完美映射到「模型版本」。我们直接采用 `project → model → version(不可变)` 三级。
- **内容寻址对象存储**：对象哈希入 S3，天然去重。我们简化为「版本目录 + 文件哈希记录」，S3-兼容抽象保留。
- **教训**：Speckle 的 workspace/权限（gatekeeper）模块闭源（EE 许可）——这是我们要开源补位的空白；GraphQL 全端 API 开发效率高但门槛高，REST+OpenAPI 更适合自托管用户。

### 4.3 3drepo.io 的教训

AGPL 核心 + 闭源可视化组件（unity 导出器），自部署者拿不到完整能力——**证明「全链路开源」本身就是差异化**。

## 5. 生产级自托管系统工程实践

### 5.1 后端选型（2026-09 npm 实测版本）

| 组件 | 选择 | 版本 | 理由 | 备选/风险 |
|---|---|---|---|---|
| 语言/运行时 | TypeScript + Node | 22 LTS | 生态、与前端共享类型 | Bun（新） |
| HTTP 框架 | **Fastify** | 5.12.1 | 内置 JSON Schema 校验、插件体系、性能第一梯队 | NestJS（重）、Hono（偏边缘） |
| ORM | **Prisma** | 7.x（8 仍在 RC） | 迁移体系成熟、类型安全；dev 用 SQLite 零依赖、prod 切 Postgres 仅改 provider | Drizzle（更轻，迁移弱） |
| 队列 | BullMQ + Redis | — | 异步转换必配 | pg-boss（少一个 Redis 依赖，单机部署更简——**小规模自托管首选**） |
| 对象存储 | 本地磁盘适配器 + S3/MinIO 适配器 | — | dev 零依赖，prod 可扩 | — |
| 认证 | JWT（access+refresh） | — | 无状态、多端 | session（需粘性） |
| 日志 | pino（fastify 内置集成） | — | 结构化、快 | — |
| 文档 | @fastify/swagger + scalar-ui | — | OpenAPI 3.1 自动生成 | — |
| 测试 | Vitest | — | 快、与 Vite 同族 | node:test |

**部署形态决策**：`docker compose up` 一键 = API + Postgres + MinIO + (可选 Redis)。转换 worker 先做成 API 内嵌线程池（`worker_threads`，默认并发=CPU/2），规模化时拆独立容器——**避免小用户被迫跑 4 个容器**。

### 5.2 数据模型（核心 8 表）

```
User(密码哈希) ─ Role(org/project 两级)   Project ─┬─ Model ─ Version(不可变)
                                                  ├─ Issue(BCF topic) ─ Comment
                                                  └─ Member(user, role)
Version ── 存储: storageKey(original/model/meta)、status(PENDING/PROCESSING/READY/FAILED)、
          hash(sha256 去重)、schema(IFC2X3/IFC4…)、stats(elements/triangles)
Element(从 meta.json 导入 DB 的可查询索引：versionId, expressID, guid, type, storeyId, name)
```

ISO 19650 CDE 状态机落到 `Version.status + revisionCode`：WIP→SHARED→PUBLISHED→ARCHIVED，PUBLISHED 不可变（对应调研报告 02 结论）。

### 5.3 文件上传

- 小文件（<64MB）：单请求 multipart（@fastify/multipart）。
- 大文件：分片上传接口（`POST /uploads` 创建会话 → `PUT /uploads/:id/parts/:n` → `POST /uploads/:id/complete`），S3 端映射 multipart upload，本地端 append。
- 上传完成 → 建任务 → worker 转换 → 状态轮询/SSE 推送。

### 5.4 安全基线

- bcrypt/argon2 密码哈希；JWT HS256 + 7d refresh 轮换；RBAC：`owner/admin/editor/viewer`（project 级）。
- 所有下载走鉴权流（原文件不可直接静态暴露）。
- 上传类型白名单 `.ifc/.ifczip/.bcfzip`，大小上限可配；路径穿越防护（storageKey 服务端生成，禁止用户输入拼路径）。

### 5.5 前端选型

| 项 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite 8 + React 19 | 2026 主流 |
| 3D | three 0.185（命令式封装 Viewer 类） | r3f 对 BIM 指令式操作（剖面/隔离/测量）反而绕 |
| UI | Ant Design 6 | 中文生态、企业级组件齐全（树/表格/布局） |
| 状态 | zustand | 轻量，viewer 状态与 React 解耦 |
| 路由 | react-router v7 | — |

**React 与 three.js 集成模式**：Viewer 是纯命令式单例（canvas 挂载时创建），React 只做 UI 壳；选中状态经 zustand 双向同步。不引入 r3f（BIM 操作大量 imperative API，声明式包装是负资产）。

### 5.6 Monorepo 结构建议

```
bim-platform/
├─ apps/
│  ├─ api/                # Fastify 后端（含 IFC 转换 worker）
│  └─ web/                # React 查看器
├─ packages/
│  ├─ ifc/                # web-ifc 封装：几何提取/空间树/属性（纯库，可独立测试）
│  ├─ core/               # 共享类型 + API client（前端后端共用）
│  └─ bcf/                # BCF 2.1/3.0 读写（纯库）
├─ docs/                  # research/、architecture.md、api.md、deployment.md
├─ docker/                # Dockerfile、docker-compose.yml
├─ samples/               # 示例 IFC（测试/演示用）
└─ .github/workflows/     # CI：lint+test+build
```

## 6. 选型定论（开工清单）

1. **后端**：Node 22 + TypeScript + Fastify 5 + Prisma 7（dev SQLite / prod Postgres）+ pino + @fastify/swagger（OpenAPI）。
2. **转换管线**：`packages/ifc` 用 web-ifc 0.0.77 服务端解析 → glb（meshopt 可选，MVP 先不压缩保稳定）+ meta.json；`worker_threads` 池；任务状态机 PENDING→PROCESSING→READY/FAILED。
3. **前端**：React 19 + Vite 8 + AntD 6 + three 0.185 命令式 Viewer + zustand。
4. **标准落地**：IFC GUID 22 字符编解码（报告 02 字符表）、空间树、Pset 读取、BCF 2.1 导出（P0）；BCF 导入、CDE 状态机（P1）。
5. **交付**：Dockerfile + docker-compose（api+web+postgres）、GitHub Actions CI（lint/test/build）、Apache-2.0、中英双语 README。

## 来源

- web-ifc 0.0.77 类型定义与源码（npm pack 实测）：https://www.npmjs.com/package/web-ifc
- ThatOpen 组织：https://github.com/ThatOpen/engine_web-components
- three.js GLTFLoader 文档（setMeshoptDecoder/setDRACOLoader）：https://threejs.org/docs/pages/GLTFLoader.html
- three.js BufferGeometryUtils：https://threejs.org/docs/#/examples/jsm/utils/BufferGeometryUtils
- three.js Releases：https://github.com/mrdoob/three.js/releases
- Fastify 文档：https://fastify.dev/docs/
- Prisma 文档：https://www.prisma.io/docs
- BullMQ：https://docs.bullmq.io/
- Speckle 对象模型/分支提交：https://github.com/specklesystems/speckle-server
- BIMserver 架构：https://github.com/opensourceBIM/BIMserver
- meshopt 规范：https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/KHR_meshopt_compression/README.md
- Ant Design：https://ant.design/
