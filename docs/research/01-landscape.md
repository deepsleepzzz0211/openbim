# 开源 BIM 平台生态调研报告

> 调研时间：2026-09 ｜ 调研方式：GitHub 仓库/Release 元数据（GitHub API + 页面抓取）+ 项目文档 + 社区讨论交叉验证
> 用途：为自研「生产级开源 BIM 系统」提供生态地图、共性缺口与差异化定位依据
> 说明：star 数为 2026-09 抓取值，用于刻画量级而非精确排名

---

## 1. 执行摘要

开源 BIM 生态呈"哑铃型"分布：**两端强、中间弱**。

- **底层数据/几何引擎层**非常成熟：IfcOpenShell（IFC 解析 + 几何内核）、xBIM Toolkit（.NET 侧）、web-ifc（浏览器 WASM 侧）三者基本垄断了"读写 IFC"这件事，且全部持续活跃。
- **桌面创作层**有 Bonsai（原 BlenderBIM）和 FreeCAD BIM 两个原生 IFC 创作方案，2024–2026 年进步显著（原生 IFC 编辑、IFC4x3 支持）。
- **Web 引擎/查看器层**碎片化严重：ThatOpen（前 IFC.js）、xeokit、BIMsurfer 3 各自为战，且近两年出现明显的"去开源化/商业化"倾向（xeokit 转 AGPL+商业双轨，ThatOpen 平台服务闭源苗头）。
- **平台/协同服务器层**是最薄弱的一环：BIMserver 老化（v2 重写多年未落地）、Speckle 企业能力闭源（workspaces/gatekeeper 为 EE 专有）、3drepo.io 依赖闭源渲染组件、OpenProject 的 BIM 模块干脆不开源。**"生产级、全开源、开箱即用的 BIM 协同平台"在 2026 年仍是空白**，这正是本项目的定位空间。

许可证整体图谱：MIT/MPL（ThatOpen、BIMsurfer）、Apache-2.0+EE（Speckle）、AGPL-3.0（BIMserver、3drepo.io、xeokit）、LGPL-3.0/GPL-3.0（IfcOpenShell）、CDDL（xBim 新版本）。"看似开源、关键能力闭源"的混合许可模式（Speckle、3D Repo、OpenProject）已成为行业常态，评估复用组件时必须逐一核查。

**方法论与阅读指引**：本报告数据采集于 2026-09，star/fork/最近提交均来自 GitHub 实时元数据，版本号取自官方 Release 页，许可证逐一到仓库 LICENSE 文件原文核对（GitHub 的 SPDX 自动识别存在误差，如 xBim 与 Speckle 均被标为 NOASSERTION）。第 2 节按"定位→技术栈→协议→成熟度→优缺点"五段式逐项拆解；第 3 节给出一页式横向对比；第 4 节聚焦本次自研最关心的五个维度（Web 轻量查看、版本管理、BCF 协同、权限、部署）归纳共性空白；第 5 节据此给出"必须自研 / 建议复用 / 协议与选型"三层决策建议。若时间有限，可只读第 3、4、5 节。

---

## 2. 逐项调研

### 2.1 BIMserver（opensourceBIM/BIMserver）

**定位/核心功能**：老牌开源 BIM 服务器（10+ 年历史），自称"IFC 数据库"而非文件服务器。核心能力是**模型驱动的 IFC 对象级存储**：多项目/多版本（revision）管理、checkout/回写、模型合并（merge）、模型检查（model checking）、BimQL/JSON 查询、多用户权限与通知、插件体系（OSGi 式）、BCF 支持、OAuth 与 BIMSie 服务接口。这是目前唯一把 IFC 拆解为对象粒度并提供查询/合并/版本化 API 的开源服务器。

**技术栈与架构**：Java 单体（Jetty 容器），数据库支持内嵌库及 MySQL/PostgreSQL 等多种后端；服务端 API 通过 SOAP/JSON/REST 暴露；插件化序列化器（IFC、glTF、BinarySerializers 等）；官方 Web 客户端为 bimvie.ws，查看器为 BIMsurfer 3。其开放服务接口值得特别注意：BIMserver 是 **BIMSie**（buildingSMART 早期的服务接口提案）的主要参考实现，支持以 BIMbot 机制把"服务"（模型检查、合并、清单提取等）远程挂载到模型上，配套 OAuth 授权；BCF 以独立模块形态集成；周边还衍生出碰撞检测、NL 建筑法令合规检查等实验性服务插件。这套"模型即平台、服务可插拔"的设计思想在十余年后看仍不过时，是自研平台 API 设计的重要参考。

**开源协议**：AGPL-3.0（SPDX: `AGPL-3.0`），官方 README 明确标注。

**成熟度**：约 1.7k star / 645 fork；最新 release **v1.5.188（2025-07-31）**；仓库最近一次 push 为 2026-03；开源 issue 约 107 个。社区能感受到的核心作者（Ruben de Laat）已转向商业平台 BIM.works（BIM Base B.V.）。

**优点**：唯一成熟的开源"模型服务器"范式；对象级查询/合并/版本化至今无开源替代；标准兼容性好（IFC/BCF/OAuth/BIMSie）；插件生态完整。

**缺点**：Java 单体部署重、上手门槛高；官方 Web UI（bimvie.ws/BIMsurfer 3）陈旧或长期 beta；v2 重写多年未见发布；核心开发者精力外流导致演进放缓；云原生/Docker 一键部署体验差；几何渲染依赖外部查看器。

来源：https://github.com/opensourceBIM/BIMserver ｜ https://bimserver.org/ ｜ https://github.com/opensourceBIM/BIMserver/releases ｜ https://community.osarch.org/discussion/26/bonsai-new-release/p14 （社区对 BIMserver 后继的讨论见 https://github.com/rubendel ）

### 2.2 xBIM Toolkit（xBimTeam）

**定位/核心功能**：.NET 平台上最完整的 IFC 工具包。三个组件：**XbimEssentials**（IFC2x3/IFC4 等 schema 的读写、几何抽象、BCF、报表）；**XbimGeometry**（基于 Open CASCADE 的 C++ 几何引擎，通过 CLR interop 供 .NET 调用，支持布尔运算等）；**XbimExchange**（COBie 序列化与模型验证库，被英国 NBS 数字工具箱采用；该仓库已归档，最后实质更新 2022 年）。

**技术栈与架构**：C# / .NET（NuGet 包分发：Xbim.Essentials、Xbim.Geometry 等），几何引擎为 C++ + OCCT；CI 在 Azure DevOps，master/develop 双分支。

**开源协议**：当前 `LICENCE.md` 正文为 **CDDL**（Common Development and Distribution License，未注明版本号；GitHub 归类为 NOASSERTION）。注意 xBim 早期版本为 LGPL-2.1，评估商用时需以所用版本的 LICENSE 文件为准。

**成熟度**：XbimEssentials 约 573 star，NuGet 稳定版 6.0.517（2025-04-18），仓库 push 至 2026-08-28（活跃）；XbimGeometry 约 294 star，5.1.820（2025-04-11），push 至 2026-07。

**优点**：.NET/Windows 生态下 IFC + 几何 + COBie + 验证一站式；工程化质量好（CI/测试/NuGet 版本化）；有真实商业背书（NBS）。

**缺点**：绑定 .NET 生态，难以直接服务 Web/Python 技术栈；几何引擎 C+++OCCT 构建链复杂；Web 端无官方方案；社区规模与文档深度远小于 IfcOpenShell；XbimExchange 已归档。

来源：https://github.com/xBimTeam/XbimEssentials ｜ https://github.com/xBimTeam/XbimGeometry ｜ https://github.com/xBimTeam/XbimExchange ｜ https://raw.githubusercontent.com/xBimTeam/XbimEssentials/develop/LICENCE.md

### 2.3 IfcOpenShell（IfcOpenShell/IfcOpenShell）

**定位/核心功能**：开源 IFC 生态的事实标准——"开源 IFC 库与几何引擎"。包含：C++/Python 双 API 的 IFC 解析与几何内核（几何基于 OCCT）；命令行工具（IfcConvert、ifccsv、ifcdiff、ifcpatch、ifcquery）；**Bonsai**（原 BlenderBIM，Blender 内的原生 IFC 创作平台）；ifcclash（碰撞检测）；ifctester（IDS 规范校验）；bcf（BCF-XML 库）；bsdd（bSDD 客户端）；ifccityjson、ifc4d/ifc5d（进度/成本）、ifcsverchok（参数化）等。支持 IFC2x3 TC1、IFC4、IFC4x1/4x2/4x3（解析层；几何层覆盖 2x3 与 IFC4，并持续扩展）。

**技术栈与架构**：C++（CMake/OCCT）+ Python 绑定；Bonsai 为 Blender GPL 插件；仓库内含 Docker/conda/nix/pyodide（WASM）/AWS Lambda 等多形态构建基础设施，说明其被大量下游项目嵌入。

**开源协议**：仓库整体 **LGPL-3.0**（SPDX: `LGPL-3.0`）；**Bonsai 与 ifcsverchok 为 GPL-3.0**（`GPL-3.0-or-later`）。库本身可被闭源软件以动态链接方式复用，但 Bonsai 插件代码不可直接抄入闭源产品。

**成熟度**：约 2.7k star / 959 fork / 22,600+ commits；仓库 push 到 **2026-09-02（当日仍活跃）**；release 节奏为 Bonsai 0.9.0 系列每日 alpha（如 bonsai-0.9.0-alpha2609021508）。open issues 约 1.1k（活跃度高带来的自然积压）。

**优点**：IFC 数据 + 几何的"最强心脏"，活跃度全生态最高；工具覆盖从几何到 IDS/BCF/bSDD 全链条；Bonsai 是唯一成熟的开源原生 IFC 创作工具（2024-09 v0.8.0 起由 BlenderBIM 更名，新增 IFC4x3/Blender 4.2 支持）。

**缺点**：编译依赖重（OCCT），二进制分发与版本管理麻烦；无服务器/协同层；Python API 文档靠源码与社区；Bonsai 的 GPL 对闭源集成不友好；大模型几何性能仍受 OCCT 制约。

来源：https://github.com/IfcOpenShell/IfcOpenShell ｜ https://www.blendernation.com/2024/09/01/bonsai-previously-blenderbim-add-on-v0-8-0-adds-blender-4-2-and-much-more/ ｜ https://bonsaibim.org/ ｜ https://docs.ifcopenshell.org/bcf.html

### 2.4 ThatOpen 引擎（前 IFC.js）：engine_web-ifc / engine_components / Fragments

**定位/核心功能**：浏览器端 BIM 应用开发引擎。演变史：**IFC.js**（2020–2022，web-ifc-viewer 与 web-ifc-three）→ 2022 年品牌重塑为 **That Open Company / ThatOpen**，旧库弃用（web-ifc-viewer 已被官方标注 DEPRECATED）。当前组件：**engine_web-ifc**（WASM 编译的 IFC 读写内核，"以原生速度解析 IFC"）；**engine_components**（Open BIM Components：基于 Three.js 的组件库——IFC 加载、剖切、尺寸标注、平面图导航、DXF 导出、后期处理等，v3 架构）；**engine_fragment**（开源二进制 BIM 格式 **Fragments**，用于 Web 端流式加载与高性能渲染）；engine_ui-components（Web Components UI）；engine_clay（轻量建模引擎，2024-10 后更新停滞）；另有 platform_services（2026-08 开始出现提交的服务端雏形）。

**技术栈与架构**：TypeScript + Three.js + WebAssembly；可在 Web/Node/Electron/React Native 运行；Fragments 格式把 IFC 预转换为二进制分块，Web 端按需流式加载，是其性能路线的核心。

**开源协议**：engine_web-ifc 为 **MPL-2.0**；engine_components / engine_fragment / engine_ui-components / 旧 web-ifc-viewer、web-ifc-three 均为 **MIT**。

**成熟度**：engine_web-ifc 约 1.0k star，最新 release 0.77（2026-03-06），push 至 2026-08-31（活跃）；engine_components 约 697 star，v3.4.0（2026-04-09），push 至 2026-07；engine_fragment 约 205 star；旧 web-ifc-viewer 1k+ star 但 2023-09 起冻结。

**优点**：当前浏览器端 IFC 的主流开源技术路线（WASM 解析 + 二进制格式 + Three.js），MIT/MPL 许可对商用友好；文档、教程、社区课程活跃；组件化设计适合构建自研 Web 前端。

**缺点**：**无平台层**——官方不提供服务器、账号、权限、协同、BCF 工作流，只做引擎；API 迭代激进，v1→v2→v3 均有破坏性变更，升级成本高；web-ifc 对部分复杂几何实体覆盖不全；Fragments 转换器质量与 IFC 覆盖面弱于 IfcOpenShell；engine_clay 等子项目有烂尾迹象。

来源：https://github.com/ThatOpen/engine_web-ifc ｜ https://github.com/ThatOpen/engine_components ｜ https://docs.thatopen.com/intro ｜ https://www.jsdelivr.com/package/npm/web-ifc-viewer （弃用声明）｜ https://community.osarch.org/discussion/1551/that-open-company

### 2.5 BIMsurfer 3（opensourceBIM/BIMsurfer）

**定位/核心功能**：BIMserver 官方 WebGL 查看器。三代演进：v1（XeoEngine+BIMserver）、v2（Three.js/xeogl，数据源为 BIMserver 或 IfcOpenShell 生成的 glTF 静态文件）、**v3（beta）**：完全重写、自研 WebGL2 引擎、引入 3D Tiles、主打高性能，**仅支持 BIMserver 作为数据源**。提供模型树、属性面板、隐藏/隔离、剖切等基础查看能力。

**技术栈与架构**：纯 JavaScript，自定义 WebGL2 渲染管线（非 Three.js），与 BIMserver API 深度耦合。

**开源协议**：**MIT**。

**成熟度**：约 428 star；**无正式 release**（README 自述 "no official release yet, beta"）；push 至 2025-12-30；维护人力极少（基本单人）。v1/v2 已不推荐用于新项目。

**优点**：与 BIMserver 查询/树形结构集成最紧密的开源查看器；MIT 许可；性能目标激进（WebGL2 + 3D Tiles）。

**缺点**：长期 beta、无稳定 API；WebGL2-only 兼容面窄；几乎单人维护、bus factor 低；锁定 BIMserver 生态，无法独立使用。

来源：https://github.com/opensourceBIM/BIMsurfer （README 含版本对比表）｜ https://github.com/AECgeeks/BIMsurfer2/

### 2.6 Speckle（specklesystems/speckle-server）

**定位/核心功能**：AEC 数据枢纽（data hub），定位不是 IFC 模型服务器而是**跨软件互操作平台**：通过 20+ 连接器（Revit、Rhino/Grasshopper、Blender、ETABS、Civil 3D、Python/ specklepy、.NET 等）把各软件数据抽取为 Speckle 对象模型；服务端提供项目（Project）→ 模型（Model）→ **分支（branch）/提交（commit）/版本（version）** 的内容寻址对象存储（类似 Git 的语义）；Web 前端含 3D 查看器、比较（diff）、数据表格、自动化（Automations）等。

**技术栈与架构**：monorepo：`packages/server`（Node.js 服务 + GraphQL API）、`packages/frontend-2`（Nuxt/Vue 3）、`packages/viewer`（Three.js 查看器 @speckle/viewer）、objectloader 等；后端依赖 PostgreSQL、Redis、S3 兼容对象存储；对象按 hash 内容寻址，天然支持版本化与增量传输。数据模型层级为 Server → Project（含 model 聚合）→ Model → Branch → Commit → Version，每个 commit 指向一个对象树根 hash，配合对象级去重可高效传输与比较；较新的 Workspaces（工作区，跨项目治理）与 Automations（自动化流水线）能力中前者已在闭源 EE 侧。连接器矩阵是其真正的护城河：桌面 CAD/CAE（Revit、Civil 3D、Rhino+Grasshopper、Blender、ArchiCAD、Tekla、ETABS/SAP2000、Revizto 等）、代码侧（specklepy、speckle-sharp、Node/浏览器 SDK）以及 Unity/Unreal 运行时。

**开源协议**：仓库主许可 **Apache-2.0**，但 LICENSE 明确声明两个例外：`packages/server/modules/workspaces/` 与 `packages/server/modules/gatekeeper/`（企业工作区与权限模块）为 **Speckle Enterprise Edition（EE）专有许可**，不开源。

**成熟度**：约 840 star / 251 fork；最新 release **2.31.14（2026-06-15）**，push 至 2026-08-26（活跃，由 AEC Systems 商业公司支撑）；社区论坛 speckle.community 已出现 v2→v3 迁移话题。

**优点**：互操作性与连接器生态全生态最强；现代 Web 技术栈；对象级版本管理设计优秀；查看器基于 Three.js 易扩展；商业公司持续投入、文档完善。

**缺点**：**关键企业能力（工作区、细粒度权限 gatekeeper）闭源**，自托管开源版在多团队治理上有天花板；部署组件多（Postgres/Redis/对象存储/服务器/前端），运维复杂；数据模型是 Speckle 自有对象模型而非 IFC 原生，IFC 导入存在有损映射，官方明确不承诺 IFC 全保真；许可证混合增加商用合规成本。

来源：https://github.com/specklesystems/speckle-server ｜ https://raw.githubusercontent.com/specklesystems/speckle-server/main/LICENSE （EE 例外原文）｜ https://speckle.community/ ｜ https://docs.speckle.systems/developers/server/introduction

### 2.7 FreeCAD 与 Bonsai（BlenderBIM）——桌面创作侧

**FreeCAD**：开源多平台参数化三维建模器（C++/Python，**LGPL-2.1-or-later**），约 **33.2k star**，是本生态中最大众化的项目。BIM workbench（Yorik van Havre 主导）自 1.0（2024-11）起推进 **Native IFC**：把 IFC 当作原生工程格式直接读写编辑，而非仅作导入导出；**IfcOpenShell 已被默认捆绑进官方安装包**；1.1（2026 年初发布）进一步增强了原生 IFC 创作与分类体系支持。优点：完全开源免费、参数化建模 + BIM 双能力、社区庞大。缺点：桌面单机工具，无协同；BIM 功能成熟度与 Revit 等仍有差距；大模型性能一般。
来源：https://github.com/FreeCAD/FreeCAD ｜ https://yorik.uncreated.net/?blog%2F2025%2F002-nativeifc-tutorial ｜ https://community.osarch.org/discussion/263/freecad-bim-development-news-by-yorik/p5

**Bonsai（原 BlenderBIM）**：见 2.3。作为 Blender 插件提供"原生 IFC 创作"：IFC 数据直接存储、编辑、回写（无中间转换损失），且免费开源（GPL-3.0）。与 FreeCAD 构成开源桌面创作双雄，但两者路线重叠、生态分散。

### 2.8 其他值得关注的项目

**生态趋势观察（跨项目）**：本次调研捕捉到三个值得警惕的行业趋势。其一，**"再许可潮"**：xeokit 由 MIT 转 AGPL+商业双轨，Speckle 把企业模块闭源为 EE，3D Repo 与 OpenProject 把核心 BIM 能力保留在闭源侧——开源 BIM 项目普遍选择"内核开源、能力收费"的混合模式，真正完整开源的生产级平台反而稀缺。其二，**单人/小团队风险**：BIMsurfer 3、BIMserver、3drepo.io 的核心维护者均为极少数人，一旦转向商业项目（如 BIMserver 作者创办 BIM.works），社区版演进即明显放缓；选型时应优先考虑有机构支撑或贡献者分散的项目。其三，**OSArch 社区**（community.osarch.org）已成为开源 AEC 的事实协调层，其"FLOSS 高优先级项目清单"多次点名：协同平台、BCF 工作流、Web 查看器是全行业公认的短板——与本次调研的缺口结论互相印证。

**3D Repo / 3drepo.io**：Web 端 BIM 协同平台（federation 联邦、container/revision 版本化、issues/BCF、tickets、分组、风险管控）。技术栈 Node.js + MongoDB + RabbitMQ + C++ 模型处理（3drepobouncer）。**许可证 AGPL-3.0（另需签 CLA，可商业授权）**；致命短板：生成可视化模型所需组件 **3drepounity 是闭源商业项目**（除非退回 v1.12 的旧 x3dom 路线），意味着按 AGPL 自部署也无法获得完整能力；后端 Node 8 时代技术栈老旧。约百星量级。是"平台形态"最接近我们目标的项目，但开源完整度最差。
来源：https://github.com/3drepo/3drepo.io （README 明示 3drepounity 闭源）

**xeokit（xeokit-sdk / xeokit-bim-viewer）**：高性能浏览器 BIM 查看器 SDK（双精度坐标、超大模型、XKT 二进制格式），2019 年由 xeolabs 创建，现由瑞士 **Creoox AG** 维护；曾为 MIT，**现已转为 AGPL-3.0 + 商业双许可**（社区明确批评其"商业使用需购买商业许可，不算真正的自由软件"）；V3 正迁移到新仓库 github.com/xeokit/sdk；xeokit-bim-viewer（约 559 star，同样 AGPL-3.0）是与 OpenProject 协作的开源查看器应用。性能标杆，但许可恶化使其不再适合作为我们内核的直接依赖。
来源：https://github.com/xeokit/xeokit-sdk ｜ https://github.com/xeokit/xeokit-bim-viewer ｜ https://community.osarch.org/discussion/289/xeokit-agpl-not-quite-free-and-not-really-free-software ｜ https://creoox.com/2025/04/11/new-version-1-7-1-of-xeokit-sdk/

**iTwin.js（Bentley）**：基础设施数字孪生开源平台（TypeScript，**MIT**），提供 iModel 变更集（changeset）式的版本管理、Synchronizer 把 DGN/Revit 数据同步为 iModel、Web 查看器框架。工程化程度极高，但生态深度绑定 Bentley 云服务（iTwin Platform/iModelHub 承担存储与协同），自托管开源能力有限，适合作为架构参考而非复用底座。
来源：https://github.com/iTwin/itwinjs-core ｜ https://raw.githubusercontent.com/iTwin/itwinjs-core/master/LICENSE.md

**OpenProject**：开源项目管理平台（核心 GPL），其 **BIM/BCF 模块（IFC 查看器 + BCF 问题管理）为专有代码**，随付费的 "BIM edition" 分发——又一例"核心开源、BIM 能力闭源"。其 IFC 查看器技术源自与 xeokit 的合作。
来源：https://www.openproject.org/docs/bim-guide/ ｜ https://community.osarch.org/discussion/397/list-of-high-priorities-floss-projects-for-aec-industry-published-by-osarch-org

**buildingSMART 开放标准生态**：BCF-XML / BCF-API（REST 问题交换规范，官方 GitHub 维护）、IDS（信息交付规范）、bSDD、IFC4x3。开源实现：IfcOpenShell 的 bcf/ids 模块、BCFier（GPL-3.0，Revit/Navisworks，基本停滞）、PinMy 等免费浏览器 BCF 查看器。标准本身开放是实现协同能力的合法且省力路径。
来源：https://github.com/buildingSMART/BCF-XML ｜ https://github.com/buildingSMART/BCF-API ｜ https://technical.buildingsmart.org/bcf-software-implementations/

---

## 3. 横向对比速览

| 项目 | 角色 | 技术栈 | 许可证（SPDX） | star | 最新版本/时间 | 平台能力 |
|---|---|---|---|---|---|---|
| BIMserver | 模型服务器 | Java | AGPL-3.0 | ~1.7k | v1.5.188 / 2025-07 | 版本/查询/合并/权限（有）|
| xBIM | .NET IFC 库+几何 | C# / C++(OCCT) | CDDL | ~570 | 6.0.517 / 2025-04 | 无（库）|
| IfcOpenShell | IFC 引擎+创作 | C++ / Python / OCCT | LGPL-3.0（Bonsai GPL-3.0）| ~2.7k | 0.9.0-alpha 每日 | 无（引擎/桌面）|
| ThatOpen | Web 引擎 | TS / Three.js / WASM | MIT + MPL-2.0 | ~1.0k(web-ifc) | components v3.4.0 / 2026-04 | 无（引擎）|
| BIMsurfer 3 | Web 查看器 | JS / WebGL2 | MIT | ~430 | 无正式 release | 仅查看（配 BIMserver）|
| Speckle | 数据枢纽平台 | Node/TS / Vue / PG | Apache-2.0（EE 模块闭源）| ~840 | 2.31.14 / 2026-06 | 版本/连接器（强）；权限 EE |
| 3drepo.io | 协同平台 | Node / Mongo / C++ | AGPL-3.0（渲染组件闭源）| ~100 | 持续发布 | 版本/issue/BCF（强，但不完整开源）|
| FreeCAD | 桌面创作 | C++ / Python | LGPL-2.1-or-later | ~33k | v1.1 / 2026 | 无（桌面）|
| Bonsai | 桌面 IFC 创作 | Python / Blender | GPL-3.0 | 含于 IfcOpenShell | 0.9.0-alpha 每日 | 无（桌面）|
| xeokit | Web 查看器 SDK | JS / WebGL | AGPL-3.0（+商业）| ~930 | V3 迁移中 | 无（查看器）|
| iTwin.js | 数字孪生平台 | TS | MIT | —（Bentley 维护）| 持续 | 版本/协同（绑定 Bentley 云）|

---

## 4. 共性缺口分析

1. **Web 端轻量化查看：引擎多、产品少，且许可恶化。** 浏览器端 IFC 渲染已有三条技术路线（ThatOpen 的 WASM+Fragments、xeokit 的 XKT、BIMsurfer 的自研 WebGL2），但没有一个"开箱即用、许可无忧、可持续维护"的完整查看器产品：ThatOpen 只有引擎组件，搭建一个带树/属性/剖切/测量/BCF 锚点的完整查看器仍需数周胶水工作；BIMsurfer 3 无正式版；xeokit 转 AGPL+商业双轨后商用合规成本上升。多数路线还绕开 IFC 原生数据（先转中间二进制格式），导致属性/分类保真度依赖转换器质量——转换损耗是普遍痛点。*对自研的启示：查看器应作为产品的一等公民打磨（树/属性/剖切/测量/漫游/截图标注一步到位），并建立"二进制缓存 + IFC 保真回溯"的双轨数据管线。*
2. **模型版本管理：Speckle 最好但语义不同，IFC 侧退化。** 唯一把"版本"做成一等公民的是 Speckle（branch/commit/内容寻址对象），但其版本针对自有对象模型而非 IFC 文件语义，IFC 全保真往返不成立；BIMserver 有 revision/checkout 概念但 UI 与 API 陈旧；3drepo.io 有 container/revision 但不开源完整；iTwin 的 changeset 模式绑定云。**开源界缺一个"以 IFC/开放数据为本、语义化、可 diff 的版本管理层"**。
3. **协同与问题跟踪（BCF）：标准开放，产品空白。** BCF-XML/BCF-API 标准开放且被 Revit 等商业软件广泛支持，但开源侧没有一个生产级的 BCF 服务端 + 3D 锚点 + 截图 + 状态流转的完整实现：BCFier 停滞、BIMserver 的 BCF 依附老平台、OpenProject 的 BCF 模块闭源。3D 视图中"选中构件→创建 issue→BCF 导入导出→通知→状态看板"的闭环，开源产品近乎空白。
4. **权限与多租户：要么简单要么闭源。** BIMserver 有用户/项目/授权模型但停留在单机时代；Speckle 的企业级权限（workspaces/gatekeeper）明确闭源为 EE；3drepo.io 权限同样不完整开源；ThatOpen/BIMsurfer 根本没有。**生产级开源 BIM 系统所需的 RBAC/项目级 ACL/细粒度构件级权限/SSO，没有任何开源方案完整提供。**
5. **部署体验：全部不合格。** BIMserver（Java 单体+外部 DB）、Speckle（服务器+前端+PG+Redis+对象存储）、3drepo.io（Node+Mongo+RabbitMQ+C++ worker）都要求多个有状态组件，均无维护良好的 Helm/Compose 生产级部署与平滑升级路径；对国内用户还存在 OCCT/WASM 构建链与文档语言障碍。"docker compose up 即得可用 BIM 平台"无人做到。
6. **（附带）互操作孤岛**：各平台各自绑定查看器/数据格式（Fragments、XKT、BIMserver 序列化），标准侧 IFC/BCF/IDS 开放但平台侧封闭，数据在开源平台之间同样难迁移。
7. **（附带）IFC 深度语义能力薄弱**：分类体系（classification）、bSDD 字典对接、IDS 合规校验、4D/5D（进度/成本）关联等"数据深度"能力散落在 IfcOpenShell 工具集里，没有任何平台将其产品化为面向工程人员的功能；国内规范（如各类构件编码标准）适配更是完全空白，这也是国产化自研可叠加的本地化优势。

---

## 5. 对自研「生产级开源 BIM 系统」的差异化定位建议

**一句话定位**：做"Speckle 的部署体验 + BIMserver 的 IFC 模型语义 + Speckle 闭源部分（工作区/权限）的完全开源替代 + 原生 BCF 协同闭环"的生产级平台。

**必须自研（生态空白，即差异化护城河）**：
1. **平台层**：多租户工作区/项目/成员、RBAC + 项目级 ACL（构件级权限可选做）、SSO/OIDC、审计日志——对应 Speckle EE 闭源部分与 BIMserver 的陈旧实现，是最大差异化点。
2. **语义化版本管理**：以模型文件/对象为核心，提供 commit/branch/对比（可基于内容寻址对象存储设计，参考 Speckle 架构与 iTwin changeset 概念），保证 IFC 往返保真。
3. **原生 BCF 协同**：服务端 BCF-XML/BCF-API 实现 + 3D 查看器锚点联动 + 截图/回复/状态流转/通知，打通"查看器→issue→外接 Revit/Bonsai"闭环——标准开放，实现空白。
4. **一键部署**：docker compose 单机起步 + 可演进到 K8s 的拓扑（应用无状态化、对象存储/PG 外置），把"5 分钟自托管"作为产品级卖点。

**建议复用现有库（勿重复造轮子）**：
- IFC 解析/几何/转换/IDS/BCF 工具库：**IfcOpenShell（LGPL-3.0，进程隔离调用更稳）**，服务端转换管线用 IfcConvert/Python API，避免内联 GPL 的 Bonsai 代码。
- Web 查看器内核：优先 **ThatOpen engine_web-ifc + Fragments（MPL-2.0/MIT）** 或自研 Three.js 管线 + IfcOpenShell 转换出的二进制格式；xeokit 因 AGPL 不再适合作为默认内核（除非走商业授权或隔离）。
- 标准格式：BCF-XML/BCF-API、IDS、bSDD 全部按 buildingSMART 标准实现，互操作免费红利。
- 桌面端协同：通过 BCF/开放 API 对接 Bonsai/FreeCAD，而非自研建模。

**协议选择建议**：平台主代码采用 **Apache-2.0**（对企业采用与商业生态最友好）或 **AGPL-3.0 + 商业双许可**（若担心云厂商白嫖、需要开源商业化护城河，与 BIMserver/3drepo 同路线）；**切勿混入 GPL 组件到主代码**；对复用的 LGPL 库采用动态链接/进程隔离；EE 功能可效仿行业惯例单独闭源，但作为"全开源生产级"卖点，建议核心企业能力（权限/工作区）保持开源，以 Speckle 的闭源部分为对标卖点。

**建议技术选型栈（结合缺口与许可约束）**：服务端采用 TypeScript/Node 或 Java/Kotlin 皆可，但建议与查看器生态同构选 TypeScript，降低全栈协作成本；存储层以 PostgreSQL（元数据/索引/权限）+ S3 兼容对象存储（IFC 原文件与转换产物、BCF 附件、截图）+ 对象内容寻址表（模型对象图）三层构成，避免引入 MongoDB/Redis 等额外有状态组件以简化自托管；IFC 处理 worker 独立容器化（内含 IfcOpenShell，暴露队列接口），保证 GPL/LGPL 边界清晰、可水平扩展；前端查看器以 Three.js + ThatOpen web-ifc/Fragments 起步，逐步沉淀自研组件；BCF 服务端按 BCF-API 2.1 实现 REST 接口并兼容 BCF-XML 文件导入导出；身份层内置 OIDC（Keycloak 兼容），权限模型按"工作区→项目→模型→构件"四级设计。该选型的每一项都直接对应第 4 节的某个缺口，且全部落在宽松许可或进程隔离的合规路径上。

来源汇总：https://github.com/opensourceBIM/BIMserver ｜ https://github.com/xBimTeam/XbimEssentials ｜ https://github.com/IfcOpenShell/IfcOpenShell ｜ https://github.com/ThatOpen/engine_components ｜ https://github.com/ThatOpen/engine_web-ifc ｜ https://github.com/opensourceBIM/BIMsurfer ｜ https://github.com/specklesystems/speckle-server ｜ https://github.com/3drepo/3drepo.io ｜ https://github.com/FreeCAD/FreeCAD ｜ https://github.com/xeokit/xeokit-sdk ｜ https://github.com/iTwin/itwinjs-core ｜ https://www.openproject.org/docs/bim-guide/ ｜ https://github.com/buildingSMART/BCF-XML ｜ https://community.osarch.org/discussion/289/xeokit-agpl-not-quite-free-and-not-really-free-software ｜ https://www.blendernation.com/2024/09/01/bonsai-previously-blenderbim-add-on-v0-8-0-adds-blender-4-2-and-much-more/
