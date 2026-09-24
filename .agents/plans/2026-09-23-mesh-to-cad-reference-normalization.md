# Plan: Mesh-to-CAD 参考 Mesh 归一化与 draft 坐标系

## 目标与完成标准

让 GT 和生成的 CAD 从一开始就处在同一个坐标系里，使 Mapping 不需要配准就能直接比较。做法参考 TRELLIS 的数据预处理：导入前把参考 mesh 的包围盒中心移到原点，按最长边等比缩放，不旋转；缩放目标取 `[-1, 1]^3` 乘 50，即最长边 100 mm。draft 的输入同时写明这个坐标系和包围盒尺寸，让 draft 按这个尺寸、以原点为中心建模。

完成后用户可以看到：

- `bun run mesh-to-cad --mesh <任意单位的 Z-up mesh>` 生成的 `reference.json` 尺寸是归一化后的尺寸（最长边 100 mm），run 目录多一个 `reference-normalization.json`，记录中心偏移、缩放系数和前后尺寸；
- 私有参考库中的 canonical STL、参考视图、plan 收到的几何摘要都来自归一化后的 mesh；
- draft 的每个部件请求都带有 `=== REFERENCE FRAME ===` 块，写明包围盒以原点为中心、各轴范围和总尺寸；
- （09-24 追加）不开 `--refine` 时，plan 和 draft 也收到 GT 的 7 张公开视图：等轴测（仍是 `image.png`）加前、后、左、右、上、下，不再只有一张等轴测图；
- host adapter 可以用同一个导出函数 `normalizeReferenceStl` 把 GT 归一化，得到与 draft 相同的坐标系。

非目标：

- 不旋转参考 mesh，不做 PCA 转正，也不做任何配准；
- 不改 Mapping、visual critic、renderer、refine 代码、上游 draft 提示词和 `$fs` facet 策略；
- 不改 `ReferenceAuthority`、`src/reference/normalization.ts`、`src/mesh/normalize.ts` 和 Studio 代码；
- 本计划的代码不依赖付费运行；最后一步的付费 draft 验证需要单独授权，结果只作为下一步决策依据。

## 关键发现

- **draft 看不到绝对尺寸。** plan 阶段通过 `HOST GEOMETRY SUMMARY` 收到 `reference.json` 的尺寸，但 09-15 的 `plan.json` 只写相对比例（如“直径约等于物体高度”）；draft 的输入只有 `"Generate editable CAD from this host-produced plan:\n\n" + planText`（`src/pipeline_mesh2code/procedura_adapter.ts`），而 `prompts/scad_system.md` 要求“Infer absolute scale from the image”。09-15 draft 猜出 197 × 42 × 16.6 mm，GT 是 99.4 × 64.8 × 14.4 mm。
- **draft 总是从原点往外搭。** `prompts/scad_part_system.md` 规定第一个部件“centred near the origin”并以它确定尺度，于是链条从原点沿 +X 生长；GT 的包围盒中心却在 (−29.5, −0.8, 0) mm。坐标系说明必须明确原点是整个物体的中心，而不是第一个部件。
- **坐标系块能到达每个部件请求。** `src/pipeline/draft-incremental.ts` 的部件请求包含 `=== TEXT DESCRIPTION (whole object) ===\n${text}`，plan review 和 assembly 请求也包含同一段 `text`；追加在 `text` 末尾的块会进入每一步。`runIncrementalDraft` 一开始就把 `text` 写入 `prompt.txt` 和 `effective_text.txt`（第 2134–2135 行），早于任何 LLM 请求。
- **refine 也读这段文本。** `--refine` 时 `src/config/workspace.ts` 读取 `effective_text.txt`，`src/pipeline/refine-direct.ts` 把它作为 `=== TEXT SPEC ===` 放进每次 patch 请求（基线第 495 行），所以坐标系块也会进入 refine；第 318 行只在没有参考图像时使用，Mesh-to-CAD 总有参考图像，不会走到。复用已有 draft 时不会重写 `effective_text.txt`，其中仍是旧文本。
- **SCAD 不能直接用 `[-1, 1]` 单位。** 上游 `SEED_FACET_POLICY` 固定 `$fs = 1`（`draft-incremental.ts` 第 273 行），`scad_part_system.md` 和 refine 提示词要求相邻部件至少重叠 0.5 mm。模型只有 2 个单位长时，球和圆柱会退化成五边形，0.5 mm 相当于模型长度的四分之一。
- **上游已有同一种归一化。** `src/mesh/normalize.ts` 的 `normalizeMeshInPlace({ stlPath, targetHalfExtent })` 把 STL 居中，并把最长边缩放到 `2 × targetHalfExtent`，同时拒绝空 mesh 和零尺寸包围盒，返回缩放系数、中心偏移和前后尺寸。`publishMesh` 用 `targetHalfExtent = 1` 处理发布的 `draft.obj`/`final.obj`（以及 `exportStl` 时的 STL）；SCAD 源码和 refine 内部的编译结果保持原始坐标。本计划用 `targetHalfExtent = 50` 调用同一个函数，所以 GT 坐标系正好是 Procedura 发布归一化乘 50；验证时必须重新编译 `draft.scad`，不能读 `draft.stl`。
- **归一化与源单位无关。** 在打过 Planned Patch 的临时树中，先用 `normalizeReference` 转成 STL，再调用 `normalizeReferenceStl`：`outputs/examples/01-snake-arm/reference.obj` 的缩放系数 100.6125、中心偏移 (0.2950, 0.0082, 0)，结果尺寸 100.00 × 65.15 × 14.49 mm，包围盒中心为 (0, 0, 0)；放大 100 倍的 `reference-100x.stl` 缩放系数 1.00613、中心偏移 (29.504, 0.822, 0)，两者归一化后顶点最大差 7.6e-6 mm。
- **Studio 只读取已导入的参考。** 上游文件 `web/server.ts` 构造 `ReferenceAuthority` 只为 `/api/reference/mesh` 读取 canonical STL，`web/server/scan.ts` 读取 run 目录里的 `reference.json`；`importReference` 唯一的调用方是 `importReferenceRun`。所以无论归一化放在哪一层，新 run 在 Studio 中显示的参考 mesh 和尺寸都会是归一化结果，Studio 代码不需要改。
- **根目录校验没有副作用。** `ReferenceAuthority` 的构造函数只检查参考库根目录与 runs、工作区不相交；`importReferenceRun` 在写任何文件之前先构造它。
- **复用 draft 且不开 refine 时不调用 LLM。** `runProcedura` 只有在参考（`image.png` 或文本）、`draft.scad` 和 `draft.obj`/`draft.stl` 都存在时才跳过 Phase 1（`hasDraftArtifacts`）。09-15 的 replay 复用完整 draft，0 次请求、8.6 秒完成。删除 `draft.obj` 和 `draft.stl`、保留 `plan.json` 和 `draft.scad` 时，生成流程仍复用 plan，但会重新进入 `runIncrementalDraft`。09-15 从头生成 plan + draft 共 15 次请求，只用一张等轴测透视图。
- **不开 refine 时 plan 和 draft 只看一张 GT 等轴测图（09-24 追加）。** 08-31 多视图计划把 `planReferenceRun` 的默认视角定为 `["isometric"]`，理由是控制实验成本；只有开 `--refine` 时，`mesh-to-cad-generation.ts` 才传入 7 个视角（原 `REFINE_REFERENCE_VIEWS`）。09-23 付费 draft 的 12 次请求中，前 4 次各带 1 张图，后 8 次各带 8 张：1 张 GT 等轴测图加 7 张 draft 已建部件的渲染（adapter 的 `contextRenders`），没有 GT 俯视图。plan 于是用等轴测画面方向描述链条走向（“upper-left-to-lower-right”），draft 把它当成世界 XY 方向，拟合出约 46° 偏航。09-15 以来的 refine 实验复用的 draft 也只看过这一张图。`runMeshToCadGeneration` 是 `planReferenceRun` 唯一的 tracked 调用方。
- **图片预算够用。** draft 部件请求在参考图之后附加已建部件渲染，预算是 `16 - 参考图数`（`draft-incremental.ts` 第 2867 行）；7 张 GT 视图加 7 张已建部件渲染共 14 张，已建部件视图不会被挤掉。
- **桩函数抛错会被重试放大。** LLM 请求通过 `src/llm/long-timeout-fetch.ts` 调用全局 `fetch`，外层还有 harness 和 draft 的重试。免费检查因此让桩函数在第一次被调用时直接记录结果并结束进程。
- **文件归属。** `src/pipeline_mesh2code/*`、`src/reference/*`、`scripts/mesh-to-cad.ts`、`experiments/octree-mapping/*` 都不在上游 SpatiaOS 仓库中，是本 fork 的 Mesh-to-CAD 模块；`README.md` 和 `src/mesh/normalize.ts` 是上游文件，其中 `README.md` 的 Mesh-to-CAD 一节由本 fork 添加。
- 仓库没有单元测试；TypeScript 用 `bun run typecheck` 检查，行为用调用真实入口的黑盒脚本验证。

## 方案与决策

**归一化方式：TRELLIS 的居中 + 等比缩放，目标最长边 100 mm。** 这与 `[-1, 1]^3` 只差固定系数 50，既满足“归一化到 `[-1, 1]^3`”的要求，又保持上游 facet 策略和 mm 容差有意义。实现上只读调用上游 `normalizeMeshInPlace`（`targetHalfExtent = 50`），由新模块的 `normalizeReferenceStl` 包装成记录格式；pipeline 和 host adapter 都调用这个函数。放弃的方案：

- SCAD 直接使用 `[-1, 1]` 单位：需要改上游 `$fs` 策略和多处 mm 容差提示词，违反上游隔离；
- 每轮在 Mapping 里把 candidate 也单独归一化：这等于用包围盒做一次粗配准，杆长做错时误差会被缩放吸收，Mapping 看不到尺寸错误；
- 相似配准或刚体配准：用户明确不采用；
- PCA 转正（旋转）：TRELLIS 不旋转；先用付费 draft 验证判断朝向是否仍是主要误差，再决定是否另开计划。

**放置位置：`src/pipeline_mesh2code/` 下的新模块包装 `planReferenceRun`。** 新模块先把源 mesh 转成 STL（复用 `normalizeReference`，支持全部导入格式），归一化后写成临时 STL，再交给原有的 `planReferenceRun` 导入。放弃在 `ReferenceAuthority` 或 `src/reference/normalization.ts` 中归一化：AGENTS.md 和 ADR 0001 要求新能力放在可删除的模块里，而 authority 与 `normalizeReference` 的职责只是把各格式转成 canonical STL，保持这个边界可以让删除新能力时不碰参考库代码。

**临时文件放在已校验的私有参考库根目录下。** 新模块先按 `importReferenceRun` 的方式解析 runs 根目录，构造 `ReferenceAuthority(referenceRoot, [runsRoot, PROCEDURA_ROOT])` 校验根目录，再检查源 mesh 存在和格式受支持，之后才创建 `<referenceRoot>/.normalize-*` 并写入临时 STL；导入完成或失败后都在 `finally` 中删除。误配的根目录在任何写入之前被拒绝。authority 的 handle 只匹配 `ref_*`，不会把临时目录当成参考。

**draft 输入追加坐标系块，plan 输入不变。** plan 已经通过几何摘要看到尺寸，且只输出相对描述；缺的是 draft。坐标系块由新模块生成，`procedura_adapter.ts` 只负责把它接在 plan 文本后面。块内写明 Z-up 毫米、包围盒以原点为中心、各轴半宽和总尺寸，并明确第一个部件也要放在它在包围盒中的位置。开 `--refine` 时 refine patcher 通过 `effective_text.txt` 也会看到这个块，这与 draft 的坐标系一致，不单独屏蔽。

**记录文件放在 run 目录。** `reference-normalization.json` 只有 10 个数：canonical Z-up 毫米坐标下的中心偏移、缩放系数、归一化前后尺寸，不含路径、源字节、材质或几何。按 ADR 0002，它和 `reference.json` 的摘要一样属于有界几何摘要；plan、draft 和 refine 只读取 `plan.json`、公开图像和 `effective_text.txt`，不会读到它。它用于复查，以及把 CAD 映射回 canonical 坐标。

**plan 和 draft 默认看 GT 的 7 个视角（09-24 追加）。** `runMeshToCadGeneration` 不论是否开 refine，都向规划入口传入等轴测加 6 个正交视角；调用方显式传入的 `referenceViews` 优先。等轴测仍排第一、写成 `image.png`，保留 Studio 和上游图像模式依赖的文件契约；其余写成 `image-<view>.png`，与 refine 使用的同一组图片。放弃的方案：只加俯视图（前后左右和底视图同样约束高度和侧面形状，多几张图的成本差别不大）；新增 CLI 开关（用户要求默认就看到 7 张）；改 `planReferenceRun` 的默认值（生成层已有 7 视角常量，这里是 Mesh-to-CAD 唯一的编排点，改一处即可）。

**在 Mesh-to-CAD 中始终启用，不加开关。** 这是 Mesh-to-CAD 的坐标系约定；加开关会让 draft 坐标系块和 Mapping 约定同时支持两种坐标系，而目前没有需要保留旧坐标系的调用方。

## Patch Artifact

- **计划基线：** `2aff1df`（`Merge pull request #24 from 87003697/codex/publish-mapping-native-mm-units-records`）；Patch 只覆盖下列 5 个文件，工作区中 `src/pipeline/refine-direct.ts` 和 `.agents/notes/依赖排查.md` 的既有改动不属于本计划
- **计划 Patch：** [2026-09-23-mesh-to-cad-reference-normalization.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch>)
- **批准前校验：** 用临时 index 读取基线后执行 `GIT_INDEX_FILE=<tmp> git read-tree 2aff1df && GIT_INDEX_FILE=<tmp> git apply --check --cached /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch`；另在 `git archive 2aff1df` 解出的临时树中用 `patch -p1` 应用，确认 5 个文件与目标内容一致后运行 `bunx tsc --noEmit -p tsconfig.json`，通过
- **Final Patch：** [2026-09-23-mesh-to-cad-reference-normalization.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.final.patch>)，从同一基线生成，对基线 apply-check 通过，与 Planned Patch 逐字节相同
- **09-24 追加：** 用户要求把 7 视角默认直接加进本计划并实现。两份 Patch 按同一方式重新生成，仍是这 5 个文件，239 行、11 个 hunk，SHA-256 都是 `4b95a495…01da1bd`，替换原 `65ab1fd9…db55f6` 版本；新增的改动只在 `mesh-to-cad-generation.ts`（视角常量与规划调用）和 `README.md`（视图说明）。对基线的临时 index apply-check 通过；`git archive 2aff1df` 解出的临时树打上 Patch 后，5 个文件与工作区逐字节一致

## Patch Intent

### `src/pipeline_mesh2code/mesh-to-cad-reference-frame.ts`

- **`REFERENCE_LONGEST_SIDE_MM`（新增，模块内常量）：** 归一化后的最长边定为 100 mm，即 `[-1, 1]^3` 乘 50。这样参考坐标系既是 TRELLIS 式的单位立方体，又让上游 `$fs = 1` 和 0.5 mm 重叠等 mm 量级约定继续成立；上游代码不需要改动。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:22>)
- **`ReferenceNormalization`、`normalizeReferenceStl`（新增）：** 用 `targetHalfExtent = 50` 调用上游 `normalizeMeshInPlace`，原地把 STL 包围盒中心移到原点、最长边缩放到 100 mm，不旋转；返回中心偏移、缩放系数和前后尺寸，变换形式是 `(source + centerOffset) * scale`。空 mesh 和零尺寸包围盒沿用上游的报错。pipeline 和 host adapter 调用同一个函数，所以 draft 看到的坐标系和 Mapping 使用的 GT 坐标系一致；源 mesh 是什么单位都不影响结果。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:34>)
- **`planNormalizedReferenceRun`（新增）：** Mesh-to-CAD 原来直接导入源 mesh，GT 保留自己的原点和尺度。现在先在私有参考库根目录下暂存归一化后的 STL，再交给原有的 `planReferenceRun` 导入和规划，最后删除暂存目录，并在 run 目录写入 `reference-normalization.json`。参考库、参考视图、`reference.json` 和 plan 的几何摘要因此都来自归一化 mesh；返回值与 `planReferenceRun` 相同，plan 复用、视图选择和导入校验保持不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:52>)
- **写入前的根目录和源文件校验（新增）：** 暂存前先构造 `ReferenceAuthority` 校验参考库根目录与 runs、工作区不相交，并检查源 mesh 存在、格式受支持。误配的根目录和不存在的 mesh 在创建任何目录之前被拒绝，报错与 authority 相同；GT 副本只会写进已校验的私有根目录。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:60>)
- **`referenceFrameText`（新增）：** draft 以前只能从图像猜绝对尺度，并把第一个部件放在原点。新函数生成 `=== REFERENCE FRAME ===` 块，写明 Z-up 毫米、包围盒以原点为中心、各轴半宽和总尺寸，并说明原点是整个物体的中心、第一个部件也要放在它在包围盒中的位置。draft 因此有明确的尺寸和位置目标；上游提示词本身不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:83>)

### `src/pipeline_mesh2code/mesh-to-cad-generation.ts`

- **模块导入（修改）：** 生成流程改从新模块取得规划入口和坐标系块；`mesh-to-cad-plan.ts` 只剩类型导入，按仓库习惯写成 `import type`。这是删除新能力时唯一需要回退的导入改动。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:105>)
- **`REFERENCE_VIEWS`（重命名，09-24 追加）：** 原 `REFINE_REFERENCE_VIEWS` 只在开 refine 时使用；现在它是 Mesh-to-CAD 生成的默认视角列表（等轴测、前、后、左、右、上、下），名字去掉 refine。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:115>)
- **`runMeshToCadGeneration` 规划调用（修改）：** 调用点从 `planReferenceRun` 换成 `planNormalizedReferenceRun`，参数和返回类型不变；draft 复用和 stale 文件清理逻辑保持原样。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:124>)
- **`runMeshToCadGeneration` 参考视角（修改，09-24 追加）：** 原来只有开 refine 才传 7 个视角，不开时 plan 和 draft 只收到一张等轴测图。现在总是传 `planOpts.referenceViews ?? REFERENCE_VIEWS`：plan、plan review 和每个 draft 部件请求都收到同一组 7 张 GT 图，调用方显式指定的视角优先。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:127>)
- **`runMeshToCadGeneration` 坐标系块（修改）：** 用 `reference.json` 中归一化后的尺寸生成坐标系块并传给 adapter，让 draft 收到的尺寸与 plan 看到的几何摘要完全一致。其他传给 adapter 的参数不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:135>)

### `src/pipeline_mesh2code/procedura_adapter.ts`

- **`MeshToCadProceduraOpts.referenceFrame`（新增字段）：** adapter 的输入新增必填的坐标系块。唯一调用方 `runMeshToCadGeneration` 已同步传入，漏传会在 typecheck 时报错，不会悄悄生成没有坐标系的 draft。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:147>)
- **`runMeshToCadProcedura` 文本（修改）：** 把坐标系块接在 plan 文本之后，写入 `runProcedura` 的 `text`；它随之进入 `prompt.txt`、`effective_text.txt` 和每个部件请求，开 `--refine` 时还通过 `effective_text.txt` 进入每次 patch 请求。incremental、assembly、direct refine 和 open-loop promotion 等设置不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:156>)

### `README.md`

- **Mesh-to-CAD 导入说明（修改）：** 原文要求 STL/OBJ/PLY 已经是 Z-up 毫米。现在只要求 Z-up，并说明导入前会居中、把最长边等比缩放到 100 mm、不旋转，源单位不影响结果。其他格式的坐标约定描述保留。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:170>)
- **`--refine` 说明（修改，09-24 追加）：** 原文说开 refine 时才把参考 Mesh 渲染成 7 个视角；现在 7 个视角是默认，改为 refine 用同一组 7 张公开视图审查和修补 draft。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:182>)
- **参考视图说明（修改，09-24 追加）：** 原文写“默认只渲染一张等轴测 `image.png`，程序化调用方可以追加视角”；改为 Plan 2 渲染等轴测（`image.png`，权威视图）加前、后、左、右、上、下共 7 张，程序化调用方可以换成别的有序列表。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:193>)
- **Plan 3 输入（修改）：** 说明增量生成器除了公开图像和 `plan.json`，还收到带居中包围盒的坐标系块，并被要求在这个坐标系中建模；不把 LLM 是否遵守写成事实。上游重试、plan reviewer、连通性门禁和断点续跑的描述不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:200>)
- **输出与坐标系（修改）：** 保留文件列表加入 `reference-normalization.json`，并把原来“canonical STL 保留源坐标”的说法改为：私有 canonical STL、参考视图和 `reference.json` 尺寸使用归一化坐标系，`final.scad` 被要求在这个坐标系中生成；发布的 `final.obj` 仍由 Procedura 归一化到 `[-1, 1]`，毫米级比较要重新编译 `final.scad`。“Selected supplementary views” 随视角默认改为 “Supplementary views”。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:212>)

### `experiments/octree-mapping/README.md`

- **Mapping critic adapter 约定（修改）：** 要求 Mesh-to-CAD run 的 host adapter 先用 `normalizeReference` 把 target 转成 STL，再用 `normalizeReferenceStl` 归一化这份副本。这与 `reference-normalization.json` 记录的变换一致，target 因此与 draft 处在同一坐标系，不需要配准。原有的 mm 字段和检查半径约定不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch:231>)

## 实现步骤

以下命令都在仓库根目录执行，使用 zsh，这样 `.env` 中的 OpenSCAD 与模型配置会被加载。验证输出写入 `C=outputs/reference-frame-check-2026-09-23`。免费检查使用的私有参考库都在 `/private/tmp` 下，需要在沙箱外运行；脚本把 `globalThis.fetch` 替换为桩函数，保证不发出付费请求。

- [x] **应用 Planned Patch。** 输入：冻结的 Planned Patch 和基线 `2aff1df`。改动：先记录 `src/pipeline/refine-direct.ts` 的 SHA-256，再 `git apply .agents/plans/2026-09-23-mesh-to-cad-reference-normalization.planned.patch`。验证：`git diff --stat` 与 `git status --short`；再次计算 `refine-direct.ts` 的 SHA-256。完成：除应用前已有的 `refine-direct.ts` 和 `.agents/notes/依赖排查.md` 改动外，只有本计划的 4 个文件被修改、1 个文件新增；`refine-direct.ts` 的哈希不变，真实暂存区为空。
- [x] **静态检查。** 验证：`bun run typecheck`；`git diff --check -- src/pipeline_mesh2code README.md experiments/octree-mapping/README.md`。完成：两条命令退出码均为 0。
- [x] **归一化黑盒检查。** 输入：`outputs/examples/01-snake-arm/reference.obj` 和 `outputs/paid-retest-2026-09-15/reference-100x.stl`。改动：新建 `$C/normalize-check.ts`：用 `normalizeReference` 把 OBJ 转成 `$C/obj.stl`，把 STL 复制为 `$C/big.stl`，分别调用 `normalizeReferenceStl`，再用 `loadSTL` 读回两者，输出两份记录、归一化后包围盒中心、顶点最大差，以及 `referenceFrameText` 的结果到 `$C/normalize-check.json`。验证：`bun run $C/normalize-check.ts`。完成：两个结果的包围盒中心每轴绝对值 < 1e-3 mm；最长边 = 100 ± 1e-3 mm；尺寸四舍五入为 100.00 × 65.15 × 14.49；OBJ 的缩放系数 = 100.6125 ± 1e-4、中心偏移 = (0.2950, 0.0082, 0) ± 1e-4；STL 的缩放系数 = 1.00613 ± 1e-5、中心偏移 = (29.504, 0.822, 0) ± 1e-2；两者顶点最大差 < 1e-3 mm；坐标系块文本包含 `measures 100.00 × 65.15 × 14.49 mm (X ±50.00, Y ±32.58, Z ±7.24)`。
- [x] **导入、记录和根目录校验的免费连线检查。** 输入：`cp -R outputs/paid-retest-2026-09-15/run $C/run`（已有完整 draft，复用时不调用 LLM）。改动：新建 `$C/wiring-check.ts`：把 `globalThis.fetch` 替换为计数后抛错的函数，删除 `/private/tmp/procedura-reference-frame-check-2026-09-23`；先以 `referenceRoot: $C/bad-root`（位于 runs 根目录内）调用 `planNormalizedReferenceRun` 并捕获错误；再以 `outputDir: $C/run`、`meshPath: outputs/examples/01-snake-arm/reference.obj`、`runsRoot: outputs`、`referenceRoot: /private/tmp/procedura-reference-frame-check-2026-09-23`、`refine: false` 调用 `runMeshToCadGeneration`，把结果写入 `$C/wiring-check.json`。验证：在沙箱外运行 `bun run $C/wiring-check.ts`。完成：脚本退出码 0，fetch 调用次数为 0；误配根目录的调用以 `reference root must be disjoint from runs and workspace roots` 失败，且 `$C/bad-root` 不存在；`$C/run/reference.json` 的尺寸为 100.00 × 65.15 × 14.49（±0.01）；`$C/run/reference-normalization.json` 的 `scale` = 100.6125 ± 1e-4、`centerOffset` = (0.2950, 0.0082, 0) ± 1e-4，`dimensions` 与 `reference.json` 相差 < 1e-3；参考库根目录下恰好 1 个 `ref_*` 目录、0 个 `.normalize-*`；该目录中 `canonical.stl` 的包围盒中心每轴 < 1e-3 mm、最长边 100 ± 1e-3 mm；`$C/run/final.scad` 存在。
- [x] **坐标系块接入 draft 的免费检查。** 输入：`cp -R outputs/paid-retest-2026-09-15/run $C/run-text && rm -f $C/run-text/draft.obj $C/run-text/draft.stl`，保留 `plan.json` 和 `draft.scad`，使生成流程复用 plan 但重新进入 `runIncrementalDraft`。改动：新建 `$C/text-check.ts`：删除 `/private/tmp/procedura-reference-frame-text-check-2026-09-23`，把 `globalThis.fetch` 替换为桩函数，桩函数第一次被调用时读取 `$C/run-text/effective_text.txt`、`plan.json` 和 `reference.json`，把 `effective_text.txt` 是否等于 `("Generate editable CAD from this host-produced plan:\n\n" + planText + "\n\n" + referenceFrameText(summary.dimensions)).trim()` 及实际内容写入 `$C/text-check.json`，然后以退出码 0 结束进程；然后以 `outputDir: $C/run-text`、同一 mesh、`runsRoot: outputs`、该参考库、`refine: false` 调用 `runMeshToCadGeneration`；如果调用返回或抛错时桩函数从未被调用，写入 `fetchCalls: 0` 并以退出码 1 结束。验证：在沙箱外运行 `bun run $C/text-check.ts`。完成：退出码 0；`$C/text-check.json` 显示桩函数恰好被调用 1 次，且 `effective_text.txt` 与期望文本完全相等（旧文本不含坐标系块，因此能区分是否重写）。
- [x] **生成 Final Patch。** 改动：把基线文件和实现后的 5 个文件分别导出到 `outputs/.plan-reference-frame/{base,final}`，用与 Planned Patch 相同的 `git diff --no-index` 方式生成 `.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.final.patch`，并把路径前缀改回 `a/`、`b/`。验证：临时 index 读取 `2aff1df` 后执行 `git apply --check --cached <final-patch>`。完成：Final Patch 只包含这 5 个文件，并能从基线应用。
- [x] **付费 draft 验证（需要单独授权）。** 输入：`outputs/examples/01-snake-arm/reference.obj`，默认模型，不开 refine（与 09-15 相同，只用一张等轴测视图），约 15 次请求，上限 40 次。改动：新建不纳入 git 的 `outputs/paid-draft-normalized-reference/run.ts`（下称 `$RUN` 为其中的 `run/` 目录），包装 fetch 记录并限制请求次数，设置 `PROCEDURA_REFERENCE_ROOT=/private/tmp/procedura-paid-reference-normalized`，调用 `runMeshToCadGeneration`；再新建 `analyze.ts`，用 `compileScad` 重新编译新 draft 和 09-15 的 `draft.scad` 得到原始坐标 STL，以 `normalizeReferenceStl` 处理后的 GT 为参照，计算两者的包围盒尺寸、中心，以及 `register_reference.py` 给出的 `unregisteredRms`、形状误差 `registeredRms / scale` 和 `rotationDegrees`（仅用于评估，不进入运行）。验证：`$RUN/effective_text.txt` 包含 `=== REFERENCE FRAME ===` 和 `100.00 × 65.15 × 14.49`；分析结果写入 `analysis.json`，并在 `.agents/report/` 写报告。完成：报告给出新旧 draft 的尺寸、中心、未对齐 RMS、形状误差和拟合旋转；未对齐 RMS 同时列出两个基线：2151 报告中 09-15 draft 对原始毫米 GT 的 74.0 mm，以及本次重算的 09-15 draft 对归一化 GT 的值。下一步按以下顺序取第一条满足的规则：① 任一轴尺寸相对误差 > 15%，或包围盒中心偏离原点 > 10 mm → 修改坐标系块措辞；② 否则 `rotationDegrees` > 15° → 另开 PCA 转正计划；③ 否则 → 进入不配准的 Mapping refine 运行。RMS 和形状误差只作报告，不参与判定。
- [x] **追加 7 视角默认（09-24）。** 改动：`mesh-to-cad-generation.ts` 把 `REFINE_REFERENCE_VIEWS` 改名为 `REFERENCE_VIEWS`，规划调用总是传 `referenceViews: planOpts.referenceViews ?? REFERENCE_VIEWS`；`README.md` 同步改 `--refine`、默认视图和补充视图文件三处说明。验证：`bun run typecheck` 与 `git diff --check`（`$C/views-static-check.log`）；新建 `$C/views-check.ts`，把 `globalThis.fetch` 换成第一次调用就记录请求并结束进程的桩函数，分两种模式在沙箱外运行：`plan` 用空 run 目录，第一次请求是 Plan 2 planner；`draft` 复制 09-15 run 并删除 `draft.obj`/`draft.stl`，复用 plan，第一次请求来自 `runIncrementalDraft`。完成：两条静态命令退出码 0；两种模式都恰好 1 次 fetch、请求带 7 张图，标签依次是 isometric（primary）、front、back、left、right、top、bottom，run 目录有 `image.png` 和 6 个 `image-<view>.png`（`$C/views-check-{plan,draft}.json`）；重新生成的 Planned/Final Patch 对基线 apply-check 通过，临时树打上后与工作区一致。
- [x] **付费 draft 验证：7 个 GT 视角（用户已授权）。** 输入：与上一次付费 draft 相同（同一 fixture、`gpt-5.5`、不开 refine、cycles 渲染、上限 40 次请求），唯一变量是 plan 和 draft 收到 7 张 GT 视图。改动：新建不纳入 git 的 `outputs/paid-draft-seven-views/`（`run.ts`、`analyze.ts`、`plot_top.py`），参考库为 `/private/tmp/procedura-paid-reference-seven-views`；`analyze.ts` 用同样的方法同时评估本次 draft、上一次单图 draft 和 09-15 draft，并列出每次请求的图片数。完成：`.agents/report/` 给出三者的尺寸、中心、未对齐 RMS、形状误差和拟合旋转，以及俯视对比图；下一步按上一步的同一组规则判定。

## 接口与兼容性

- `runMeshToCadGeneration` 的参数和返回类型不变；`scripts/mesh-to-cad.ts` 的参数和输出格式不变，只是打印的尺寸变为归一化尺寸。
- `reference.json` 的 schema 不变，`summary.dimensions` 变为归一化尺寸；新增 `reference-normalization.json`（`schemaVersion: 1`）。
- `MeshToCadProceduraOpts` 新增必填 `referenceFrame`；唯一的 tracked 调用方已更新。`outputs/` 下的旧实验脚本不在 typecheck 范围内，也不再使用。
- 私有参考库中存储的 `source.stl` 是归一化后的 mesh，不再是原始文件；记录文件可把它还原到 canonical Z-up 毫米坐标（即 `normalizeReference` 转换后的坐标，对 glTF/GLB/3MF 不等于原文件坐标）。
- 不存在的 mesh 和不支持的格式在创建参考库根目录之前就被拒绝，报错文本与 authority 相同。
- Studio、`ReferenceAuthority`、`normalizeReference`、`normalizeMeshInPlace` 和上游 draft/refine/publish 代码不变；新 Mesh-to-CAD run 在 Studio 中显示的参考 mesh 和尺寸变为归一化结果。
- 开 `--refine` 时坐标系块随 `effective_text.txt` 进入每次 patch 请求；与 09-22、09-23 不带坐标系块的 refine 基线相比，这是一个额外变量。复用旧 draft 的 run 不重写 `effective_text.txt`。
- 发布的 `draft.obj`/`final.obj`（以及 STL）仍由上游归一化到 `[-1, 1]`；毫米级比较需要重新编译 SCAD。
- （09-24 追加）不开 refine 的 Mesh-to-CAD run 也渲染并保留 7 张参考图，plan、plan review 和每个 draft 部件请求多带 6 张图；请求次数不变，每次请求的图片 token 增加，渲染时间增加。程序化调用方传入 `referenceViews` 时，开 refine 也使用调用方的列表（此前开 refine 会覆盖成 7 个视角）；tracked 调用方都不传这个参数。`scripts/mesh-to-cad.ts` 的参数不变。
- 在本改动前生成 draft 的旧 run 目录，复用时 draft 与归一化参考不在同一坐标系；这类目录应重新生成。

## 验证

- 正常路径：归一化黑盒检查覆盖 OBJ、STL 两种输入和两种源尺度；连线检查覆盖导入、记录文件、临时目录清理和 draft 复用路径；文本接入检查覆盖坐标系块进入新 draft 的 `effective_text.txt`。
- 失败路径：连线检查确认误配的根目录在写入前被拒绝；导入失败时 `finally` 删除暂存目录；fetch 桩保证免费检查不产生请求。
- 回归：typecheck 覆盖 adapter 必填字段；Studio、authority 和上游 normalize 代码没有改动。
- 行为证据：坐标系块是否改变 draft 的尺寸、位置和朝向，只能由付费 draft 验证回答。

## 风险与回滚

- **LLM 不遵守坐标系块，仍把第一个部件放在原点或自己猜尺度：** 付费 draft 验证中的包围盒中心和尺寸会直接暴露；缓解办法是加强措辞，例如给出第一个部件应在的大致坐标范围。
- **朝向仍然不一致：** GT 在俯视图中是斜的，本计划不旋转；付费验证中的拟合旋转会暴露，届时另开 PCA 转正计划。
- **绝对物理尺度被丢弃：** 所有参考都缩放到最长边 100 mm；记录文件保留中心偏移和缩放系数，可把 CAD 映射回 canonical 坐标。
- **refine 对比多一个变量：** 下一轮不配准的 Mapping refine 若与 09-22、09-23 结果比较，需要在报告中注明坐标系块同时进入了 patch 请求。
- **进程在暂存期间被强制结束：** `finally` 不执行时 `.normalize-*` 会留在已校验的私有参考库根目录内，不会进入 runs 或工作区；可手动删除。
- **回滚：** 删除 `mesh-to-cad-reference-frame.ts`，并用基线版本恢复另外 4 个文件；run 目录中多出的 `reference-normalization.json` 可以直接删除。

## 上游隔离（AGENTS.md）

- **新增模块：** `src/pipeline_mesh2code/mesh-to-cad-reference-frame.ts` 承载全部校验、暂存、归一化记录和坐标系块逻辑；它只读调用上游 `src/mesh/normalize.ts` 的 `normalizeMeshInPlace`，不修改该文件。
- **修改的上游 SpatiaOS 文件：** 只有 `README.md`，且只改本 fork 添加的 Mesh-to-CAD 一节。原文写着“canonical STL 保留源坐标”和“默认只渲染一张等轴测图”，本改动后这两处会变成错误说明，无法用新文件替代。
- **修改的本 fork 已有文件：**
  - `mesh-to-cad-generation.ts`：换规划入口、传入坐标系块、默认传 7 个参考视角。这是 Mesh-to-CAD 唯一的编排点，新模块无法从外部插入。
  - `procedura_adapter.ts`：把坐标系块接到 draft 文本。draft 文本只在这里拼接。
  - `experiments/octree-mapping/README.md`：Mapping adapter 约定需要写明 target 的归一化方式。
- **删除新能力后：** 回退 `README.md` 的 Mesh-to-CAD 一节和上述 3 个 seam（共 4 个文件），并删除新模块，Mesh-to-CAD 的导入、plan、draft 文本和文档都恢复到基线；上游 draft、refine、publish、Studio 代码在改动前后都不变。

## Plan Review

- **Mode A 第 1 轮（独立 reviewer）：** 8 条 finding，全部采纳并已修改 Planned Patch 和本计划：
  - [P0] 归一化 GT 在根目录校验之前写入 → 暂存前先构造 `ReferenceAuthority` 校验，并先检查源 mesh 与格式；
  - [P2] Studio 与 refine 影响描述不准 → 放置理由改为 AGENTS.md、ADR 0001 和 authority 职责边界，兼容性写明 Studio 显示归一化结果、refine patch 请求带坐标系块；
  - [P2] README 过度声明、记录文件与 ADR 0002 关系未说明 → README 改为“被要求在该坐标系建模”，写明 `final.obj` 仍是 `[-1, 1]`；计划写明记录文件属于有界几何摘要；
  - [P2] 重复实现上游 `normalizeMeshInPlace` → 改为调用它，导出函数改为基于路径的 `normalizeReferenceStl`；
  - [P3] 导入写法、多余导出和注释 → 改为 `import type`，去掉 `normalization` 返回字段和常量导出，删除 adapter 字段注释，补上 mesh 不存在的报错；
  - [P3] “源坐标”定义不精确 → 统一为 canonical Z-up 毫米坐标，实验 README 写明先转 STL；
  - [P4] 免费检查未覆盖坐标系块接入 → 新增文本接入免费检查；
  - [P4] 付费决策规则不可判定 → 改为有序、完备的规则，RMS 只报告并列出两个基线。
- **Mode A 第 2 轮（全范围 re-review）：** 确认第 1 轮 8 条均已修复；新增 2 条 finding，全部采纳：
  - [P3] README 仍写“`final.scad` is generated in it” → 改为 “requested in it”，Patch Intent 同步；
  - [P3] refine 代码行引用不准 → 只引用第 495 行的 `=== TEXT SPEC ===`，并说明第 318 行仅在没有参考图像时使用。
- **Mode A 第 3 轮（全范围 re-review）：** `No findings`。

## 状态

**当前阶段：** Implemented — 用户已批准计划与 Planned Patch（SHA-256 `65ab1fd9…db55f6`，已冻结）并授权付费 draft 验证；免费验证全部通过，Mode B review clean，Final Patch 已冻结；付费 draft 验证完成（12 次请求），按规则 ① 判定为修改坐标系块措辞，但证据指向 plan 的屏幕方向描述，见[报告](../report/2026-09-23-2358_paid-draft-normalized-reference.md)。09-24 用户要求把 7 视角默认直接加进本计划、实现并跑一次付费 draft：代码、README 和两份 Patch（`4b95a495…01da1bd`）已更新，免费检查通过；7 视角付费 draft 完成（17 次请求，其中 3 次为 HTTP 503 重发），拟合旋转 45.7° → 3.5°、未对齐 RMS 19.6 → 4.7 mm，规则 ① 再次触发，但偏差来自一处关节错位，见[报告](../report/2026-09-24-1330_paid-draft-seven-views.md)。用户决定提交代码并从 7 视角 draft 进入不配准的 Mapping refine。代码经 Issue #25、PR #26 合入 `main`（merge commit `01c6655`；feature commit `d64ba8e` 的 5 个文件与 Final Patch 逐字节一致）

## Implementation Review

- **Mode：** B — Patch Reconciliation（独立只读 reviewer，两轮）
- **结果：** `No findings`。第一轮 1 条 finding 在计划文本中（“上游隔离”的删除说明漏掉 `README.md`），已修正；代码和两份 Patch 没有因审查而改动。
- **Planned → Final：** 完整代码树没有差异。Final Patch 与冻结的 Planned Patch 逐字节相同（SHA-256 都是 `65ab1fd9…db55f6`），工作区 5 个文件（含未跟踪的新模块）与 Final Patch 一致；没有需要接受或移除的差异。Final Patch 的 9 个 hunk 与 Planned Patch 相同，Patch Intent 中的行号同样适用于 Final Patch，例如 [normalizeReferenceStl](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.final.patch:34>)、[根目录校验](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.final.patch:60>)、[referenceFrameText](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.final.patch:83>)、[adapter 文本](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mesh-to-cad-reference-normalization.final.patch:156>)（行号已按 09-24 重新生成的 Patch 更新）。
- **验证证据**（均在 `outputs/reference-frame-check-2026-09-23/`）：
  - 应用：HEAD `2aff1df`，Planned Patch 对基线和工作树 apply-check 通过后应用；`refine-direct.ts` 与 Planned Patch 的 SHA-256 未变，真实暂存区为空；
  - 静态（`static-check.log`）：`bun run typecheck`、`git diff --check` 退出码 0，新文件无行尾空白；
  - 归一化（`normalize-check.json`）：9 项全部通过，OBJ 缩放 100.6125、中心偏移 (0.2950, 0.0082, 0)，100 倍 STL 缩放 1.00613、中心偏移 (29.504, 0.822, 0)，尺寸 100.00 × 65.15 × 14.49，顶点最大差 7.6e-6 mm；
  - 连线（`wiring-check.json`）：12 项全部通过，fetch 0 次，误配根目录在写入前被拒绝且未创建，参考库恰好 1 个 `ref_*`、0 个 `.normalize-*`，canonical STL 居中且最长边 100 mm；
  - 文本接入（`text-check.json`）：新 draft 的 `effective_text.txt` 与“plan 文本 + 坐标系块”完全相等，旧文本不含坐标系块；
  - Final Patch：对基线 apply-check 通过，只含 5 个计划文件。
- **未验证：** 坐标系块对 draft 尺寸、位置和朝向的实际效果由付费 draft 验证回答，不属于 Mode B 范围。
- **09-24 追加部分：** 按用户要求直接加进本计划并实现，没有单独做 Mode A/B 审查；上面的审查结论只覆盖 `65ab1fd9…db55f6` 版本（归一化与坐标系块）。追加部分的证据是 `views-static-check.log`、`views-check-{plan,draft}.json`，以及重新生成的 Patch 的 apply-check 和临时树一致性检查。
- **7 视角付费 draft 结果**（不改变代码或 Patch）：尺寸 85.5 × 53.9 × 14.5 mm、中心 (−8.7, −7.0, 0.0) mm、未对齐 RMS 4.7 mm、拟合旋转 3.5°、尺度 0.879。走向已与 GT 一致；剩余偏差来自 draft 把中央关节放在中间连杆中点、且该连杆朝向 −34.5°（GT 近似水平）。按规则 ① 判定为修改坐标系块措辞，报告建议改为从这份 draft 进入不配准的 Mapping refine。
- **付费 draft 验证结果**（Mode B 之后运行，不改变代码或 Patch）：12 次请求（上限 40），`effective_text.txt` 以坐标系块结尾。新 draft 尺寸 100.0 × 39.3 × 16.3 mm、中心 (0.0, 12.4, −0.9) mm、未对齐 RMS 19.6 mm；09-15 draft 对归一化 GT 为 197.1 × 41.9 × 16.6 mm、中心偏离 90.7 mm、未对齐 RMS 56.4 mm（对原始 GT 为 74.0 mm）。拟合变换是绕 Z 约 46° 的偏航，尺度 0.974，拟合后 RMS 2.42 mm。按规则 ① 判定为修改坐标系块措辞；报告指出 Y 和中心偏差来自 plan 用等轴测屏幕方向描述链条走向。
