# 部署指南 / Deployment

## 拓扑

```
浏览器 ──▶ web (Nginx: 静态文件 + /api 反代) ──▶ api (Fastify, worker 池) ──▶ BlobStore + 数据库
```

最小拓扑（`docker-compose.yml` 默认）= web + api + SQLite（卷持久化）。适合 ≤50 人团队单机自托管。

## Docker Compose（默认）

```bash
JWT_SECRET=$(openssl rand -base64 48) docker compose up --build -d
```

- web: `http://localhost:3000`（Nginx 反代 `/api` 与 `/healthz`）
- api: `http://localhost:3001`（也可直连）
- 数据持久化在命名卷 `hubdata`（SQLite + blobs）
- 上传大小限制：Nginx `client_max_body_size 512m` 与 API `MAX_UPLOAD_MB` 保持一致

升级：`git pull && docker compose up --build -d`。API 启动时自动 `prisma db push` 增量建表并恢复中断的转换任务。

## 切换 PostgreSQL（多副本/大规模）

1. 修改 `apps/api/prisma/schema.prisma`：

   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```

2. `pnpm --filter @openbim-hub/api exec prisma generate` 并重建镜像（client 随镜像生成）。
3. compose 中为 api 设置：

   ```yaml
   environment:
     DATABASE_URL: postgresql://openbim:pass@postgres:5432/openbimhub
   ```

   并增加 `postgres:16` 服务（参考 [docker-compose.yml](../docker-compose.yml) 注释）。

> 说明：Element/Version 查询大量使用 `contains`/范围过滤，PostgreSQL 下可进一步加 pg_trgm 索引；schema 仅使用可移植类型。

## 对象存储（S3/MinIO）

`BlobStore` 接口（`apps/api/src/blobStore.ts`）已抽象 `put/putStream/writeStream/get/getStream/delete/pathFor`。
默认实现 `LocalDiskBlobStore`。接入 S3 的步骤：

1. 新增 `S3BlobStore implements BlobStore`（推荐 @aws-sdk/client-s3 的 Upload/GetObject 流式 API）。
2. `pathFor` 仅被转换 worker 用于本机文件读写；S3 模式下将 `ConversionJobInput` 改为传递临时文件路径：提交任务前把原文件下载到 worker 本地临时目录，转换产物再回传 S3。
3. 在 `server.ts` 按 `BLOB_STORE=s3` 环境变量选择实现。

## 环境变量

见 [.env.example](../.env.example)。生产必须：

- `JWT_SECRET` 强随机（默认值会打印告警）
- 反向代理终止 HTTPS；收紧 CORS（`apps/api/src/app.ts` 中 `origin: true` → 具体域名）
- `CONVERSION_MODE=worker`（默认）；`CONCURRENCY` 按 CPU 调整（每 worker 峰值内存可达数百 MB，大模型场景给 2–4GB/worker）

## 运维

- 健康检查：`GET /healthz`（含 DB 连通性），compose 加 healthcheck 即可
- 日志：pino JSON（stdout），`requestId` 贯穿请求；转换失败会输出 `versionId` 与 `errorCode`
- 备份：SQLite 单文件（`DATA_DIR/openbim-hub/app.db`）+ `DATA_DIR/blobs/` 目录；PostgreSQL 用 `pg_dump`
- 版本产物不可变：直接删除 Version 行不会清理 blob，清理脚本按 `projects/**/models/**/vN` 前缀对账（TODO 贡献点）

## 端到端冒烟

```bash
curl -s localhost:3001/healthz
# 注册 → 建项目 → 建模型 → 上传 samples/sample-building.ifc → 轮询版本 READY → GET /file/glTF
# UI: http://localhost:3000 登录后进入查看器
```
