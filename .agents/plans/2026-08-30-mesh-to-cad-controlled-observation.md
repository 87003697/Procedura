# Plan: Mesh-to-CAD Plan 2 — 受控观察与 Reconstruction Brief

## 目标与完成标准

在已经验收的 Plan 1 私有导入/Viewer 上增加第二个独立切片：宿主取得 bounded summary 和 isometric/front/right/top 四张固定 AO PNG，以恰好一次 HTTP 请求调用 Observer，严格验证模型字段，再由宿主写入 dimensions 与 view mappings，产出 `reconstruction-brief.json`。本阶段仍不生成 CAD。

完成必须同时满足：`--observe-only` 可导入或复用 handle；Authority 在运行时拒绝非固定 view；Observer 请求不经过 transport retry 或 continuation/replay；模型输入仅含 handle、summary、可选 intent 和四张 PNG；brief 的 dimensions/views 由宿主盖章；`--import-only` 与 Plan 1 Viewer 行为保持不变。

非目标：多图 CAD generation、`runProcedura`、SCAD/OBJ、Generated 标签、几何比较、评分、refine、repair 和 unit tests。

## 关键发现

- `renderAOViews` 已支持 STL/OBJ 与固定 `ViewName`，Authority 只需暴露四值 allowlist。
- 现有 `createLLMClient.stream` 会 continuation/replay；严格单请求必须绕过 stream，只复用 `prepare` 的 auth/body 后执行一次 native fetch。
- Plan 1 的 `importReferenceRun`、public manifest 与 Viewer 无需改变；观察结果是新的附加 artifacts。

## 方案与决策

继续使用同一个进程内 Authority，并增加固定 render operation；Observer 使用无工具 one-shot 编排，不引入 Harness agent loop 或 MCP transport。严格单请求 helper 放在现有 `generateOnce` seam，默认关闭，只有 Observer 显式启用，因此其他模型调用保持原 resilience。

## Patch Artifact

- **计划基线：** `fac191ed49f55fcc2e0f23897e986042249f59fe` 加已成功应用的 Plan 1 patch：`/Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.planned.patch`。
- **计划 Patch：** [2026-08-30-mesh-to-cad-controlled-observation.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch>)
- **批准前校验：** 在临时树依次应用 Plan 1 后运行 `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch`。
- **后续基线：** Plan 3 必须在 Plan 1 + Plan 2 planned state 上生成和校验。

## Patch Intent

### `README.md`
- **受控观察说明（新增）：** 增加 `--observe-only` 用法及模型输入/宿主字段边界。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:9>)

### `prompts/reference_observer_system.md`
- **Observer system prompt（新增模块）：** 限定可见证据和精确 JSON 字段，明确禁止 raw Mesh/path/几何查询，输出中性几何/结构观察而非 CAD 构造指令，dimensions/views 归宿主。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:30>)

### `scripts/mesh-to-cad.ts`
- **Observer imports（修改模块）：** 增加 prompt file 读取和 observe pipeline 入口，不影响 import-only。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:56>)
- **`Args` 观察字段（修改类型）：** 增加 intent、observer model 与 `observeOnly`。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:66>)
- **`help` 观察选项（修改函数）：** 展示 durable observe-only 模式。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:78>)
- **`parse` 模式与参数（修改函数）：** 解析观察参数并强制 import-only/observe-only 二选一。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:101>)
- **CLI 分支编排（修改模块）：** import-only 继续原流程；observe-only 调用 `observeReferenceRun` 并报告 brief。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:121>)

### `src/llm/generate.ts`
- **`singleRequestClient` / `singleRequestEvents`（新增模块逻辑/函数）：** 复用 prepare/auth 后只执行一次 native fetch，设置 `redirect: "error"`，直接解析单个 response，不进入 retry/continuation stream。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:149>)
- **`generateOnce.singleRequest`（新增字段）：** 为需要严格一次请求的调用者提供显式选择，默认调用行为不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:195>)
- **`generateOnce` 请求路径（修改函数）：** 只有显式 singleRequest 时使用 helper，其余调用继续使用原 client。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:204>)

### `src/pipeline/mesh-to-cad-reference.ts`
- **Observer import（修改模块）：** 接入受控观察结果，不改变 Plan 1 import 类型。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:218>)
- **`ObserveReferenceRunOpts` / `ObserveReferenceRunResult`（新增类型）：** 在导入结果上增加 intent/model/signal 和 observation artifacts。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:226>)
- **`observeReferenceRun`（新增函数）：** 先复用 Plan 1 导入，再以同一 roots/handle 调用 Authority + Observer；本阶段到 brief 即停止。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:244>)

### `src/reference/authority.ts`
- **`REFERENCE_VIEWS` / `ReferenceView`（新增常量/类型）：** 固定四个可观察视角，并复用现有 render 类型。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:272>)
- **`RenderedReferenceView`（新增类型）：** 公开值只含 view 和 PNG bytes。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:281>)
- **`renderReferenceView` 与 `#record`（新增方法/修改私有方法）：** 运行时验证 allowlist、私有缓存 Blender 输出，并让内部 record 携带私有目录；返回值不含路径或日志。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:293>)

### `src/reference/observer.ts`
- **`ObserverDraftSchema`（新增 schema）：** 严格限定模型可写字段并拒绝额外字段，包含中性几何/结构观察而非 OpenSCAD/CAD 构造策略。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:352>)
- **`ReconstructionBrief`（新增类型）：** 合并模型字段与宿主权威 dimensions/views。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:360>)
- **`ObservationResult`（新增类型）：** 返回 brief 与受控 run-local artifact paths。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:369>)
- **`jsonObject`（新增函数）：** 解析纯 JSON 或 fenced JSON，错误输出在写 brief 前失败。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:375>)
- **`observeReference`（新增函数）：** 固定收集 summary/四视图；仅在显式提供 intent 时加入 intent part；发出一次模型请求、验证并宿主盖章后持久化 brief。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.planned.patch:381>)

## 实现步骤

- [ ] 固定观察。输入：Plan 1 handle；改动：Authority 固定 views 与 private render cache；验证：四个 view 成功，其他 runtime 值失败，run 只有四张 PNG 而无 raw source/log；完成：受控观察包可人工验收。
- [ ] 单请求 Brief。输入：summary、四图、可选 intent；改动：single-request helper、Observer schema/prompt/orchestration；验证：真实 gateway 请求计数恰为 1，流中断或 length 不 replay，错误 JSON 失败，dimensions/views 与 Authority/文件逐一相等；完成：稳定 `reconstruction-brief.json`。
- [ ] CLI 与回归。改动：新增 `--observe-only` 并保留 import-only；验证：两个模式分别运行，Plan 1 Viewer/历史 run 不变，root typecheck、CLI help、diff check；完成：无 CAD artifacts。

## 接口与兼容性

新增 `--observe-only`、Observer model/intent 参数、四张 `_reference_observer/renders/ao-*.png` 与 `reconstruction-brief.json`。扩展 `generateOnce` 的可选 `singleRequest`，默认不变。Plan 1 manifest、endpoint 和 Viewer 契约不变。

## 验证

不新增、修改或运行 unit tests。实施阶段运行固定 view、真实单请求 gateway、错误 response、import-only 回归、CLI help、root typecheck 和 diff 检查；不运行 CAD generation 或 OpenSCAD。计划阶段依赖缺失时 typecheck 明确未验证。

## 风险与回滚

单请求意味着网络中断直接失败而不重试，这是隐私/请求次数契约的预期取舍。回滚时删除 prompt/observer 文件，并移除 Authority render、generateOnce 可选 seam、pipeline/CLI observe 分支；Plan 1 继续可用。

## 外部副作用与授权

实施验收需要一次真实模型请求和 Blender 四视图渲染，会产生模型费用、GPU/CPU 时间及 run PNG/brief；需在实施前确认授权。不会生成 CAD 或调用 OpenSCAD。

## 状态

**当前阶段：** Planning — 依赖 Plan 1 批准与实现后实施。
