# Plan: direct refine 失败时记录真实 verdict

## 目标与完成标准

`runDirectRefine` 在 critic 调用失败时直接 `break`，不改 `verdict`，于是返回初值 `max-steps`。Patch 调用失败引起的“连续两轮无改动”停止同样返回 `max-steps`。从 PR #29 起，Mesh-to-CAD 把 `max-steps` 视为成功，这两类调用失败因此以退出码 0 结束，发布的 `final.*` 可能就是 draft。

改为按停止原因记录 verdict：

- critic 抛错 → `error`；抛错时 refine 已被中止 → `aborted`。
- “连续无改动”停止时：refine 已被中止 → `aborted`；否则，这段连续无改动中任一轮的修复尝试以 Patch 调用失败结束 → `error`；每一轮都以解析、应用、编译或面数门禁拒绝结束 → 仍为 `max-steps`。

完成后：`bun run mesh-to-cad --refine` 遇到上述失败时以 `Mesh-to-CAD refine ended with verdict: error` 退出；预算用尽和模型侧停滞仍然成功；所有情况下 `final.*` 和 `final_summary.txt` 照常写出，summary 记录新的 verdict。

非目标：

- 不改循环控制：critic 抛错仍立即结束；Patch 调用失败仍让下一轮重试。
- 不改 `mesh-to-cad-generation.ts` 的成功判定，不改 agent 版 refine，不让 `generateOnce` 响应中止信号。
- 不处理 Mapping Agent 把自身 LLM 调用失败和中止吞成空的或截断的诊断的问题（见“关键发现”），不决定 Mapping 是否容忍 tool-call 参数解析失败，也不处理 Mapping adapter 落地和 `validatePlanCoverage`。这些都交给 Mapping adapter 落地计划。

## 关键发现

- `verdict` 初值为 `"max-steps"`（`src/pipeline/refine-direct.ts` 第 335 行）。只有入口编译失败、渲染失败（`error`）、循环开头检测到中止（`aborted`）、critic 无可修复问题或 Patch 回复 `NOCHANGE`（`ok`）会改写它。
- critic 的 `catch`（第 449–452 行）只记日志并 `break`。视觉 critic 和 Mapping critic 用 `Promise.all` 并行，任一抛错都进入这个分支。
- harness 的 `client.generate` 除请求准备阶段（第 248 行的 `prep`，例如缺少 API key）外不抛错：HTTP 错误、fetch 异常、流中断和中止都收集成 `error` 事件（`vendor/harness/src/llm/route.ts` 第 253–258、286–290、327–331 行）。
  - 视觉 critic 和 Patch 走 `generateOnce`，它把 `error` 事件抛出（`src/llm/generate.ts` 第 60 行）；`generateWithRetry` 在三次尝试都失败或都只返回空文本（只有 reasoning）时抛出（第 92–107 行）。
  - Mapping Agent 的 `parseToolCalls`（`src/agents_mesh2code/mapping-agent.ts` 第 44–62 行）忽略 `error` 事件。失败发生在工具调用之前时，它返回已经流出的文本，可能为空，也可能被截断；`runDirectRefine` 得到空的或残缺的 Mapping 诊断，本轮照常继续，不进入 `catch`。
  - Mapping critic 抛错有三类来源：确定性失败（输入准备即 Python 流程、`parseSemanticPlan`、`validatePlanCoverage`）；请求准备失败；第 59 行对 tool-call 参数的 `JSON.parse` 失败。OpenAI Chat 协议不发 `tool-call-finish`，参数只能靠这次解析；模型输出因长度截断、传输在参数中途中断或被中止，都会留下残缺参数（`route.ts` 第 286–290、303–307 行）。所以参数解析失败不一定是模型侧错误。
- 中止不会打断视觉 critic 或 Patch 的 HTTP 请求：`generateOnce` 构造请求时没有带 `signal`（`src/llm/generate.ts` 第 47–51 行）。`generateWithRetry` 在一次尝试失败后检查中止，已中止则立即抛出、不再重试（第 98 行）。所以 critic `catch` 里的 `aborted` 出现在：视觉 critic 请求在中止后失败；Mapping 请求被中止时恰好停在工具调用中途；或中止之后任一 critic 因其他原因抛错。
- Patch 调用失败时，`catch` 立即结束本轮尝试（第 555–563 行），本轮不可能再落地、计为无改动；连续两轮无改动后停止（第 680–688 行），`verdict` 仍为 `max-steps`。落地时 `barren` 清零（第 673 行）。
- 上游把连续无改动的门槛设为 2 而不是 1，理由是“critic 和 patcher 都是随机的，一轮失败可能只是运气，两轮相同的失败才不是运气”（第 151–153 行）。
- agent 版 refine（`src/pipeline/refine.ts` 第 470–476 行）已经把循环错误记为 `error`、中止记为 `aborted`；direct 版在这两处与之不一致。
- `DEFAULT_REFINE_STEPS` 在模块加载时读取 `PROCEDURA_REFINE_STEPS`，默认 6（`src/pipeline/refine.ts` 第 132 行）。
- verdict 的使用方：
  - `writeFinalOutputs` 只把 verdict 写进 `final_summary.txt`，产物不受影响。
  - `scripts/results-server.ts` 显示 verdict；`scripts/batch.ts` 按 `ok` / `max-steps` 计数。
  - Studio 的 `web/server/scan.ts`（`parseVerdict`，第 224–238 行）把 `ok`、`give_up`、`max-steps` 以外的 verdict 都显示为 `incomplete`。
  - 上游 `scripts/procedura.ts`（第 419–424 行）只要产出了 mesh，`refine.ok` 为 false 时都返回退出码 3；`web/server/jobs.ts`（第 260–273 行）按是否产出模型判定任务成功。这两处不看具体 verdict。
  - `src/pipeline_mesh2code/mesh-to-cad-generation.ts` 第 71 行对 `error` 和 `aborted` 已经抛错，无需修改。

## 方案与决策

在 `runDirectRefine` 的两个停止点按停止原因写 verdict，只改标签，不改控制流。verdict 回答的是“循环为什么停下”。

- **critic 抛错记 `error`，不区分来源。** 视觉 critic 的网络失败或三次空回复，Mapping critic 的确定性失败、请求准备失败或 tool-call 参数解析失败，都会让本轮拿不到完整诊断，refine 本来就在这里结束；它们都不是预算用尽。代价是不对称：Mapping 偶发一次输出截断或传输中断就会让 Mesh-to-CAD 失败，而 Patch 侧的模型格式错误被当作预算内的停滞容忍。是否让 Mapping 容忍参数解析失败，交给 Mapping adapter 落地计划决定；那份计划不能单凭“参数解析失败”判定为模型侧错误，否则会把传输失败和中止重新吞掉。
- **“连续无改动”停止按整段判定。** 从上一次落地（或 refine 开始）算起的这段连续无改动中，只要有一轮的修复尝试以 Patch 调用失败（包括三次空回复）结束，就记 `error`；每一轮都以模型侧拒绝结束（尝试用完或同一拒绝重复出现）才记 `max-steps`。理由是上游设 2 轮门槛的前提：一轮失败可能只是运气。如果这两轮中有一轮是调用失败，模型实际只失败过一轮，提前停止有一部分是基础设施造成的。结果与各轮先后顺序无关：
  - 前一轮调用失败、本轮模型侧拒绝 → `error`；
  - 前一轮模型侧拒绝、本轮调用失败 → `error`；
  - 本轮第 1 次尝试被拒、第 2 次调用失败 → `error`；
  - 调用失败、下一轮落地、之后两轮模型侧拒绝 → `max-steps`（落地时清零）；
  - 前 5 轮都落地、第 6 轮调用失败、第 7 轮模型侧拒绝 → `error`。判定只看从上一次落地算起的这段连续无改动，与之前落地过多少改动无关；Mesh-to-CAD 以退出码 1 结束，`final.*` 仍含这 5 次改动。
- **预算用尽时保持 `max-steps`，即使这段连续无改动中有 Patch 调用失败。** verdict 回答循环为什么停下：预算用尽时循环因预算停止，调用失败不是停止原因；达到连续无改动上限时，调用失败是提前停止的成因之一。代价是：当总轮次 `PROCEDURA_REFINE_STEPS` 小于连续无改动上限 `PROCEDURA_REFINE_MAX_BARREN` 时，“连续无改动”停止永远不会触发，即使每一轮的 Patch 调用都失败，也以预算用尽结束、记 `max-steps`，Mesh-to-CAD 以退出码 0 发布 draft。默认上限是 2，所以默认配置下只有 1 步预算会这样；把上限调到超过预算时也会这样。默认预算是 6，Mesh-to-CAD 的付费运行用 8。
- **中止优先于 `error` 和 `max-steps`。** 两个停止点都先检查 `opts.signal?.aborted`，与循环开头的中止检查保持一致；“连续无改动”停止时若已中止，即使各轮都以模型侧拒绝结束也记 `aborted`。
- **放弃：只看触发停止的那一轮。** 这是上一版方案，用每轮重新声明的标记实现。它让结果取决于顺序：“前一轮调用失败、本轮模型侧拒绝”记 `max-steps`，顺序反过来记 `error`；前一种情况下模型只失败过一轮，Mesh-to-CAD 却以退出码 0 发布。
- **放弃：在 Mesh-to-CAD 侧识别。** `RefineResult` 只有 `ok`、`verdict`、`summary`、`steps`、`toolCalls`，无法区分“预算用尽”和“critic 在第 N 轮失败”；解析 `_refine_steps` 目录是脆弱的旁路。
- **放弃：Patch 调用失败时立即结束 refine。** 上游有意让下一轮重新诊断并再试 Patch；立即结束会改变这一控制流。
- **放弃：把所有“连续无改动”都记为 `error`。** 模型侧拒绝说明模型已经尝试、但没有产出可接受的修改，属于预算内的停滞；上游注释也把这种提前停止视为优于继续消耗预算。
- **放弃：预算用尽时也按 `barrenCallFailed` 判定。** 这能覆盖上面的预算缺口，但预算用尽不是调用失败造成的，这样判定会把 verdict 的含义从“停止原因”变成“近期有过基础设施失败”。这是另一种设计，需要单独批准。

## Patch Artifact

- **计划基线：** `4eb6bbf`（[PR #32](https://github.com/87003697/Procedura/pull/32) 的提交，父提交为 `main` 的 `26e5793`；#32 合入后 `main` 的 tree 与之相同）。Patch 只覆盖 `src/pipeline/refine-direct.ts`；工作区中 `.agents/notes/依赖排查.md` 的改动不属于本计划。
- **计划 Patch：** [2026-09-27-direct-refine-failure-verdict.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch>)
- **最终 Patch：** [2026-09-27-direct-refine-failure-verdict.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch>)（与计划 Patch 逐字节相同，见“Implementation Review”）
- **批准前校验：** `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch`（在 HEAD 为 `4eb6bbf`、`refine-direct.ts` 未修改的工作区中运行）

## Patch Intent

### `src/pipeline/refine-direct.ts`

- **`barrenCallFailed`（新增）：** 记录当前这段连续无改动中是否有 Patch 调用失败。它和 `barren` 在同一作用域、同样跨轮保留，含义与 `barren` 配对，所以声明在 `barren` 旁边。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch:10>)
- **`runDirectRefine` critic 失败分支（修改）：** critic 抛错时 refine 本来就立即结束，但结果被标为 `max-steps`，Mesh-to-CAD 会把它当作成功。改为记 `error`；抛错时 refine 已被中止则记 `aborted`。日志和 `break` 不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch:18>)
- **`runDirectRefine` Patch 调用失败分支（修改）：** 在已有的 `catch` 里置位 `barrenCallFailed`。调用失败后本轮立即退出尝试循环、不会落地，所以置位的这一轮一定计入当前这段连续无改动。本轮仍计为无改动，下一轮照常重试，repair history 和日志不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch:26>)
- **`runDirectRefine` 落地清零（修改）：** 落地时 `barrenCallFailed` 与 `barren` 一起清零，让标记只覆盖从上一次落地算起的这段连续无改动；写法沿用本文件 `if (...) { ...; ...; }` 的单行形式。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch:34>)
- **`runDirectRefine` 连续无改动停止（修改）：** 停止时按原因写 verdict：已被中止记 `aborted`，这段连续无改动中有 Patch 调用失败记 `error`，否则保持 `max-steps`。进入这里时 verdict 必定仍是 `max-steps`，末尾的 `else` 只是让赋值分支完整。停止条件和日志不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.planned.patch:43>)

## 实现步骤

- [x] 合入 PR #32 后，在 `main` 上按 Planned Patch 修改 `refine-direct.ts`；验证：`bun run typecheck`、`git diff --check`；完成：两者通过，diff 与 Planned Patch 一致。
- [x] 按“验证”一节运行免费桩验证；需要 OpenSCAD 和 Blender，在沙箱外运行（沙箱内 OpenSCAD 的 Manifold 探测会失败，见 `.agents/notes/依赖排查.md`）；完成：8 个场景的 verdict、请求次数、日志断言和 Mesh-to-CAD 行为全部符合预期。
- [x] 从同一基线生成 Final Patch 并做 Mode B review。
- [x] 经 Issue 和 PR 合入 `main`：[Issue #33](https://github.com/87003697/Procedura/issues/33)、[PR #34](https://github.com/87003697/Procedura/pull/34)，merge commit `7f8e5ea`。

## 接口与兼容性

- `RefineResult` 类型和 `verdict` 取值集合不变。
- 上游行为变化（原来都是 `max-steps`）：
  - critic 抛错时返回 `error`，已中止时返回 `aborted`；
  - “连续无改动”停止时，若这段连续无改动中有 Patch 调用失败，返回 `error`；
  - “连续无改动”停止时若已中止，不论各轮怎样结束都返回 `aborted`。目前没有调用方给 `runProcedura` 或 `runDirectRefine` 传中止信号，实际影响小。
  - `final_summary.txt`、results server 和 batch 统计显示新的 verdict。
  - Studio 中这些运行的状态从 `max-steps` 变为 `incomplete`。
  - `ok` 仍为 false，产物照常写出；上游 CLI 退出码（3）和 Studio 任务成败（按是否产出模型判定）不变。
- Mesh-to-CAD：上述情况下 CLI 退出码从 0 变为 1；预算用尽和模型侧停滞仍为 0。即使之前已落地多轮改动，只要最后这段连续无改动因含调用失败而记 `error`，退出码也是 1，`final.*` 仍包含已落地的改动。

## 上游隔离（AGENTS.md）

- **修改的上游文件：** 只有 `src/pipeline/refine-direct.ts`。无法放进新模块：verdict 在 `runDirectRefine` 内部决定，`RefineResult` 没有其他字段能让调用方区分停止原因。
- **性质：** 这是对上游 verdict 标签的修正，不属于 Mesh-to-CAD 新能力；它让 direct refine 与 agent 版 refine 的 `error` / `aborted` 语义一致。
- **删除 Mesh-to-CAD 后：** 本修正仍然生效，上游 direct refine 在“接口与兼容性”列出的情况下返回 `error` / `aborted` 而不是 `max-steps`，Studio 状态随之变化。这是有意的上游行为变化，需要用户在批准时确认。

## 验证

免费桩验证，不发出付费请求。脚本放在被忽略的 `outputs/failure-verdict-check-2026-09-27/`，约定如下：

- **进程与环境：** 每个场景一个独立的 `bun` 进程。`PROCEDURA_REFINE_STEPS` 在模块加载时读取、`PROCEDURA_REFINE_MAX_BARREN` 可被环境覆盖，所以两者都在命令行显式设置（后者固定为 2）；同时设置 `OPENAI_BASE_URL=http://stub.invalid/v1`、`OPENAI_API_KEY=stub`、`PROCEDURA_MODEL=gpt-5.5`。工具路径与 09-24 的付费运行脚本一致：`OPENSCAD_PATH=/opt/homebrew/bin/openscad`、`PROCEDURA_BLENDER_PATH=/Applications/Blender.app/Contents/MacOS/Blender`（`src/render/ao.ts` 的候选路径在本机都不存在，最后一项 `"blender"` 也不搜索 `$PATH`）。
- **输入：** 每个场景使用独立副本 `outputs/failure-verdict-check-2026-09-27/<scenario>/run`，复制自 `outputs/paid-refine-seven-views-mapping/run`（已有 `plan.json`、`draft.scad` 和全部部件，不触发 plan 或 draft 请求）。夹具自带上次运行的 refine 产物，其中 `final_summary.txt` 第一行就是 `verdict: max-steps`，而 `runDirectRefine` 不会删除旧文件；所以复制后先删除 `_refine_steps`、`final.scad/.obj/.stl/.mtl`、`final_summary.txt`、`preview_final`、`_final_build`，保证断言读到的是本次新写出的文件。`runMeshToCadGeneration` 的 `runsRoot` 为仓库的 `outputs/`，参考 mesh 为 `outputs/examples/01-snake-arm/reference.obj`，私有参考库为 `/private/tmp/procedura-failure-verdict-check/<scenario>`。
- **桩：** 完全替换 `globalThis.fetch`，从不调用真实的 `fetch`：`/chat/completions` 以外的请求直接抛错，保证不会发出付费请求。失败返回 HTTP 400（不在 `long-timeout-fetch` 的重试集合内，没有退避等待）；成功返回 OpenAI 兼容的 SSE 流。patch 请求按系统提示识别（`refine-patch-prompt.md` 以 `# Refine — patch step` 开头），其余 refine 请求视为视觉 critic。critic 成功时返回 `SUMMARY: stub` 加一条 `1. stub_issue [HIGH] PROBLEM: stub.`，满足 `hasDiagnosisIssues`。模型侧拒绝用不含任何 `=== MODULE/PLACE/ADD ===` block 的文本模拟；解析拒绝不会提前结束本轮，所以每个模型侧拒绝的轮次消耗 3 次 patch 请求。落地用“原样回填”模拟：取 `listTopLevelModules(draft.scad)` 的第一个模块名 `m`，返回 `=== MODULE m ===` 加 `extractModuleDefinition(draft.scad, m)` 的原文（`src/scad/parts.ts`）。`applyPatch` 不拒绝与原文相同的定义，编译通过、面数不变，这一轮会被接受。桩记录每类请求的次数。
- **公共断言：** 每个场景的日志都不匹配 `/^  compile failed on entry: /m` 和 `/^  render failed: /m`（`refine-direct.ts` 第 362、376 行的行首格式），排除入口编译失败、渲染失败这两条已有路径碰巧给出同样的 verdict。不用裸子串，因为收尾阶段非致命的 AO 预览警告也含 `render failed`。一次失败的 LLM 调用对应 3 次请求（`generateWithRetry` 的三次尝试）。

场景（请求次数写作“critic / patch”）：

- **critic 调用失败：** `PROCEDURA_REFINE_STEPS=1`，所有请求返回 400，经 `runMeshToCadGeneration({ refine: true })` 运行。预期抛出 `Mesh-to-CAD refine ended with verdict: error`，`final_summary.txt` 以 `verdict: error` 开头，`final.scad` 非空；请求 3 / 0；`critic failed` 出现 1 次。
- **Patch 调用失败：** `PROCEDURA_REFINE_STEPS=2`，critic 成功，patch 请求都返回 400，经 `runMeshToCadGeneration` 运行。预期抛出同一错误，`final_summary.txt` 以 `verdict: error` 开头；请求 2 / 6；`patch call failed` 出现 2 次，`2 consecutive cycles accepted nothing` 出现 1 次。
- **模型侧停滞（回归）：** `PROCEDURA_REFINE_STEPS=2`，critic 成功，patch 都返回无 block 文本，经 `runMeshToCadGeneration` 运行。预期正常返回，`final_summary.txt` 以 `verdict: max-steps` 开头；请求 2 / 6；`2 consecutive cycles accepted nothing` 出现 1 次。
- **先调用失败、后模型侧拒绝：** 直接调用 `runDirectRefine({ outputDir, maxSteps: 2 })`，critic 成功；第 1–3 次 patch 请求（第 1 轮的一次调用）返回 400，第 4–6 次返回无 block 文本。预期 `verdict === "error"`；请求 2 / 6；`patch call failed` 出现 1 次，`2 consecutive cycles accepted nothing` 出现 1 次。若只看触发停止的那一轮，这里会得到 `max-steps`。
- **落地清零：** 直接调用 `runDirectRefine({ outputDir, maxSteps: 4 })`，critic 成功；第 1–3 次 patch 请求返回 400（第 1 轮调用失败），第 4 次返回原样回填（第 2 轮落地），第 5–10 次返回无 block 文本（第 3、4 轮模型侧拒绝）。预期 `verdict === "max-steps"`；请求 4 / 10；`ACCEPTED` 出现 1 次，`patch call failed` 出现 1 次，`2 consecutive cycles accepted nothing` 在第 4 轮出现 1 次。若落地时不清零，这里会得到 `error`。
- **critic 在中止后失败：** 直接调用 `runDirectRefine({ outputDir, maxSteps: 1, signal })`，不传 Mapping critic；第一次 critic 请求先 abort 控制器，再返回 400。预期 `verdict === "aborted"`；请求 1 / 0（`generateWithRetry` 发现已中止后不再重试）；`critic failed` 出现 1 次。
- **Patch 失败后中止：** 直接调用 `runDirectRefine({ outputDir, maxSteps: 2, signal })`，critic 成功；第 1–3 次 patch 请求返回 400，第 4 次（第 2 轮的第一次）先 abort 控制器，再返回 400。预期第 2 轮进入“连续无改动”停止，`verdict === "aborted"`；请求 2 / 4；`2 consecutive cycles accepted nothing` 出现 1 次。
- **预算缺口（钉住已知行为）：** 直接调用 `runDirectRefine({ outputDir, maxSteps: 1 })`，critic 成功，patch 请求都返回 400。预期 `verdict === "max-steps"`；请求 1 / 3；`patch call failed` 出现 1 次，`consecutive cycles accepted nothing` 出现 0 次。这确认“预算用尽时保持 `max-steps`”的决策与实现一致。
- 预算用尽这条路径本身不受 Patch 影响。09-24 的 8 轮付费运行只证明了 `runDirectRefine` 在预算用尽时返回 `max-steps`；那次运行发生在 PR #29 之前，Mesh-to-CAD 随后仍以该 verdict 抛错。Mesh-to-CAD 接受 `max-steps` 这一侧，由上面的“模型侧停滞”场景首次在运行时覆盖。

## 风险与回滚

- **统计口径变化：** batch、results server 和 Studio 会把这类失败从 `max-steps` 改计为 `error` / `incomplete`，与历史结果不能直接比较。
- **Mapping critic 抛错会让 Mesh-to-CAD 报错：** 这包括确定性失败、请求准备失败和 tool-call 参数解析失败；以前被当成成功，现在会让命令失败，符合“critic 抛错不区分来源”的决策。其中 `validatePlanCoverage` 是确定性抛错：Patch 新增模块后，下一轮一定以 `error` 结束。CLI 目前不接 Mapping，所以不影响现有用户；Mapping adapter 落地计划会修复覆盖检查、并决定 Mapping 是否容忍参数解析失败（不能把它一律当作模型侧错误），应在本修正之后进行。产物和 `_refine_steps/` 在失败时仍然保留。
- **Mapping 的部分 LLM 调用失败仍然静默：** 失败发生在工具调用之前时（HTTP 错误、fetch 异常、流中断、中止），Mapping Agent 静默返回空的或截断的诊断，本轮用剩下的诊断继续，最终可能记为 `max-steps` 甚至 `ok`。本计划不改变这一点，交给 Mapping adapter 落地计划处理。
- **预算小于连续无改动上限时的剩余缺口：** 每轮 Patch 调用都失败仍记 `max-steps`，见“方案与决策”，不在本计划内处理。
- **回滚：** 还原 `refine-direct.ts` 的 5 处改动。

## Implementation Review

- **Mode B：** 独立 reviewer 全范围复核，结论 No findings。
- **Planned 与 Final：** [Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch>) 与 Planned Patch 逐字节相同（sha256 `9520c52d…78ab`）。从基线 `4eb6bbf` 分别重建的 P、F 两棵树都是 `34130e6`，没有需要接受或删除的差异。Final Patch 只含 `src/pipeline/refine-direct.ts`，不含工作区中 `.agents/notes/依赖排查.md` 的无关改动；用临时 index 对基线执行 `git apply --cached --check` 通过。
- **Final Patch hunk 与 Patch Intent 的对应：**
  - [`barrenCallFailed` 声明](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch:10>)
  - [critic 失败分支](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch:18>)
  - [Patch 调用失败置位](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch:26>)
  - [落地清零](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch:34>)
  - [连续无改动停止](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-27-direct-refine-failure-verdict.final.patch:43>)
- **验证证据：**
  - 分支 `codex/direct-refine-failure-verdict`（基于合入 #32 后的 `main` `14348b6`，tree 与 `4eb6bbf` 相同）上 `git diff --check` 和 `bun run typecheck` 通过。
  - 免费桩验证 8 个场景全部通过，用时约 9 分钟，没有发出任何付费请求。脚本为 `outputs/failure-verdict-check-2026-09-27/scenario.ts` 和 `run-all.ts`，各场景的 `log.txt`、`result.json` 和汇总 `summary.json` 在同一目录。critic / patch 请求次数依次为：critic-fail 3/0、patch-fail 2/6、model-stall 2/6、fail-then-reject 2/6、landing-reset 4/10、critic-abort 1/0、patch-abort 2/4、budget-gap 1/3；所有场景的 `other` 请求都为 0，日志都不匹配两条禁止模式。
- **执行细节（比“验证”一节写得更具体或更严）：**
  - 请求分类：只有系统提示以 `diagnose-prompt.md` 首句开头的请求算作 critic；两类都不是的请求记为 `other`、返回 400，并断言为 0。
  - 所有场景都检查 `final.scad` 非空、`final_summary.txt` 的 verdict。direct 场景的 verdict 取函数返回值，Mesh-to-CAD 场景取 `final_summary.txt`。landing-reset 另外断言停止行出现在 `--- cycle 4/4 ---` 之后。
- **未验证：** 没有在未打补丁的代码上做负对照。静态推断：critic-fail、patch-fail、fail-then-reject、critic-abort、patch-abort 在旧代码上都会得到 `max-steps`，能区分新旧代码；model-stall 和 budget-gap 是回归和钉住已知行为的场景。landing-reset 能区分“落地不清零”的写法，fail-then-reject 能区分“只看触发停止的那一轮”的写法，patch-abort 能区分“中止不优先”的写法。

## 状态

**当前阶段：** Merged — 用户已批准；PR #32 已合入；实现、8 个桩场景验证和 Mode B（No findings）完成，Final Patch 与 Planned Patch 相同并已冻结；经 [PR #34](https://github.com/87003697/Procedura/pull/34) 合入 `main`（`7f8e5ea`），[Issue #33](https://github.com/87003697/Procedura/issues/33) 已关闭。

**计划阶段记录：** Planned Patch 已生成；`git apply --check`、`git diff --check` 和基线 worktree 上的 `bun run typecheck` 通过；Mode A 前 3 轮共 10 条 findings 均针对计划文档；第 4 轮指出“只看触发停止的那一轮”与上游 2 轮门槛的理由矛盾，Patch 改为按整段连续无改动判定（新增 `barrenCallFailed`，落地清零），并修正了 Mapping 失败方式的描述；第 5 轮 2 条针对验证方案（补 `PROCEDURA_BLENDER_PATH`，补请求次数和公共断言）；第 6 轮 2 条低严重度文档意见（预算用尽路径的证据说法，断言锚定行首），新增预算缺口场景；第 7 轮 1 条（预算用尽决策的理由与整段判定不一致，补“已落地多轮仍记 `error`”的说明），Patch 未变；第 8 轮全范围复审 No findings。
