# 留档：3D Tiles 1.1 输出 spike（ticket 11）

日期：2026-09-19。产物目录：`spikes/3dtiles/out/`（生成物，不入库）。

## 结论速览

- manifest → tileset.json 生成器（`packages/ifc/src/tiles.ts`）在 3 个样例模型上产出结构合法的 3D Tiles 1.1，OGC 官方校验器 `3d-tiles-validator@0.6.1` 全部 **0 errors / 0 warnings**。
- 每块 GLB 重定位为块局部原点（节点 translation 减块中心），tile transform 用 double 平移 + 根节点 Y-up→Z-up 旋转，float32 内容只覆盖块内范围，无精度损失风险。
- 属性挂接路径验证通过：tile → chunk id（`tiles/<id>.glb` URI）→ `meta.chunks` → buckets → expressID → GUID，与全部几何元素一一对应且互斥（`tiles.test.ts` 用例 5）。
- 收益评估：单级（每块一叶子）树只能提供**剔除**级 LOD，不提供细节分级；正式化收益有限 → 决策报告建议搁置（见 `docs/research/04-3dtiles-spike-decision.md`）。

## 数据（out/spike-report.json）

| 模型 | 源字节 | schema | 元素 | 三角 | 块/瓦片 | 瓦片总字节 | 最大瓦片 | tileset.json | convert | export |
|---|---|---|---|---|---|---|---|---|---|---|
| sample-building | 5,201 | IFC4 | 4 | 48 | 2 | 6,376 | 3,196 | 1,832 | 60ms | 2ms |
| duplex | 2,380,763 | IFC2X3 | 218 | 26,774 | 16 | 1,117,836 | 194,104 | 12,317 | 4,535ms | 14ms |
| landscaping | 1,074,044 | IFC4 | 6 | 4,799 | 2 | 237,824 | 197,004 | 2,116 | 276ms | 2ms |

duplex 16 瓦片字节分布：113596, 194104, 181336, 26228, 26224, 9424, 9424, 5344, 178832, 10044, 14560, 44048, 44344, 44056, 44348, 171924。导出开销相对转换可忽略（≤0.3%）。

## 校验器

工具：`3d-tiles-validator@0.6.1`（npm，`spikes/3dtiles/tools/`）。sharp 通过 `overrides` 固定 0.33.5（0.32 从 GitHub releases 拉 libvips，本网络不可达；0.33 走 npm registry 预编译）。

三份 `out/<model>.validator.txt`：均 `exit=0`、`numErrors: 0, numWarnings: 0, numInfos: 0`。

修复记录：首版用 `{center, halfAxes}` 对象写 boundingVolume.box，校验器报 `TYPE_MISMATCH /root/boundingVolume/box`（该对象形态是 b3dm 内部约定）；3D Tiles 1.1 JSON 要求 12 元素扁平数组，改正后通过。

## 复现

```sh
pnpm --filter @openbim-hub/ifc build
node spikes/3dtiles/run-spike.mjs --validate   # 重跑生成 + OGC 校验
node --test packages/ifc/test/tiles.test.ts     # 单元/导出/属性挂接 5 用例
# 手工观察（见下）：
python -m http.server -d spikes/3dtiles/out 8099
# 打开 http://localhost:8099/viewer.html
```

## 手工观察清单（待人工执行，浏览器自动化被否决）

`out/viewer.html`（Cesium 1.120 CDN，无 ion）已就绪，观察项记录到本文件：

- [ ] 三个模型瓦片加载渲染正确（模型清单下拉切换）
- [ ] 剔除：删除/遮挡部分瓦片（DevTools 请求拦截或改 tileset）后仅缺失块消失
- [ ] 内存预算：`maximumMemoryUsage` 调小后 `memoryStats` 点数/字节回落
- [ ] LOD/误差：`screenSpaceError` 调大后 `renderError` 变化（单级树预期只影响加载优先级）
- [ ] 属性挂接：左键点选构件 → 控制台输出 chunk id 与 GUID 清单，与实际构件一致

CDN 脚本无 SRI —— 仅 spike 本地用途，README 已注明。
