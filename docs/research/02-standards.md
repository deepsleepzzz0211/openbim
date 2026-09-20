# buildingSMART 开放标准与 BIM 数据互操作调研报告

> 调研日期：2026-09。本文基于 buildingSMART 官方规范文档（BCF-XML 3.0 技术文档、IFC 4.3.2 官方文档站、IFC-GUID 官方实现指南、IDS/bSDD 官方仓库、glTF 扩展规范原文）及 IfcOpenShell 参考实现整理，供自研 BIM 系统（Web 端 three.js 渲染 + 模型服务器）做标准落地决策使用。

---

## 1. IFC 标准（ISO 16739）

### 1.1 版本演进与 IFC2x3 / IFC4 / IFC4.3 的差异

IFC（Industry Foundation Classes）是 buildingSMART 制定的开放数据模型，当前以 ISO 16739 系列发布：

| 版本 | ISO 对应 | 发布时间 | 要点 |
|---|---|---|---|
| IFC2x3 | 非 ISO（协调稿 ISO/PAS 16739:2005） | 2006 | 生态兼容面最广，大量存量模型与旧版软件（Revit ≤2017 等）仅支持此版本；实体较少，无 tessellation（细分网格）实体，无 IfcTypeObject（用 IfcObjectTypeObject 之前的 IfcTypeProduct） |
| IFC4 | ISO 16739:2013（:2018 修订版为 IFC4 ADD2 TC1） | 2013/2018 | 面向建筑的重构：引入 IfcTypeObject 统一类型系统、4D/成本/材料增强、新增 `IfcTriangulatedFaceSet`/`IfcPolygonalFaceSet` 细分几何、改进 Pset 与几何结构；建模软件（Revit 2018+、ArchiCAD、Tekla 等）主流导出版本 |
| IFC4.3 | ISO 16739-1:2024（当前最新版 IFC 4.3.2.0） | 2024 正式成为 ISO | 在 IFC4 基础上新增数百个基础设施实体：公路、铁路、桥梁、隧道、港口、水道、线性定位（IfcLinearPlacement/IfcAlignment）等；2024 年以 100% 支持率通过 ISO 终审 |

来源：
- buildingSMART 官方公告《IFC 4.3 Formally Approved and Published as an ISO Standard》：https://www.buildingsmart.org/ifc-4-3-formally-approved-and-published-as-an-iso-standard/
- buildingSMART IFC 标准页（IFC 4.3.2.0 = ISO 16739-1:2024）：https://www.buildingsmart.org/standards/bsi-standards/industry-foundation-classes/
- ISO 16739:2018（IFC4）：https://www.iso.org/standard/70303.html

**选型结论**：解析器应同时支持 IFC2x3 与 IFC4/4.3 的 schema 差异（读取 `FILE_SCHEMA` 判断）；渲染优先支持 IFC4 几何，因 IFC2x3 缺少细分几何实体，瓦片化流水线需先把 B-rep 网格化。

### 1.2 IFC 物理文件结构（STEP / .spf 语法）

IFC 文件采用 ISO 10303-21（STEP Part 21，"Physical File"）语法，即常见的 `.ifc`（本质是 `.spf`）文本文件，结构如下：

```step
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView_V1.0]'),'2;1');
FILE_NAME('sample.ifc','2024-05-01T10:00:00',('Author'),('Org'),
  'IFC file schema generator','IFC engine','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'Zhang',$,$,$,$,$);
#10=IFCPROJECT('2qQh2XaQb7zORYw$cHjXnC',$,'Demo',$,$,$,$,(#20),#30);
/* 每个实例一行：#id = 实体名(属性表) */
ENDSEC;
END-ISO-10303-21;
```

关键语法规则：
- `HEADER` 段的 `FILE_NAME`（文件名、时间戳、作者、预处理器）是 BCF Header 匹配模型与 IFCSUMMARY 交换的依据；`FILE_SCHEMA` 决定解析目标版本（IFC2X3 / IFC4 / IFC4X3）。
- `DATA` 段每行 `#n=IFCXxx(...)`：`#n` 是实例 ID；实体间引用直接写 `#m`；列表 `(a,b,c)`；字符串用单引号，内部引号转义为 `''`；枚举写成 `.X.`（如 `.T.`/`.F.` 布尔、`.MILLI.` 前缀）；未赋值写 `$`，派生属性写 `*`。
- 属性为按位置对齐的位置参数，跨版本同一实体属性数可能变化（如 IfcProject 的 RepresentationContexts/UnitsInContext 在 IFC4 提升到父类 IfcContext），解析器需按 schema 逐版本映射属性名。

来源：
- ISO 10303-21（STEP 物理文件语法）概览：https://en.wikipedia.org/wiki/ISO_10303-21
- IFC Header 数据实现指南（FILE_NAME/FILE_DESCRIPTION 约定）：https://standards.buildingsmart.org/documents/Implementation/ImplementationGuide_IFCHeaderData_Version_1.0.2.pdf

### 1.3 几何表示

产品几何的挂接链路：`IfcProduct → ObjectPlacement（IfcLocalPlacement 链）+ Representation（IfcProductDefinitionShape → IfcShapeRepresentation 列表）`。每个 `IfcShapeRepresentation` 有 `ContextOfItems`（IfcGeometricRepresentationSubContext，如 `Body`/`Facetation`/`Axis`）、`RepresentationIdentifier`（'Body' 等）与 `RepresentationType`（'SweptSolid'、'Brep'、'Tessellation'、'MappedRepresentation' 等）。

常用几何实体（均源自 IFC 4.3.2 官方文档 https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/ ）：

- **IfcSolidModel 族（实体建模）**
  - `IfcExtrudedAreaSolid`：截面沿直线拉伸，最常见（墙、梁、板），属性 SweptArea（IfcProfileDef：I/L/C/T 形参数化截面等）、ExtrudedDirection、Depth。
  - `IfcRevolvedAreaSolid`：截面旋转扫掠；`IfcSweptDiskSolid`：沿曲线扫掠圆盘（管线）。
  - `IfcFacetedBrep`："多面体 B-rep，所有面均为平面多边形"（官方定义），由 IfcClosedShell + IfcFace（平面）组成；`IfcFacetedBrepWithVoids` 支持开洞。适合已三角化/多边形化的第三方几何。
  - `IfcAdvancedBrep`：允许曲面与复杂边界（B 样条面等）。
- **细分几何（IFC4+，最贴近 WebGL）**
  - `IfcTriangulatedFaceSet`：官方定义"所有面均为三角形的细分面集，面由三个笛卡尔点构成的隐式折线围成"，核心属性 `Coordinates`（IfcCartesianPointList3D 顶点表）+ `CoordIndex`（每行 3 个 1-based 索引）+ 可选 `Normals` 与 `Closed`。这正是 glTF 顶点缓冲的同构数据，可零语义损耗地转成 BufferGeometry。
  - `IfcPolygonalFaceSet`（IFC4 ADD2+）：多边形面集（面可为任意多边形，由 FaceIndex 引用顶点，可选 PnIndex）。
- **实例化复用：IfcRepresentationMap + IfcMappedItem**
  - 官方定义：`IfcMappedItem` 是"源定义（类似块/共享单元/宏定义）的插入实例，通过 MappingTarget 的笛卡尔变换算子放置"；`IfcRepresentationMap` = MappingOrigin + 被映射的 IfcShapeRepresentation（作为"块定义"）。
  - 门、窗、设备、大量重复构件普遍用 `RepresentationType='MappedRepresentation'` 的 IfcMappedItem 引用同一份几何。Web 端应把映射源烘焙为共享 BufferGeometry，用 three.js InstancedMesh / 共享 geometry+多 Mesh 恢复实例化，可显著降内存。注意 MappedItem 可嵌套（宏套宏），变换矩阵需逐层累乘。

**解析优先级建议**：`IfcTriangulatedFaceSet / IfcPolygonalFaceSet`（直接转顶点缓冲）→ `IfcFacetedBrep`（三角化后同上）→ `IfcExtrudedAreaSolid` 等扫掠体（需参数化截面离散 + 拉伸生成网格）→ 其余（IfcCsgSolid、曲面）可暂降级为占位体。

### 1.4 属性集（Psets）与工程量（Qto）

- 属性挂接：`IfcRelDefinesByProperties（RelatedObjects[], RelatingPropertyDefinition）`，IFC4/4.3 中这是唯一途径（IFC2x3 还有已废弃的 IfcRelDefines）。RelatingPropertyDefinition 指向 `IfcPropertySet`，其 `HasProperties` 列表内为 IfcProperty 子类：`IfcPropertySingleValue`（NominalValue 是 IfcValue 选择类型：IfcLabel/IfcReal/IfcInteger/IfcBoolean/IfcLengthMeasure…，可能带 Unit）、`IfcPropertyEnumeratedValue`、`IfcPropertyListValue`、`IfcPropertyBoundedValue`、`IfcPropertyTableValue` 等。
- 命名约定：`Pset_`（如 Pset_WallCommon 的 FireRating、IsExternal、LoadBearing）与 `Qto_`。类型对象（IfcWallType.HasPropertySets）上的属性为类型级，可被实例继承覆盖——读取时先实例后类型。
- 工程量：`IfcElementQuantity`（同样是 IfcRelDefinesByProperties 挂接）内 `Quantities` 列表为 `IfcQuantityLength/Area/Volume/Weight/Count/Time`（Name + 可选 Unit + 可选 Formula）。行业约定 `Qto_WallBaseQuantities`（NetVolume、GrossVolume、NetArea 等），是造价与 FM 数据源。

来源：IFC 4.3.2 文档 IfcPropertySet：https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcPropertySet.htm ；IfcElementQuantity：https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcElementQuantity.htm

### 1.5 空间结构层级与关键关系

空间层级固定为：`IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey → IfcSpace`（IFC4.3 扩展出 IfcFacility/IfcRoad/IfcBridge 等可插层）。两条关系承载整棵树：

- **IfcRelAggregates**（组成/分解，"整体—部分"）：官方语义为聚合关系，可应用于所有 IfcObjectDefinition 子类；空间树正是用它把 Site→Building→Storey→Space 逐级串起来（父=RelatingObject，子=RelatedObjects）。
- **IfcRelContainedInSpatialStructure**（空间包含）：把物理构件（IfcElement：墙、板、门、设备…）挂到某个空间元素（通常是 Storey）下。官方明确："构件在空间结构中的包含必须是层次化的，一个构件只能被包含在一个空间元素内"（非层次的引用用 IfcRelReferencedInSpatialStructure）。
- **IfcRelDefinesByProperties**：属性挂接（见 1.4）。

**空间树解析算法**（自研系统 P0）：
1. 定位 IfcProject（全文件应只有 1 个）；
2. 沿 IfcRelAggregates 反向索引递归下钻，生成 Project/Site/Building/Storey/Space 树；
3. 构件节点通过 IfcRelContainedInSpatialStructure 找到宿主 Storey/Space（构件默认挂在树外，渲染树要把"容器"节点与"构件"叶子合并展示）；
4. 世界坐标 = 逐层累乘 IfcLocalPlacement（PlacementRelTo 父链），最终叠上 IfcGeometricRepresentationContext.WorldCoordinateSystem。门/窗经 IfcRelFillsElement/IfcRelVoidsElement 与墙体关联，需从宿主构件反查。

来源：
- IfcRelAggregates 官方文档：https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcRelAggregates.htm
- IfcRelContainedInSpatialStructure 官方文档：https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcRelContainedInSpatialStructure.htm
- IfcProject（上下文与单位根）：https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcProject.htm

## 2. BCF（BIM Collaboration Format）2.1 与 3.0

BCF 用于在**不依赖 BIM 模型本身**的前提下交换"议题/批注"（Topic）：截图 + 视角 + 构件可见性/高亮 + 文字讨论。文件级交换为 BCF-XML，服务级交换为 BCF-API（REST + JSON body，OpenCDE 计划的一部分）。

### 2.1 zip 包结构（官方 BCF 3.0 文档原文整理）

- 容器扩展名：BCF 2.1 起为 `.bcf`（此前 `.bcfzip`）。zip 根目录包含：
  - `bcf.version`（必填，version.xsd，指明 `VersionId` 如 3.0）；
  - `extensions.xml`（必填：预定义 TopicType/TopicStatus/Priority/Label/User/Stage/SnippetType 字典）；
  - `project.bcfp`（可选：ProjectId + Name）；
  - `documents.xml` + `Documents/` 目录（3.0 新增，附件以 GUID 命名防重名）。
- 每个 Topic 一个以**全小写 UUID 命名的文件夹**，内含：
  - `markup.bcf`（必填）：文字信息；
  - `viewpoint*.bcfv`（可选，visinfo.xsd）：视觉信息（相机、可见性等）；
  - `snapshot.png`/`snapshot.jpg`（可选，3.0 起允许 JPEG；最长边 ≤1500px）；
  - 位图标注文件（Bitmap 引用）。

### 2.2 markup.bcf 关键字段

- `Header/File[]`：IfcProject、IfcSpatialStructureElement（IfcGuid）、Filename、Date、Reference、IsExternal——用于打开议题时自动匹配模型；因 IFC 文件无唯一 ID，官方要求导入方提供人工匹配兜底。
- `Topic`（必填属性 `Guid`，小写）：TopicType/TopicStatus（extensions.xml 字典）、Title、Priority、Index（3.0 已弃用）、Labels[]、CreationDate/CreationAuthor、ModifiedDate/ModifiedAuthor、DueDate、AssignedTo、Description、Stage、ServerAssignedId（3.0 新增，服务器侧可读编号，客户端不得设置/修改）、ReferenceLink[]、BimSnippet、DocumentReferences、RelatedTopic。
- `Comment[]`：Guid、Date、Author、Comment 文本、Viewpoint（回指 .bcfv 的 Guid）。官方约束：**一条评论至多引用一个 viewpoint；一个 viewpoint 可被多条评论引用**；Comment 与 Viewpoint 至少有其一。
- `Viewpoints[]`：Viewpoint（bcfv 文件名）、Snapshot（图片文件名）、Index。**viewpoint 一经创建不可修改**，需改动就新增。
- 日期时间：xs:dateTime（ISO 8601）；**无时区后缀时一律按 UTC 解释**（BCF 特意偏离 ISO 8601 的"本地时间"语义）。

### 2.3 visinfo（.bcfv）与 viewpoint

- `Components`：`Selection[]`（高亮）、`Visibility`（`DefaultVisibility` + `Exceptions[]` + `ViewSetupHints`[SpacesVisible/SpaceBoundariesVisible/OpeningsVisible]）、`Coloring[]`（ARGB 十六进制，6 或 8 位）。
- 可见性应用顺序（官方规定）：① DefaultVisibility → ② ViewSetupHints → ③ Exceptions。且**不考虑空间包含传播**——隐藏 Storey 不代表隐藏其内构件。
- 优化规则（官方）：exceptions 应取"较小的一侧"（隐藏的少→DefaultVisibility=true；可见的少→false）；单列表超 1000 个构件应提醒用户（BCF 不适合大规模编码）。
- `Component`：`IfcGuid`（优先；22 字符 IFC GUID）+ 可选 `OriginatingSystem`、`AuthoringToolId`（无 IfcGuid 时的兜底）。
- 相机：`PerspectiveCamera`（ViewPoint/Direction/UpVector + FieldOfView 垂直视场角 0-180 开区间 + AspectRatio）或 `OrthogonalCamera`（+ ViewToWorldScale，即竖向世界尺度）二选一。AspectRatio 为 3.0 新增；读旧文件按 1.0 处理并按官方公式换算 FoV/ViewToWorldScale。
- 其他：`ClippingPlanes[]`（Location+Direction，Direction 指向被裁掉的不可见半空间）、`Lines[]`（3D 画线）、`Bitmap`（贴图：png/jpg + Location/Normal/Up/Height[米]）。
- 单位：**BCF 中所有数值固定为米（长度）与度（角度）**，与 IFC 工程单位无关，导出时需换算。

### 2.4 2.1 → 3.0 主要差异

新增 documents.xml/Documents 附件、JPEG 快照、ServerAssignedId、相机 AspectRatio；弃用 Topic/Index 与 Comment 级 Status/VerbalStatus（统一到 TopicType/TopicStatus）；明确 viewpoint-评论 1:N 映射、快照 ≤1500px、无时区即 UTC 等实现约定。BCF 3.0 XML 与 BCF 2.1 向后兼容（schema 演进而来）；JSON 化的 BCF（BCFjson）由 BCF-API 仓库承载 JSON schema。

### 2.5 自研系统实现 BCF 导入/导出要点

1. zip 内路径分隔符必须用 `/`，且**必须在 zip 中央目录写入目录条目**（官方给了正确/错误对比与 7z/unzip 校验法）；按 Topic GUID 建目录。
2. 导出 viewpoint：从相机取 ViewPoint/Direction/UpVector（注意 BCF 是右手系、Y 上惯例视软件而定，需做一次坐标变换）；透视相机把 three.js PerspectiveCamera.fov 直接写入 FieldOfView，正交把视口竖向世界高度写 ViewToWorldScale。
3. 可见性编码遵循"小侧 exceptions"规则；高亮/着色用 IfcGuid（见第 6 节编码），并存 OriginatingSystem=自家系统名。
4. 导入时忽略未知 XML 属性（官方要求不得报错），以兼容扩展。
5. 若无对应模型上下文（bcfv 里的构件 GUID 找不到），保留点位与快照，构件列表标记"未解析"。

来源（以下均核对原文）：
- BCF 3.0 技术文档（BCF-XML release_3_0/Documentation/README.md）：https://github.com/buildingSMART/BCF-XML/blob/release_3_0/Documentation/README.md
- BCF-XML 仓库与版本说明：https://github.com/buildingSMART/BCF-XML
- BCF-API（REST/JSON 版 BCF）：https://github.com/buildingSMART/BCF-API
- BCF 官方介绍页：https://www.buildingsmart.org/standards/bsi-standards/bim-collaboration-format/

## 3. IDS、bSDD 与 COBie 简述

- **IDS（Information Delivery Specification）**：buildingSMART 的机器可读信息交付规范，`.ids` 文件内含若干 Specification；每条 = **Applicability（适用对象）+ Requirements（要求）**，两者都由 Facet 组合：Entity、Attribute、Classification、Property、Material、PartOf。典型用法："所有墙必须有 FireRating 属性"。IDS 对属性的校验可直接吃 Pset/Qto（官方明确 Quantity 与 Property 在 IDS 中可互换校验），支持 xsd 数据类型与正则/枚举等复杂限制。对自研系统的价值：作为**发布门禁的自动化校验规则格式**，替代人工对表。
  来源：https://github.com/buildingSMART/IDS/blob/master/Documentation/UserManual/README.md ；官方页 https://www.buildingsmart.org/standards/bsi-standards/information-delivery-specification-ids/
- **bSDD（buildingSMART Data Dictionary）**：在线数据字典服务（canonical 数据库 + REST/GraphQL API），存放分类体系、属性、允许值、单位、多语言翻译；提供 Search/Manage 门户与 Test 环境。可与 IDS 联动（Classification/Property facet 引用 bSDD URI）。对自研系统：分类编码（如 Uniclass/中文分类标准）与属性字典不必自建，走 bSDD API 即可。
  来源：https://github.com/buildingSMART/bSDD/blob/master/README.md
- **COBie（Construction Operations Building information exchange）**：运维移交的 IFC 子集/交换规范（IFC2x3 对应 COBie 2.x MVD，IFC4 对应 COBie4 MVD），以电子表格式工作表组织：Facility/Floor/Space/Type/Component/Attribute/System/Document/Job/Spares 等；由美军工兵团发起、NIBS 标准化（COBie v3）。自研系统如需对接 FM/CAFM，可按 Type-Component 模型导出。
  来源：https://en.wikipedia.org/wiki/COBie ；https://www.thenbs.com/knowledge/what-is-cobie ；http://nibs.org/nbims/v3/cobie/

## 4. ISO 19650 CDE（公共数据环境）

### 4.1 状态模型

ISO 19650-1 定义信息容器（Information Container）在 CDE 中的四个状态与流转：

```
WIP（Work in Progress，团队内部工作中）
   →（质量门禁：检查/评审通过）
Shared（共享：供跨专业协调使用，禁止修改）
   →（授权/批准）
Published（发布：合同意义上的"适用施工/正式版"，全项目只读）
   →（项目结束/被替代）
Archived（归档留存）
```

配套的**容器元数据**（承袭 BS 1192）：状态码（suitability，如 S0–S7 表示"适用用途"从初稿到竣工，A1–A6 表示"授权程度"）、版本号（P01…草稿 / C01…正式）、分类码、责任方、日期。状态跃迁伴随审批动作与通知；Published 容器不可变，任何修改产生新版本。来源：
- BibLus《Container Information States ISO 19650: WIP, Shared, Published, Archived》：https://biblus.accasoftware.com/en/container-information-states-iso-19650-wip-shared-published-archived/
- Autodesk University《ISO 19650, the CDE and Autodesk Construction Cloud》（按状态分目录+权限的落地法）：https://www.autodesk.com/autodesk-university/article/ISO-19650-Common-Data-Environment-and-Autodesk-Construction-Cloud
- 12d Synergy CDE 指南（State 与 Status code 的区分）：https://www.12dsynergy.com/guides/common-data-environment/
- BIM Corner《CDE solution according to ISO 19650》（各状态权限矩阵）：https://bimcorner.com/cde-solution-according-to-iso-19650/

### 4.2 对模型服务器功能设计的启示

1. **以"容器"为中心而不是以"文件"为中心**：每个上传对象必须携带（或自动生成）状态、版本、状态码、责任方、时间戳元数据；服务器端把 WIP→Shared→Published→Archived 建成显式状态机，非法跃迁直接拒绝。
2. **Published 不可变 + 版本链**：发布即锁定内容哈希，后续修改生成新版本号（C01→C02…），天然支持审计追溯——这正好与 BCF/Issue 追踪、IDS 校验报告绑定（发布前跑 IDS 检查作为质量门禁）。
3. **权限随状态收敛**：WIP 仅团队可写、Shared 协调方可读、Published 全项目只读、Archived 管理员访问；实现为 RBAC + 容器状态联合判定。
4. **交付物计划**：TIDP/MIDP（信息交付计划）可作为服务器端的"待交付清单"，驱动通知与逾期提醒。

## 5. glTF 2.0 作为 BIM Web 传输格式的实践

### 5.1 为什么选 glTF 2.0

glTF 2.0 是 Khronos 的运行时 3D 资产格式（JSON 描述 + 二进制 buffer），PBR 材质、实例化（EXT_mesh_gpu_instancing）、量化（KHR_mesh_quantization）齐备；3D Tiles 1.1 直接以 glTF 为瓦片内容格式，且 3D Tiles 的元数据体系与 glTF 元数据扩展同源（3D Metadata Specification），是"IFC→Web"流水线的事实标准输出。

### 5.2 EXT_structural_metadata：把 BIM 属性带进 glTF

官方规范（CesiumGS/glTF 3d-tiles-next 分支，3D Tiles 1.1 引用）要点：

- 在 glTF 根对象挂 `EXT_structural_metadata` 扩展，内含 **schema**（classes + enums + properties，每个属性有 type/componentType/required/最小最大值等）与三类存储：
  - **Property Tables**（首选，BIM 场景）：面向"行=构件"的列式表，`count` 行 × 每属性一个 bufferView 值数组；支持比 GPU accessor 更丰富的类型（INT8/64、枚举、布尔、字符串等）。
  - Property Attributes / Property Textures：逐顶点/逐纹素元数据（点云、贴图数据）。
- 构件身份关联：**EXT_mesh_features** 扩展给 mesh primitive（或逐顶点）分配 `featureIds`（featureId attribute `_FEATURE_ID_0` 或 featureId 纹理），featureId 即属性表行号；再在行内放 IfcGuid 属性即可实现"拾取构件→查属性"。
- 实践建议：一个构件 = 一个 primitive（或共享几何 + featureId 表），行 0 存 IfcGuid、Pset 键值扁平化、Storey/Space 路径、体积面积等 Qto；schema 可外置（schemaUri）多模型共享。

来源：
- EXT_structural_metadata 规范原文：https://github.com/CesiumGS/glTF/blob/3d-tiles-next/extensions/2.0/Vendor/EXT_structural_metadata/README.md
- EXT_mesh_features：https://github.com/CesiumGS/glTF/blob/3d-tiles-next/extensions/2.0/Vendor/EXT_mesh_features/README.md
- 3D Tiles glTF 瓦片格式说明：https://github.com/CesiumGS/3d-tiles/blob/main/specification/TileFormats/glTF/README.adoc

### 5.3 几何压缩：Draco vs meshopt

- **KHR_draco_mesh_compression**：按 primitive 压缩（需列入 `extensionsRequired`，不支持时整个资产不可用），压缩率高，但压缩/解压改变数据布局、速度一般，适合"少而大"的网格；three.js 需配 `DRACOLoader`（WASM 解码器）。
- **KHR_meshopt_compression**（由 EXT_meshopt_compression 正式晋升，extreme 系从业者常用旧名）：按 bufferView 独立压缩，mode=ATTRIBUTES/TRIANGLES/INDICES，filter 支持 OCTAHEDRAL/QUATERNION/EXPONENTIAL/COLOR；设计目标是**解码极快（WASM SIMD 约 1 GB/s）+ 与 gzip/brotli 兼容叠加**，并保留未压缩 fallback buffer 以便老加载器；适合"多而碎"的 BIM 网格与流式加载，是目前 BIM Web 交付的推荐默认。与 KHR_mesh_quantization（顶点量化）组合收益最大。
- 权衡：Draco 比率更优但 CPU 开销与内存拷贝高；meshopt 可不解压直达 GPU 友好布局。自研系统建议：默认 meshopt + 量化；对超大静态地形/点云可加 Draco。

来源：
- KHR_meshopt_compression：https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_meshopt_compression/README.md
- KHR_draco_mesh_compression：https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md

### 5.4 three.js 加载 glTF 的方式

`GLTFLoader`（three/addons/loaders/GLTFLoader.js）是标准入口：

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const loader = new GLTFLoader();
loader.setDRACOLoader(new DRACOLoader().setDecoderPath('/libs/draco/')); // Draco 解码器
loader.setMeshoptDecoder(MeshoptDecoder);                                // meshopt 解码器
const gltf = await loader.loadAsync('model.glb');
scene.add(gltf.scene);
```

GLTFLoader 源码（three r1xx，`examples/jsm/loaders/GLTFLoader.js`）确认：`setDRACOLoader()` 处理 KHR_draco_mesh_compression、`setMeshoptDecoder()` 处理 EXT_meshopt_compression、内置 KHR_mesh_quantization/KHR_materials_* 支持；khr 场景材质、KHR_texture_basisu（KTX2）需另配 KTX2Loader。注意：three.js 不解析 EXT_structural_metadata/EXT_mesh_features（CesiumJS 原生支持），自研系统要么自写 propertyTable 解析器（按 3D Metadata 二进制表格式读 bufferView，实现简单），要么把属性拆到随包 JSON（自定义副作用最小、工具链最简单）。

来源：
- three.js GLTFLoader 源码与用法注释：https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/GLTFLoader.js
- three.js 示例（WebGL_loader_gltf）：https://github.com/mrdoob/three.js/tree/dev/examples

## 6. IFC GUID：22 字符 base64 编码与 JS 实现

### 6.1 规则

buildingSMART 官方《IFC-GUID》实现指南：IFC 实例使用 128-bit UUID（ISO/IEC 11578），为节省 1996 年时代（IFC 1.0，软盘交换）的存储，压缩为**定长 22 字符**字符串。字符表为**数字在前**的 base64 变体：

```
0-9 A-Z a-z _ $   （即 "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"）
```

128 bit ÷ 6 bit/字符 = 21.33 → 22 字符（132 bit 位，末尾补 4 个 0）。因首字符只承载前 6 bit 中高 2 位的有效信息，**首字符恒为 0–3**——可作为快速合法性校验。BCF 的 IfcGuid、IDS、IFC 文件 GlobalId 均用此编码。

### 6.2 算法与 JS 实现

官方引用的参考实现为 IfcOpenShell `guid.py`：首字节编 2 个 base64 字符；其后每 3 字节（24 bit）编 4 个字符，共 5 组 → 2 + 5×4 = 22。

```js
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

function ifcGuidCompress(uuidHex /* 32 位十六进制，无连字符 */) {
  const b = uuidHex.match(/../g).map(h => parseInt(h, 16));
  const enc = (v, len) => Array.from({ length: len }, (_, i) =>
    CHARS[Math.floor(v / 64 ** i) % 64]).reverse().join("");
  let out = enc(b[0], 2);
  for (let i = 1; i <= 13; i += 3)
    out += enc((b[i] << 16) | (b[i + 1] << 8) | b[i + 2], 4);
  return out; // 22 字符
}

function ifcGuidExpand(g /* 22 字符 */) {
  const dec = s => [...s].reduce((a, c) => a * 64 + CHARS.indexOf(c), 0);
  const b = [dec(g.slice(0, 2))];
  for (let i = 0; i < 5; i++) {
    const d = dec(g.slice(2 + 4 * i, 6 + 4 * i));
    for (let j = 0; j < 3; j++) b.push((d >> (8 * (2 - j))) % 256);
  }
  return b.map(x => x.toString(16).padStart(2, "0")).join(""); // 32 位 hex
}
```

要点：
- 标准带连字符的 UUID 需先去掉 `-`；生成新 GUID 用 `crypto.randomUUID().replaceAll('-','')` 后压缩。
- `CHARS.indexOf` 建议预建 Map/查找表（大模型解析数十万实例时是热点）；也可用 BigInt 一次位移实现，但分组实现与官方参考一致、无精度风险。
- 校验：长度 22、首字符 ∈ '0'..'3'、全部字符在表内；解码输出 32 位 hex 可再格式化为标准 UUID。
- 自研系统内部存储建议直接存 22 字符 IFC GUID 作为构件稳定 ID（与 IFC/BCF 互通零换算），另存服务器自增 ID 做外键。

来源：
- buildingSMART《IFC-GUID》官方实现指南：https://github.com/buildingSMART/technical.buildingsmart.org/blob/main/IFC-GUID.md
- IfcOpenShell guid.py 参考实现：https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.8.0/src/ifcopenshell-python/ifcopenshell/guid.py
- 官方论坛实现讨论：https://forums.buildingsmart.org/t/ifcgloballyuniqueids-spec-description-is-incorrect-proposal-to-simplify/1083

## 7. 单位与比例（unit/scale）处理

- IFC 的全局单位在 `IfcProject.UnitsInContext`（IfcUnitAssignment.Units）中声明，常见 `IfcSIUnit(Name=METRE, Prefix=MILLI, UnitType=LENGTHUNIT)` 即毫米；也支持 `IfcConversionBasedUnit`（如英尺：ConversionFactor=IfcMeasureWithUnit(ValueComponent=0.3048, UnitComponent=METRE)，甚至多级嵌套）与 `IfcDerivedUnit`。几何与属性的数值**不带单位、一律用工程单位**，解析端必须换算一次。
- 换算算法（IfcOpenShell `calculate_unit_scale` 的权威实现）：沿 IfcConversionBasedUnit 链累乘 ConversionFactor 到 IfcSIUnit；然后**前缀要按量纲幂次方作用**——`mm³ = (1e-3 m)³ = 1e-9 m³` 而不是 0.001 m³（即对 METRE/SQUARE_METRE/CUBIC_METRE 等纯长度幂量纲，prefix 乘子取 lengthExponent 次幂；Pa/N 等混合量纲保持线性）。`ifc_project_length × unit_scale = SI 米`。
- 工程实践（自研渲染管线）：
  1. 加载时读 LENGTHUNIT 计算 `scale`，把所有顶点/位移/包盒一次性乘到米，**管线内部统一米**；
  2. 属性面板/导出时按显示需求反算（毫米、面积 m²、体积 m³）；
  3. `IfcPlaneAngleMeasure` 默认度（若为弧度需另换算）；BCF 导出时相机与裁剪平面记得用米/度；
  4. 注意 IfcPropertySingleValue.Unit 可逐属性覆盖项目默认单位。

来源：
- IfcOpenShell unit 工具（prefixes/si_conversions/calculate_unit_scale）：https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.8.0/src/ifcopenshell-python/ifcopenshell/util/unit.py
- IfcSIUnit / IfcUnitAssignment 官方文档：https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcSIUnit.htm 、 https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcUnitAssignment.htm

## 8. 自研系统标准落地优先级建议

### P0（必须，直接决定互操作底线）
1. **IFC GUID 编解码**（第 6 节算法）：构件稳定主键，BCF/IDS/IFC 全链路依赖；实现 + 单测（首字符 0-3、22 字符、往返一致）。
2. **空间树解析**：IfcRelAggregates 层级 + IfcRelContainedInSpatialStructure 构件挂接 + IfcLocalPlacement 链求世界矩阵；前端结构树与拾取定位的根基。
3. **单位换算**：calculate_unit_scale 同款算法，含 mm²/mm³ 幂次陷阱。
4. **Pset/Qto 读取**：IfcRelDefinesByProperties → IfcPropertySet/IfcElementQuantity（含类型级继承）。
5. **glTF 导出流水线（meshopt + 量化 + EXT_mesh_features/structural_metadata 或自定义属性 JSON）**：Web 传输主路径；每构件带 IfcGuid。
6. **BCF 2.1 导入/导出**：外部协作最低公约数；zip 规范（正斜杠、目录条目）、markup/bcfv 核心字段、可见性小侧规则。

### P1（应做，提升协作与管控）
7. **BCF 3.0 全量支持**：documents、ServerAssignedId、AspectRatio、JPEG 快照；导入侧容忍未知字段。
8. **CDE 状态机（WIP/Shared/Published/Archived）+ 版本不可变 + 审批门禁**：模型服务器骨架。
9. **IDS 解析与基础校验**（Property/Entity/Classification 三类 facet 先行）：发布门禁自动化。
10. **bSDD API 集成**：分类/属性字典外部化。

### P2（可延后）
11. IFC4.3 基础设施实体与线性定位（IfcAlignment/IfcLinearPlacement）。
12. COBie / COBie4 导出（对接 FM）。
13. IFC 写出（.spf 生成器）/ MVD 全量校验 / IDS 复杂限制（正则、列表值）。
14. property textures、点云元数据、3D Tiles 瓦片化调度优化。

### 三个具体实现的技术注意事项汇总
- **BCF 导出**：zip 必须带目录条目且用 `/`；Topic 文件夹名 = 全小写 UUID；IfcGuid 一律小写集合内 22 字符编码；数值米/度；无时区时间按 UTC；viewpoint 不可变、评论↔viewpoint 1:N；可见性 exceptions 取小侧；导出后用 7z/unzip 自检。
- **IFC GUID**：字符表 `0-9A-Za-z_$`（数字在前）；2+5×4 分组编码；首字符 0-3 校验；hex→大整数或分组位移均可，注意无符号右移；全部往返单测对拍 IfcOpenShell。
- **空间树解析**：构件的包含关系唯一（防重复挂接）；门/窗靠 IfcRelFillsElement/IfcRelVoidsElement 找宿主；世界变换需沿 PlacementRelTo 递归（含 IfcMappedItem 嵌套变换累乘）；IfcSpace 也可能聚合在 Storey 下需一并纳入树；IFC4.3 中 Facility/Road 等新层级按 RelAggregates 泛化处理，不写死四层。

## 参考来源清单

1. buildingSMART：IFC 4.3 成为 ISO 标准 https://www.buildingsmart.org/ifc-4-3-formally-approved-and-published-as-an-iso-standard/
2. buildingSMART：IFC 标准页 https://www.buildingsmart.org/standards/bsi-standards/industry-foundation-classes/
3. IFC 4.3.2 官方文档（各实体页） https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/
4. ISO 16739:2018 https://www.iso.org/standard/70303.html
5. ISO 10303-21 STEP 物理文件语法 https://en.wikipedia.org/wiki/ISO_10303-21
6. IFC Header 实现指南 https://standards.buildingsmart.org/documents/Implementation/ImplementationGuide_IFCHeaderData_Version_1.0.2.pdf
7. BCF 3.0 技术文档 https://github.com/buildingSMART/BCF-XML/blob/release_3_0/Documentation/README.md
8. BCF-XML 仓库 https://github.com/buildingSMART/BCF-XML ；BCF-API https://github.com/buildingSMART/BCF-API
9. IDS 用户手册 https://github.com/buildingSMART/IDS/blob/master/Documentation/UserManual/README.md
10. bSDD https://github.com/buildingSMART/bSDD/blob/master/README.md
11. COBie https://en.wikipedia.org/wiki/COBie ；http://nibs.org/nbims/v3/cobie/
12. ISO 19650 CDE 状态 https://biblus.accasoftware.com/en/container-information-states-iso-19650-wip-shared-published-archived/ ；https://www.autodesk.com/autodesk-university/article/ISO-19650-Common-Data-Environment-and-Autodesk-Construction-Cloud ；https://bimcorner.com/cde-solution-according-to-iso-19650/
13. EXT_structural_metadata https://github.com/CesiumGS/glTF/blob/3d-tiles-next/extensions/2.0/Vendor/EXT_structural_metadata/README.md ；EXT_mesh_features https://github.com/CesiumGS/glTF/blob/3d-tiles-next/extensions/2.0/Vendor/EXT_mesh_features/README.md
14. KHR_meshopt_compression https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_meshopt_compression/README.md ；KHR_draco_mesh_compression https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md
15. three.js GLTFLoader https://github.com/mrdoob/three.js/blob/dev/examples/jsm/loaders/GLTFLoader.js
16. buildingSMART IFC-GUID 指南 https://github.com/buildingSMART/technical.buildingsmart.org/blob/main/IFC-GUID.md ；IfcOpenShell guid.py https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.8.0/src/ifcopenshell-python/ifcopenshell/guid.py
17. IfcOpenShell unit 工具 https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.8.0/src/ifcopenshell-python/ifcopenshell/util/unit.py
