# 01: Baseline 提交 — 现有 review 修复落库

**What to build:** 把工作区已有的 4 个未提交文件以两个语义清晰的 commit 落库，为后续 auth-transport 重构提供干净的 diff 基线（uploadVersion 的 XHR 修复将在后续工单中被 module 迁移吞掉，历史里需要"先修后收"的真实路径）。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] commit 1 `fix(web)`: 小文件上传 XHR 的 401 单飞刷新重试 + 3 个回归测试（a26527f）
- [x] commit 2 `docs`: CONTRIBUTING inline 例外措辞 + architecture.md 并发描述对齐实现（4426873）
- [x] 提交后工作区干净（`git status` 无未暂存变更），不 push
