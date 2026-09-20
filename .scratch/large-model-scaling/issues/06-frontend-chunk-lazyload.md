# 06: 前端分块懒加载 + 字节预算

**What to build:** 用户打开分块大模型时首屏只加载视口/所选楼层所需块，切层即换块，常驻数据受字节预算约束；关掉的楼层可被卸载回收。大模型页签内存曲线稳定可控。

**Blocked by:** 05

**Status:** implemented (2026-09-20), awaiting review

- [x] Viewer 按 manifest 驱动加载：楼层显隐映射到块加载/卸载，LRU 字节预算（桌面默认预算可配）
- [x] 属性面板点击构件经 GUID 批量 API 取值（不依赖全量 meta 常驻）
- [x] GPU 资源生命周期：卸载块时几何与附属结构显式释放；上下文丢失有恢复路径
- [x] 旧单文件版本仍走原加载路径（兼容）
- [ ] 留档：最大样例分块加载首屏时间、常驻三角形数与内存曲线（DevTools 记录）（人工）
- [x] 前端保持 TypeScript 严格模式与生产构建门禁

## 实现备注

- **纯决策层** `apps/web/src/viewer/chunkPlanning.ts`：`planEvictions`（仅淘汰隐藏块、LRU、可见几何永不淘汰——预算是天花板不是恐慌开关）；待下载侧（可见∧未加载→下载候选，保序）内联在 Viewer 的 `setVisibleStoreyKeys` 路径中；默认预算 `DEFAULT_MAX_RESIDENT_BYTES=512MiB`，`new BimViewer(canvas, { maxResidentBytes })` 可配。apps/web 新增 vitest（8 个单测覆盖计划逻辑，含 ticket 08 的 `planLodLoads`）。
- **Viewer**：`loadFederation(FederationModel[])` 统一单块/分块源（单块立即 parse 并保留 buffer；分块仅建组注册 manifest 块）；`setVisibleStoreyKeys(keys)` 一个入口驱动显隐+懒加载（并发≤3）+预算淘汰（淘汰即 `geometry/material.dispose()` 并从拾取数组摘除）；`webglcontextrestored` 时用保留的模型源整体重建再按当前可见键重下重解析；块下载失败经 `onWarning` 冒泡到 UI。storeyKey=`versionId:storeyExpressID`（无归属块=`:null`，初始与「显示全部楼层」一并可见，与旧语义一致）。
- **Page**：manifest 优先；single→原 buffer 路径不变（兼容读路径，E2E 实测 `artifactFormat:"single"`+glTF url）；chunked→解析 meta.json 后**丢弃 elements 表**（楼层构件数改由 buckets ranges 推导，头部计数用 manifest.stats）；属性面板 onSelect 改走 `POST /elements/lookup`（服务端为此端点补了 `expressIDs` 入参，与 guids 二选一或并用，≤500）。联邦加/减成员仍全量重建，块按可见键重放。
- **验证**：web 8 / api 28+9 / ifc 63 / bcf 42 全绿；`tsc --noEmit` 严格模式 + vite build 门禁通过；live E2E 后端冒烟：manifest(single)+lookup(expressIDs→属性+bbox, chunkId:null) 正常。
- **人工留档方法**（最大样例内存曲线）：以 `CHUNK_THRESHOLD_BYTES=1 CHUNK_MAX_TRIANGLES=20` 重启 API（现为 :3001 后台任务，数据在 tmp-e2e/），重新上传 sample-building → 版本即分块；DevTools Memory 面板记录 加载→切层（取消勾选→再勾选）→ 淘汰 过程的 `renderer.info.memory` 与堆曲线。当前默认阈值 32MiB 下 E2E 现有版本保持 single，不影响工单03/04 截图。
