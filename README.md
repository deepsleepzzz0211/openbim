# OpenBIM Hub

**生产级、自托管、全链路开源的 BIM 协同平台** · Apache-2.0

OpenBIM Hub 让团队上传 IFC 模型、在浏览器中轻量化查看三维模型、按空间结构浏览构件属性，并用 BCF 2.1 与外部工具（Bonsai/BlenderBIM、Solibri、Revit 插件等）交换问题清单。

> 定位（源自 `docs/research/` 生态调研）：现有开源 BIM 生态在「平台/协同层」最薄弱 —— BIMserver 部署重、Speckle 权限闭源、3drepo.io 可视化组件闭源。OpenBIM Hub 补位：**Speckle 的部署体验 + IFC 语义完整保留 + 全开源的权限/协同/BCF 闭环**。

[English](#english) · 文档：[调研报告](docs/research/) · [架构设计](docs/architecture.md) · [部署指南](docs/deployment.md)

## 功能

| 模块 | 能力 |
|---|---|
| 模型服务 | IFC2x3 / IFC4 上传（multipart 流式 + sha256 + **16MB 分片上传**），**服务端异步转换**（web-ifc WASM worker 线程池 + 实时进度），版本不可变 + 状态机，重启自动恢复中断任务，**KHR_mesh_quantization 量化传输**（顶点负载 -60%）|
| 三维查看器 | three.js 渲染（glTF 2.0），拾取查属性（Psets）、空间树楼层显隐、六向截面剖切、两点测量、隔离/适应视图、透明构件 |
| 数据 API | REST + 自动生成 OpenAPI 3.1（`/api/v1/docs`），构件分页/类型/楼层/关键字检索，空间树、元数据、原始 IFC 下载（鉴权流式） |
| 协同 | 项目/模型两级结构，成员 RBAC（OWNER/ADMIN/EDITOR/VIEWER），Issue（相机视角+画布快照+讨论）+ **BCF 2.1 导出/导入闭环**（viewpoint.bcfv/snapshot.png/GUID 去重）+ 审计日志 |
| 工程 | JWT 双令牌轮换、bcrypt、结构化日志（pino）、健康检查、Docker Compose 一键部署、CI（lint/typecheck/test/build）、Apache-2.0 |
| 标准 | IFC GUID 22 字符编解码、空间结构解析（IfcRelAggregates/IfcRelContainedInSpatialStructure）、Pset/属性抽取、单位归一化（几何统一为米 + Y-up）、BCF 2.1 |

## 快速开始（开发）

依赖：Node 20+ 与 pnpm 10。

```bash
pnpm install
pnpm -r build                    # 编译共享包与后端
cd apps/api && pnpm exec prisma db push   # 初始化 SQLite（默认 file:./data/app.db）
pnpm dev                         # 并行启动 api(3001) 与 web(3000)
```

打开 <http://localhost:3000>，注册首个用户（自动成为平台管理员），新建项目 → 新建模型 → 上传 `samples/sample-building.ifc` → 「三维查看」。

- API 文档：<http://localhost:3001/api/v1/docs>
- 健康检查：<http://localhost:3001/healthz>

## 快速开始（Docker）

```bash
docker compose up --build
# web: http://localhost:3000   api: http://localhost:3001
```

`docker-compose.yml` 包含 `web`（Nginx 托管静态文件并反代 API）、`api`、`postgres`。首次启动自动建表；数据落 `pgdata` 与 `blobs` 卷。生产部署（S3、Postgres、HTTPS、JWT_SECRET 等）见 [docs/deployment.md](docs/deployment.md)。

## 仓库结构

```
├─ apps/
│  ├─ api/        Fastify 5 + Prisma 6（SQLite/PostgreSQL）+ 转换 worker 池
│  └─ web/        React 19 + Vite + Ant Design 6 + three.js（命令式查看器）
├─ packages/
│  ├─ ifc/        web-ifc 0.0.77 封装：IFC → GLB + meta.json 转换管线（纯库，独立测试）
│  └─ bcf/        BCF 2.1 zip/xml 写出器（纯库，独立测试）
├─ docs/
│  ├─ research/   三份调研报告：开源生态 / buildingSMART 标准 / 技术选型
│  ├─ architecture.md   架构与 API 规范
│  └─ deployment.md     生产部署指南
├─ samples/       样例 IFC（scripts/generate-sample-ifc.js 生成）与官方测试文件
├─ docker/        Dockerfile 与 compose
└─ .github/workflows/ci.yml
```

## 测试

```bash
pnpm test              # 全仓：59 个 vitest 用例
pnpm typecheck         # 全仓 TypeScript 门禁
pnpm lint              # eslint
pnpm test:mutation     # StrykerJS 变异测试（纯逻辑包，见下）
```

- `packages/ifc`：GUID 编解码、GLB 量化 JSON 精确契约、builders 增长边界、样例 IFC 全管线（空间树/Pset/单位/Y-up 断言）
- `packages/bcf`：BCF XML 模板逐字节规格断言、reader 互操作健壮性（大写条目/非法坐标/GUID 回退）、导出导入回环
- `apps/api`：fastify.inject 集成测试 —— 注册→项目→上传→转换→元素/空间树/GLB→Issue 视点快照/BCF 导入导出→RBAC→分片上传→审计
- `apps/web`：TypeScript 严格模式 + 生产构建门禁

### 变异测试（Mutation Testing）

纯逻辑包接入 StrykerJS：每个变异体都必须被测试套件消灭，分数低于阈值即失败（bcf ≥85 / ifc ≥80）。

| 包 | 变异分数 | 基线 → 现在 |
|---|---|---|
| @openbim-hub/bcf | **87.6%** | 60.5% → 87.6%（补 XML 规格断言 + reader 边界） |
| @openbim-hub/ifc | **84.2%** | 53.4% → 84.2%（补 builders 边界 + GLB 精确契约 + GUID 错误分支） |

```bash
pnpm test:mutation   # 运行两个纯逻辑包的变异测试
```

HTML 报告（幸存变异体逐条可查）：`packages/*/reports/mutation/mutation.html`。剩余幸存变异体均为防御性/等效分支（不可达的对齐填充、缓存性能优化），已在源码以 `// Stryker disable` 注明理由。

## 技术栈与关键取舍

| 项 | 选择 | 原因（详见调研报告 3） |
|---|---|---|
| IFC 解析 | web-ifc 0.0.77（MPL-2.0） | 浏览器/Node 双端 WASM、流式几何提取；服务端转换让首开秒开 |
| 传输格式 | 自研 GLB（mesh-primitive 合并桶：楼层×颜色）+ meta.json sidecar | three.js 不解析 EXT_structural_metadata；sidecar 兼做 DB 导入源与 API 查询源 |
| 后端 | Fastify 5 + Prisma 6 | 内置 JSON Schema 校验/OpenAPI；dev 用 SQLite 零依赖，prod 切 PostgreSQL 仅改 provider |
| 转换隔离 | worker_threads 池 | WASM 内存隔离于 API 进程；可重入任务队列 + 启动恢复 |
| 前端 | React 19 + AntD 6 + three.js 命令式 Viewer | BIM 操作（剖面/隔离/测量）本质是命令式 API，r3f 包装是负资产 |

## 路线图

- [ ] BCF 2.1 导入（含 viewpoint 快照）与 BCF 3.0
- [ ] 模型合并联邦（多专业同场景）与碰撞检测
- [ ] meshopt/Draco 压缩与分块流式加载
- [ ] S3/MinIO BlobStore 实现（接口已抽象）与 PostgreSQL 生产 profile
- [ ] IDS/bSDD 属性校验、IFC4.3 基础设施实体
- [ ] SSE 转换进度推送、测量/截图标注入 Issue

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。行为准则见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，安全漏洞报告见 [SECURITY.md](SECURITY.md)。

## 许可

代码以 **Apache-2.0** 发布（见 [LICENSE](LICENSE)）；第三方依赖许可见 [NOTICE](NOTICE)。

---

<a name="english"></a>

## English summary

OpenBIM Hub is a production-grade, self-hosted, fully open-source (Apache-2.0) BIM collaboration platform: upload IFC models, stream them to a three.js web viewer (server-side web-ifc → glTF conversion in a worker pool), browse element properties via the spatial tree, section/measure, and exchange issues as BCF 2.1. REST API with generated OpenAPI docs, JWT+RBAC, SQLite-for-dev/PostgreSQL-for-prod, one-command Docker Compose. See the docs above for research background and architecture.

```bash
pnpm install && pnpm -r build
cd apps/api && pnpm exec prisma db push
pnpm dev    # web on :3000, api on :3001
```
