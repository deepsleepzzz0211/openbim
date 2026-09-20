# 10: ifcpatch 预切片并行转换（GB 级收尾）

**What to build:** GB 级 IFC 在普通内存预算的容器上可转换：先做文本级按楼层预切片（秒级、近零内存），分片并行入队转换再按 manifest 聚合，单任务内存峰值 <1GB；用户侧仍是一个模型一次上传。

**Blocked by:** 09

**Status:** done（GB 级端到端留档为手工待办）

- [x] 大文件（阈值可配）走预切片→分片转换→聚合管线；失败分片可单独重试而不整模型重来
  - `PRESPLIT_THRESHOLD_BYTES`（默认 512MiB，0=禁用；仅 wasm 引擎生效，与 09 的 native 路由分层）。管线：`packages/ifc/src/presplit.ts` 文本级按结构切片（保留原始实体 id，双向引用闭包保证分片自洽）→ 各分片经普通 `ConversionService.submit` 并行入队 worker 池 → `aggregatePresplitShards` 按 manifest 契约聚合。`apps/api/src/conversion/presplitPipeline.ts` 维护 `<base>/presplit/plan.json`（分片级 PENDING/DONE/SKIP/FAILED），重试/重启只重跑未完成分片（测试断言 DONE 分片不被重新提交）。
- [x] 聚合后 GUID/构件索引、楼层树、空间语义与整体转换一致（一致性回归集）
  - `packages/ifc/test/presplit.test.ts`：构件索引/楼层树/units/schema/triangle 总数逐字段相等；bucket 颜色签名多重集相等（双向吸引子修复样式链泄漏）；世界 bbox 与 origin 帧换算一致（<1e-3）；chunk GLB 节点 extras.bucket 全局重映射；manifest 契约（id 连续、bucket 划分不重不漏、Σ chunk.triangles=stats.triangles、GLB 文件字节=manifest.bytes）；无归属文件单分片与整体转换等价（JSON 归一后 meta 全等、GLB json/bin 全等）。
- [x] 单任务峰值内存有断言测试
  - 子进程（`--expose-gc`）测量强制 GC 后的存活堆（heapUsed+external；RSS 在 Windows 上碎片滞留不可用于断言）：34MB/18 万语句合成多楼层文件，切片+写盘全程存活峰值 <2× 源文件大小。
- [x] 进度上报体现分片粒度；重启恢复覆盖「部分分片完成」
  - 0–8 切片、8–90 分片（按分片字节加权；`shards:{done,total}` 进入 SSE `version` 事件）、90–99 聚合；server.ts 重启把 PROCESSING/PENDING 重新入队 → processVersion 复用磁盘上的 plan，DONE 分片产物直接进聚合（api `test/presplit.test.ts` 覆盖）。
- [ ] 留档 GB 级样例端到端报告
  - 手工待办：本机无 GB 级样例（pip 网络阻断、无 docker），浏览器自动化按用户要求不启用。切片/聚合为流式常数内存路径，34MB 断言已护栏；待有真实大文件时在部署环境跑一次并记录峰值 RSS 与耗时。
