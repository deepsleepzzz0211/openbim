# 贡献指南 / Contributing

感谢关注 OpenBIM Hub！接受任何形式的贡献：bug 报告、文档、测试、功能。

## 开发流程

1. Fork / 建分支（`feat/xxx`、`fix/xxx`）。
2. 提交前确保本地全绿：

   ```bash
   pnpm lint && pnpm typecheck && pnpm test && pnpm -r build
   ```

3. PR 描述请说明动机与验证方式（贴测试输出/截图）。

## 代码约定

- TypeScript strict；后端 CommonJS（web-ifc 的 Node 入口依赖 require 语义），前端 ESM。
- 提交信息遵循 Conventional Commits（`feat:`、`fix:`、`docs:`、`test:`、`chore:`）。
- 涉及 IFC/BCF 标准的行为变更，请在 `docs/research/02-standards.md` 对应章节补来源，并加测试用例。
- 纯逻辑（GUID、GLB、BCF、转换）必须带单元测试；API 变更必须更新 fastify schema（自动进 OpenAPI）并补集成测试。

## 架构约束（改动前必读）

- 转换逻辑只能放在 `packages/ifc`（纯库、可在 worker 运行），API 进程禁止加载 web-ifc。
- `Version` 一经 READY 不可变；产物写入只允许经 `BlobStore`，key 由服务端生成。
- 面向用户的错误一律走 fastify 错误处理（statusCode + message），不向客户端泄漏内部细节。

## 报告 Bug

附上：复现步骤、IFC 文件（如可公开）、API 日志片段、期望/实际行为。
