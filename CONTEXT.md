# CONTEXT.md — OpenBIM Hub 领域词汇

供架构工作（codebase-design / improve-codebase-architecture）使用的领域名词表。新概念在加深 module 时就地补充。

## Version 产物（Version Artifacts）

一次 IFC 转换的全部落盘物：`original.ifc`（源文件）、`model.glb`（量化 GLB，单格式版本）、`chunks/`（预分块 GLB）、`meta.json`（转换清单：spatial 树、elements 元数据、bucket/range、origin/CRS、artifactFormat）、`model.glb.br`（brotli sidecar，仅单格式）。产物一经 READY 不可变；重新转换会整体重建并更新修订号。

## 产物修订号（artifact revision）

产物内容的代次标识，前端用作下载 URL 的缓存指纹（`?v=...`）。当前实现用 `Version.updatedAt`；升级方向见 large-model-scaling 候选 8（BlobStore → 产物 module 自发修订号）。

## Origin 与世界坐标

web-ifc 将几何归一化为米 + Y-up；`origin` 记录归一化平移。**true world = glb 坐标 + origin**。联邦场景中多版本各自带 origin 落位；碰撞检测的 bbox 与查看器使用同一套换算（clash 路由与查看器必须保持一致）。legacy meta 无 origin 时按 [0,0,0] 处理。

## Bucket / Range

meta.json 中几何的组织单元：一个 bucket = 同 storey × 同颜色的一片合并网格（GLB node），`ranges` 是 bucket 内 expressID → 索引区间的映射（拾取与按构件显隐的依据）。前端 key 约定 `versionId:storeyExpressID`。

## auth-transport（apps/web/src/api/authTransport.ts）

前端 token 状态与 401 刷新协议的唯一 owner。所有网络 transport（JSON request / 小文件 XHR 上传 / 分片 XHR / 二进制下载 / BCF 导入 / SSE）通过 `withAuthRetry(op)` 消费协议，不得自行实现。

**不变量（不要在 transport 层重写）：**

- **op 契约**：op 要么返回 `{auth: "failed", message?}`（唯一被 module 介入的结果；message 带上后端错误信息供 ApiError 透传），要么返回 `{auth: "ok", status, value}`（已解析的成功结果）；其余失败模式在 op 内 throw（网络错误不重试，直接传播）。
- **单飞刷新**：后端 refresh token 单次有效，重放已用的 token 会吊销整个会话——并发 401 必须共享同一个 in-flight refresh。
- **只重试一次**：刷新成功后重跑 op；再 failed 直接失败，不再刷新。
- **失败即登出**：刷新失败 → 清 token + 触发 `onUnauthorized`（登出 UI）。
- **SSE 重连也走协议**：断线后先探测 `GET /auth/me`（经由 withAuthRetry）再重建——token 过期在这里被刷新（单飞），网络抖动不消耗 refresh token（探测成功即原 token 重建），死会话由 withAuthRetry 登出并停止重连循环。
