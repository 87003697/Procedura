# Plan：Mesh-to-CAD 可控多视图输入实验

## 目标与完成标准

在已完成的单图 Mesh-to-CAD 开放环流程上增加一个程序化 opt-in：调用方可以从
Procedura 现有命名视角目录中选择有序视图列表，Plan 2 planner/reviewer 与 Plan 3
incremental generator 在同一次 run 中消费同一组由 host 渲染的公开图片。列表第一项
是权威主视图并继续写为 `image.png`；其余视图写为 `image-<view>.png` 并作为补充视角。

完成时：默认调用仍只渲染/发送 `isometric`，现有 CLI 无新增参数，普通 upstream
公开 `inputImage` 调用不变；程序化传入例如 `referenceViews: ["isometric", "front",
"right", "top"]` 时，两次 Plan 2 模型调用及每个 Plan 3 部件调用都收到四张图片，
日志/trajectory 记录 `refCount: 4`，公开 run 保留四张图片、`plan.json`、draft 与 final
产物。多视图仍不得向模型暴露 reference handle、私有 canonical STL、源 Mesh
bytes/path、manifest、材质、纹理或 host metadata。

本计划不增加任意相机向量、自由文本视角、CLI flag、图片 manifest、Studio 多图浏览、
几何比较、refine/repair、闭环迭代、新 Mesh 格式或 unit tests，也不声称一次模型运行能
证明多视图提升质量。

## 关键发现

- 计划基线 `361d28d5dd2d542125c661046b734f3d94f77631` 已包含完成并提交的 Plan 3，
  工作树在本计划开始前干净；因此本增量使用新的 Plan/Patch，不回写已冻结的 Plan 3
  Planned/Final Patch。
- `renderAOViews` 已支持 `ViewName` 目录中的约 20 个命名相机视角，真正的单图限制只在
  `ReferenceAuthority.renderReferenceImage` 固定传入 `["isometric"]` 并返回一张图片。
- `draft-incremental.ts` 内部已经用 `refImages`/`refParts` 向 planner、reviewer 和每个
  part generation 发送多图；现有 `extraRefs` 只能通过图像模型生成补充图，不能接收
  host 从同一 canonical Mesh 渲染的真实多视图。
- `image.png` 同时是 upstream 图像模式检测、Studio reference 展示和历史 run 的稳定
  文件契约。第一张选定视图继续占用该路径，可让多图能力保持可删除且无需修改这些
  downstream consumers。
- `PlanReferenceRunOpts` 已由新 Mesh-to-CAD 旁路拥有，增加程序化 `referenceViews`
  不需要修改 CLI。现有单图成功 run 位于 `outputs/mesh-to-cad-plan3-runtime`，可作为
  同输入的历史比较证据。

## 方案与决策

采用“caller-selected named views + primary compatibility file”的小接口：

1. `ReferenceAuthority` 将单图方法替换为接收有序 `ViewName[]` 并返回
   `{view, bytes}[]` 的多图方法。名称仍由现有 renderer catalog 约束；选择、数量和顺序
   由调用方控制。没有增加任意相机参数，因为那会要求改 Blender 脚本并扩大验证面。
2. `planReferenceRun` 默认选择 `["isometric"]`，所以未 opt-in 时模型 payload 的图片
   数量与排列不变。多图时给每张图片添加主/补充及视角标签，将同一数组用于 planner
   与 reviewer；第一张写 `image.png`，后续图片写 `image-<view>.png`。每次运行先清除
   catalog 中可能遗留的补充图，避免从多图切回少图后公开 run 混入旧图片。
3. `IncrementalDraftOpts` 将单路径 `inputImage` 统一替换为有序 `inputImages` seam；
   单图就是长度为 1 的数组。`RunProceduraOpts.inputImage` 这个现有公开入口继续保留，
   `procedura.ts` 只做一次机械适配。不新建第二套生成流程，也不改现有 text/image、
   generated `extraRefs`、plan、compile 或 promotion 行为。
4. Mesh-to-CAD generation 仅把 Plan 2 返回的公开 `{view, path}` 列表转发给这个 seam。
   不写 manifest、不重新扫描目录，也不让 incremental draft 访问私有 authority。

放弃“默认把 CLI 改为四视图”：它会无条件增加所有运行的模型图片成本，并使本次实验
变成公开默认行为。放弃“新增 `--views`”：当前目标只是受控实验，程序化 seam 足以验证，
待证据显示有价值后再单独决定是否形成 CLI 契约。

## Patch Artifact

- **计划基线：** `361d28d5dd2d542125c661046b734f3d94f77631`
- **计划 Patch：** [2026-08-31-mesh-to-cad-multi-view.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch>)
- **批准前校验：** `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch`

## Patch Intent

### `README.md`

- **Mesh-to-CAD 输入说明（修改）：** 将单图描述改为可选择的 host-rendered reference images，同时保持默认 isometric；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:10>)
- **公开 artifacts 与隐私边界（修改）：** 说明第一张仍是 `image.png`、补充图的命名及 Plan 2/3 使用同一公开图片集；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:21>)

### `src/reference/authority.ts`

- **`ViewName` 依赖（新增）：** authority 直接复用现有 renderer catalog 类型，不再创造第二份视角名称集合；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:286>)
- **`RenderedReferenceImage`（新增）：** 以最小 `{view, bytes}` 结果保留图片与相机语义的对应关系；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:294>)
- **`renderReferenceImages`（替换）：** 一次渲染调用消费 caller-selected 有序视图并返回同序图片，私有 canonical 路径仍封装在 authority 内；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:307>)

### `src/pipeline/mesh-to-cad-plan.ts`

- **补充视图清理依赖（修改）：** 使用既有 view catalog 枚举可遗留的公开补充图，不引入 manifest 或目录猜测；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:135>)
- **`PlanReferenceRunResult` 与默认视图（修改）：** 返回本次实际公开图片路径，默认仍为单张 isometric；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:143>)
- **`PlanReferenceRunOpts.referenceViews`（新增）：** 让程序化调用方控制命名视图的数量、选择与主图顺序；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:160>)
- **`generate`（修改）：** 不判别图片数量，始终按顺序附加主/补充标签和每张图片；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:166>)
- **`planReferenceRun` 渲染与公开写入（修改）：** 清除旧补充图、渲染所选视角、固定第一张为 `image.png`，并统一使用 reference views prompt；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:199>)
- **planner 调用（修改）：** 初始计划与 parse retry 始终复用完整图片数组；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:231>)
- **reviewer 调用（修改）：** plan review prompt 与 payload 使用同一完整图片数组；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:240>)
- **`PlanReferenceRunResult.referenceImages`（返回）：** 将本次图片清单交给同进程 generation，而不是从目录重新发现；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:261>)

### `src/pipeline/draft-incremental.ts`

- **`IncrementalDraftOpts.inputImages`（替换）：** 用一个 ordered provided views seam 同时表达单图和多图，删除内部单路径入口；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:47>)
- **`providedImages`（新增）：** 单一 seam 直接成为 Stage A/Stage C 的内部图片集合，不维护兼容分支；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:57>)
- **Stage A provided-image 选择（修改）：** 只把第一张 authoritative view 复制到稳定的 `image.png`；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:67>)
- **`refImages` 构造（修改）：** 从公开路径加载其余 provided views，并继续复用现有图像归一化；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:77>)
- **multi-ref evidence（修改）：** 无论补充图来自 host 还是 image generation，只要实际发送多图就记录 ref count；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:93>)
- **`refParts` 多图说明（修改）：** 用通用 supplementary wording 覆盖 host-rendered 与 generated extras，不再误称所有补充图都是生成视角；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:101>)
- **模型可见多图说明（修改）：** 明确 View 1 权威、其余仅补充形状上下文；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:110>)

### `src/pipeline/mesh-to-cad-generation.ts`

- **`runMeshToCadGeneration` 图片转发（修改）：** 只把 Plan 2 已公开的 view/path 清单传给 incremental seam，保持私有 reference 隔离；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:122>)

### `src/pipeline/procedura.ts`

- **`runProcedura` incremental adapter（修改）：** 保留既有公开 `inputImage` 入口，并在调用统一 seam 时把它表示为一项 primary 数组；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.planned.patch:272>)

## 实现步骤

- [ ] 从计划基线应用冻结的 Planned Patch，只修改 Patch 中的 6 个业务文件；验证：检查 diff 文件边界；完成：实现与 Planned Patch 一致，Plan 3 历史 planning artifacts 未变化。
- [ ] 将 reference authority 与 Plan 2 改为 caller-selected named views；验证：TypeScript typecheck、静态检查默认 `["isometric"]` 与多图顺序；完成：第一张写 `image.png`，补充图按 view 命名，旧补充图在重跑时清除。
- [ ] 将同一公开图片集送入 planner/reviewer 与 incremental generation；验证：静态检查所有模型调用点及 `draft.multiref.ready.refCount`；完成：单图和多图走同一 ordered-view payload，多图每次调用都包含同序图片。
- [ ] 保持 upstream 和公开行为；验证：CLI help、调用点搜索、Studio/paint/refine 路径静态检查；完成：CLI 无新 flag、公开 `RunProceduraOpts.inputImage` 调用不变、`image.png`/reference handle 契约不变。
- [ ] 在获得 patch 批准后，以 `outputs/transformer-robot-smoke-20260830/final.obj` 做一次四视图真实运行；验证：公开 artifacts、Plan 2 plan、trajectory ref count、31/31 或本次实际计划 part 完成状态、final SCAD/OBJ 及独立 OpenSCAD compile；完成：记录模型如何利用多视图形成 plan 和 CAD，不把一次结果表述为质量提升证明。
- [ ] 生成同基线 Final Patch 并执行 implementation-review Mode B；验证：Planned→Final tree comparison、现有验证证据与独立 reviewer；完成：`No findings` 或把 result-changing finding 交给用户决定。

## 接口与兼容性

- `PlanReferenceRunOpts.referenceViews?: readonly ViewName[]` 是新的程序化 opt-in；省略时
  仍为 `["isometric"]`，CLI 继续省略它。
- `PlanReferenceRunResult.referenceImages` 只包含公开 run 内的 view/path，不含私有
  handle 或 geometry；当前 CLI 不展示该字段。
- `IncrementalDraftOpts.inputImages` 是唯一的 provided-image seam；原内部
  `IncrementalDraftOpts.inputImage` 被它替换，单图表示为一项数组。
- `RunProceduraOpts.inputImage` 继续保留并在 `procedura.ts` 薄适配为一项数组，因此
  scripts、CLI 和普通 Procedura 调用不受影响。
- `image.png` 继续表示第一张权威图，保持 workspace、Studio、refine、paint 和历史 run
  契约。补充图是 additive artifacts，当前 Studio 不展示。
- 合法 view name 复用 `ViewName`/`VIEW_CATALOG`；不接受任意自由文本相机名称，也不新增
  renderer catalog。

## 验证

- 已有 planning evidence：Planned Patch 对基线 `git apply --check` 通过；在隔离的基线
  副本应用 Planned Patch 后，`bun run typecheck` 与 `bun run mesh-to-cad --help` 通过。
- 批准后静态验证：6-file business diff、旧 `renderReferenceImage` 与内部
  `IncrementalDraftOpts.inputImage` 调用清零、默认单图
  payload 分支、全部 model-visible image 来源均为公开 output paths、无私有字段传播。
- 批准后真实验证：沿用已授权的 Venus `gpt-5.5` destination、本机 Blender/OpenSCAD
  和 transformer robot OBJ；选择 `isometric/front/right/top`，将多图 plan 与既有单图
  31-part run 作描述性对比，并确认 Plan 2、Plan 3 都记录/消费四图。
- 失败验证：若外部生成失败，保留本次 reference images、plan/draft/intermediate
  evidence，但既有 Plan 3 final 成功判定与失败清理语义不变。
- 遵守仓库约束：不新增、修改或运行 unit tests，不安装依赖，不做 SHA verification。

## 风险与回滚

- 多图会增加每次 planner、reviewer 和 per-part 请求的图像 token、延迟及费用；只有显式
  `referenceViews` opt-in 才承担该成本。真实测试已经由用户要求，但实现仍须在 Planned
  Patch 明确批准后执行。
- 不同视图可能让模型发现单图遮挡的部件，也可能因视角解释冲突生成更复杂或不一致的
  plan；测试报告只记录观察，不以单样本得出质量结论。
- 回滚时恢复 `renderReferenceImage` 与 incremental 单路径参数，删除
  `referenceViews/referenceImages/inputImages` seams、`procedura.ts` 薄适配和补充图文档
  即可；`image.png`、CLI、Plan 3 generation、Studio 及普通 upstream 行为无需迁移。

## 状态

**当前阶段：** Implementation complete；Final Patch 已冻结，Mode B 为 `No findings`。

## Implementation Review

冻结的 Planned Patch 从基线
`361d28d5dd2d542125c661046b734f3d94f77631` 落地后未发生实现修正；同基线生成的
Final Patch 与 Planned Patch 字节一致，因此 P→F 没有差异，也没有需要接受或拒绝的
final-only hunk。独立 implementation-review Mode B 返回 `No findings`，确认业务 diff
恰好覆盖批准的 6 个文件且没有 test 改动。

Final Patch 关键位置：

- [README 多视图公开契约](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:21>)
- [`IncrementalDraftOpts.inputImages` 统一 seam](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:47>)
- [`runIncrementalDraft` provided views 与 multi-ref evidence](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:67>)
- [Mesh-to-CAD generation 公开图片清单转发](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:123>)
- [`PlanReferenceRunOpts.referenceViews` 与统一 payload](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:161>)
- [`planReferenceRun` 渲染、公开文件与 Plan 2 调用](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:199>)
- [`runProcedura` 公开单图薄适配](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:272>)
- [`ReferenceAuthority.renderReferenceImages`](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-31-mesh-to-cad-multi-view.final.patch:307>)

验证证据：`bun run typecheck`、`bun run mesh-to-cad --help`、`git diff --check` 通过；
Final Patch 可从原基线应用，并可对当前实现反向应用；遵守仓库约束，未新增、修改或运行
unit tests。真实四视图运行使用既有 transformer robot OBJ，公开生成 `image.png`、
`image-front.png`、`image-right.png`、`image-top.png`，Plan 2 得到 31-part plan，trajectory
记录 `refCount: 4`；Plan 3 的 31/31 部件全部在 `[gen 1]` 编译成功，总耗时 2095 秒。
期间只有一次模型传输层 HTTP 500 自动重试，没有 CAD regeneration 或 repair。

成功 run 保留在 `outputs/mesh-to-cad-multiview-runtime`：`final.scad` 约 118 KB、
`final.obj` 约 4.9 MB，summary 为 `verdict: ok`。独立 OpenSCAD 编译成功，结果为
manifold、`NoError`、74,214 vertices、150,372 facets，验证 STL 约 41 MB。与既有单图
run 相比，两者均为 31 parts；多图计划单独分解了头顶立柱和小腿履带轮，并调整了躯干、
肩部拆分，但单次样本不构成质量提升证明。

仍未验证：从四视图重跑为更少视图以动态验证旧补充图清理；Studio 人工交互；失败注入。
后两项对应的 Studio 与 final promotion/failure 代码本次未修改，已有 Plan 3 契约保持不变。
