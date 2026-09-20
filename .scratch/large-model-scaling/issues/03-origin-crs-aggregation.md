# 03: origin/crs 落盘与多楼栋聚合

**What to build:** 转换时把「被减掉的世界坐标原点」与坐标系信息写入模型元数据；用户在联邦查看器叠加同项目多个楼栋/专业模型时，各模型按各自 origin 摆回正确相对位置，不再互相穿插。

**Blocked by:** 01（建议排其后：改动同一转换管线，串行避免冲突；语义上无门禁）

**Status:** implemented (2026-09-20), awaiting review；浏览器 E2E 截图留档待补（后端 E2E 已验证）

- [x] 转换产物元数据含 origin（被平移掉的世界坐标）与 crs（来自 IFC 单位上下文与地图坐标系定义，缺失时有明确默认）
- [ ] 前端联邦叠加读取各版本 origin 做二次定位，双模型样例不再穿插（浏览器 E2E 截图留档）——代码与后端验证完成，见备注；浏览器截图待补
- [x] 原始 IFC 坐标超大（超出可安全偏移阈值）时的策略有测试覆盖
- [x] 既有导出（BCF viewpoint 坐标语义）在新原点模型下仍正确

## 实现备注

- **origin 提取（packages/ifc）**：web-ifc 0.0.77 的 COORDINE_TO_ORIGIN 平移是惰性写入的 `_coordinationMatrix = translate(-p0)`（p0 = 首个流出几何体顶点 0 的世界坐标，见 IfcGeometryProcessor.cpp:1716），在 StreamAllMeshes 之后、CloseModel 之前调用 `api.GetCoordinationMatrix(modelID)`，取 `origin = [-m[12], -m[13], -m[14]]`；无几何体时为恒等阵 → origin [0,0,0]。真实世界坐标 = glb 坐标 + origin。
- **crs 提取**：IfcProjectedCRS（Name → parseEpsgCode 解析 "EPSG:25832"/纯数字）+ IfcMapConversion（Eastings/Northings → mapConversion.x0/y0）。无定义时 `source: "ABSENT"` 全 null 默认。
- **落盘**：Version 表新增 `originJson`/`crsJson`（可空，legacy 行按 [0,0,0]/ABSENT 处理），转换完成时从 meta 写入；`/versions/:id/file/meta` 的 meta.json 同步含 origin/crs。
- **碰撞帧修正（apps/api clash）**：`parseOrigin` + `translateBoxes(B, originB − originA)`，AABB 重叠检测在 A 帧内进行；响应 summary 含 originDelta。
- **前端联邦（apps/web）**：Viewer.loadFederation 按 `origin_i − origin_primary` 建 THREE.Group 包裹各模型（不能用 mesh.position，GLB 节点 translation 携带量化中心）；fitAll/highlight 走 matrixWorld 自动正确。覆盖层 Select 分「当前模型 / 项目内其他模型（联邦）」两组；epsg 不一致时显示"坐标系不一致"警示 Tag。
- **BCF 语义**：顶点输出未变，主模型联邦偏移为 0，BCF viewpoint（场景坐标）天然正确；既有 BCF 往返测试通过。
- **测试**：packages/ifc 新增 origin-crs.test.ts 7 项（平移增量精确、超大坐标 5e8/3e9 mm 仍安全、GLB 体积 ±2%、legacy 默认、crs 解析）；api.test.ts 断言 originJson/crsJson 落盘与 meta 一致 + parseOrigin/translateBoxes 单测。ifc 52 / api 28 / bcf 42 全绿，web typecheck 通过。
- **后端 E2E 验证（2026-09-20）**：独立实例（tmp-e2e DB，api:3001 + vite:3000），Building A（原始 fixture）与 B（#14 平移 +30 m/+40 m）均 READY，meta origin 分别为 [-4,0,3] 与 [26,40,3]，差值精确 (30,40,0)。浏览器截图未完成（自动化操作被取消，改人工补留档：登录后进入项目 cmu8o4ep10006u5t8lckw3xru 的 Building A 查看器，叠加 Building B）。
