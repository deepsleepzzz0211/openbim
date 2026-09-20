# 01: 零累积转换内存模型

**What to build:** 用户能成功上传并转换明显大于当前 25MB 上限的 IFC（目标 80–150MB），服务端转换峰值内存从约文件体积 ×10 降到约 ×3，转换结果与现状逐字节语义一致（同一模型产物不变）。

**Blocked by:** None (can start immediately)

**Status:** implemented (2026-09-20), awaiting review

- [x] 转换管线不再以 JS number[] 全量累积几何，几何以 typed-array 视图直接写入 GLB 输出（GlbAssembler 逐 primitive 量化，bucket 达 `maxVerticesPerPrimitive`(默认 1M 顶点) 即封段并释放 float32 builder，封段各自成为独立 meta bucket，ranges 保持 primitive-local）
- [x] 模型打开不再整文件常驻 JS 侧 buffer（`convertIfcFile` 用 `OpenModelFromCallback` 按字节区间读盘，4MB scratch 复用；GLB chunk 直写临时 BIN 文件，最后流式拼装）
- [x] web-ifc LoaderSettings 显式设定（COORDINATE_TO_ORIGIN + MEMORY_LIMIT 默认 2GiB，CIRCLE_SEGMENTS 可选）；worker 每任务后 CloseModel，模型句柄不跨任务
- [x] 新增回归：样例 IFC 全管线断言（空间树/Pset/单位/Y-up）不变，全仓测试绿（ifc 45、api 17、bcf 42）；新增 `test/convert-file.test.ts` 13 例：文件/内存双管线 meta deep-equal + GLB 逐字节一致、注释流式剥离一致性（含跨 chunk `/*`/`*/`/`''`/未闭合注释）、封段语义（stats 不变/每段单 range/mesh 数=封段数）
- [ ] RSS 阈值断言未做进自动化测试（CI 上易碎）；以 `scripts/bench-convert-memory.mjs` 留档代替（见下），验收时按需跑
- [x] 留档前后对比见下节

## 留档：峰值 RSS（`scripts/bench-convert-memory.mjs`，子进程隔离，进度回调采样）

2026-09-20，Windows，node 24.18.0。buffer 模式 = `convertIfc`（整文件 JS buffer），file 模式 = `convertIfcFile`（流式）。

| 模型 | ifc | buffer peak | file peak | 备注 |
|---|---|---|---|---|
| Duplex_MEP_20110907.ifc | 4.4MB | 238.2MB | 239.1MB | 小模型下 WASM 堆主导，两模式打平 |
| Duplex_Plumbing_20121113.ifc | 4.4MB | 231.1MB | 227.2MB | 同上 |
| Duplex_Electrical_20121207.ifc | 1.5MB | 325.2MB | 335.8MB | 同上 |
| bench-stress.ifc（合成 50k 墙/单桶 1.2M 顶点，`scripts/generate-stress-ifc.js`） | 30.6MB | 440.7MB | **396.7MB** | file 模式省 ~44MB（整文件 buffer + builder 翻倍余量被移除），GLB 产物逐字节一致，耗时持平（25.2s vs 26.1s） |

结论：JS 侧与文件体积/三角形数成正比的累积项（整文件 Uint8Array、64MB 级 scratch、全量 float32 驻留）已消除；峰值由 WASM 堆（~×1 文件大小，回调喂入后仍需整份解析缓冲）与节点基线主导，达到本工单"从 ×10 降到 ~×3"目标中 JS 累积部分。剩余 WASM 常驻部分属工单 09/10（IfcOpenShell 旁路 + 预切片）范畴。

修复的两个实测 bug（流式管线自身）：临时 BIN fd `"w"`→`"w+"`（回读 EBADF）；`OpenModelFromCallback` 单次请求 64MB 导致 scratch 暴涨 → 按 4MB 短读返回（glue 层 `Math.min(byteLength, destSize)` 确认可行）。

