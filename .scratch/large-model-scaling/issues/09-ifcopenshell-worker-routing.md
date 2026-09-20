# 09: IfcOpenShell 转换容器 + 引擎路由

**What to build:** 平台能吃下 500MB 级 IFC：超过 wasm 引擎安全阈值的任务由独立的 IfcOpenShell 转换容器完成（多线程三角化、每文件一进程、不烘焙世界坐标），产物与现有 GLB/manifest 契约一致；用户在 Web 上无感知地用大模型走完上传→转换→查看。同时建立双引擎一致性回归集，保证同一模型不会被两种引擎转出不同形状。

**Blocked by:** 05

**Status:** implemented (2026-09-20), awaiting review；E2E/compose 两项留待人工验证（本环境无 docker、ifcopenshell 无法本地 pip 安装、浏览器自动化已被取消）

- [x] 新增转换 worker 容器（独立进程/容器隔离满足 LGPL 边界），镜像进 docker 部署线，资源限额有文档默认值（docker/ifcopenshell-worker：worker.py HTTP 任务协议 + 每文件一子进程；compose 新增 ifc-worker 服务，mem_limit 6g / cpus 4 默认值与依据写入 docs/conversion-engines.md）
- [x] 任务分派按源文件大小/构件数路由到 wasm 或原生引擎；状态机、进度上报、重启恢复沿用（routeEngine 默认阈值 NATIVE_THRESHOLD_BYTES=256MiB；processVersion 走原有 PENDING→PROCESSING→READY 状态机、进度节流与 server.ts 重启恢复；Python 侧进度经轮询回传 onProgress）
- [x] 双引擎一致性回归集：samples/complex 全量模型逐一对拉三角数/bbox/面积，偏差阈值进 CI（可手动触发档起步）（scripts/engine-parity.mjs 逐模型 dequantize 对拉，阈值 tri 15%/dims 2%/面积 10%；.github/workflows/engine-parity.yml 手动触发；本地已验证 wasm 侧与 python 纯标准库管线 16/16 unittest，IfcOpenShell 适配器等 CI 首跑验证）
- [x] 同一模型禁止混用两引擎的约束落在代码与文档（sticky 路由：同模型新版本沿用最新引擎，原生 worker 不可用直接 FAILED 不回退 wasm；docs/conversion-engines.md「禁止混用」节）
- [ ] E2E：一个 500MB 级真实 IFC 全链路转换成功并在浏览器可交互（人工：需 docker + 真实 500MB 样例）
- [ ] 全仓测试与 compose 起服务验证通过（全仓测试已通过：ifc 63 / api 53 / web 38 / bcf 42，lint+typecheck 全绿；compose 起服务待人工执行）
