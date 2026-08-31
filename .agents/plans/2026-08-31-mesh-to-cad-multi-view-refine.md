# Plan 4：Mesh-to-CAD 多视图闭环修正

## 目标与完成标准

在现有 Plan 2 → Plan 3 主线上增加默认关闭的 `--refine`，但不建立并行生命周期：
`planReferenceRun` 仍负责公开参考图与 `plan.json`，随后
`mesh-to-cad-generation.ts` 只调用一次统一的 `runProcedura`。该 module 完成增量
draft 后，根据同一个 `refine` 值选择既有 draft promotion 或 whole-model direct refine。

完成时，不带 flag 的调用仍是开放环 Plan 3；带 flag 时参考 Mesh 产生
`isometric/front/back/left/right/top/bottom` 七张公开图片，同一组有标签图片同时供
增量生成和 direct refine 使用。只有 pipeline 返回成功且非空 `final.scad/final.obj`
存在时 Mesh-to-CAD 才报告成功。模型不得获得 reference handle、canonical/source Mesh、
私有路径、manifest、材质或纹理。

本计划只做 multi-view image-space review；Plan 5 再做 3D 配准、尺寸误差、Chamfer、
feature/surface 校验。本计划不新增 reviewer DTO、prompt、修正协议、循环、renderer、
Studio 页面、模型/轮数参数或 unit tests。

## 关键发现

- 基线 `949d208f503c87b32c4bd12bf0033e86f0d8983c` 已提供多视图 reference、
  `PlanReferenceRunResult.referenceImages`、`IncrementalDraftOpts.inputImages` 和
  `inputPlan`，Plan 4 不需要修改 reference authority、renderer、planner 或 incremental
  generator。
- `runProcedura` 本来就是 draft → refine/promotion 的深 module；Plan 3 绕过它直接调用
  `runIncrementalDraft` 并手工复制 final，才造成两套 lifecycle。Plan 4 应消除这处绕行，
  而不是在其后再挂 `runDirectRefine`。
- `runDirectRefine` 已拥有固定七视图 CAD render、critic、measurement、patch、
  compile/regression/connectivity gate、轮次 artifacts 与 final writer；唯一缺口是它只能
  从 workspace 读取单张 `image.png`。
- 同目录重跑已经清除 final-derived artifacts；将 `_refine_steps/` 纳入同一清理集合后，
  refine 与非 refine 重跑都不会展示旧轮次证据。
- `runProcedura` 的标准 promotion 与 Plan 3 已冻结的 open-loop promotion 在 preview 和
  summary verdict 上不同；统一 lifecycle 必须显式选择 Plan 3 profile，不能让无 flag 路径
  多跑 Blender 或改变既有 artifacts。
- Plan 3 的 per-part generation 仍使用完整公开 `plan.json` 作为 whole-object text；统一
  handoff 必须保留该文本，不能以新的固定句子替换。

## 方案与决策

调用结构固定为：

```text
planReferenceRun
  → runProcedura({
      incremental: true,
      inputImages: planned.referenceImages,
      inputPlan: plan.json,
      redo: true,
      refine
    })
      → Phase 1: runIncrementalDraft
      → Phase 2: promoteDraftAsFinal | runDirectRefine
```

`--refine` 只是 Phase 2 的配置，不与 Plan 2/3 并行。`mesh-to-cad-generation.ts`
不 import `runDirectRefine`，不直接调用 `runIncrementalDraft`，也不再复制
`draft.* → final.*`。`runProcedura` 的 interface 仅补齐已有下游已经支持的
`inputImages/inputPlan`，显式选择 direct refine，并在 direct mode 中把同一
`inputImages` 传给 `runDirectRefine`。`refine-direct.ts` 只把可选有序图片编码成现有 critic/patch
共用的 `referenceParts`；未提供时保留单图和 text-only 行为。

七张 reference 以 isometric 为第一张 authoritative 图，六个 ortho 为补充图。CAD 侧仍
沿用 direct refine 内部固定七视图；双方依靠 view label 表达对应关系。Plan 4 不导出
direct refine 的内部 view 常量，也不让它反向感知 Mesh-to-CAD。

`PROCEDURA_REFINE_MODE=agent` 仍是普通 Procedura 的 A/B override；Mesh-to-CAD 显式传入
`refineMode:"direct"`，所以外部环境不会把七图闭环静默降级为 agent 单图 review。无 flag
路径显式传入 `draftPromotion:"open-loop"`，保持原有 `verdict: ok` summary 且不生成
`preview_final/`。

删除测试：移除 CLI flag、Mesh-to-CAD 的七视图选择、`runProcedura` 的两个输入透传，
以及 direct refine 的可选 `referenceImages` 后，Plan 1/2 reference 与 planning 合同、
普通 Procedura 单图/text-only 行为及 incremental implementation 均保持原样。

## Patch Artifact

- **计划基线：** `949d208f503c87b32c4bd12bf0033e86f0d8983c`
- **计划 Patch：** [2026-08-31-mesh-to-cad-multi-view-refine.planned.patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch>)
- **批准前校验：** `git apply --check /Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch`

## Patch Intent

### `README.md`

- **统一 pipeline 的 opt-in 示例（新增）：** 说明 `--refine` 启用同一 Plan 2 → Plan 3
  pipeline 的 whole-model Phase 2，而非另起流程；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:9>)
- **范围与 artifact 语义（修改）：** 区分默认 promotion、multi-view image-space refine
  与 Plan 5 的 3D 校验；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:26>)

### `scripts/mesh-to-cad.ts`

- **参数 DTO（修改）：** 增加默认关闭的 `refine` 布尔值；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:43>)
- **help 与 parse（修改）：** 增加唯一 `--refine` flag，不增加模型、轮数、相机或独立命令；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:57>)
- **调用转发（修改）：** 仅在 opt-in 时向 Mesh-to-CAD module 传入 `refine:true`；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:80>)

### `src/pipeline/mesh-to-cad-generation.ts`

- **依赖方向（修改）：** 删除 incremental/promotion 依赖，只依赖统一 `runProcedura`；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:90>)
- **stale cleanup 与七视图（修改）：** 清理旧 refine evidence，并在 side-path 内声明 Plan 4 reference set；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:108>)
- **opt-in interface（修改）：** 从 planning options 中剥离 `refine`，避免传入 Plan 2；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:121>)
- **统一 lifecycle handoff 与成功 gate（修改）：** 一次调用 `runProcedura`，传入图片、计划及 `refine`，并以其结果和 final artifacts 验收；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:132>)

### `src/pipeline/procedura.ts`

- **promotion 验证依赖（修改）：** 引入 open-loop 原子校验与失败清理所需的文件操作；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:196>)
- **`RunProceduraOpts.inputImages/inputPlan`（新增）：** 暴露 incremental implementation
  已存在的两个输入，让统一 pipeline 能消费 host-produced Plan 2 artifacts；
  [查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:206>)
- **Phase 2 选择 interface（新增）：** 用窄 enum 显式选择 direct/agent 与 standard/open-loop promotion，默认保持普通 Procedura；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:218>)
- **Phase 1 透传（修改）：** 将 ordered images 与 host plan 交给 incremental draft；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:232>)
- **Phase 2 dispatch（修改）：** promotion 使用所选 profile，refine 使用显式 mode 并复用共同 options；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:246>)
- **Phase 2 多图透传（修改）：** 仅 direct refine 接收同一 ordered images；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:269>)
- **promotion profile 参数（修改）：** 将 profile 局部化到既有 promotion implementation；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:284>)
- **open-loop 原子 promotion（修改）：** 保留 Plan 3 的 summary、verdict、无 preview 与失败清理，standard profile 不变；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:304>)

### `src/pipeline/refine-direct.ts`

- **`DirectRefineOpts.referenceImages`（新增）：** 增加唯一可选的 ordered reference
  interface；现有 `RefineOpts` 和 agent refine 不变；
  [查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:364>)
- **`referenceParts` 构造（修改）：** 显式多图按 label/primary 编码，否则保持单图与
  text-only payload；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.planned.patch:386>)

## 实现步骤

- [x] **先合并 Plan 3 lifecycle seam。** 输入：Plan 2 的 `referenceImages` 和
  `plan.json`；改动：`runProcedura` 接收并透传两个输入，
  `mesh-to-cad-generation.ts` 改为唯一调用者；验证：默认路径返回
  `verdict: ok` 且生成非空 `final.scad/final.obj`、不新增 preview，失败删除半成品 final，
  且 generation text 与基线相同；完成：不存在 direct
  `runIncrementalDraft` 或手工 promotion。
- [x] **接通 opt-in multi-view Phase 2。** 输入：同一组七张公开图片；改动：
  `refine:true` 选择七视图，direct refine 接收 ordered references；验证：静态检查同一
  图片数组同时进入 Phase 1 和 Phase 2；完成：critic 与 patch 两个既有调用点共用完整
  `referenceParts`。
- [x] **公开最小 CLI 和文档。** 输入：现有 Mesh-to-CAD CLI；改动：新增无值
  `--refine`；验证：help 输出；完成：默认命令不变，没有平行命令或额外调参。
- [x] **实施期静态验证。** 对冻结 patch 运行 `bun run typecheck`、CLI help、
  `git diff --check` 和业务文件边界检查；不得新增、修改或运行 unit tests。
- [x] **另获授权后真实验收。** 核对公开 reference、trajectory、`_refine_steps/`、final
  artifacts 与 verdict。用户已授权 LLM、Blender/OpenSCAD 以及发现后的 Blender 5
  compatibility 修复；真实运行完成 6/6 轮并按合同以 `max-steps` 结束。

## 接口与兼容性

- CLI 仅新增默认关闭的 `--refine`。
- `runMeshToCadGeneration` 新增 `refine?: boolean`；Plan 1/2 DTO 不变。
- `RunProceduraOpts` 新增 incremental-only `inputImages/inputPlan`，对应下游既有
  interface；普通 `inputImage` 仍转成一张 primary 图。另新增可选 `refineMode` 与
  `draftPromotion`；默认值保持普通 Procedura，Mesh-to-CAD 显式固定 direct/open-loop。
- `runDirectRefine` 兼容扩展可选 `referenceImages`；普通 single-image/text-only
  调用不变。
- 默认 Plan 3 仍写 `verdict: ok / open-loop promoted` summary，且不新增 final preview；
  普通 Procedura 的 standard promotion 仍为 `verdict: skipped` 并尝试生成 preview。
- Refine 非 `ok` 时保留 upstream best-effort evidence，但 Mesh-to-CAD CLI 不报告成功。
- Studio 不新增页面；继续展示 generic artifacts。

## 验证

- 规划期隔离副本已通过 `bun run typecheck` 与 `git diff --check`。
- Final Patch 需在干净基线副本通过 `git apply --check`，并完成包含 renderer 修复的
  implementation-review Mode B；旧版旁路设计的 review 结论作废。
- 真实模型、Blender/OpenSCAD 已执行，结果见 Runtime Validation；GitHub、commit/push 未执行。
- Plan 5 的 3D 指标和硬门槛不属于本 patch。

## 风险与回滚

- 七张 reference 加七张 CAD 增加 vision token、延迟和 render 成本；由 `--refine`
  隔离，默认 Plan 3 不承担 review 成本。
- `draftPromotion` 与 `refineMode` 是统一 pipeline 上新增的两个窄选择；默认值完全保持普通
  Procedura 行为，Mesh-to-CAD 固定使用自己的已冻结 promotion 与 direct refine 语义。
- 修改的 upstream 文件为 `procedura.ts`（统一 pipeline 输入透传）、
  `refine-direct.ts`（多图 reference payload）和 `_render_parts_color_blender.py`（以稳定的
  Blender node type 取得既有 Principled BSDF）。前两处是统一 lifecycle 的最小 seam；
  renderer 的一行修复是既有 direct refine 在 Blender 5 上工作的必要 compatibility 修正，
  不含 Mesh-to-CAD 反向依赖。删除 Plan 4 后仅需移除 flag、七视图选择和两个可选透传；
  renderer 修复可独立保留，Plan 1/2、incremental generator 和普通 Procedura 合同不需迁移。
- 回滚无需迁移 artifacts；移除 flag、七视图选择和两个可选透传即可。

## Implementation Review

- **首次 Mode B：** renderer 修复前的五文件实现为 `No findings`。
- **Planned → Final：** 用户授权的真实运行暴露 Blender 5 将默认 shader 节点本地化，
  final-only 增加 `_render_parts_color_blender.py` 一行：从英文显示名查找改为稳定的
  `BSDF_PRINCIPLED` node type。其余五个业务文件与 Planned Patch 一致。
- **Final Patch：** [2026-08-31-mesh-to-cad-multi-view-refine.final.patch](</Users/zhiyuanma/.codex/worktrees/37b9/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view-refine.final.patch>)。
- **最终 Mode B：** `No findings`。复审确认 Planned → Final 只新增稳定的
  `BSDF_PRINCIPLED` node-type lookup；修复 Blender 5 本地化故障而不改变 interface 或
  pipeline 行为。工作树与 Final Patch 一致，`max-steps` 正确保留 evidence 且不报告 CLI 成功。
- **验证证据：** `bun run typecheck`、`bun run mesh-to-cad --help`、`git diff --check`
  已再次通过；Final Patch 在基线 `949d208f503c87b32c4bd12bf0033e86f0d8983c`
  的干净临时 clone 中通过 `git apply --check`，应用后六个业务文件逐文件匹配当前工作树。
- **测试边界：** 按仓库规则未新增、修改或运行 unit tests；真实 LLM、Blender/OpenSCAD
  结果见 Runtime Validation，未执行 Studio 交互。

## Runtime Validation

- 用户授权后以历史 transformer robot `final.obj` 运行真实 `--refine`。沙箱内两次 Blender
  均在 Metal device 探测阶段 exit 139；沙箱外运行成功生成 isometric 加六个 ortho 共七张
  reference，并把七图附加到 Plan 2 与每个 Plan 3 generation call。
- Plan 2 生成 26-part plan；Plan 3 的 26/26 parts 全部在 `[gen 1]` 编译成功，用时
  1713 秒，得到 105,190-byte `draft.scad` 与 4,350,733-byte `draft.obj`。
- 首次 Direct refine 在 parts-colour renderer 阶段未生成七张 `color-*.png`。独立低分辨率
  诊断定位为 Blender 5.0.1 compatibility：
  `_render_parts_color_blender.py` 假定 `mat.use_nodes = true` 后存在名为
  `Principled BSDF` 的节点，但实际取得 `None` 并在设置 `Base Color` 时抛出
  `AttributeError`；Blender 对该 Python 异常返回 exit 0，TS wrapper 随后报告所有 view
  missing。
- 用户授权后将该查找改为稳定的 `BSDF_PRINCIPLED` node type；同一 26-part 输入的独立
  Cycles 诊断成功生成 parts-colour isometric，随后从已完成的 draft 恢复统一 pipeline 的
  Phase 2，没有重复 Plan 2/3 的 LLM 生成。
- 恢复运行完成 6/6 个 refine cycles、12 次 LLM call，每轮各有一个 patch 通过既有
  compile/regression/connectivity gate；最终 `final.scad` 约 104 KiB、`final.obj` 约 4.1 MiB，
  `preview_final/`、6 组 `_refine_steps/`、trajectory 与 summary 均存在。最终 connectivity
  为无真实 air gap；115 个 flush micro-gap shells 被 union analysis 容许。
- 第 6 轮后仍有 leg stance 偏宽与 abdomen armor 暴露腰部两项 high-severity image-space
  差异，因此没有虚报通过，而是按既有预算合同返回 `verdict: max-steps`、`ok:false`；final
  artifacts 作为 best-effort evidence 保留，Mesh-to-CAD 不报告成功。这验证了成功 gate、
  最大轮数和失败 artifact 语义。
- 初次完整 run 位于 `outputs/mesh-to-cad-plan4-refine-runtime-unsandboxed`，恢复验收位于
  `outputs/mesh-to-cad-plan4-refine-runtime-retry`；两个 sandbox 环境失败 run 分别位于
  `outputs/mesh-to-cad-plan4-refine-runtime` 与
  `outputs/mesh-to-cad-plan4-refine-runtime-cpu`。

## 状态

**当前阶段：** Complete — implemented、真实闭环已验证、Blender 5 compatibility 已修复，最终 Mode B `No findings`；该真实样本在 6 轮预算后仍有两项视觉差异，因此按合同以 `max-steps` 拒绝虚假成功。
