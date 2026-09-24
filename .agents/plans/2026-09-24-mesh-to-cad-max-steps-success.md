# Plan: Mesh-to-CAD 把 max-steps 视为成功

## 目标与完成标准

`--refine` 用尽轮次预算时，Procedura 仍写出完整的 `final.scad` / `final.obj`，verdict 是 `max-steps`、`ok` 为 false。Mesh-to-CAD 目前因此抛错退出。改为：verdict 为 `max-steps` 且最终产物完整时，命令成功；`error`、`aborted`、`give_up` 仍失败。

完成后：`bun run mesh-to-cad --refine` 在预算用尽、产物完整时退出码 0；`final_summary.txt` 仍记录真实 verdict。

非目标：不改上游 `refine.ok` 语义、不改 `give_up`、不改 Mapping adapter 或 `refine-direct.ts`。

## 关键发现

- `runDirectRefine` 在 `max-steps` 时调用 `writeFinalOutputs`，产物完整；`ok` 只在 `verdict === "ok"` 时为 true（`src/pipeline/refine-direct.ts` 第 708 行）。
- `runMeshToCadGeneration` 在产物检查之前就因 `!generated.refine.ok` 抛错（第 71–73 行）。2026-09-24 的 8 轮 Mapping refine 因此以 `Mesh-to-CAD refine ended with verdict: max-steps` 退出，尽管 `final.*` 已写出。
- 不开 refine 时 open-loop promotion 的 verdict 是 `ok`，不受影响。

## 方案与决策

只改 Mesh-to-CAD 的成功判定：`ok || verdict === "max-steps"`，随后仍要求 `final.scad` / `final.obj` 非空。放弃改上游 `ok`：那会改变 Procedura 自己的 ranking 语义。

## Patch Artifact

- **计划基线：** `0111892`
- **计划 Patch：** [2026-09-24-mesh-to-cad-max-steps-success.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-24-mesh-to-cad-max-steps-success.planned.patch>)
- **Final Patch：** [2026-09-24-mesh-to-cad-max-steps-success.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-24-mesh-to-cad-max-steps-success.final.patch>)

## Patch Intent

### `src/pipeline_mesh2code/mesh-to-cad-generation.ts`

- **`runMeshToCadGeneration` 成功判定（修改）：** `max-steps` 不再抛错；产物检查仍拒绝空的 `final.scad` / `final.obj`。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-24-mesh-to-cad-max-steps-success.planned.patch:25>)

### `README.md`

- **Mesh-to-CAD refine 成功条件（修改）：** 写明预算用尽且产物完整时命令成功，其他 verdict 仍失败。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-24-mesh-to-cad-max-steps-success.planned.patch:10>)

## 实现步骤

- [x] 修改成功判定并更新 README。
- [x] `bun run typecheck`；`git diff --check`。
- [x] 从基线生成 Planned / Final Patch。
- [x] 经 Issue #28、PR #29 合入 `main`（merge commit `8c3ab37`；feature commit `197b3b9` 与 Final Patch 一致）。

## 接口与兼容性

- `runMeshToCadGeneration` 的参数和返回类型不变。
- 上游 `RefineResult.ok` 不变；Mesh-to-CAD CLI 在 `max-steps` 时退出码从 1 变为 0。

## 上游隔离（AGENTS.md）

- **修改的上游 SpatiaOS 文件：** 只有 `README.md` 的 Mesh-to-CAD 一节。
- **修改的本 fork 文件：** `mesh-to-cad-generation.ts`，这是唯一检查 refine verdict 的编排点。
- **删除新能力后：** 回退这两个文件，Mesh-to-CAD 再次把 `max-steps` 当失败；上游 refine 不变。
