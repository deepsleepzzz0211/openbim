# 安全策略 / Security Policy

## 报告漏洞

请勿公开提交安全漏洞。发送邮件至仓库所有者（GitHub Security Advisory 优先），包含：
复现步骤、影响评估、可能的修复思路。我们会在 72 小时内确认。

## 当前安全基线

- 密码：bcrypt（cost 10）
- 会话：JWT access（15 分钟）+ refresh（30 天，哈希落库、单次轮换）
- 上传：类型白名单 `.ifc`、大小上限（默认 512MB）、大小流式计量
- 下载：所有产物经鉴权流式返回，无静态暴露；BlobStore key 服务端生成并做路径穿越防护
- 输入：fastify JSON Schema 校验；SQL 一律经 Prisma 参数化

## 部署要求（生产）

- 必须设置强随机 `JWT_SECRET`
- 建议 HTTPS 终止在反向代理、限制 CORS 来源（`@fastify/cors` 当前 `origin: true` 便于开发，生产请收紧）
- SQLite 适用于单机小团队；多副本部署请切换 PostgreSQL 并共享对象存储
