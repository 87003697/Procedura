# Plan: Mesh-to-CAD pipeline isolation and Procedura adapter

## 目标与完成标准

将 Mesh-to-CAD 专属 pipeline 模块从 `src/pipeline/` 移到可删除的
`src/pipeline_mesh2code/`，并把其对现有 Procedura draft/refine 的参数组合集中到
`procedura_adapter.ts`，使 adapter 成为唯一构造 Mesh-to-CAD 执行 profile 的调用点。删除 upstream 中仅为该功能引入的旧顶层 profile 字段和重复分支。完成后 Mesh-to-CAD CLI 行为保持不变；普通 Procedura、Refiner、
mapper、Reference Authority 与 Studio 行为不变；删除该旁路只需移除新目录及 CLI 接线。

本计划不实现 Mapping Feedback Agent/Artifact，不重写 draft/refine，不迁移共享的
`src/reference`，不新增或修改 unit tests，不提交或推送。

## 关键发现

- 当前基线为 `639df61`，Mesh-to-CAD 的三个模块仍在 `src/pipeline/`，CLI 从那里动态导入。
- `src/reference/authority.ts` 同时被 Web/Studio 使用，是共享 trust boundary，不是可整体搬迁的
  Mesh-to-CAD 私有模块。
- 现有 `runProcedura`、`runIncrementalDraft` 和 `runDirectRefine` 是稳定执行实现；复制它们会
   产生两套生命周期，因此旁路应通过窄 adapter 复用，而不是重建执行器。
- upstream 中的 `inputPlan`、`inputImages`、`refineMode`、`draftPromotion` 是此前
  Mesh-to-CAD 引入的顶层字段；本计划删除其顶层 profile 表面，改由单一
  `externalExecution` 上下文承载。底层 draft/refine 的通用输入消费保留，所有 Mesh-to-CAD
  固定值集中在 adapter。
- 迁移后模块需要把对 upstream `pipeline`、`config`、`llm`、`render`、`reference` 的相对导入
  调整为跨目录路径；功能代码本身不应改变。

## 方案与决策

采用“新目录 + 单一 adapter + 最小 CLI seam”：

1. 将 `mesh-to-cad-reference.ts`、`mesh-to-cad-plan.ts`、`mesh-to-cad-generation.ts` 移到
   `src/pipeline_mesh2code/`。
2. 新增 `procedura_adapter.ts`，唯一负责 Mesh-to-CAD 对 `runProcedura` 的固定参数组合，
   包括 `inputPlan`、ordered reference images、direct refine 和 open-loop promotion。
3. `mesh-to-cad-generation.ts` 只调用 adapter；不再直接拼装 Procedura options。
4. 在 `RunProceduraOpts` 中新增 `externalExecution` 并删除旧的四个 Mesh-to-CAD 顶层字段。
   这是尚未承诺稳定的 Mesh-to-CAD 实验接口的 breaking 收敛；普通 Procedura 的其他字段
   与默认行为不变。

相比在旁路复制 draft/refine，复用现有执行实现减少重复生命周期和行为漂移；相比一次性重构
所有 upstream options，当前迁移范围更小、可回滚且不改变已验收行为。

## Patch Artifact

- **计划基线：** `639df61` (`origin/main`)
- **计划 Patch：** [2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch>)
- **批准前校验：** `git apply --check /Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch`

## Patch Intent

### `scripts/mesh-to-cad.ts`
- **CLI 动态导入（修改）：** 将唯一 Mesh-to-CAD 入口切换到隔离目录，用户命令和参数保持不变；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:6>)

### `src/pipeline/mesh-to-cad-generation.ts`
- **旧模块（删除）：** 移除 upstream pipeline 中的 Mesh-to-CAD 编排实现，避免新功能逻辑继续占据 upstream 目录；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:20>)

### `src/pipeline/mesh-to-cad-plan.ts`
- **旧模块（删除）：** 移除 upstream pipeline 中的 Mesh-to-CAD planning 实现；等价内容由新旁路模块承载；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:106>)

### `src/pipeline/mesh-to-cad-reference.ts`
- **旧模块（删除）：** 移除 upstream pipeline 中的 Mesh-to-CAD reference 编排实现；共享 Authority 保持原位；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:266>)

### `src/pipeline/procedura.ts`
- **`RunProceduraOpts.externalExecution`（新增/替换）：** 将 Mesh-to-CAD 所需的 plan、ordered images、refine mode 和 promotion profile 收敛为一个可选上下文，并删除旧的散落顶层字段；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:357>)
- **旧顶层 profile 字段（删除）：** 删除仅服务 Mesh-to-CAD 的 `refineMode` 与 `draftPromotion` 顶层选项，避免 upstream 继续暴露旁路专属配置；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:380>)
- **Phase 1 输入透传（修改）：** 仅从 `externalExecution` 向通用 incremental draft 透传输入，避免 Mesh-to-CAD 参数在多个顶层字段散落；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:387>)
- **Phase 2 promotion/refine dispatch（修改）：** 仅从 `externalExecution` 读取 profile 和 reference images，保留普通 Procedura 的默认 promotion/refine 选择；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:403>)
- **Direct refine reference 透传（修改）：** 把可选多视图作为通用执行输入传给既有 direct refine，不让 upstream 判断 Mesh-to-CAD 业务；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:421>)

### `src/pipeline_mesh2code/mesh-to-cad-reference.ts`
- **`importReferenceRun` 与相关类型（新增）：** 在隔离目录保留原有私有导入、opaque handle 和 run artifact 行为，仅调整跨目录 import；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:677>)

### `src/pipeline_mesh2code/mesh-to-cad-plan.ts`
- **`planReferenceRun` 与相关类型（新增）：** 在隔离目录保留原有 planning、reference image 和 plan.json 生成行为，仅调整跨目录 import；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:517>)

### `src/pipeline_mesh2code/mesh-to-cad-generation.ts`
- **`runMeshToCadGeneration`（新增）：** 在隔离目录保留清理、Plan→draft/refine、final artifact 检查和错误语义，并通过 adapter 调用 Procedura；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:435>)

### `src/pipeline_mesh2code/procedura_adapter.ts`
- **`MeshToCadProceduraOpts`（新增）：** 集中 Mesh-to-CAD 对现有 Procedura 的窄输入合同，避免调用方散落固定 profile；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:772>)
- **`runMeshToCadProcedura`（新增）：** 复用现有 `runProcedura` 执行 draft/refine，固定 Mesh-to-CAD 所需 profile，不改变普通 Procedura 默认路径；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.planned.patch:775>)

## 实现步骤

- [ ] 从基线应用迁移和 adapter patch；验证：`git apply --check`；完成：三个旧模块消失，新目录包含四个模块。
- [ ] 扫描全部 import 与 CLI 入口；验证：`rg` 无旧 `src/pipeline/mesh-to-cad-*` 引用；完成：唯一入口指向 `pipeline_mesh2code`。
- [ ] 做静态/转译验证；验证：`git diff --check`、`bun build scripts/mesh-to-cad.ts --no-bundle`；完成：CLI 与新模块可转译。
- [ ] 做 upstream seam 收敛审阅；验证：确认旧 Mesh-to-CAD 顶层字段和 profile 分支已删除，
  `externalExecution` 只由 adapter 构造并由 upstream 透传；完成：不存在第二处 Mesh-to-CAD
  profile 构造，普通 Procedura 默认行为未变。
- [ ] 做普通路径回归审阅；验证：确认 upstream 三个 seam 的默认值和非 Mesh-to-CAD 调用未变；完成：删除旁路后无普通行为依赖新目录。

## 接口与兼容性

- 用户 CLI、`runMeshToCadGeneration` 和 reference/plan artifact 格式不变。
- 新 adapter 是 Mesh-to-CAD 私有 API；不向普通 Procedura 暴露新业务概念。
- `src/reference`、`draft-incremental.ts`、`refine-direct.ts` 的执行行为不变；
  `procedura.ts` 删除 Mesh-to-CAD 专用顶层字段，改用新的可选上下文。旧 Mesh-to-CAD 实验
  字段不提供兼容 alias；普通 Procedura 的其他字段和默认行为不变。
- 删除旁路需要移除 `src/pipeline_mesh2code/` 与 CLI 动态 import；无需 artifact 迁移。

## 验证

- 结构：旧路径无生产引用，新路径所有相对 import 可解析。
- 转译：CLI bundle-free build 成功；`git diff --check` 成功。
- 行为：不运行 unit tests；通过静态检查和必要的 CLI help/入口检查确认普通路径未受影响。
- 隔离：确认没有修改 mapper、Reference Authority、Web/Studio、Refiner 或 Executor 逻辑。

## 风险与回滚

- 风险：迁移后的相对路径错误；由 bundle-free build 和 stale import 扫描发现。
- 风险：adapter 固定 profile 与旧 generation 调用不一致；由逐字段 diff 与 CLI 入口审阅发现。
- 风险：Git 暂未暂存时显示删除+新增；内容不变，暂存/提交时可识别为 rename。
- 回滚：删除 `src/pipeline_mesh2code/`、恢复 CLI 动态 import，并恢复三个旧文件；upstream 其余文件无需回滚。

## 状态

**当前阶段：** Implemented and reviewed

## Implementation Review

- **Mode A：** 修订后全范围复审为 `No findings`；修订内容包含 upstream `procedura.ts`
  的旧 Mesh-to-CAD 顶层字段删除与 `externalExecution` 收敛。
- **Planned → Final：** 无差异；Final Patch 与 Planned Patch 字节级相同，无额外实现偏差。
- **Mode B：** 全范围复审为 `No findings`；确认迁移三模块、CLI seam、`externalExecution`
  透传和 adapter 固定 profile 与计划一致。
- **验证证据：** 干净 `639df61` 基线的 Planned/Final `git apply --check` 通过；Patch Intent
  链接检查覆盖 13 个 hunks；`bun build scripts/mesh-to-cad.ts --no-bundle` 与
  `git diff --check` 通过；未新增、修改或运行 unit tests。
- **Final Patch：** [2026-09-02-mesh-to-cad-pipeline-isolation.final.patch](</Users/zhiyuanma/.codex/worktrees/fdfe/Procedura/.agents/plans/2026-09-02-mesh-to-cad-pipeline-isolation.final.patch>)
