# meshopt 压缩体积对比报告（工单04）

生成时间：2026-09-19T17:49:32.985Z · meshoptimizer 1.1.1 (encoder) / three r185 内置 decoder 1.1 · Brotli quality 9

| 模型 | 三角形 | 量化 GLB (KiB) | +meshopt (KiB) | meshopt 增益 | +HTTP Brotli (KiB) | 相对量化GLB总增益 |
|---|---|---|---|---|---|---|
| sample-building | 48 | 5.9 | 6.4 | −-7.0% | 1.0 (量化+br: 0.9) | −82.6% |
| complex/Building-Architecture | 1127 | 60.6 | 31.2 | −48.5% | 13.1 (量化+br: 11.2) | −78.3% |
| complex/Building-Hvac | 1061 | 54.7 | 25.7 | −53.1% | 11.9 (量化+br: 10.6) | −78.2% |
| complex/Building-Landscaping | 4799 | 231.9 | 120.6 | −48.0% | 73.6 (量化+br: 44.7) | −68.3% |

说明：meshopt 为 bufferView 级有损无关压缩（作用于量化后的 int16/int8/uint32 字节）；小模型 JSON 元数据占比高，meshopt 增益可能为负，Brotli 层可完全吸收该开销。
