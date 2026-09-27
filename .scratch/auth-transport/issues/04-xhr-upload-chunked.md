# 04: XHR 系迁移 — uploadVersion 小文件 + 分片上传

**What to build:** 大文件上传全链路获得 401 自动续传：小文件 XHR 直传与 16MB 分片 PUT（authedXhr）都迁入 module。用户可见修复：**48MB+ 模型分片上传中途 token 过期不再失败**（分片覆盖写幂等已确认，重放安全；401 时后端业务未执行，重放安全）。

**Blocked by:** 02

**Status:** ready-for-agent

- [x] uploadVersion 小文件 XHR 迁入 withAuthRetry（op 重放 = 重传整文件，onprogress 仍工作；02 期间完成）
- [x] authedXhr 分片 PUT 迁入 withAuthRetry（签名改为返回 text、非 2xx 自抛带 failLabel；create/complete 走 api.post 已由 02 覆盖）
- [x] uploadRefresh.test.ts 缩为 2 条冒烟（小文件 + 分片 401 续传），协议语义断言已上收至 authTransport.test.ts
- [x] web 全部测试绿（45/45）+ lint + typecheck + build
