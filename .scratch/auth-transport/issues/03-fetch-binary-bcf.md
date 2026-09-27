# 03: fetch 系收尾 — downloadBinary + importBcfZip 迁入

**What to build:** 二进制下载与 BCF zip 导入获得与 JSON 请求相同的 401 自动续传。从用户视角的可见修复：**token 过期后导入 BCF 不再直接失败**（此前该路径没有刷新重试，是 review 确认的缺失副本之一）。

**Blocked by:** 02

**Status:** ready-for-agent

- [x] downloadBinary 迁入 withAuthRetry（op 内 fetch + arrayBuffer，401 判定上收）
- [x] importBcfZip 迁入 withAuthRetry（401 时后端业务未执行，重放安全已确认）
- [x] 迁移覆盖：authTransport.test.ts 的 downloadBinary 冒烟含 401 续传断言（BCF 与 downloadBinary 同构，未单独建用例）
- [x] web 全部测试绿 + lint + typecheck（时点计数 45，最终 49 见 07）
