# 02: sha256 秒传 + 引用计数去重

**What to build:** 用户在同一工作区重复上传同一个 IFC 文件（新版本或新模型）时瞬间完成（不重传字节、不重复落盘）；删除一个引用后文件仍可被其他引用读取，最后一个引用删除后才物理清理。

**Blocked by:** None (can start immediately)

**Status:** implemented (2026-09-20), awaiting review

- [x] 上传分片携带逐片校验，合并后计算整文件 sha256 并登记内容寻址 blob 表（sha256 → 存储键、大小、引用计数）
- [x] 命中去重时版本直接引用既有 blob，秒传路径端到端可用（新版本号、零字节搬运）
- [x] 去重范围限工作区/项目内，跨租户不去重（防侧信道）
- [x] 引用计数随版本删除递减，归零才删物理文件；并发引用竞态有测试
- [x] API 集成测试覆盖：上传→重复上传秒传→删一引用另一引用仍可读→删全部引用后清理

## 实现备注

- 新表 `ContentBlob`：`@@unique([projectId, sha256])`，storageKey 固定为 `projects/{pid}/content/{sha256}.ifc`，`refCount` 初始 0；`Version.blobId`（`onDelete: SetNull`）。产物（model.glb / meta.json）仍按版本 storageKey 分开存放。
- 上传两通道（multipart / 分片）都先流式落到 `tmp/uploads/…/original.ifc` 并同步哈希，再 `linkOrStoreContent`：命中→删临时文件 + refCount++；未命中→move 临时文件到内容键 + 建记录；P2002 并发冲突→链接到胜者记录且**绝不删内容文件**（字节相同）。
- 秒传：`POST /models/:modelId/versions/fast-import`（sha256+size 匹配才命中，否则 404 走正常上传）；前端 `uploadVersion` 先 WebCrypto 算哈希试秒传，404 回退；分片 PUT 支持可选 `x-part-sha256`（不匹配 422）。
- 释放：`DELETE /versions/:versionId` 新增；模型删除级联前先收集 blobId 逐个 release；refCount 原子递减归零才删物理文件并删行。
- bug 顺带修复：并发上传同一模型会在 `@@unique([modelId, versionNumber])` 相撞（count+1 非原子）→ `createVersion` 冲突重试（最多 5 次）；分片 complete 现在逐片删除临时 part（修复原有 tmp 泄漏）。
- 测试注意：light-my-request 原始字节用 `res.rawPayload`（不是 rawBody）；`dedup.test.ts` 9 例全过，api 原 26 例、ifc 45、bcf 42 无回归。
- 遗留：legacy 版本（blobId 为空）通过 `originalKeyOf` 回退 `${storageKey}/original.ifc`，不做迁移。
