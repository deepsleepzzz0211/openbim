# OpenBIM Hub — 真实复杂模型端到端验证报告

> 验证日期：2026-09-11。目的：验证平台对**真实工程复杂模型**（非手工样例）的全链路处理能力：
> 上传 → web-ifc worker 池转换 → 量化 GLB → three.js 联邦查看器 → 碰撞检测 / 版本 diff。

## 1. 模型来源（联网获取的真实模型）

本机网络环境无法直连 GitHub / 各模型仓库，最终通过两条稳定通道获取：

| 通道 | 用途 |
|---|---|
| `codeload.github.com`（直连可达） | 下载仓库 tarball（绕过单文件路径限制） |
| `media.githubusercontent.com`（直连可达） | 下载 Git LFS 指向的真实文件 |

获取的真实模型（存于 `samples/complex/`，共 14 个 IFC）：

| 系列 | 来源 | 说明 |
|---|---|---|
| **Duplex Apartment**（5 个） | [buildingsmart-community/Community-Sample-Test-Files](https://github.com/buildingsmart-community/Community-Sample-Test-Files)（LFS） | Autodesk Revit 2011 真实项目导出（IFC2x3 CoordinationView），业界标准测试模型 |
| **PCERT Simple-Scene**（9 个） | [buildingSMART/Sample-Test-Files](https://github.com/buildingSMART/Sample-Test-Files) | buildingSMART 官方**专业认证**场景（SketchUp 2026 导出，IFC4 ReferenceView），覆盖建筑/结构/暖通/电气/桥梁/道路/铁路/水暖/景观 |

规模最大的文件：`Duplex_Plumbing`（84,389 个 STEP 实体 / 4.5 MB）、`Duplex_MEP`（82,250 实体）、`Duplex_A`（38,898 实体）。

## 2. 转换管线验证（API E2E）

在演示项目下创建 5 个模型上传（`scripts/e2e-complex-upload.py`），worker 池异步转换结果：

| 模型 | IFC 大小 | STEP 实体数 | 转换耗时 | 三角面 | GLB 量化后 | 压缩比 | Schema |
|---|---|---|---|---|---|---|---|
| 真实项目-Duplex公寓 | 2,325 KB | 38,898 | 9.2 s | 26,774 | 1,090 KB | 46.9% | IFC2X3 |
| 真实项目-Duplex机电 | 4,511 KB | 82,250 | 27.3 s | 10,478* | 2,989 KB* | 66.3% | IFC2X3 |
| 真实项目-Duplex给排水 | 4,493 KB | 84,389 | 39.3 s | 97,130 | 4,148 KB | 92.3% | IFC2X3 |
| 认证场景-桥梁 | 1,702 KB | 919 | 3.1 s | 13,240 | 627 KB | 36.8% | IFC4 |
| 认证场景-景观 | 2,294 KB | 1,186 | 3.1 s | 20,162 | 978 KB | 42.6% | IFC4 |

\* 机电为**剔除坏几何后**的数字（见 §3.1）。

- 5 个模型全部 `READY`，`progress=100`，无错误码。
- 另上传 2 个 v2 版本（机电重传同文件、景观换 Infra-Road 文件）模拟版本演进，均正常转换。
- GLB 均带 `KHR_mesh_quantization`（顶点 24B→9B）；给排水 92.3% 是因 B-rep 细分管道顶点密度高，属正常。

## 3. 验证过程中发现并修复的真实缺陷（5 个）

真实模型暴露了样例数据永远不会触发的问题，全部修复并带回归保障：

### 3.1 无空间归属构件的元数据丢失（elements=0）
- **现象**：Duplex_MEP/给排水转换后 `elements: 0`，几何正常但构件不可拾取。
- **根因**：`packages/ifc/src/convert.ts` 只从 `IfcRelContainedInSpatialStructure` 收集构件元数据；Revit 2011 的 MEP 导出**三种空间关系全为 0**（诊断脚本 `scripts/diag-ifc-relations.js` 证实）。
- **修复**：为所有带几何的构件注册元数据（`storey=null`）。
- **回归**：新 fixture `sample-building-no-containment.ifc` + 测试（ifc 32 个用例全绿）。

### 3.2 损坏 placement 产生"飞点几何"
- **现象**：机电模型碰撞结果出现交叠中心 X=1.8e13 m、体积 8e24 m³；158/212 构件 bbox 在 1e15-1e16 m（Revit 2011 散热器/锅炉 placement 单位损坏）。
- **修复**：转换器丢弃世界坐标超 100 km 的网格（保留元数据）。机电三角面 73,490→10,478，碰撞结果回归米级真实坐标。
- **回归**：全部 5+2 版本 bbox 复查异常=0。

### 3.3 转换进度竞态（progress 45 < READY）
- **现象**：小模型转换瞬间完成时，fire-and-forget 的 45% 进度写在 READY/100% **之后**落库，终态被覆盖。
- **修复**：进度写改 `updateMany` + `where: { status: "PROCESSING" }` 守卫，迟到写不命中终态行。

### 3.4 产物 HTTP 缓存导致重转换后客户端拿旧模型
- **现象**：reconvert 后浏览器仍加载旧 GLB（`cache-control: private, max-age=3600`，URL 不变）。
- **修复**（三层）：
  1. 产物响应改 `ETag(mtime+size)` + `no-cache` 协商缓存（验证 304 生效）；
  2. 响应加 `Vary: Authorization`；错误响应（`setErrorHandler`）加 `Cache-Control: no-store`（缓存的 401 会遮蔽真实产物）；
  3. 前端产物 URL 追加 `?v={updatedAt}` 指纹（`ViewerPage.artifactUrl`），reconvert 后 URL 自然变化。

### 3.5 URL 指定版本被自动选版覆盖
- **现象**：`?version=<v1>` 打开页面后自动跳到最新版（v2）。
- **根因**：`versionIdRef` 声明后从未赋值，`!versionIdRef.current` 恒真，每次 `loadVersions` 都执行自动选版。
- **修复**：首次自动选版后写入 ref，并在加载 effect 中同步。

## 4. 浏览器查看器验证（UI E2E）

- **渲染**：给排水模型（97k 三角面）完整渲染 —— 热水器、浴缸、马桶、洗手盆、立管/支管/阀门清晰可见，相机自动 fit；顶栏正确显示 "1 个模型 · 322+ 构件"。
- **拾取/属性**：点击浴缸 → 属性面板显示 `M_Bath Tub`（IFCFLOWTERMINAL，GlobalId、expressID 42582）与 6 个真实 Revit Pset（Plumbing 展开 Flow Pressure: 16812.1584）。
- **联邦叠加**：「叠加版本…」多选 v1 → 顶栏 "2 个模型 · 246+ 构件"，双版本同场景。
- **碰撞检测**：⚡ 对话框（容差 0.01m）→ 机电 v1×v2 "共 54 处碰撞（检查 54 × 54 个构件）"，结果为真实管道构件对、交叠中心米级。
- **版本 diff**：同文件 v1→v2 `unchanged: 246`；景观→道路 `added: 70 / removed: 108 / unchanged: 3`（真实构件增删：road parking、asphalt binder course 等）。

## 5. 质量门槛（全部通过）

| 项 | 结果 |
|---|---|
| 全仓测试 | **91 个全绿**（bcf 42 + ifc 32 + api 17，含新增回归测试） |
| lint | 0 错误 |
| typecheck | 4 个包全部通过 |
| 全仓 build | 通过 |

## 6. 验证脚本与工件

| 文件 | 用途 |
|---|---|
| `scripts/e2e-complex-upload.py` | 真实模型批量上传 |
| `scripts/e2e-complex-poll.py` / `e2e-complex-reconvert.py` | 转换轮询 / 重转换 |
| `scripts/e2e-upload-v2.py` | v2 版本上传（碰撞/diff 数据） |
| `scripts/diag-ifc-relations.js` | IFC 空间关系诊断工具 |
| `scripts/e2e-complex-upload.sh` | （bash 早期版本，中文 JSON 有 Content-Length 问题，已被 .py 取代） |
| `samples/complex/*.ifc` | 14 个真实模型 |

## 7. 遗留事项

- `Duplex_MEP` 等模型中 158 个 Revit 2011 损坏构件的几何被防线剔除（元数据保留）——源头是导出工具 bug，平台侧已正确容错。
- 渲染验证覆盖给排水（致密）与机电（稀疏管道）两类形态；桥梁/景观等 IFC4 基础设施模型已完成转换与 API 层验证，浏览器渲染抽查未逐一截图。
- 第三梯队（OIDC SSO、S3/MinIO、meshopt 等）仍未动，见 `docs/gap-analysis.md`。
