# OpenBIM Hub — 架构设计文档

> 版本 1.0（2026-09）。本设计基于 `docs/research/` 三份调研报告的结论。
> 定位：**生产级、全链路开源（Apache-2.0）、Docker 一键自托管**的 BIM 协同平台。

## 1. 产品定位与差异化

调研结论（报告 01）：开源 BIM 生态呈「哑铃型」——IFC 引擎成熟、平台层薄弱。我们的定位：

| 能力 | BIMserver | Speckle | 3drepo.io | **OpenBIM Hub** |
|---|---|---|---|---|
| IFC 原生支持 | ✅ 对象级 | ⚠️ 连接器 | ✅ | ✅ 服务端解析 |
| Web 轻量查看 | ⚠️ BIMsurfer beta | ✅ | ✅（闭源组件） | ✅ three.js 全开源 |
| 模型版本管理 | ⚠️ | ✅（权限闭源） | ✅ | ✅ 全开源 |
| BCF 协同闭环 | ❌ | ⚠️ | ✅ | ✅ P0 实现 |
| RBAC / 多项目 | ✅ 陈旧 | ⚠️ EE | ✅ | ✅ |
| 一键自托管 | ❌ Java 重 | ⚠️ 微服务多 | ❌ | ✅ compose up 即用 |
| 许可 | AGPL-3.0 | Apache-2.0(核心) | AGPL-3.0 | **Apache-2.0** |

**P0 功能集**：注册/登录(JWT+RBAC) → 项目 → 模型版本（上传 IFC，服务端异步转换）→ Web 查看器（几何+空间树+属性+拾取+隔离+截面+测量）→ 元素检索 API → BCF 2.1 导出。

## 2. 总体架构

```
┌──────────────┐     ┌────────────────────────────────────────────┐
│  web (React) │────▶│  api (Fastify 5, Node 22)                  │
│  three.js 查看器│    │  ├─ auth: JWT access/refresh + RBAC        │
└──────────────┘     │  ├─ projects/models/versions/issues        │
                     │  ├─ elements 查询 API（Postgres 索引）        │
                     │  ├─ 静态产物流（glb/meta，鉴权后流式）          │
                     │  ├─ ConversionService ──▶ worker_threads 池 │
                     │  └─ Prisma 7                               │
                     └───────┬──────────────────────┬──────────────┘
                             │                      │
                    ┌────────▼────────┐   ┌─────────▼─────────┐
                    │ PostgreSQL/SQLite│   │ BlobStore 抽象     │
                    │ 元数据/索引/用户   │   │ LocalDisk | S3     │
                    └─────────────────┘   └─────────┬─────────┘
                                                    │
                              ┌─────────────────────▼───────────────┐
                              │ packages/ifc (web-ifc 0.0.77 WASM)   │
                              │ OpenModel→StreamAllMeshes→glb+meta   │
                              └─────────────────────────────────────┘
```

设计原则：
1. **一次归一化**（学 BIMserver serializer 思想）：IFC 上传后立即转换为 `model.glb + meta.json + original.ifc`，查看器永不接触原始 IFC。
2. **版本不可变**（学 Speckle commit / ISO 19650 Published）：Version 只创建不修改，转换状态机 `PENDING→PROCESSING→READY|FAILED`。
3. **进程隔离**：web-ifc WASM 只在 worker 线程加载，API 主进程崩溃面最小。
4. **零依赖起步**：dev 全链 SQLite + 本地磁盘 BlobStore，`pnpm dev` 即跑；prod 切 Postgres/S3 只改环境变量。

## 3. 数据模型（Prisma schema 摘要）

```prisma
User        { id, email(unique), name, passwordHash, role(GLOBAL_ROLE), createdAt }
RefreshToken{ id, userId, tokenHash, expiresAt, revokedAt? }
Project     { id, name, description, key(unique), createdById, timestamps }
ProjectMember{ projectId, userId, role(OWNER|ADMIN|EDITOR|VIEWER), @@id([projectId,userId]) }
Model       { id, projectId, name, description, timestamps }        // 模型分支
Version     { id, modelId, versionNumber, status, errorCode?,
              schema?, statsJson?, storageKey, originalName, sizeBytes, sha256,
              createdById, createdAt, @@unique([modelId, versionNumber]) }
Element     { id, versionId, expressID, guid, ifcType, name, storeyGuid,
              storeyName, attributesJson, psetsJson
              @@unique([versionId, expressID]) @@index([versionId, ifcType]) }
Issue       { id, projectId, guid, title, description, status(OPEN|CLOSED),
              priority, authorId, createdAt }
IssueComment{ id, issueId, authorId, body, createdAt }
```

Blob 布局（BlobStore 键）：

```
projects/{projectId}/models/{modelId}/v{versionNumber}/original.ifc
projects/{projectId}/models/{modelId}/v{versionNumber}/model.glb
projects/{projectId}/models/{modelId}/v{versionNumber}/meta.json
```

`meta.json` 结构（转换器输出、`Element` 表导入源、查看器元数据三合一）：

```jsonc
{
  "schema": "IFC4",
  "units": { "length": 0.001 },          // IFC 原始单位→米
  "stats": { "elements": 120, "triangles": 45000 },
  "spatial": {                            // 空间树（storey 为展示层）
    "guid": "...", "type": "IFCPROJECT", "name": "...",
    "children": [ /* Site→Building→Storey */ ]
  },
  "elements": {
    "<expressID>": { "guid": "22char", "type": "IFCWALLSTANDARDCASE", "name": "Wall-01",
                     "storeyGuid": "...", "attributes": {...}, "psets": { "Pset_WallCommon": {...} } }
  }
}
```

glb node 约定：每 mesh `name = expressID 字符串`，`extras.storey = storeyGuid`，材质色来自 IFC。

## 4. API 规范（REST + OpenAPI 自动生成）

统一前缀 `/api/v1`，鉴权 `Authorization: Bearer <access>`。错误格式 `{ statusCode, error, message }`。

### Auth
| 方法/路径 | 说明 | 权限 |
|---|---|---|
| POST /auth/register | 注册（首个用户为平台 ADMIN） | 公开 |
| POST /auth/login | 登录 → {accessToken, refreshToken} | 公开 |
| POST /auth/refresh | 刷新令牌（轮换） | 公开 |
| POST /auth/logout | 吊销 refresh | 登录 |
| GET /auth/me | 当前用户 | 登录 |

### Projects / Members
| 方法/路径 | 说明 |
|---|---|
| GET/POST /projects | 列表（我参与的）/ 创建（建者自动 OWNER） |
| GET/PATCH/DELETE /projects/:id | 详情/改名/删除（ADMIN+） |
| GET/POST /projects/:id/members | 成员列表/邀请（ADMIN+），body {email, role} |
| PATCH/DELETE /projects/:id/members/:userId | 改角色/移除（ADMIN+） |

### Models / Versions
| 方法/路径 | 说明 |
|---|---|
| GET/POST /projects/:id/models | 列表/创建模型分支（EDITOR+） |
| POST /models/:id/versions | 上传新版本（multipart field=`file`, `.ifc`；EDITOR+）→ 202 {id,status:PENDING} |
| GET /models/:id/versions | 版本列表（含状态/统计） |
| GET /versions/:id | 版本详情（状态轮询） |
| GET /versions/:id/file/glTF | 下载 model.glb（VIEWER+，流式） |
| GET /versions/:id/file/meta | meta.json |
| GET /versions/:id/file/original | 原始 IFC（VIEWER+） |
| GET /versions/:id/elements | 分页元素列表（q/ifcType/storeyGuid 过滤） |
| GET /versions/:id/elements/:expressId | 单元素属性+Psets |
| GET /versions/:id/spatial | 空间树 |
| POST /versions/:id/reconvert | 失败重转（EDITOR+） |

### Issues（BCF）
| 方法/路径 | 说明 |
|---|---|
| GET/POST /projects/:id/issues | 列表/创建（VIEWER+/EDITOR+） |
| GET/POST /issues/:id/comments | 评论 |
| PATCH /issues/:id | 改状态/优先级 |
| GET /projects/:id/issues/export.bcfzip | BCF 2.1 导出（zip: markup.bcf + snapshot） |

### 运维
`GET /healthz`（DB 连通检查）、`GET /api/v1/openapi.json`、Scalar UI 挂 `/api/v1/docs`。

## 5. 转换管线（packages/ifc + worker）

```
上传完成 → Version(PENDING) → ConversionQueue(内存队列+并发上限)
  → WorkerThread: packages/ifc/convert(buffer):
     1. Init IfcAPI(SetWasmPath 绝对路径, 单线程 wasm)
     2. OpenModel(COORDINATE_TO_ORIGIN=true) → GetModelSchema()
     3. 读 IfcProject 单位 → scale
     4. StreamAllMeshes：按 storey×color 合并 → positions/normals/indices/expressRanges
     5. 空间树：IfcRelAggregates + IfcRelContainedInSpatialStructure
     6. 属性：全量扫 IFCRELDEFINESBYPROPERTIES 建 expressID→Psets 索引
     7. 产出 meta.json + glb（自写极简 GLB 序列化：单场景，node.name=expressID）
     8. BlobStore 写三个对象 → Version(READY, stats) → Element 批量入库
  失败 → Version(FAILED, errorCode) → 可 reconvert
```

- 内存防护：worker 接收的是 BlobStore 里的文件路径（不传大 buffer 给线程；线程内流读）。
- 并发默认 `max(1, cpus-1)`，队列上限 8，超限 429。
- GUID：实现 RFC 4122 压缩 base64（字符表 `0-9A-Za-z_$`，见报告 02 §6），转换时从 web-ifc `GlobalId` 属性读取并校验。

## 6. 前端架构（apps/web）

```
src/
├─ main.tsx / App.tsx          # 路由：/login /register /projects /projects/:id/models/:modelId
├─ api/client.ts               # fetch 封装（token 自动刷新）
├─ store/auth.ts, viewer.ts    # zustand
├─ viewer/                     # 命令式 Viewer（非 r3f）
│  ├─ Viewer.ts                # three 场景/相机/灯/OrbitControls/拾取/隔离/截面/测量
│  ├─ GlbLoader.ts             # GLTFLoader + expressID 映射 + storey 分组
│  └─ tools/                   # SectionTool MeasureTool IsolateTool
└─ pages/
   ├─ ProjectList / ModelList  # AntD 表格+上传
   └─ ViewerPage               # 左:空间树(Storey) 中:canvas 右:属性面板 底:状态
```

- 拾取：raycast 命中 mesh → faceIndex 落在哪个 expressRange → expressID → 属性面板拉 `/elements/:id`。
- 空间树：`GET /versions/:id/spatial` 渲染 AntD Tree；勾选楼层=按 `extras.storey` 显隐。
- 截面：6 面剪裁盒 + 材质 `clippingPlanes`，工具条滑杆。
- token 失效自动 refresh；401 跳登录。

## 7. 质量与交付

- **测试**（Vitest）：packages/ifc 纯单测（GUID 编解码、GLB 结构、meta 生成，用 `samples/wall.ifc` 固定样例）；api 集成测试（fastify.inject：注册→建项目→传样例 IFC→轮询 READY→elements/spatial/glTF 下载断言）；前端 `tsc` 类型门禁。
- **CI**：GitHub Actions —— pnpm install → lint → typecheck → test → build（矩阵 Node 20/22）。
- **容器**：多阶段 Dockerfile（api 与 web 同源）；docker-compose.yml = postgres + api + web(+volume)。
- **文档**：README（中文为主+英文摘要）、docs/deployment.md、docs/api.md（由 OpenAPI 导出）、CONTRIBUTING.md、SECURITY.md。
- **可观测性**：pino 结构化日志（requestId 贯穿）、/healthz、转换任务日志带 versionId。

## 8. 里程碑（对应本仓库当前交付）

M1 脚手架+共享包 → M2 转换管线（样例 IFC→glb/meta，纯库测试绿）→ M3 API 全量+集成测试 → M4 Web 查看器 → M5 BCF 导出+Docker+CI+文档 → M6 端到端验证。
