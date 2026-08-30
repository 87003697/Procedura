# Plan: Mesh-to-CAD Plan 3 — 开放环 CAD 生成衔接

## 目标与完成标准

在 Plan 1 导入/Viewer 与 Plan 2 受控 Brief 已验收的基础上，把 host-validated brief 和四张受控 PNG 接入现有 incremental draft，输出可编辑 `final.scad` 与 `final.obj`。不传 `--import-only` 或 `--observe-only` 时执行生成；两个诊断模式继续保留。

完成必须同时满足：现有 `runProcedura` / `runIncrementalDraft` 被复用，不出现第二套 SCAD 生成器；四张 supplied views 进入 plan 和逐部件调用；Mesh-to-CAD 固定 incremental=true、refine=false；Studio 对带 reference 的生成 run 显示 Reference/Generated，而无 reference 的历史 run 仍显示原 3D 标签和 painted-first 默认；普通 text/image Procedura 行为不变。

非目标：source-vs-generated 比较、Chamfer/VoxBlame、自动 refine/repair、闭环评分、STEP/build123d、更多 Mesh 格式和 unit tests。

## 关键发现

- incremental draft 已有单张 supplied image 和多张 generated refs，只需增加有序 `inputImages` 并避免编号冲突。
- Plan 2 已提供 validated brief 和实际 render paths，Plan 3 只需薄 orchestration 层调用现有 `runProcedura`。
- Reference Viewer 已在 Plan 1 存在；本阶段只对同时含 reference/generated 的 run 使用条件式 Generated 标签。

## 方案与决策

新增独立 `src/pipeline/mesh-to-cad.ts` 作为生成编排，复用 `observeReferenceRun` 与 `runProcedura`；导入和观察模块继续保持可独立调用。多图能力放入现有 incremental seam，默认未提供时行为不变。保持开放环，避免首个生成验收被几何修复系统扩大。

## Patch Artifact

- **计划基线：** `fac191ed49f55fcc2e0f23897e986042249f59fe` 加依次成功应用的 Plan 1 与 Plan 2 planned patches。
- **Plan 1 patch：** `/Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch`
- **Plan 2 patch：** `/Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch`
- **计划 Patch：** [2026-08-30-mesh-to-cad-generation.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch>)
- **批准前校验：** 在临时树依次应用 Plan 1、Plan 2 后运行 `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch`。

## Patch Intent

### `README.md`
- **开放环生成说明（新增）：** 说明默认生成命令、输出和明确不做比较/refine 的边界。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:9>)

### `scripts/mesh-to-cad.ts`
- **生成 pipeline import（修改模块）：** 接入独立 `runMeshToCad`，保留两个诊断入口。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:32>)
- **`Args.scadModel`（新增字段）：** 允许选择现有增量 SCAD 模型。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:40>)
- **`help` 生成选项（修改函数）：** 记录 scad model；省略诊断 flag 即为默认生成。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:48>)
- **`parse` 模式规则（修改函数）：** 只拒绝两个诊断 flag 同时出现，不传时进入生成。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:57>)
- **CLI 三分支编排（修改模块）：** import-only、observe-only 和默认生成分别调用已存在的专用入口，并仅在生成结果存在时报告模型。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:75>)

### `src/pipeline/draft-incremental.ts`
- **`IncrementalDraftOpts.inputImages`（新增字段）：** 接受有序的 host-provided reference views，保留单图 option。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:101>)
- **`runIncrementalDraft` 输入归一化（修改函数）：** 拒绝单图/多图与 text-only 的歧义组合，并统一为绝对路径列表。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:109>)
- **`runIncrementalDraft` 主图准备（修改函数）：** 列表首图继续使用既有 `image.png` contract。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:126>)
- **`runIncrementalDraft` 其余 views（修改函数）：** 复制并附加剩余 supplied images，再从后续编号生成 extra refs，确保 plan/逐部件调用看到全部四图。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:135>)

### `src/pipeline/mesh-to-cad.ts`
- **`RunMeshToCadOpts`（新增类型）：** 在观察参数上增加 SCAD 模型选择。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:159>)
- **`RunMeshToCadResult`（新增类型）：** 扩展完整观察结果并附加现有 Procedura generation，使 CLI 仍能读取 descriptor/summary/brief。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:167>)
- **`generationText`（新增函数）：** 把可选 intent 与 validated brief 转为增量生成说明。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:171>)
- **`runMeshToCad`（新增函数）：** 复用观察结果和四图调用 `runProcedura`，固定 incremental/no-refine 并返回观察与生成结果。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:180>)

### `src/pipeline/procedura.ts`
- **`RunProceduraOpts.inputImages`（新增字段）：** 把多张宿主图片加入现有公共选项，仅供 incremental draft。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:202>)
- **`runProcedura` 多图转发（修改函数）：** 原样把 inputImages 传给增量 draft，其他模式不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:210>)

### `web/src/components/views/ModelView.tsx`
- **`ModelView` 条件式标签（修改函数）：** 只有带 reference 的生成 run 把 3D 标为 Generated，历史 run 继续显示 3D。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.planned.patch:222>)

## 实现步骤

- [ ] 多图 seam。输入：Plan 2 四张 render paths；改动：`inputImages` 与 Procedura 转发；验证：四图复制/编号/附件顺序，单图、text-only 和 generated extra refs 回归；完成：现有 draft 能消费全部受控 views。
- [ ] 开放环生成。输入：validated brief、四图、可选 intent/model；改动：`runMeshToCad` 与 CLI 默认分支；验证：真实低预算运行产生可重编译 SCAD、非空 OBJ，refine 未运行，diagnostic modes 保持；完成：首个 editable Mesh-to-CAD 结果。
- [ ] Studio/回归。改动：条件式 Generated 标签；验证：Reference/Generated 切换、历史 3D/painted-first、普通 text-only 和 `--image` Procedura、root/web typecheck、CLI help、diff check；完成：没有既有行为回归。

## 接口与兼容性

新增默认 Mesh-to-CAD generation、`--scad-model`、`RunProceduraOpts.inputImages` 和生成 pipeline API。保留 `--import-only`、`--observe-only`、Plan 1 manifest/Viewer 与 Plan 2 brief。现有 Procedura 调用不提供 inputImages 时行为不变。

## 验证

不新增、修改或运行 unit tests。实施阶段运行真实低预算模型、OpenSCAD 编译、非空 OBJ、Reference/Generated Viewer、诊断模式、普通 text/image 流程、root/web typecheck、CLI help 和 diff 检查。几何相似度不属于本阶段验收。

## 风险与回滚

主要风险是四图增加上下文成本，以及文件编号与 generated refs 冲突；通过固定四图和统一编号验证。回滚只需删除生成 pipeline，并移除多图 seam、CLI 默认分支和条件式标签；Plan 1/2 仍完整可用。

## 外部副作用与授权

实施验收需要真实 Observer 与 CAD 模型调用、Blender 四视图和 OpenSCAD 编译，会产生模型费用、计算时间、private Mesh 副本与 run artifacts；需在实施前确认授权。

## 状态

**当前阶段：** Planning — 依赖 Plan 1、Plan 2 批准与实现后实施。
