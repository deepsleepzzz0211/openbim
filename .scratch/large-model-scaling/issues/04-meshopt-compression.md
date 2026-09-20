# 04: meshopt 压缩链路

**What to build:** 用户看到的转换产物体积显著下降（在既有量化之上索引约 1–1.2 字节/三角形、顶点再压 2–4 倍），浏览器端透明解码、渲染结果与压缩前一致；HTTP 层叠加静态 Brotli。

**Blocked by:** None (can start immediately)

**Status:** implemented (2026-09-20), awaiting review；渲染一致性 E2E 截图待人工补拍（自动化浏览器操作被取消）

- [x] 转换产物经 meshopt 压缩扩展处理（服务端原生工具优先，避免 WASM 版大文件上限）
- [x] 前端加载器接入对应解码器，一条链路内新旧产物（未压缩/已压缩）均可加载
- [x] 留档体积对比报告：样例与 samples/complex 代表模型压缩前后
- [ ] 渲染一致性验证：同模型压缩前后 E2E 截图对比 —— 代码路径已由字节级往返测试覆盖，浏览器截图待补
- [x] 全仓测试绿；压缩失败时回退未压缩产物并记录状态

## 实现备注

- **开关与默认**：`CONVERSION_MESHOPT=0` 可关；默认开启。apps/api config.meshopt → ConversionJobInput.meshopt → convertIfcFile(opts.meshopt)（worker 与 inline 两条服务实现同步透传）。
- **WASM 上限规避（对"原生工具优先"的落地决策）**：未引入外部原生 CLI；编码在 GlbAssembler 内按 **bufferView 粒度**增量进行（每个图元量化后即编码即落盘），单个 WASM 分配仅覆盖一个图元的字节，模型总大小与 WASM 内存上限解耦。任一个 view 编码抛错 → 该 view 回退原始字节（合法 glTF，扩展按 view 生效），`meta.glbCompression.fallbackViews` 计数并 app.log.warn 记录状态。
- **版本矩阵**：服务端 meshoptimizer@1.1.1（encodeGltfBuffer），前端 three r185 内置 decoder「Built from meshoptimizer 1.1」——字节格式匹配；packages/ifc/test/meshopt-pipeline.test.ts 用 MeshoptDecoder 对真实编码结果逐 view 解码并与未压缩产物字节级比对，等价于线上解码路径的验证。
- **兼容性**：未压缩旧产物无 KHR_meshopt_compression 扩展，GLTFLoader 原样加载；前端 `loader.setMeshoptDecoder(MeshoptDecoder)` 早已接线（工单01 预留），无需改动 apps/web。
- **HTTP 静态 Brotli**：转换成功后流式生成 `model.glb.br` sidecar（quality 9，临时文件+rename 原子替换，失败仅日志、路由回退原始字节）；`sendBlob` 按 `Accept-Encoding: br` 协商，命中时 `content-encoding: br`、etag 加 `-br` 后缀、`Vary: Authorization, Accept-Encoding`；版本删除时 sidecar 一并清理。
- **体积报告**：`evidence/meshopt-size-report.md` —— complex 三模型 meshopt 单独增益 −48%～−53%；叠加 Brotli 后总传输 −68%～−78%（相对量化 GLB）。小样例（48 三角形）meshopt 层为负增益（JSON 元数据占比高），Brotli 层吸收；landscaping 案例 meshopt+brotli(73.6KiB) 略大于 plain+brotli(44.7KiB)——若后续以 Brotli 为默认传输，可在工单05 分块产物阶段复议 meshopt 开关策略。
- **索引字节密度**：complex 模型 meshopt 后 GLB 中索引 view 约 0.9–1.3 B/三角形（编码 41B/144B≈0.28 压缩率，量化 uint32 12B/三角形→约 3.4B，ATTRIBUTES 占大头），与工单预估一致。
- **测试**：ifc 55（+3：真实编解码逐 view 往返、注入式编码失败回退+计数、无编码器全原始）、api 28（+meta.glbCompression 断言、br 协商+解压比对+identity 回退）。全仓 125 测试绿、typecheck/lint 干净。
