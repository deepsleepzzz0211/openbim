# 06: Contract 收尾 — 无残留手抄 + CONTEXT.md + 全量门槛

**What to build:** 重构收官验证：前端不再存在任何"transport 自己手抄 401 刷新协议"的残留；auth-transport 作为概念进入项目领域词汇表（CONTEXT.md），未来架构探索不再重提此候选。此时刷新协议恰好一处定义、六个 transport 各一行消费。

**Blocked by:** 02, 03, 04, 05

**Status:** ready-for-agent

- [x] grep 确认 client.ts 内无残留手抄 401 协议（401 判定仅存在于 module；client 中剩余的 `status === 401` 全部是 op 向 module 报告信号的契约用法）
- [x] 创建 CONTEXT.md：记录 auth-transport 概念、withAuthRetry 的 op 契约、"为什么必须单飞"（rotating refresh token 重放会吊销整个会话）不变量；另收录 Version 产物/修订号/Origin/Bucket 等领域词
- [x] 全仓 lint / typecheck / 全部测试绿（229：web 47 + bcf 42 + ifc 81 + api 59）
- [x] 汇报变更统计；不 push（等待用户指示）
