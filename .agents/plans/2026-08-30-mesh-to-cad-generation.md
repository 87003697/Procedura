# Plan 3：Mesh-to-CAD 开放环生成

## 目标与边界

在已完成的 Plan 1/Plan 2 之后，把同一公开 run 中的 `image.png` 与
`plan.json` 交给 Procedura 现有 incremental draft，发布可编辑的
`final.scad` 与 `final.obj`。入口仍为：

```bash
bun run mesh-to-cad --mesh reference.stl -o outputs/reference-cad
```

成功后 `reference.json`、`image.png`、`plan.json` 保留，并增加最终 CAD
产物；不新增模型选择参数。

本切片是开放环：不做几何相似度/source-vs-generated 比较、自动
refine/repair、闭环迭代、STEP/build123d、材质/纹理处理或新 Mesh 格式。
Mesh-to-CAD 调用增量草稿的最小 opt-in seam，关闭其 per-part compile-fix
重试、connectivity/assembly/motion 拒绝重生及相关 repair 路径；默认调用
仍保持现有行为。
不恢复已经删除的诊断参数（`--import-only`、`--observe-only`、
`--scad-model`），不新增或运行 unit tests。

## 已确认事实

- 当前基线为 `f60b18d497292952cc623161f38b2ffbbd25a24b`，Plan 1/2 已在此实现。
- `scripts/mesh-to-cad.ts` 目前只调用 `planReferenceRun`；它保留私有
  canonical geometry，仅向 run 写 `reference.json`、`image.png`、`plan.json`。
- `src/pipeline/mesh-to-cad-plan.ts` 已复用 upstream 的默认模型、plan
  prompt、JSON parser/retry/review，并写出 Plan 2 的单张 isometric 图和计划。
- upstream incremental draft 可直接接收 `inputImage` 与公开 `inputPlan`；incremental draft 目前会自行
  规划，不能自动把已有 `plan.json` 当作权威输入。
- `web/server/scan.ts` 已识别 `reference.json`，`RunDetail` 已包含 host-owned
  reference metadata；`ModelView` 当前对 mesh 显示 `3D`，reference viewer
  通过 handle 读取私有网格。Studio 对普通历史 run 的行为必须不变。

## 设计

新增可删除的 `src/pipeline/mesh-to-cad-generation.ts` 编排旁路：解析
`PlanReferenceRunOpts`，先清理 Studio 识别的全部旧 final/final-derived
outputs（该清理非原子且保留 Plan 2/draft/intermediate），再调用
现有 `planReferenceRun`，然后以新写入的公开路径 `image.png` 和 `plan.json` 调用
`runIncrementalDraft`。Plan 2 planner 只接收单张公开 `image.png` 与 bounded Z-up/mm
summary；Plan 3 incremental generator 接收公开 `image.png` 与公开
`plan.json`。两次调用都永远不接收 handle、私有 canonical STL、源 bytes/path、
manifest、材质、纹理或 host metadata。生成文本只包含公开计划 JSON/固定说明。

为使计划真正被消费，在 `IncrementalDraftOpts` 增加 `inputPlan`（公开 JSON
路径），并在 `runIncrementalDraft` 中读取、解析、写入同一 run 的
`plan.json`，跳过 planner/reviewer；默认未传该参数时保持原行为。另增加
仅由 Mesh-to-CAD 传入 `inputPlan` 即启用严格开放环：单次生成尝试、关闭增量 repair/gate
重生，并要求每个计划 part 成功 commit 后才返回 `ok`。该模式同时强制 planned mode、忽略
`PROCEDURA_MAX_PARTS` 对已提供计划的截断并关闭
context views；既有 `draftResult.ok` gate 会在旁路晋级前拒绝 partial run。
Plan 3 直接调用 incremental draft；旁路负责 draft→final 晋级与最小 summary。

同一公开 run 的重复执行语义由该旁路完整拥有：在 Plan 2 前非原子地清理
Studio 识别的全部 final/final-derived 文件（含 painted、ortho、materials）及
`preview_final/`、`preview_painted/`、`preview_ao/`、`preview_ao_ortho/`、`preview_final.tmp/`、`_final_build/`、`motion/`，但保留 Plan 2、draft 和
intermediate evidence；然后执行 Plan 2 与开放环 CAD。已有旧 final 不作为输入，
删除前复用 outputDir/runsRoot 的既有目录安全契约，拒绝非目录及 runsRoot 之外的路径；
旁路传入 `inputPlan`。失败时可能保留
已写出的 draft/intermediate artifacts 与 Plan 2 artifacts，但不得
把旧 final 或半成品 final 宣称为本次成功结果。在进入生成前验证 `image.png` 与
`plan.json` 存在且计划可解析；生成阶段错误向上抛出，且旁路在返回前验证
`final.scad` 与 `final.obj` 均存在且非空。

Studio 只需把“存在 `reference.json` 且存在 final mesh”作为
Mesh-to-CAD 的 Reference/Generated 展示条件；draft mesh 仍可作为普通
`3D` fallback。Reference 使用现有 `ReferenceViewer`，Generated 使用 final
OBJ；无 final 时初始模式不得选择 Reference，不带 reference 的历史 run
仍显示原 `3D` 标签和 painted-first 默认。host-owned metadata 只读，不由
模型或生成文本覆写。

## Planned file boundary 与补丁意图

仅下列业务文件进入 planned patch；本计划文件与 patch 文件是本任务实际
修改的唯一文件。

- `scripts/mesh-to-cad.ts`：将 `--mesh ... -o ...` 及可选 roots 委托给新编排；
  仅在 cleanup → Plan 2 → generation 全部成功后输出 final 路径。
- `src/pipeline/mesh-to-cad-generation.ts`（新增）：先做上述完整 stale-final
  cleanup，再调用 `planReferenceRun`，校验公开 artifacts，构造不含私有信息的
  生成文本并直接调用 `runIncrementalDraft`，仅传入 inputPlan 以启用严格开放环；仅晋级
  draft.scad/obj 为 final.scad/obj 并写最小 final_summary.txt。
- `src/pipeline/mesh-to-cad-plan.ts`：增加仅 generation 使用的 `maxParts` seam，
  使 Plan 2 parser 完整消费计划；普通调用默认行为不变。
- `src/pipeline/draft-incremental.ts`：增加 `inputPlan` 旁路并跳过
  已有计划的 planner/reviewer；这是 unavoidable upstream seam，因为现有 draft
  没有消费外部计划或关闭 repair 的入口。默认路径字节/行为不变。
- `web/src/components/views/ModelView.tsx`：仅在同时有 reference metadata 与
  final mesh 时显示 Reference/Generated；draft 仍为普通 `3D`，无 final 的初始
  模式不得选择 Reference，且不改变已有 reference handle 读取契约。
- `README.md`：记录默认端到端入口、Plan 2 artifacts 保留、final 产物与
  开放环非目标，删除“仅 planning/不生成 CAD”的旧描述。

## Patch Intent

- `README.md`：区分 Plan2/Plan3 输入并记录开放环边界。[Planned Patch](./2026-08-30-mesh-to-cad-generation.planned.patch#L1)
- `scripts/mesh-to-cad.ts`：CLI 交给旁路拥有完整生命周期。[Planned Patch](./2026-08-30-mesh-to-cad-generation.planned.patch#L44)
- `src/pipeline/mesh-to-cad-plan.ts`：为 generation 增加 `maxParts` 无 cap seam，令两次 Plan 2 parser 完整消费计划且普通调用保持默认值。[Planned Patch](./2026-08-30-mesh-to-cad-generation.planned.patch#L69)
- `src/pipeline/draft-incremental.ts`：inputPlan 严格开放环、无 repair/context/noPlan/skip compile/plan cap override。[Planned Patch](./2026-08-30-mesh-to-cad-generation.planned.patch#L88)
- `web/src/components/views/ModelView.tsx`：final-only 成对模式与 draft 3D fallback。[Planned Patch](./2026-08-30-mesh-to-cad-generation.planned.patch#L173)
- `src/pipeline/mesh-to-cad-generation.ts`：安全清理后直接增量生成并晋级必需 final 产物。[Planned Patch](./2026-08-30-mesh-to-cad-generation.planned.patch#L196)

不修改 Plan 1/2 reference authority、scanner/types、upstream prompts 或
其他 pipeline。删除本能力时移除新增编排/旁路及上述最小注册，upstream
原有 text/image 行为与公开契约保持不变。

## 分阶段验收

1. **计划消费与保留**：静态验证同一 run 有 `reference.json`、单张
   `image.png`、有效 `plan.json`；生成调用使用这些文件，未把私有 handle、
   canonical mesh、source path、manifest、材质/纹理放入模型输入。
2. **SCAD/OBJ**：静态审阅确认 generation 传入 inputPlan 严格开放环，其 trajectory
   只走单次 per-part draft，compile-fix/connectivity/assembly/motion
   repair 未运行，且该模式忽略所有 skip/repair env overrides（含
   `PROCEDURA_SKIP_PART_COMPILE`）、`PROCEDURA_NO_PLAN`/`PROCEDURA_CONTEXT_VIEWS`，无
   context render attachments，promotion 不调用 `renderAOViews` 或 Blender；在获得授权的真实低预算运行中确认成功时产生非空
   `final.scad`、`final.obj`，Plan 2 artifacts 仍存在。
3. **OpenSCAD**：对 `final.scad` 做 OpenSCAD 编译并确认 OBJ 非空；不引入
   STEP/build123d 或额外视觉闭环服务。
4. **Studio/回归**：scanner 识别 reference run；Reference 与 Generated
   可切换；无 reference 历史 run 仍显示 `3D`、painted-first；普通
   `scripts/procedura.ts` text/image 路径保持不变。只做 typecheck、CLI
   help、静态 diff/apply 检查，不新增/修改/运行 unit tests。
5. **失败语义**：审阅确认重复运行先清除旧 final/final-derived artifacts；
   Plan 2 失败，或任一计划 part 未 commit/生成失败时 `ok` 为 false，旁路在
   promotion 前失败，旧/半成品 final 不会被宣称为本次成功；已有 Plan 2
   artifacts 与 draft/intermediate evidence 可读，下一次运行可重新开始。

## 回滚、风险与外部副作用

回滚为删除新增编排、移除 `inputPlan` 转发与读取、`maxParts` seam（并将两处
Plan 2 parser 参数恢复为 `DEFAULT_MAX_PARTS`）、stale-final 清理及标签/文档改动；
不触碰 Plan 1/2。主要风险是 upstream incremental
seam 与已有计划 schema 漂移，
通过同一 parser 和静态 apply 检查约束。真实验收会产生模型费用、计算时间、
OpenSCAD 进程及 run artifacts；这些外部副作用未在本次 planning 中执行。

## 状态

**Implementation：** Planned Patch 已获人类批准并从基线
`f60b18d497292952cc623161f38b2ffbbd25a24b` 落地。Final Patch 已冻结，
implementation-review Mode B 全范围复核为 `No findings`；运行时与外部验收仍按下节明确保留。

## Implementation Review

Mode B 对冻结的 Planned Patch、同基线 Final Patch、当前实现和已有验证证据进行了两轮
全范围独立复核。第一轮发现 promotion 在 summary 写入或最终非空检查失败时可能留下
`final.scad` 与 `final.obj`；实现随后在同一新增旁路内补充失败清理，并重新生成 Final
Patch。第二轮的 runtime、upstream isolation/simplification、privacy/UI/CLI、
plan/patch consistency 四个分区均返回 `No findings`（上游分区首次因未读取到 patch
返回 `Review Not Run`，使用全新隔离 reviewer 重试后为 `No findings`）。

Planned→Final 仅有一项接受差异：promotion 的 copy、summary 写入与非空检查进入同一
`try`，任一步失败时删除本次 `final.scad`、`final.obj`、`final_summary.txt` 后重新抛错。
该差异补全既定失败语义，不改变成功路径、文件边界、架构决策或公开接口。

Final Patch hunks：

- [README](./2026-08-30-mesh-to-cad-generation.final.patch#L1)
- [CLI](./2026-08-30-mesh-to-cad-generation.final.patch#L47)
- [inputPlan incremental seam](./2026-08-30-mesh-to-cad-generation.final.patch#L80)
- [Plan 2 maxParts seam](./2026-08-30-mesh-to-cad-generation.final.patch#L212)
- [Studio Reference/Generated](./2026-08-30-mesh-to-cad-generation.final.patch#L242)
- [Mesh-to-CAD generation orchestration and accepted promotion fix](./2026-08-30-mesh-to-cad-generation.final.patch#L268)

已有验证证据：`bun run typecheck` 通过；`bun run mesh-to-cad --help` 通过；6 个业务文件的
diff check 通过；Final Patch 通过同基线隔离 index 的 `git apply --check`，并可对当前
实现反向应用；当前实现恰好覆盖计划中的 6 个业务文件。遵守仓库约束，未新增、修改或
运行 unit tests。

用户随后明确授权向 `.env` 配置的 Venus `gpt-5.5` 服务发送单张参考图、bounded 几何
摘要与公开计划，并运行本机 Blender/OpenSCAD。真实验证使用
`outputs/transformer-robot-smoke-20260830/final.obj` 作为输入：第一次 run 生成 29-part
计划，在第 10 个部件遇到 Venus `4001` 后失败；`reference.json`、`image.png`、
`plan.json`、`draft.scad`、`draft.obj`、trajectory 与 `_draft_build` 均保留，三个
`final.*` 均不存在。同目录再次调用重新生成 31-part 计划并从 part 1 开始，31/31
部件均在 `[gen 1]` 编译成功，证明没有静默 skip/resume 旧计划；最终产生 121,770-byte
`final.scad`、4,016,458-byte `final.obj` 与 `verdict: ok` summary。独立使用 OpenSCAD
重新编译 final SCAD 成功，得到 32,207,224-byte STL，状态为 `NoError`。

另在 `outputs/mesh-to-cad-plan3-failure` 预置成功 final 后执行不可达 planner 的可控
失败：新 invocation 保留本次 288-byte `reference.json` 与 441,962-byte `image.png`，
并清除旧 `final.scad`、`final.obj`、`final_summary.txt`。成功 run 保留在
`outputs/mesh-to-cad-plan3-runtime`，私有 reference evidence 保留在 checkout 外的
`/tmp/procedura-plan3-reference-runtime`。仍未验证：Studio 中 Reference/Generated
人工交互，以及无 reference 历史 run 的实际 UI 回归。
