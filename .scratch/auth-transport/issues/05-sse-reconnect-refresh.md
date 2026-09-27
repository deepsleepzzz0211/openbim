# 05: SSE 断线自动续token重建

**What to build:** 长会话中转换进度实时推送不再静默失效。现状：SSE 的 access token 在连接建立时快照进 query（EventSource 不能带 header），服务端只在建立时校验一次；连接断开后 EventSource 重连被 401 拒绝即**永久静默**（非 200 时不重连）。从用户视角：上传大模型后等待转换推送的场景里，token 过期导致的断线会自动带新 token 恢复推送。

**Blocked by:** 02

**Status:** ready-for-agent

- [x] onerror → close → 单飞刷新 → 新 token 重建 EventSource（保留 onUpdate 绑定），压掉 EventSource 自身重连竞争；刷新失败且 token 未变时退避 5s 再试（防 401 死循环）
- [x] 重建走 module 的刷新路径（探测 /auth/me 经 withAuthRetry——实现较原计划的 attemptRefresh 直调更优：网络抖动不耗 refresh token，死会话自动登出；偏离已记录于 07）
- [x] SSE 重建测试（sseReconnect.test.ts：401 → 重建带轮换 token → 收推送；07 补真竞态窗口——probe 挂起中取消；网络抖动不耗 refresh；死会话登出停连）
- [x] web 全部测试绿（47/47）+ lint + typecheck + build
