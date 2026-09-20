# 差距分析：当前实现 vs 真正的生产级 BIM 平台

> 2026-09。对照 `docs/research/` 调研结论与真实生产环境（几万-百万构件、多专业、多副本、企业安全合规）逐维度盘点当前 OpenBIM Hub 的差距。每项标注：🔴 阻塞生产使用 / 🟡 影响体验与规模 / 🟢 已达标。

## 1. 规模与性能（最硬的差距）

| 项 | 现状 | 生产要求 | 等级 |
|---|---|---|---|
| 模型规模 | 实测上限 ~25MB IFC（rac-basic，34万三角形，转换 23s） | 500MB–2GB IFC、50万–500万三角形 | 🔴 |
| 转换内存 | 几何以 JS `number[]` 全量驻留内存，峰值约为文件体积 ×10 | 分块/流式转换 + 内存上限保护 | 🔴 |
| 传输体积 | GLB 未压缩（无 meshopt/Draco/量化） | meshopt + 量化，体积降 50–80% | 🔴 |
| 加载方式 | 单文件全量加载，无分块/LOD/渐进 | 按楼层/空间分块流式 + 视锥/楼层懒加载 | 🟡 |
| 上传 | 单请求 multipart，512MB 上限 | 分片上传、断点续传、秒传（sha256 已存但未用于秒传） | 🔴 |
| 数据库 | SQLite（单写者）；Element 无全文索引；meta 单文件全量载入 | PostgreSQL + 索引策略；属性检索走搜索引擎（大项目 Pset 检索） | 🔴 |
| 渲染 | 无 InstancedMesh（门窗实例化被展开复制）、无 BVH 加速拾取 | 实例化 + three-mesh-bvh + GPU picking | 🟡 |
| 转换吞吐 | 单机 worker 池，无水平扩展 | 队列服务（Redis/BullMQ 或 pg-boss）+ 转换容器独立伸缩 | 🟡 |

**结论：当前架构按 ≤100MB / ≤10万构件优化。超过这个规模必须重做转换管线的内存模型与传输管线。**

## 2. IFC 语义完整性

- 🟡 属性仅支持 `IfcPropertySingleValue`；缺 List/Bounded/Table、材料体系（IfcMaterial/MaterialLayerSet）、分类引用（IfcClassificationReference）
- 🟡 逆向关系缺失：门窗→所属墙（IfcRelFillsElement/IfcRelVoidsElement）、开洞布尔
- 🟡 IfcMappedItem 实例化未映射 InstancedMesh（几何展开复制，GLB 膨胀）
- 🔴 几何覆盖未验证：NURBS/曲线扫掠/IfcSectionedSolid（IFC4x3 线性设施）无样例无测试
- 🟢 P0 已达标：空间树、GUID、单位归一化、Pset 单值读取

## 3. 协同能力（与调研定位的差距）

- ✅ **BCF 闭环已实现（2026-09）**：BCF 2.1 导出含 viewpoint.bcfv（相机+选中构件）+ snapshot.png；BCF 导入（GUID 去重）已上线，浏览器端到端验证通过
- 🔴 无模型联邦（多专业合并同场景）与碰撞检测——调研时定位的差异化核心，均未开工
- 🟡 转换进度已实现（worker 进度上报 + 轮询显示）；SSE/WebSocket 实时推送待做
- 🟡 无版本对比（两个版本构件增删改 diff）、无版本标签/发布流（ISO 19650 状态机只做了数据位）
- 🟡 Issue 无附件/截图标注/@通知/邮件

## 4. 企业运维与安全

- 🔴 CORS `origin: true` 全开、无速率限制、无审计日志
- 🔴 无 SSO（OIDC/LDAP/SAML）——企业自托管的第一道门槛
- 🟡 无 S3/MinIO BlobStore 实现（接口已抽象）；本地磁盘=单机架构，无法水平扩展
- 🟡 无指标/追踪/告警（Prometheus/OpenTelemetry）、无备份恢复工具链
- 🟡 镜像未非 root 化、无 SBOM/依赖扫描（Trivy/Dependabot）
- 🟢 基线达标：bcrypt、JWT 轮换+吊销、路径穿越防护、上传白名单、参数化 SQL、健康检查、结构化日志

## 5. 工程质量

- 🔴 前端 0 单测（仅 typecheck 门禁）；Viewer 无视觉回归测试（本可复用端到端截图）
- 🟡 无负载/大文件/故障注入测试；无覆盖率门禁
- 🟡 API 无版本弃用策略；文案硬编码中文（无 i18n 框架）；无 a11y
- 🟢 24 用例全绿、CI lint/typecheck/test/build 矩阵、OpenAPI 自动生成、错误结构统一

## 6. 互操作验证深度（调研的局限）

调研回答了「选什么、怎么做」，生产还需要「在多脏的数据上跑得怎么样」：

- 🔴 未建立与 Bonsai/Revit/ArchiCAD 的双向 round-trip 验证矩阵（当前仅 2 个官方样例 + 1 个手搓样例通过）
- 🔴 无脏数据攻击面测试（超大坐标、循环引用、损坏 STEP——本项目开发中已两次踩到手搓 IFC 的坑）
- 🟡 IDS/bSDD 校验、COBie、4D/5D（调研标注 P1/P2）未开工

## 7. 从当前状态到生产级的建议路线

**第一梯队（不做到位不能上生产）**
1. 转换管线流式化 + meshopt 压缩 + 分块上传/断点续传
2. BCF 导入 + viewpoint/snapshot 闭环
3. PostgreSQL 生产 profile + S3 BlobStore 实现
4. OIDC SSO + 审计日志 + CORS 收紧
5. CI 增加浏览器 E2E 与覆盖率门禁

**第二梯队（规模化）**：模型联邦与碰撞检测、版本 diff、SSE 实时推送、Prometheus 指标、实例化/BVH 渲染优化、备份工具链

**第三梯队（生态深度）**：IDS 校验、IFC 导出、round-trip 互操作矩阵、i18n/a11y、4D/5D 扩展

> 一句话总结：**当前是「生产级工程骨架 + 50 人以下小团队可用」的真实水平；距离「百万构件、多专业、企业安全合规」的生产级，主要差在规模工程化（第 1 节）与协同闭环（第 3 节），而不是代码质量本身。**
