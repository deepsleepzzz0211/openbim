# 11: 3D Tiles 1.1 输出（可选 spike）

**What to build:** 结论性 spike：验证「分块产物导出 OGC 3D Tiles 1.1（tileset.json + 每块 glTF，double 精度 tile transform）」在标准开源渲染器中流式加载的可行性与收益，产出是否投入正式化的决策报告；不改动主链路行为。

**Blocked by:** 06

**Status:** done（Cesium 页人工观察为手工待办）

- [x] 由 manifest 生成 tileset.json（显式树、geometricError 策略、块局部原点入 transform）— `packages/ifc/src/tiles.ts`，3 模型经 OGC `3d-tiles-validator@0.6.1` 校验 0 错误 0 警告（留档 `../evidence/3dtiles-spike.md`）
- [ ] 验证页：标准 3D Tiles 渲染器加载样例模型的 tileset，LOD/剔除/内存预算行为观察留档 — 页面已就绪（`spikes/3dtiles/out/viewer.html`，Cesium 1.120 无 ion），浏览器观察清单留人工（自动化被否决）
- [x] 属性侧方案验证：块内局部 id→GUID 映射与既有属性 API 的挂接路径 — `tiles.test.ts` 用例 5：tile→chunk→buckets→GUID 互斥且全覆盖，与 `/attributes?guid=` 兼容
- [x] 决策报告：继续（正式化为可选导出）/ 搁置（自有 manifest 够用）及理由 — `docs/research/04-3dtiles-spike-decision.md`，结论：搁置，附正式化路径
- [x] 主链路回归不受影响（全仓测试绿）
