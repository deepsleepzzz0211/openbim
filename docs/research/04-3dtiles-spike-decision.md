# 3D Tiles 1.1 输出 spike 决策报告

> 日期：2026-09。对应工单 `.scratch/large-model-scaling/issues/11-3dtiles-spike.md`。
> 代码与数据：生成器 `packages/ifc/src/tiles.ts`、测试 `packages/ifc/test/tiles.test.ts`、spike 工具链 `spikes/3dtiles/`、留档 `.scratch/large-model-scaling/evidence/3dtiles-spike.md`。

---

## 1. 问题与结论

**问题**：ticket 05 的分块产物（`chunks/<id>.glb` + `meta.json` manifest）能否低成本导出为 OGC 3D Tiles 1.1，让第三方标准渲染器（Cesium 等）直接流式加载大规模模型？值得正式化吗？

**结论：搁置（不正式化），保留 spike 代码作为参考实现。**

理由概述：spike 证明技术通路完全可行（OGC 官方校验器 0 错误 0 警告），但收益不成立——单级瓦片树只提供剔除级 LOD，不提供细节分级；而属性挂接、 element 级选择、增量加载等核心需求已由自有 manifest + chunked GLB 链路满足。3D Tiles 的真实价值在「跨组织互操作交付」，当前产品阶段（MVP、单体交付）不存在这个需求。若未来出现，正式化路径已在 §5 记录，代价约 1–2 人日。

## 2. spike 做了什么

1. **manifest → tileset.json 生成器**（纯函数 + 磁盘导出器）：
   - 每个 chunk 一个叶子瓦片；根节点 transform 承载 Y-up→Z-up 旋转与模型原点平移，子瓦片 transform 为块包围盒中心的纯平移（double 精度）。
   - 导出时重写每块 GLB 的节点 translation（减去块中心），使 float32 顶点只覆盖块内范围 → 块局部原点消除了大坐标模型的精度损失。
   - `boundingVolume.box` 采用 1.1 规范的 12 元素扁平数组（首版误用 b3dm 的 `{center, halfAxes}` 对象形态，被校验器 `TYPE_MISMATCH` 拒绝后修正）。
   - geometricError 策略：单级树，根 = 并集对角线（可配），叶 = 0；REPLACE 精化。
2. **标准渲染器验证页**：Cesium 1.120（CDN、无 ion），支持内存预算/screenSpaceError 调节、stats 导出、点选构件反查 GUID。
3. **官方校验**：`3d-tiles-validator@0.6.1`（OGC 参考实现）对 3 个样例全部通过。
4. **属性挂接验证**：tile → chunk id（content URI）→ `meta.chunks` → buckets → expressID → GUID，与全部几何元素互斥且全覆盖，与既有 `/attributes?guid=` API 完全兼容（无需新 API）。

## 3. 证据

| 模型 | 源 | schema | 元素/三角 | 瓦片 | 瓦片总字节 | tileset.json | convert/export | 校验 |
|---|---|---|---|---|---|---|---|---|
| sample-building | 5.2 KB | IFC4 | 4 / 48 | 2 | 6.4 KB | 1.8 KB | 60ms / 2ms | 0 err 0 warn |
| duplex | 2.4 MB | IFC2X3 | 218 / 26,774 | 16 | 1.12 MB | 12.3 KB | 4,535ms / 14ms | 0 err 0 warn |
| landscaping | 1.1 MB | IFC4 | 6 / 4,799 | 2 | 238 KB | 2.1 KB | 276ms / 2ms | 0 err 0 warn |

- 导出开销 ≤ 转换时间的 0.3%，元数据膨胀（tileset.json）约 1%，均可忽略。
- 主链路零改动：`tiles.ts` 是独立新增导出，`convertIfc`/API/前端行为不变；全仓回归保持绿。

## 4. 为什么搁置

1. **LOD 收益不成立**。3D Tiles 的核心卖点是层次细节（一个父瓦片多个精化层级）。我们的块是**空间分区**而非**精化层级**，导出的树只有两级（根+叶），渲染器能做的只有视锥剔除与距离加载——这两件事自有 manifest 的 `bbox`/`chunkId` 字段在 three.js 侧同样能做到，且已在 web 查看器实现。
2. **属性语义反而是减法**。IFC 的价值在 element 级语义；3D Tiles 的 tile 粒度（本 spike 中最小 5 KB、最大 194 KB）粗于 element。第三方渲染器拿到 tileset 后丢失 element 选择能力，除非再引入 metadata 3D Tiles 扩展（`EXT_mesh_features`/tile metadata），那是另一个数量级的工作量。
3. **需求侧缺位**。正式化的唯一硬理由是「把模型交付给使用标准 Tiles 消费端的第三方组织」。当前产品是自有 Web 查看器 + 自有 API，没有外部 Tiles 消费者。
4. **维护成本非零**。正式化意味着 tileset schema 演进（geometricError 策略、content transforms、后续可能的 1.2）进入回归面，以及 API 增加一个导出格式分支。

## 5. 若未来正式化（参考路径）

spike 代码已覆盖难点，正式化预计 1–2 人日：

1. `apps/api` 增加导出格式开关（如 `?format=3dtiles` 或 conversion 选项），落盘 `<base>/3dtiles/`（tileset.json + tiles/），复用 `exportTilesetFromArtifact`。
2. 静态路由：相对路径由服务端 chunk id 生成（spike 已含 URI 逃逸守卫：`path.normalize` + 拒绝绝对路径/`..`），不引入用户可控 URL。
3. 真 LOD 需要转换期多精度网格（DecimationModifier 或 meshopt simplify 生成 2–3 级），这是主要增量成本，spike 未做也刻意不做。
4. 若需保留 element 语义：`EXT_structural_metadata` 挂 GUID/expressID per-primitive（需 web-ifc 逐三角形归属，属工单外新调研）。
5. CI 接入 `3d-tiles-validator`（本机 sharp 需 `overrides: 0.33.5` 绕开 GitHub 不可达）。

## 6. 遗留手工项

`out/viewer.html` 的观察清单（剔除/内存预算/点选反查 GUID）留待人工在浏览器执行，见留档文件 §手工观察清单；Cesium CDN 脚本无 SRI，仅限本地 spike 用途。
