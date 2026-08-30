# Plan: Mesh-to-CAD Plan 1B — 多格式导入与 Z-up 规范化

> **历史状态：** 本计划及其未实施 Planned Patch 仅作为设计演进记录保留，不得再直接实施。其需求已经由 [低侵入完整 Plan 1](./2026-08-30-mesh-to-cad-plan-1-low-intrusion.md) 重新收缩、实现并通过 Mode B；后续 Plan 2/3 必须以低侵入 Plan 1 的 Final 状态为基线。

## 目标与完成标准

在已完成且冻结的 Plan 1（STL/OBJ 私有导入与 Viewer）之后补齐第一阶段输入合同：可信宿主接受 STL、OBJ、PLY、GLB、glTF 与 3MF，把每种输入转换成私有的 canonical binary STL；canonical geometry 始终是 Z-up、毫米制、triangle soup，summary、Viewer 和后续观察阶段只消费这份统一几何。run 继续只保存 original format 与 opaque handle，Agent 不获得原文件、原路径或 canonical bytes。

**本阶段是严格的 geometry-only 管线。** 系统只把顶点、三角面、尺寸、坐标变换和拓扑视为有效输入；UV、材质 ID、颜色、MTL、图片贴图及其他表面外观不参与 canonical geometry、summary、Viewer、Observer 或后续 CAD 生成，也不得成为 Agent 的判断依据。原始单文件可能因私有审计副本而仍包含内嵌 UV/材质数据，但这些数据不会被解析或公开；外部 MTL、纹理图片等 sidecar 不复制进 reference handle，因此系统不承诺可恢复或展示原始外观。

完成必须同时满足：六种格式的静态表面 Mesh 均能通过同一 CLI 导入；STL/OBJ/PLY/3MF 按 Z-up 解释，glTF/GLB 的标准 Y-up/米制几何被转换为 Z-up/毫米；PLY polygon 被三角化；glTF 默认场景的静态 TRIANGLES、node/world transform 与实例被烘焙；3MF core build、component transform、build transform 与声明单位被展开；summary 尺寸与 Viewer 展示都来自无纹理 canonical STL；带 UV/MTL/图片贴图的输入只保留几何且在 Viewer 中以统一无纹理材质显示；失败导入不发布 handle；旧 v1 private handle 明确要求重新导入；历史普通 run 与通用 `/api/file` 不变。

本计划不支持 FBX、USD/USDZ、point-cloud-only PLY、OBJ 材质/纹理、glTF skin/animation/morph、Draco/Meshopt、非 TRIANGLES primitive，以及 3MF 材质、纹理、required extension、beam/lattice。这里的“支持 OBJ/glTF/3MF”只表示支持其中符合合同的几何，不表示支持其材质或纹理能力；纹理缺失不能阻止几何导入，也不能改变几何结果。当前阶段不增加轴向或单位 override，不调用 LLM/OpenSCAD，也不生成 CAD。

## 关键发现

- Plan 1 当前把原始 STL/OBJ 同时用作 summary 与 Viewer 输入；要避免六套前端 loader 和后续渲染语义分叉，格式差异应在 Authority 私有边界内结束。
- 现有 `STLMesh`、`loadSTL`、`loadOBJ` 与 `writeSTL` 已能把 STL/OBJ 收敛为 binary STL，不需要新增 npm 依赖。
- `/Applications/Blender.app/Contents/MacOS/Blender` 是 notarized Blender 5.1.1 arm64；在获准的 sandbox 外 background、Python/operator probe 均 exit 0，已核实 PLY/glTF/STL operators 及计划参数存在，3MF operator 不存在。此前 sandbox 内 exit 139 是 Metal device 枚举隔离导致；本计划不把它描述为安装损坏，也不在计划阶段再次启动 Blender。
- Blender Python 自带 `zipfile`、`ElementTree` 与 `struct`，足以在同一受控运行时解析 3MF core model，而无需引入 zip/XML npm 依赖。
- 原 Plan 2 planned patch 仍把 raw source 当渲染输入；Plan 1B 通过后，Plan 2 必须改为 canonical render seam 并重新完成 Mode A，Plan 3 也必须在修订后的 Plan 2 基线上重新生成与审查。

## 方案与决策

采用混合 canonicalizer：STL/OBJ 在 TypeScript 进程内复用现有 loader/writer；PLY、GLB/glTF 由一个受控 Blender Python asset 导入并展开 evaluated world-space triangles；3MF 在同一 Blender Python 运行时内使用标准库解析 build graph 并直接写 binary STL。Authority 在私有 staging 目录完成转换与测量，成功后才原子发布 handle 目录。

未采用“前端按六种格式分别加载”，因为 summary、Viewer 与后续 Observer 会形成三套格式语义；未采用纯 TypeScript 手写 glTF/3MF，因为会重复成熟 scene/import 能力并新增 three/zip/XML 依赖；未采用纯 Blender 原生方案，因为当前 Blender 没有 3MF operator。混合方案保留一个 canonical seam，同时只为新增格式启动已经存在的 Blender 依赖。

## Patch Artifact

- **计划基线：** `fac191ed49f55fcc2e0f23897e986042249f59fe` 加 [Plan 1 Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch>) 后的代码树。
- **计划 Patch：** [2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch>)
- **批准前校验：** 在上述组合基线上运行 `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch`。

## Patch Intent

### `.env.example`

- **Blender 配置说明（修改）：** 明确 Blender 同时承担新增参考格式规范化，STL/OBJ 导入仍不依赖 Blender；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:10>)

### `README.md`

- **输入格式说明（修改）：** 把用户可见输入从 STL/OBJ 扩展为六种格式；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:25>)
- **canonical 与限制说明（新增）：** 记录 Z-up/mm 规则、Blender 依赖和明确不支持的 glTF/3MF 能力，使验收预期可见；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:35>)

### `scripts/_normalize_reference_blender.py`

- **`Point`、`Triangle`、`Matrix` 与 `IDENTITY`（新增类型/常量）：** 为 Blender scene 与 3MF graph 共用同一三角面和变换表示；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:72>)
- **`write_binary_stl`（新增函数）：** 把已规范化三角形写为带单位法线的 canonical binary STL，并拒绝空 Mesh；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:84>)
- **`gltf_document`（新增函数）：** 从 glTF JSON 或 GLB JSON chunk 读取几何合同元数据；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:99>)
- **`validate_gltf`（新增函数）：** 只沿默认 scene 递归检查可达 nodes/meshes（去重并确定性拒绝 cycle/越界），沿可达 primitive 的 accessor/bufferView 检查 Meshopt，再拒绝其可达引用中的 Draco、动画、skin、morph 与非 TRIANGLES primitive；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:116>)
- **`blender_triangles`（新增函数）：** 从 evaluated dependency graph 提取并烘焙实例、world transform 与三角化结果；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:186>)
- **`convert_with_blender`（新增函数）：** PLY 保持 Z-up/mm，glTF 由 Blender 转为 Z-up 后只做米到毫米缩放；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:209>)
- **`matrix_from_3mf`（新增函数）：** 把 3MF 的 12 数值表示转换为统一 4×4 矩阵；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:219>)
- **`multiply`（新增函数）：** 按 component graph 层级组合 parent/child 变换；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:229>)
- **`transform_point`（新增函数）：** 应用组合变换并把 3MF 声明单位换算为毫米；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:236>)
- **`local_name`（新增函数）：** 以 namespace 无关方式识别 3MF 非目标扩展元素；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:245>)
- **`convert_3mf`（新增函数）：** 读取 core model、单位、resources 与 build，并仅对 build/component 可达对象拒绝 beam/lattice，同时拒绝 required extension；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:249>)
- **`emit`（新增内部函数）：** 递归展开 component graph 和 build transform，并拒绝 component cycle；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:282>)
- **`main`（新增函数）：** 只接受四种需要外部规范化的格式，并把错误作为非零退出交给 Authority；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:328>)

### `scripts/mesh-to-cad.ts`

- **`help` 标题（修改）：** CLI 明确当前切片包含 Z-up 规范化；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:353>)
- **`help` 格式列表（修改）：** CLI 使用说明公开六种输入格式；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:362>)
- **CLI 顶层导入（修改模块逻辑）：** 等待异步 Authority 导入，避免进程在 canonical 发布前结束；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:371>)
- **summary 输出（修改模块逻辑）：** 尺寸显式标记为毫米；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:380>)

### `src/pipeline/mesh-to-cad-reference.ts`

- **`importReferenceRun` 返回契约（修改函数）：** pipeline 变为异步，handle 复用和 run descriptor 形状不变；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:389>)
- **`importReferenceRun` 新导入分支（修改函数）：** 等待 Authority 完成 canonical 发布后再写 run descriptor；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:397>)

### `src/reference/authority.ts`

- **`PrivateManifest` 与格式导出（修改类型）：** private schema v2 分离 original format、source 与 canonical 文件，公开格式扩展为六种；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:431>)
- **`ReferenceSummary`（修改类型）：** summary 增加明确毫米单位；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:441>)
- **`ReferenceViewerMesh`（修改类型）：** Viewer seam 固定声明 canonical STL；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:451>)
- **`formatOf`（修改函数）：** 接受六种扩展名并保持显式拒绝消息；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:463>)
- **`ReferenceAuthority.importReference`（修改方法）：** 在 private staging 中规范化、测量并写 manifest，全部成功后才发布 handle，失败清理 staging；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:478>)
- **`inspectReferenceSummary`（修改方法）：** 只从 canonical STL 测量，但保留 original format 供用户识别；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:522>)
- **`readReferenceViewerMesh`（重命名/修改方法）：** Viewer 永远获得 canonical STL bytes，不再按原格式分支；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:541>)
- **`#record`（修改私有方法）：** 解析 schema v2 canonical path，旧 handle 返回明确重新导入错误；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:548>)

### `src/reference/normalization.ts`

- **`ReferenceFormat`（新增类型）：** 作为 Authority 与 canonicalizer 共用的六格式词汇；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:573>)
- **`normalizeReference`（新增函数）：** STL/OBJ 进程内转换，其余格式通过有超时和错误回传的 Blender 子进程写入指定 staging 输出；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:578>)

### `src/render/ao.ts`

- **共享 Blender seam（修改模块连接）：** AO renderer 改为使用并继续兼容导出统一的 `BLENDER_BIN`；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:625>)
- **旧 resolver（删除模块逻辑）：** 移除 AO 私有的重复候选列表和解析函数；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:637>)

### `src/render/blender.ts`

- **`BLENDER_CANDIDATES`（新增常量）：** 为渲染与规范化提供同一绝对路径候选列表，并补齐 macOS 标准应用路径；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:667>)
- **`resolveBlenderBin` 与 `BLENDER_BIN`（新增函数/常量）：** 显式 `PROCEDURA_BLENDER_PATH` 优先，其次检查绝对候选，最后真正调用 `Bun.which("blender")` 查找 PATH；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:674>)

### `web/server.ts`

- **`handleReferenceMesh`（修改函数）：** 调用 canonical Viewer seam 并固定返回 STL MIME，loopback 与 cache 规则不变；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:693>)

### `web/server/scan.ts`

- **`readRunDetail`（修改函数）：** run detail 接受六种 original format，但仍只投影 handle/format；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:711>)

### `web/shared/types.ts`

- **`RunDetail.reference.format`（修改类型）：** 前端共享 DTO 与六格式 descriptor 对齐；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:728>)

### `web/src/components/MeshViewer.tsx`

- **`REFERENCE_FORMATS` 与 `referenceSource`（新增常量/修改函数）：** 接受六种 original format 的虚拟 reference source，同时保持 handle 校验；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:741>)
- **`loadModel`（修改函数）：** reference endpoint 一律按 canonical STL 解析，普通 artifact 仍按真实扩展名选择 loader；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.planned.patch:760>)

## 实现步骤

- [ ] 建立 canonicalizer。输入：六种本地源文件；改动：共享 Blender resolver、TS normalization seam 与 Blender Python asset；验证：用最小合成 PLY、GLB、self-contained/sidecar glTF、3MF build/component fixtures 检查 triangle count、单位、轴向、transform 和拒绝语义，并用 UV + MTL + `map_Kd` OBJ 确认贴图不影响 canonical triangle soup；完成：每种成功输入产生可被现有 `loadSTL` 读取的 Z-up/mm、无纹理 binary STL。
- [ ] 升级 Authority。输入：canonicalizer 与 Plan 1 private root；改动：schema v2 staging/publish、summary、Viewer DTO 与异步 pipeline/CLI；验证：六格式导入、handle 复用、失败无 handle 目录、v1 handle 明确拒绝、run 不含路径或 bytes；完成：summary 与 Viewer 数据均来自同一 canonical 文件。
- [ ] 衔接 Studio。输入：六格式 descriptor；改动：server MIME、scan/shared type 与 Viewer canonical 分支；验证：六种 original format 的 reference-only run 均能发现和查看，带纹理输入显示为统一无纹理几何，非 loopback/错误 handle/通用 `/api/file` 行为不变；完成：前端无需新增 PLY/glTF/3MF 或图片纹理 loader。
- [ ] 回归与交付。验证：root/web typecheck、CLI help、六格式 import-only smoke、Studio production API 与人工 Viewer、普通历史 run、`git diff --check`；完成：全部允许的非 unit 验证有记录，Plan 2 尚未实施。

## 接口与兼容性

`ReferenceFormat` 扩展为六种；`ReferenceSummary` 新增 `units: "mm"`；`ReferenceAuthority.importReference` 与 `importReferenceRun` 变为异步；private manifest 升级为 schema v2；`readReferenceSource` 更名为 `readReferenceViewerMesh` 且固定返回 STL。run 的 `reference.json` 继续为 schema 1 `{handle, format}`，不暴露 private path。既有 v1 private handle 不迁移，需要重新导入；功能尚未发布，不增加兼容分支。

Plan 2 与 Plan 3 的已审查 Patch 不在本计划内修改。Plan 2 在实施前必须把 raw `sourcePath` 渲染输入改为 canonical render seam，重新生成自己的 Planned Patch 并完成 Mode A；随后 Plan 3 必须以修订后的 Plan 2 planned state 为基线重新生成 Planned Patch，并再次完成 Mode A，旧链不能直接实施。

## 验证

禁止新增、修改或运行 unit tests。实施阶段必须验证六格式正常路径，以及空 Mesh、point-cloud PLY、缺少几何所需 glTF buffer sidecar、非 TRIANGLES、skin/animation/morph、Draco/Meshopt、无 build/循环/required-extension 3MF、旧 handle 与 root 隔离等失败路径；另用真实 UV + MTL + 图片贴图 fixture 验证几何导入成功、外部纹理 sidecar 不进入 handle、canonical/summary 不受纹理影响且 Viewer 不显示贴图。运行 root/web typecheck、CLI help、Studio production API/人工 Viewer 和 `git diff --check`。计划阶段只进行 Python 语法编译、Patch 链接检查、组合基线 `git apply --check` 与 diff 静态检查，不执行真实格式导入。

## 风险与回滚

主要风险是 Blender 版本的 glTF/PLY import 行为和 3MF transform 解释与 fixture 不一致；实施验收用非对称轴向、非毫米单位、嵌套 component 与多实例 fixture 检测。失败时不会发布 handle。回滚删除两个 normalization 文件和共享 resolver，恢复 AO 内部 resolver、Authority v1 与 Studio 双格式 union；已发布 schema v2 handle 在回滚后不可读，因此本阶段获准实施后应先在临时 private root 验收再用于正式数据。

## 外部副作用与授权

计划校验不转换 Mesh。实施与验收会把源文件和 canonical STL 写入指定 private root；PLY、GLB/glTF 与 3MF 会启动本机 Blender 子进程并消耗本地计算资源。不会联网、调用 LLM/OpenSCAD 或修改源文件。

## 状态

**当前阶段：** Planning — Planned Patch 待链接校验、Mode A 与用户批准；业务实现文件保持 Plan 1 状态。
