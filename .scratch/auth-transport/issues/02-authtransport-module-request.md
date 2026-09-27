# 02: authTransport module 骨架 + request() 迁移

**What to build:** 前端所有网络请求对"access token 过期"获得统一应对：新 module 持有 token 状态与单飞刷新，暴露 `withAuthRetry<T>(op)`；JSON 请求路径（request）作为第一个 adapter 迁入。从用户视角：任何 JSON API 调用在 token 过期时自动续传一次，行为与之前完全一致（不变量原样保持：单飞并发共享一个 in-flight refresh、只重试一次、网络错误不重试、刷新失败清 token 并触发登出通知）。

**Blocked by:** 01

**Status:** ready-for-agent

核心 interface 形状（grilling 共识，可直接采用）：

```ts
// op：一次可重放的认证请求。要么 throw ApiError（业务错误，module 不拦），
// 要么返回 {status, value}；status===401 是唯一被 module 介入的信号。
export function withAuthRetry<T>(op: () => Promise<{ status: number; value: T }>): Promise<T>;
```

- [x] 新 module 文件持有 token 状态、单飞刷新、withAuthRetry；client.ts re-export 公共 API（setTokens / setUnauthorizedHandler / getAccessToken），页面与 store 调用方零改动
- [x] request() 迁入：401 判定权上收 module，op 内完成 JSON 解析；request 内旧协议代码就地删除（注：uploadVersion 小文件 XHR 因机械替换会丢失"刷新失败清 token+通知"语义，一并提前完整迁入；authedXhr 分片仍留工单 04）
- [x] authRefresh.test.ts 退役，迁移为 authTransport.test.ts（3 个 module interface 用例 + request/downloadBinary 冒烟）；uploadRefresh.test.ts 的 XHR mock 保留为 transport 冒烟（后续 07 缩编）
- [x] web 全部测试绿 + build + lint（中间计数 46，最终 49 见 07）
