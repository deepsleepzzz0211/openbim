# 07: Code review 修复（Standards/Spec 两轴发现项）

**What to build:** 两轴 code review（Standards + Spec）对 auth-transport 重构的发现项全部落地：SSE 重连路径对齐 module 不变量、op 契约升级为判别联合、错误消息透传、测试补真竞态窗口与精确断言。

**Blocked by:** 06

**Status:** ready-for-agent

- [x] **op 契约判别联合**：`{auth:"failed", message?} | {auth:"ok", status, value}`——消除 5 处 `undefined as unknown as T` 占位 cast（review: Duplicated Code / 撒谎类型转换），401 时后端错误消息经 module 透传到 ApiError（review: 401 消息被抹掉）
- [x] **SSE 重连重设计（两轴最严重项）**：断线后先探测 `/auth/me`（经由 withAuthRetry）再重建——token 过期在此刷新（单飞一次）、网络抖动不消耗 refresh token（探测成功即原 token 重建）、死会话由 withAuthRetry 登出并停止重连（对齐「失败即登出」不变量，消除 CONTEXT.md 与代码矛盾）；退避具名 `RECONNECT_BACKOFF_MS`，测试可注入 `backoffMs`
- [x] **真竞态窗口测试**：probe 请求挂起期间 unsubscribe → 断言挂起重build被取消（review: 原"竞态"测试在重建完成后才取消，空转）
- [x] **分片断言精确化**：4 parts + 恰 1 次 stale 尝试（review: `>= 2` 过弱）
- [x] rawRequest 的重复 `getAccessToken()` 调用收敛（微末项）
- [x] web 全部测试绿（49/49）+ lint + typecheck + build
- [ ] 由 code-review 复核确认

**采纳说明（判断题记录）**：downloadBinary 重试后失败现在抛重试响应自身的状态码（如 403）而非原始 401——旧行为是丢失真实错误码的副作用，新行为更诚实，Spec 轴点名的此"漂移"被有意保留。
