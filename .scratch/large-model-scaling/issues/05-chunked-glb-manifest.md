# 05: 分块产物 + manifest

**What to build:** 大模型转换产物不再是单个 GLB，而是「按楼层分块（单块构件面数超阈值再按空间二分）+ manifest 清单 + 块↔构件 GUID 双向索引」；用户可通过 API 逐块下载，属性查询按 GUID 批量解析到所在块。

**Blocked by:** 01

**Status:** implemented (2026-09-20), awaiting review

- [x] 转换输出多块 GLB 与 manifest（块 id、楼层、bbox、三角形数、字节数、构件区间索引、URL），单块体量有硬上限
- [x] 空楼层/无空间归属构件（既有脏数据场景）在分块下有明确归属策略与测试
- [x] API：按版本列 manifest、按块取 GLB（鉴权+缓存协商沿用现状）
- [x] 构件区间表（块内 localId↔GUID 映射）支撑属性批量查询端点
- [x] 版本状态机与重转换在分块产物下仍正确（旧单文件版本可继续被前端加载——兼容读路径）
- [x] 集成测试：上传→分块转换→manifest 校验→逐块下载→GUID 属性查询回环

## 实现备注

- **分块路由**（`packages/ifc/src/chunking.ts`）：主键=楼层（IfcBuildingStorey；非楼层空间父级如 IfcBuilding 按父 expressID 归组；无归属→root 块 storeyExpressID=null）。单块三角形超预算沿最长轴中点二分（guillotine），每层最多 32 次分裂，耗尽后标记 `overflowed` 接受超尺寸块——保证硬上限为软终止而非死循环。二分后对保留侧 bbox 做 clip，否则重复同平面切分不收敛（测试抓到过）。
- **产物布局**：`chunks/<id>.glb`（id 为路由分配的整数，允许不连续——空兄弟流不落盘）；分块时不再写 `model.glb`。转换双向自愈：分块清旧 model.glb，单块清旧 chunks 目录。
- **格式判定**：单流（如 slab 脏数据样例）自动退化为 `artifactFormat:"single"`，字节级与 legacy 一致；分块开关由**源文件体积**决定（`CHUNK_THRESHOLD_BYTES` 默认 32MiB ≥ 全部现有样例 → 默认配置零行为变化）。预算 `CHUNK_MAX_TRIANGLES` 默认 50 万。
- **全局桶索引保留**：分块后 localId↔expressID 全局桶索引不变，BCF 高亮/拾取路径无需改动。
- **设计偏差**：块↔构件索引采用「每构件 chunkId 列」（Element.chunkId + (versionId,guid) 索引）而非「块内区间表」——GUID 批量查询端点直接命中，无需区间二分；localId 连续区间优化留给工单07 BVH 拾取时再评估。
- **API**：`GET /versions/:id/manifest`（VIEWER；chunked→chunks[]+相对 url `/api/v1/versions/:id/chunks/:n`，url 由服务端 meta.json 数字 id 拼装；single→兼容 url 指向 glTF）；`GET /versions/:id/chunks/:n`（纯数字校验 + 必须存在于 meta.json chunks，sendBlob 复用 ETag/no-cache 协商）；`POST /versions/:id/elements/lookup`（guids≤500 schema 校验，返回属性+psets+bbox+chunkId）。版本删除级联清理 chunks 目录。
- **meshopt 交互**：chunked 版本无 model.glb → 跳过 brotli sidecar；各块 GLB 仍逐 bufferView 走 meshopt（原有回退保护不变）。
- **测试**：ifc 包 63 绿（含 chunking.test.ts 8 新：散射守恒/深度封顶/无楼层 root/集成切分/字节一致 single/文件布局/slab 脏数据）；api 包 chunked describe 9 新（manifest 预算守恒+相对 url / 逐块 200+glTF 魔数+bytes 相符 / 非法块号 400-404 / 无 model.glb 404 干净 / GUID 回环 chunkId∈manifest / 501 上限 400 / slab 同配置退化 single / reconvert 后仍 chunked / 删除清 chunks 目录）+ 主 describe single 兼容读路径。全套 142 绿 + typecheck/lint 干净。
- **已知中间态**：前端当前只会加载 model.glb，chunked 版本暂不可渲染——由工单06（分块懒加载）闭环；默认阈值下现有样例全部仍为 single，不受影响。
