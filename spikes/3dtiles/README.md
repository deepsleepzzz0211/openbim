# 3D Tiles 1.1 输出 spike（工单 11）

结论性验证，不接入主链路。生成端代码在 `packages/ifc/src/tiles.ts`（纯函数 + 产物导出），
本节只负责跑通、校验与观察。

## 跑生成 + 官方校验

```bash
pnpm --filter @openbim-hub/ifc build          # 先出 dist
node spikes/3dtiles/run-spike.mjs --validate  # 转换 3 个样例 -> 导出 tileset -> 3d-tiles-validator
```

产物在 `out/<model>/{artifact,tileset}`；`out/spike-report.json` 与
`out/*.validator.txt` 是留档数据（validator 为官方 `3d-tiles-validator@0.6.1`，
安装在 `tools/`，其 sharp 依赖被 override 到 0.33.x 以走 npm 预编译二进制——
GitHub release 下载在本网络被阻断）。

## 渲染器观察页（手工）

```bash
python -m http.server -d spikes/3dtiles/out 8099
# 或 npx http-server spikes/3dtiles/out -p 8099
```

打开 http://127.0.0.1:8099/viewer.html 。页面走 CDN 引入 CesiumJS 1.120
（未加 SRI，仅限本机 spike 使用；如需外发请自行 pin/本地化脚本）。可切换
模型、`maximumMemoryUsage`、`screenSpaceError`，实时显示 tileset 统计
（selected/loading/GPU 字节），点击瓦片展示 `tile -> chunkId -> GUID` 的
属性挂接路径（GUID 解析逻辑与 manifest/属性 API 一致）。

观察项（人工填写）：
- [ ] 缩放/平移时 tilesSelected 是否随视锥变化（剔除生效）
- [ ] 调低 memory 预算后是否出现换入换出（不再全量驻留）
- [ ] 远处是否仍全量加载（单层树的 LOD 局限，预期如此）
- [ ] 点击拾取 GUID 与属性 API 返回一致

## 决策报告

见 `.scratch/large-model-scaling/issues/11-3dtiles-spike.md` 备注与
`docs/research/04-3dtiles-spike-decision.md`。
