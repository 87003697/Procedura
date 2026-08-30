# Plan: Mesh-to-CAD Plan 1 — 私有参考导入与 Studio Viewer

> **历史状态：** 本文及其 frozen Planned/Final Patch 保留为早期 Plan 1A 审计记录，不再作为当前实现依据。当前权威实现与验收记录见 [低侵入完整 Plan 1](./2026-08-30-mesh-to-cad-plan-1-low-intrusion.md)。

## 目标与完成标准

建立第一个可独立验收的垂直切片：可信宿主把 CAD Z-up STL/OBJ 导入私有 reference store，run 只保存 opaque descriptor；现有 Studio 能发现 reference-only run，并通过专用 loopback endpoint 显示原始 Mesh。本阶段不调用模型、不运行 Blender/OpenSCAD，也不生成 CAD。

完成必须同时满足：`bun run mesh-to-cad --import-only --mesh <path> -o <run>` 可导入，`--reference-handle` 可复用；原始 Mesh 和原路径不进入 run；Authority 公开返回仅含 descriptor、有限 summary 或 Viewer bytes；private root 与 runs/workspace root 双向不重叠；STL/OBJ 均能在 Studio Reference 模式显示；普通历史 run、painted-first 默认和通用 `/api/file` 行为不变。

非目标：Observer、AO/固定视图、LLM、brief、多图输入、SCAD/OBJ 生成、Generated 标签、比较、评分、refine、repair 和 unit tests。

## 关键发现

- 现有 `loadSTL`、`loadOBJ` 与 `computeBBox` 足以在 Authority 内验证格式、三角形和有限 dimensions，无需几何新依赖。
- Studio 的最小接入面是 run scan、`RunDetail`、专用 server route、`MeshViewer` 和 Model 页面；不需要新增上传 UI。
- 本阶段必须保留 durable `--import-only`，后续计划只扩展同一 CLI，不创建临时命令。

## 方案与决策

采用进程内 `ReferenceAuthority`：私有 manifest、路径与 Mesh 解析均留在深模块内部；CLI/pipeline 和 Studio 只传 opaque handle。Human Viewer raw bytes 使用独立 loopback-only route，不并入 artifact namespace。选择这一最小切片，是因为它能先独立回答“系统是否安全导入并正确显示 Mesh”，而不把模型质量或 CAD 生成问题混入验收。

## Patch Artifact

- **计划基线：** `fac191ed49f55fcc2e0f23897e986042249f59fe`
- **计划 Patch：** [2026-08-30-mesh-to-cad-reference-viewer.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch>)
- **批准前校验：** `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch`
- **后续基线：** Plan 2 必须在本 patch 已应用的 planned state 上生成和校验。

## Patch Intent

### `.env.example`
- **Reference root 配置说明（新增）：** 记录 CLI 与 Studio 共用的私有 Mesh 根目录，并说明 run 只保存 opaque handle；只新增配置文档。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:9>)

### `README.md`
- **Import/Viewer 使用章节（新增）：** 给出永久 `--import-only` 命令、目录隔离和 Studio 展示说明；用户可独立运行本阶段。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:24>)

### `package.json`
- **`scripts.mesh-to-cad`（新增）：** 暴露同一条后续阶段继续扩展的 CLI 入口，不改变现有命令。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:49>)

### `scripts/mesh-to-cad.ts`
- **`Args`（新增类型）：** 定义导入/复用、roots、output 与 durable import-only 模式。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:63>)
- **`help`（新增函数）：** 展示本阶段支持的两个 source 入口和目录参数。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:72>)
- **`parse`（新增函数）：** 强制 `--import-only`、output 必填和 mesh/handle 二选一，使错误在任何文件复制前失败。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:91>)
- **CLI 顶层导入（新增模块逻辑）：** 只调用 `importReferenceRun`，并打印 handle、格式和尺寸，不触发外部程序或模型。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:112>)

### `src/pipeline/mesh-to-cad-reference.ts`
- **`ImportReferenceRunOpts`（新增类型）：** 约束导入 run 所需 source 与 roots。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:140>)
- **`ImportReferenceRunResult`（新增类型）：** 返回 output、无路径 descriptor 和 bounded summary。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:148>)
- **`isInside`（新增函数）：** 保证 output 位于 Studio runs root，便于发现且不扩大 artifact namespace。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:154>)
- **`importReferenceRun`（新增函数）：** 固定完成 source 二选一、root 隔离、导入/复用、summary 和仅含 descriptor 的 `reference.json` 写入。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:159>)

### `src/reference/authority.ts`
- **`ReferenceFormat`、`PrivateManifest`、`ReferenceDescriptor`、`ReferenceSummary`、`ReferenceSource`（新增类型）：** 分离私有布局与三个公开返回契约；公开类型不含路径、顶点或面。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:197>)
- **`formatOf`（新增函数）：** 只接受 STL/OBJ，不做格式或轴向猜测。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:222>)
- **`loadMesh`（新增函数）：** 复用现有 loader 形成 Authority 内部可测量表示。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:229>)
- **`isInside`（新增函数）：** 支持 private root 与 forbidden roots 的双向重叠判断。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:233>)
- **`ReferenceAuthority` 与 constructor（新增类）：** 封装私有 root，并在导入前拒绝它与 runs/workspace root 重叠。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:238>)
- **`importReference`（新增方法）：** 验证 Mesh 后复制进 opaque-handle 私有目录，只返回 descriptor。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:251>)
- **`inspectReferenceSummary`（新增方法）：** 仅返回格式、Z-up、triangle count 和有限 dimensions。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:269>)
- **`readReferenceSource`（新增方法）：** 为本地 Viewer 按 handle 返回格式和 bytes，不返回路径。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:284>)
- **`#record`（新增私有方法）：** 校验 handle 并在模块内部解析 manifest/source path。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:289>)

### `web/server.ts`
- **Authority import（新增模块连接）：** Studio 复用同一 Authority 契约读取 reference。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:306>)
- **`referenceAuthority`（新增模块状态）：** 从 active repo 环境读取 private root，并同时禁止 runs root 与当前 workspace。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:314>)
- **`handleReferenceMesh`（新增函数）：** 仅接受 loopback 和 handle，按确定格式返回 bytes；通用 `/api/file` 保持不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:325>)
- **Reference route（新增模块配置）：** 注册独立只读 endpoint。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:353>)

### `web/server/scan.ts`
- **`RUN_MARKERS`（修改）：** 让只有 `reference.json` 的 run 可被发现。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:366>)
- **`detectShape`（修改）：** 复用 sparse shape 表示 reference-only run。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:375>)
- **`readRunDetail`（修改）：** 只投影经过格式检查的 handle/format，API 不获得私有路径。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:383>)

### `web/shared/types.ts`
- **`RunDetail.reference`（新增字段）：** 为前端提供 nullable descriptor；历史 run 为 null。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:407>)

### `web/src/components/MeshViewer.tsx`
- **`referenceSource`（新增函数）：** 解析显式 `reference:<format>:<handle>` source 并确定 loader。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:422>)
- **`meshUrl`（新增函数）：** reference 走专用 route，普通文件继续走 `fileUrl`。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:429>)
- **`fetchText` / `fetchBuffer`（修改函数）：** STL/OBJ 两种读取均使用统一 source URL。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:444>)
- **`loadModel`（修改函数）：** reference 使用 manifest format，普通 artifact 继续按扩展名加载。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:460>)

### `web/src/components/RunView.tsx`
- **`VIEWS` 可用性（修改）：** reference-only run 可以进入既有 Model 页面。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:474>)

### `web/src/components/views/ModelView.tsx`
- **`Mode`（修改类型）：** 增加显式 Reference 模式。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:487>)
- **`ModelView` 初始模式和选项（修改函数）：** 保留 painted-first 与已有 3D 默认，只在 reference-only run 默认 Reference。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:496>)
- **`ModelView` Reference 分支（修改函数）：** 把 descriptor 转为 Viewer virtual source；已有生成模型渲染不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch:509>)

## 实现步骤

- [ ] 可信导入。输入：Z-up STL/OBJ 或已有 handle、output/runs/reference roots；改动：实现 Authority、pipeline、CLI 和公开 manifest；验证：STL/OBJ 各导入一次、handle 复用、无效格式/空 Mesh/root 重叠在复制前失败，静态确认公开返回无 path；完成：run 仅含 `reference.json`，private store 才含源 Mesh。
- [ ] Human Viewer。输入：descriptor；改动：scan/type/loopback route/Viewer/Model 页面；验证：本机 STL/OBJ 显示，非 loopback 403，未配置 503，错误 handle 404，`/api/file` 无法寻址 private root，历史 painted run 默认不变；完成：reference-only run 可发现和查看。
- [ ] 回归与交付。验证：root/web typecheck、CLI help、Studio production API/人工 Viewer、普通历史 run、`git diff --check`；完成：全部非 unit 验证有记录。当前 checkout 缺少依赖时 typecheck 明确记为未验证，不在计划阶段安装。

## 接口与兼容性

新增 `PROCEDURA_REFERENCE_ROOT`、`--import-only`、`reference.json` schema 1、`RunDetail.reference` 与 `/api/reference/mesh`。输入只支持 CAD Z-up STL/OBJ。现有 Procedura CLI、artifact API、上传、历史 run 和 Model 默认行为不变。

## 验证

不新增、修改或运行 unit tests。实施阶段验证正常导入、handle 复用、格式/空 Mesh/root 冲突、loopback/非 loopback、STL/OBJ Viewer、历史 run 回归、root/web typecheck、CLI help 和 diff 检查。本阶段不运行 LLM、Blender 或 OpenSCAD。

## 风险与回滚

主要风险是 CLI 与 Studio 使用不同 private root，表现为 Viewer 404；通过共同环境变量和 README 检测。回滚时删除三个新增 TS 文件并移除 package/env/README 和 Studio 的 nullable reference 接入；历史 artifacts 无需迁移。

## 外部副作用与授权

计划校验无外部副作用。实施验收会把用户提供的 Mesh 复制进指定 private root，并启动本地 Studio 读取它；不调用模型或外部生成程序。

## 状态

**当前阶段：** Implemented / Mode B clean。

## Implementation Review

- Mode B：No findings。
- Planned → Final：无差异；Final patch 与 Planned patch byte-identical。
- 验证：CLI help；STL/OBJ import + handle reuse；private/run layout；invalid format、empty mesh、output overlap、root overlap failures；Studio info/runs/detail；STL/OBJ loopback route；bad handle 404；generic `/api/file` 403；`git diff --check` 与 baseline `git apply --check`。
- 未验证：root/web TypeScript typecheck，因缺少 `node_modules` / `tsc`。
- 未运行：unit tests、LLM、Blender、OpenSCAD。
- Final Patch：[2026-08-30-mesh-to-cad-reference-viewer.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch>)；由于 P→F byte-identical，各 hunk 沿用准确 Planned 行号：[env:9](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:9)、[README:24](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:24)、[package:49](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:49)、[CLI:63](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:63)、[pipeline:140](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:140)、[authority:197](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:197)、[server:306](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:306)、[scan:366](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:366)、[types:407](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:407)、[MeshViewer:422](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:422)、[RunView:474](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:474)、[ModelView:487](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.final.patch:487)。
