# Plan: Mesh-to-CAD Plan 2 — 单图规划

## 目标与完成标准

在 Plan 1 私有 canonical geometry seam 上增加一个可删除的规划切片：宿主从私有
Z-up/mm canonical STL 渲染一张 upstream 默认主视角 `isometric` 图片，将该图片与
Plan 1 已有的 bounded geometry summary 交给 upstream 现有规划流程，最终在 run
目录写出 upstream 原生 `image.png` 与 `plan.json`。本阶段不生成 CAD。

完成必须同时满足：

- `mesh-to-cad --mesh` 只有一个流程：导入、单图渲染和部件规划；
- 删除公开 `--import-only` 与 `--reference-handle` 用法，不保留兼容分支；
- 模型输入不含 handle、原始或 canonical Mesh bytes、路径、材质、纹理或用户意图；
- `plan.json` 由 upstream `plan_system.md`、`parsePlanJson`、默认 model、解析重试和
  plan review 契约产生，不新增 Plan 2 schema；
- 公开 run 只增加 upstream 已有命名的 `image.png` 与 `plan.json`，Studio 直接使用
  现有 Files/图片能力，无新页面或 DTO；
- 失败保留已经成功生成的前序产物，不增加事务发布或回滚状态机。

## 权威输入与已确认决策

- 计划基线：`eb6298d7218f329ebd146374aaf45bffbd88645b`。
- Plan 1 feature commit：`4106416c67fb9236964ab2e04c852c79d23d5e93`。
- Ticket：[GitHub Issue 2](https://github.com/87003697/Procedura/issues/2)。
- 本任务中的人类决定取代 Issue 2 旧的四视图/专用 Observer 方向：先只做一张
  upstream `isometric` 主视图；不发送用户意图或 opaque handle；不把请求次数设为
  新契约；输出直接复用 upstream `plan.json`；删除公开 `--import-only` 与 handle reuse
  CLI；后续能力另行扩展。
- 保留 ADR 0001 的 removable side path 和 ADR 0002 的 geometry-only、无纹理、
  Z-up/mm、私有 canonical geometry 边界。

## 非目标

不生成 SCAD/OBJ，不运行 refine/repair，不增加任意视角、专用 reconstruction-brief
schema、Observer prompt、模型选择参数、Studio 页面、工具调用或新的安全/重试机制。
不新增、修改或运行 unit tests；不执行 SHA verification；规划阶段不调用 LLM、
Blender 或 OpenSCAD。

## 最小方案

1. `ReferenceAuthority.renderReferenceImage(handle)` 在私有 handle 目录调用现有
   `renderAOViews`，只传 `views: ["isometric"]`，其余渲染参数沿用 upstream 默认值；
   返回 PNG bytes，不返回 canonical path 或 Blender log。
2. 新 side module `mesh-to-cad-plan.ts` 先调用 Plan 1 `importReferenceRun`，再把 PNG
   写为 run 根目录 `image.png`。
3. side module 直接读取 upstream `plan_system.md` 与 `plan_review_system.md`，使用
   `DEFAULT_MODEL`、`generateOnce`、`PLAN_MAX_ATTEMPTS`、`parsePlanJson`、
   `DEFAULT_PLAN_REVIEW_ITERS`、`parsePlanReview` 和 `mergeReviewedPlan`；固定 user text
   只说明没有文本描述并附 Plan 1 summary，不引入用户 intent。
4. 成功后直接写 upstream `PartPlanItem[]` 为 `plan.json`。CLI 只接受 Mesh 并直接调用
   该模块；Plan 1 import pipeline 保留为内部实现步骤，不再暴露独立模式。

该方案不修改 shared LLM、long-timeout fetch、render implementation、upstream draft
pipeline、Texture Mesh、Viewer server 或 Studio UI。少量 side-module 编排重复用于避免
把 Mesh-to-CAD 生命周期塞进 upstream pipeline。

## Planned Patch 文件边界

- `README.md`（既有文档）：记录默认 Mesh 规划入口、模型可见边界和无 CAD 行为。
- `scripts/mesh-to-cad.ts`（既有 side CLI）：删除 import-only/handle 选项及分支，只将
  `--mesh` 注册到 Plan 2。
- `src/pipeline/mesh-to-cad-plan.ts`（新增 removable side module）：独立拥有导入后
  渲染、upstream plan/review 编排和 `plan.json` 发布。
- `src/reference/authority.ts`（Plan 1 authority）：增加唯一不可避免的私有 geometry
  渲染 seam；canonical path 仍不离开 Authority。

没有其他 Planned Patch 文件。尤其不修改 `src/llm/generate.ts`、
`src/render/ao.ts`、`src/render/views.ts`、`src/pipeline/draft-incremental.ts` 或 `web/`。

## Patch Intent

### `README.md`

- **公开用法与边界：** 说明默认 `--mesh` 只产出 `image.png`/`plan.json`，模型只见
  单图与 summary。[Planned Patch](./2026-08-30-mesh-to-cad-controlled-observation.planned.patch#L1)；
  [Final Patch](./2026-08-30-mesh-to-cad-controlled-observation.final.patch#L1)

### `scripts/mesh-to-cad.ts`

- **单一路径 CLI：** 删除 `--import-only`、`--reference-handle` 及分支，`--mesh` 直接
  调用新 side module。[Planned Patch](./2026-08-30-mesh-to-cad-controlled-observation.planned.patch#L48)；
  [Final Patch](./2026-08-30-mesh-to-cad-controlled-observation.final.patch#L48)

### `src/pipeline/mesh-to-cad-plan.ts`

- **独立规划切片：** 复用 Plan 1 import、upstream prompts/model/parser/review，写
  `image.png` 与 `plan.json`，不进入 CAD pipeline。
  [Planned Patch](./2026-08-30-mesh-to-cad-controlled-observation.planned.patch#L130)；
  [Final Patch](./2026-08-30-mesh-to-cad-controlled-observation.final.patch#L129)

### `src/reference/authority.ts`

- **私有单图 seam：** 从 canonical STL 渲染固定 `isometric`，仅返回 PNG bytes。
  [Planned Patch](./2026-08-30-mesh-to-cad-controlled-observation.planned.patch#L250)；
  [Final Patch](./2026-08-30-mesh-to-cad-controlled-observation.final.patch#L255)

## 分阶段验收

### 1. Host-controlled image

- 静态证据：Authority 方法无 view 参数，只传 `views: ["isometric"]`；输入是
  `canonicalPath`，返回值仅为 PNG bytes。
- 实施期外部验证：经授权运行 Blender，确认公开 `image.png` 可读且只有一张；私有
  source/canonical STL 与 Blender log 不出现在 run 目录。
- 失败：保留 `reference.json`；无 `image.png`/`plan.json` 完成声明。

### 2. Upstream planning

- 静态证据：模型 content 只由固定 task text、序列化 `ReferenceSummary` 和一个 PNG
  part 组成；没有 handle、路径、Mesh、material、texture 或 intent 字段。
- 静态证据：prompt、model、parser、重试上限和 review helper 均从 upstream 直接导入。
- 实施期外部验证：经授权调用配置的 multimodal model，检查 `plan.json` 可被
  `parsePlanJson` 接受，字段与 upstream `PartPlanItem` 一致。
- 失败：规划失败保留已成功的 `reference.json`/`image.png`，不写 `plan.json`。

### 3. CLI、artifacts 与 Studio

- `mesh-to-cad --help` 只显示一个 `--mesh` 规划用法，不出现 `--import-only` 或
  `--reference-handle`。
- 默认 Mesh run 公开产物为 `reference.json`、`image.png`、`plan.json`，且没有
  SCAD/OBJ/refine/repair artifacts。
- 已有历史 run、reference descriptor 和 Viewer 数据契约不变；只删除旧 CLI 入口。
- Studio 不改代码；人工确认现有界面能查看 `image.png` 和 `plan.json`。

### 4. 静态交付检查

- `git apply --check` 对计划基线通过；`git diff --check` 通过。
- 实施期运行 root TypeScript typecheck、CLI help 和允许的真实入口验证；不运行 unit
  tests。缺失依赖或未授权的 Blender/model 验证必须明确记录为未验证，不能推断成功。

## 失败、回滚与 upstream isolation

回滚删除新增 `src/pipeline/mesh-to-cad-plan.ts`，移除 CLI 默认分支、Authority
`renderReferenceImage` 和 README 段落，并恢复旧 CLI 文件即可。Plan 1 的 private
import、summary、reference descriptor 和 Viewer 数据契约继续存在；旧 CLI 兼容性
已由本计划明确放弃。

既有文件修改的必要性：

- `scripts/mesh-to-cad.ts` 是用户入口，必须有一处薄注册才能到达 side module；
- `src/reference/authority.ts` 是唯一持有 canonical path 的信任边界，必须在其中完成
  私有 geometry 到公开 PNG bytes 的转换；
- `README.md` 是新增 CLI 外部行为的现有权威说明。

移除新 capability 并恢复该 side CLI 后即可恢复原行为；shared upstream 数据契约不变。

## 外部副作用与授权

实施期完整验收需要一次真实 Blender render，以及 upstream 默认规划/plan-review 所需
的真实模型调用，可能产生计算时间和模型费用；执行前必须取得明确授权。规划阶段只做
静态审查和 Patch apply 检查。

## Implementation Review

此前 Mode A 已完成：

- 第一轮 finding：解析失败后的第二次 plan request 未携带 upstream parse-error feedback；
  已按 upstream 模板补齐。
- 第二轮 finding：plan-review request 缺少固定无文本描述上下文和 upstream
  `keep the planner's left/right assignments` 约束；已按 upstream 模板补齐。
- 当时最终全范围独立复审：`No findings`。
- 人类随后明确批准删除 `--import-only` 与 `--reference-handle`；Planned Patch 已按该
  决定简化，先前 clean 结论因此失效，必须重新完成全范围 Mode A。
- 新一轮 P2 finding：该外部行为覆盖决定只记录在本地计划，缺少冻结前的 Issue 2
  治理记录；已在 [Issue 2 comment](https://github.com/87003697/Procedura/issues/2#issuecomment-5469311409)
  明确记录旧兼容要求被取代、保留的数据契约与重新审查状态。
- finding 解决后的全范围独立复审：`No findings`。
- 当前 `git apply --check` 对计划基线通过，`git diff --check` 通过。
- 未运行 unit tests、LLM、Blender 或 OpenSCAD。真实 render、model、CLI 入口、
  TypeScript 与 Studio 人工验证保留到经授权的实施阶段。

Mode A 只有 Planned Patch，Planned/Final 对比不适用。人类已于 2026-08-30 明确批准并
冻结该 Planned Patch，同时授权进入 `$implement-patch`；实施完成后将从同一基线生成
`.final.patch` 候选并执行 Mode B。

Implementation 与 Final Patch 候选证据：

- 冻结的 Planned Patch 已完整应用；业务文件仍严格限定为 `README.md`、
  `scripts/mesh-to-cad.ts`、新增 `src/pipeline/mesh-to-cad-plan.ts` 与
  `src/reference/authority.ts`。
- 候选 Final Patch 与 Planned Patch 有两项同范围修正：CLI 在解析 `--help` 后才延迟
  加载规划模块，使帮助入口不依赖完整 LLM 安装
  （[Final Patch](./2026-08-30-mesh-to-cad-controlled-observation.final.patch#L48)）；
  `PlanReferenceRunOpts` 明确要求 `meshPath` 且不暴露 handle 参数，落实单一路径契约
  （[Final Patch](./2026-08-30-mesh-to-cad-controlled-observation.final.patch#L129)）。
- TypeScript：初次复用同一项目主检出目录已有依赖并通过临时 tsconfig 检查；人类随后
  授权端到端验证，执行 `bun install --frozen-lockfile` 安装锁定依赖且未修改 lockfile，
  当前工作树 root `tsc --noEmit` 通过。
- CLI：`--help` 成功且只显示 `--mesh`；`--import-only`、`--reference-handle` 均以
  unknown flag 失败；缺少 `--mesh` 明确失败。
- Bun 编译：`bun build scripts/mesh-to-cad.ts --target bun --packages external` 通过，
  共打包 37 个本地模块。
- Patch：Final Patch 与当前业务实现反向检查一致；使用隔离临时 Git index 对原始基线
  的 apply check 通过；业务 diff check 通过；未写入真实暂存区。
- 人类随后明确授权真实端到端。使用 12-triangle、10×10×10 mm 立方体执行完整 CLI：
  private import、Blender 5.0.1 单张 `isometric` 渲染、真实 upstream model planning 与
  plan review 全部成功，CLI exit 0 并报告 1 part。
- 端到端公开目录恰好包含 `reference.json`、768×768 RGB `image.png` 与 `plan.json`；
  upstream `parsePlanJson` 接受生成的 `cube_body` 计划。private root 才包含 source STL、
  canonical STL、manifest 与 `render/ao-isometric.png`；公开目录无 STL/SCAD/OBJ 或
  Blender log。
- 沙箱内 Blender 5.1.1 与 5.0.1 都在 Metal 初始化时 exit 139；这两次失败均只留下
  `reference.json`，没有 `image.png`/`plan.json`。获批切换到沙箱外 Blender 5.0.1 后
  成功，证明计划的前序产物保留语义。未运行 unit tests 或 OpenSCAD。
- 模型请求体没有另设录制代理独立抓包；payload privacy 由最终代码的固定两-part
  构造（summary text + 一张 PNG）静态证明。Studio 人工查看仍未执行。
- Implementation Review Mode B 全范围独立审查：`No findings`。
- Reconciliation：Planned 与 Final 不相同，但只存在上述两项同范围差异。CLI 延迟加载
  是已验证 `--help` 行为所必需；mesh-only `PlanReferenceRunOpts` 将新模块接口收紧到
  人类批准的单一路径契约。两项均由已有 TypeScript、CLI、Bun build、diff 与 patch
  apply 证据覆盖，对应 Final Patch `scripts/mesh-to-cad.ts` 与
  `src/pipeline/mesh-to-cad-plan.ts` hunks。
- Final Patch 已在 Mode B `No findings` 后冻结；不保存第三个 execution-delta Patch。

## 状态

**当前阶段：** Complete — Planned Patch 与 Final Patch 均已冻结，Mode B `No findings`。
