# Plan: Mapping 使用 candidate SCAD 毫米单位，并提供可选的参考配准脚本

## 目标与完成标准

让 Mapping 报出的长度和位置直接等于 candidate SCAD 的毫米值，Patch 可以把 Mapping 的残差当作真实 SCAD 修改量使用；同时保留一个独立的相似配准脚本，供需要去除 GT 位姿和尺度差的实验使用。

完成标准：

- Mapping Agent 的 prompt 声明所有 `*Mm` 字段、`locationMm` 和检查半径都是 candidate SCAD mm，并以最细格子边长作为分辨率；
- `inspect_mapping_part` 的半径上限等于当前 mapping frame 的 8 个最细格子，而不是固定的 `0.25`；
- `render_mapping_report.py` 的坐标轴范围来自 frame，在 mm frame 中也能完整显示；
- `prepare_mapping_input.py` 可以接收任意 octree 根（`--root-min`、`--root-side`），并且无论 mesh 用什么长度单位，不平衡最优传输的结果都不变；默认参数下输出与基线逐字节相同；
- `register_reference.py` 可以把参考 mesh 用一次相似变换对齐到 candidate，输出配准后的 STL 和变换元数据；
- README 记录 root 参数、质量单位、配准脚本和 host adapter 的 mm 约定。

非目标：

- 不提交付费测试 adapter（`outputs/paid-retest-2026-09-23-mapping-test-adapter.ts`，位于被 git 忽略的 `outputs/`）；它是一次性实验 harness，只作为验证证据；
- 不改动 `src/pipeline/refine-direct.ts` 中已有的 Mapping-first 工作区改动，也不改 `.agents/notes/依赖排查.md`；
- 不把配准接入 tracked 的 refine 流程，不新增刚性配准模式；
- 不修改 plan/draft 的参考尺寸输入；
- 不新增付费运行。

## 关键发现

- `src/tools_mesh2code/mapping-facts.ts` 严格校验 `input.frame`，只允许 `minMm`、`sideMm`、`maxDepth` 三个字段，并在 `runMappingAgent` 构建 evidence 之前执行。frame 字段因此可以直接信任，但不能往 frame 里加换算系数字段。
- 基线 prompt 写着 “Mapping-frame displacement values are not automatically raw SCAD coordinates”，与 mm 单位直接冲突，必须改写。
- 基线 `inspect_mapping_part` 把半径上限写死为 `0.25`（`[-1, 1]` frame 的 8 个 depth-6 格子）。在 mm frame 中，这个上限会让检查半径几乎不可用。
- 基线 `render_mapping_report.py` 把坐标轴固定为 `[-1, 1]`，mm frame 下图像会被截掉。
- octree 求解器是 log-domain 不平衡 Sinkhorn：kernel 为 `log_source + log_target - cost/epsilon`，cost 以格子为单位，因此只有质量的绝对值会随长度单位变化。把面积除以 `(root_side / 2)^2` 后，mm frame 与 `[-1, 1]` frame 的质量相同，传输结果不变。
- tracked 代码里只有 `makeMappingCritic(prepare)` 接口，没有 tracked 的 host adapter；`makeInspectMappingPartTool` 的唯一调用方是 `runMappingAgent`。
- `prepare_mapping_input.py` 的其他调用方（`validation/build_fullrun_pair.py`、`examples/build_examples.py`）都使用默认 root。
- 仓库没有单元测试；TypeScript 用 `bun run typecheck`，Python 可用 `py_compile` 和 `uvx ruff`。
- 已有实验证据的覆盖范围各不相同：
  - 只针对本 Patch 本身的证据是离线等价检查（`outputs/mapping-mm-units-check-2026-09-23/summary.json`），它使用与本 Patch 功能相同的 mm 代码路径；
  - `2026-09-23-2151` 付费运行使用 mm 单位、不配准，同时带有范围外的 Mapping-first 改动（`refine-direct.ts` 中 Mapping 诊断排在前面，repair history 摘要取自 Mapping），因此只能作为“mm 单位下 Patch 修改量级正确”的参考证据；
  - `2026-09-23-2025` 付费运行仍使用归一化 adapter（frame 为 `[-1, 1]`），只证明 `register_reference.py` 在真实运行中可用，没有覆盖 mm 路径。

## 方案与决策

**单位：采用 candidate SCAD mm（用户已选定）。** 另一种做法是继续归一化，再把换算系数告诉 Mapping。但 facts 校验不允许在 frame 中加字段，Patch 仍需自己乘系数，而且 `locationMm` 仍然不是 SCAD 世界坐标。改用 mm 后，所有长度和位置都能直接与 SCAD 源码比较。

**octree 根：由 host adapter 决定，脚本只接收参数。** `prepare_mapping_input.py` 不猜测单位，只增加 `--root-min` 和 `--root-side`，默认值保持 `[-1, 1]`。付费测试 adapter 按并集包围盒居中，根边长取并集最长边除以 0.9，与旧归一化比例一致。

曾考虑的旁路是：adapter 继续把 mesh 归一化到 `[-1, 1]`，调用不修改的脚本，再把 `input.json` 的 frame 改写成 mm 根。数学上结果相同，但放弃这条路，原因有三：

- 脚本输出的 frame 会与它自己的元数据（边界、part 变换）和实际 mesh 不在同一单位，`input.json` 不再能自证其坐标含义；
- 渲染需要与报告 frame 同单位的 mesh，adapter 必须同时写归一化和 mm 两份 mesh；
- 每个 host adapter 都要重复这套归一化与改写逻辑。

脚本内部原本就用 `root_min`、`root_side` 两个变量，把它们暴露为可选参数是更小的接缝。

**质量单位：按根半边长的平方归一。** 这让传输平衡与长度单位无关；默认 root 下单位面积为 1，输出逐字节不变。

**报告图：让渲染器读取 frame 的坐标轴范围。** 渲染器已经用 frame 的 `minMm` 和 `sideMm` 计算格子中心，只有坐标轴写死为 `[-1, 1]`，与它自己的输入契约不一致。另一种做法是在 adapter 里复制一份约 45 行的渲染器，只为改两处坐标轴，这会分叉一个 tracked 工具，比两处读取 frame 的改动更大。

**检查半径上限：从 frame 计算 8 个最细格子。** 在 `[-1, 1]`、depth 6 的 frame 中结果正好是 `0.25`，与基线一致；在 mm frame 中随分辨率缩放。上限由调用方 `runMappingAgent` 计算后传给工具工厂，工具本身不读 frame。

**配准：独立脚本，默认不启用。** 用户选择默认“不对齐”。配准作为实验模块中的独立 CLI 保留，由 host adapter 按需调用；tracked 的 refine 流程不感知配准。

## Patch Artifact

- **计划基线：** `9858659`（`Merge pull request #21 from 87003697/codex/direct-patch-repair-history`）；Patch 只覆盖下列 6 个文件，工作区中 `src/pipeline/refine-direct.ts` 和 `.agents/notes/依赖排查.md` 的既有改动不属于本计划
- **计划 Patch：** [2026-09-23-mapping-native-mm-units.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch>)
- **批准前校验：** 用临时 index 读取基线后执行 `GIT_INDEX_FILE=<tmp> git read-tree 9858659 && GIT_INDEX_FILE=<tmp> git apply --check --cached /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch`
- **批准与冻结：** 用户于 2026-09-23 批准；冻结时 SHA-256 为 `118840fa2a62de78b528fa59754a47621cf007b08f83e246ed6943d6cdda3459`
- **Final Patch：** [2026-09-23-mapping-native-mm-units.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.final.patch>)，从同一基线生成，对基线 apply-check 通过

## Patch Intent

### `src/agents_mesh2code/mapping-agent.ts`

- **`SYSTEM` 单位说明（修改）：** 旧 prompt 让 Mapping 不要把位移当作 SCAD 坐标，也不要把数值直接写进 PLACE block，导致诊断里的数值没有可用单位。新说明声明所有 mapping 长度都是 candidate SCAD mm、`locationMm` 是 SCAD 世界坐标，局部问题直接给出 mm 修正；旧的“不要直接写入 PLACE”限制随之删除，因为数值现在就是 SCAD 值。新增一条分辨率规则：小于约一个最细格子边长的残差视为在分辨率以内，除非很多格子方向一致；原因是传输的 blur 为 0.75 格，更小的位移无法可靠分辨。当前 mm frame 下一个格子约 3.4–4.6 mm，这条规则会减少对格子内噪声的报告。共享或累积误差仍然只报告范围和趋势，其余 prompt 规则不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:10>)
- **`runMappingAgent`（修改）：** 从已通过 facts 校验的 frame 计算 8 个最细格子的长度，作为检查半径上限传给工具。`[-1, 1]`、depth 6 的 frame 得到的上限仍是 `0.25`；facts、semantic plan 和视觉输入的组装方式不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:22>)

### `src/agents_mesh2code/mapping-inspect-tool.ts`

- **`validateInput`（修改）：** 半径上限从固定的 `0.25` 改为调用方传入的值，超限时的错误信息带上实际上限。其他参数检查不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:53>)
- **`makeInspectMappingPartTool`（修改）：** 工厂新增 `maxRadiusMm` 参数，工具 descriptor 移入工厂，使 JSON schema 中的 `radiusMm.maximum` 与运行时检查一致。工具名称、描述、其他字段和执行结果格式不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:68>)

### `src/tools_mesh2code/render_mapping_report.py`

- **`render` 根边长（修改）：** 读取 frame 的根边长，供格子缩放和坐标轴共用；格子中心的计算方式不变。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:104>)
- **`render` 坐标轴（修改）：** 坐标轴范围改为 frame 的根立方体，mm frame 中的 mesh 和箭头因此完整可见；`[-1, 1]` frame 下的图像与基线一致。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:113>)

### `experiments/octree-mapping/scripts/prepare_mapping_input.py`

- **`parser`（修改）：** 新增可选的 `--root-min` 和 `--root-side`，让 host adapter 用 mesh 自身单位指定 octree 根；默认值仍是 `[-1, 1]`。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:125>)
- **`main` 质量单位（修改）：** 使用传入的根，并以根半边长的平方作为面积单位，使不平衡传输的平衡与长度单位无关。默认根下单位为 1。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:138>)
- **`main` 输出质量（修改）：** GT 和 candidate cell 的质量都除以同一面积单位；cell 集合、法向和 provenance 不变，默认参数下 `input.json` 与基线逐字节相同。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:147>)
- **`main` 元数据（修改）：** 私有元数据的 frame 记录 `massUnitArea`，方便复查质量换算；`input.json` 的 schema 和 frame 字段不变，因此仍能通过 facts 校验。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:163>)

### `experiments/octree-mapping/scripts/register_reference.py`

- **`sample_surface`、`similarity_from_pairs`（新增）：** 按面积在两个 mesh 表面采样，并用 Umeyama 最小二乘求缩放、真旋转（排除镜像）和平移。这是配准脚本的两个可独立复用的数值步骤。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:188>)
- **`parser`、`main`（新增）：** CLI 先拒绝非正的 `--samples` 和 `--iterations`，再从 4 个保持右手系的主轴符号组合出发做对称最近邻 ICP，选 RMS 最小的结果。输出配准后参考 mesh 的二进制 STL（candidate 坐标，三角形数量按小端写入），以及记录变换、样本数、迭代上限、种子和配准前后 RMS 的元数据。随机种子固定，结果可复现；脚本不修改输入，也不被 tracked 流程调用。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:225>)

### `experiments/octree-mapping/README.md`

- **`prepare_mapping_input.py` 说明（修改）：** 记录默认根、`--root-min/--root-side` 参数和质量单位，说明归一化和 mm 两种 mesh 得到相同的传输平衡。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:317>)
- **配准脚本说明（新增）：** 说明何时使用 `register_reference.py`、它拟合什么、不拟合镜像，以及不配准时位姿差会被报告为表面位移，并给出命令示例。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:328>)
- **Mapping critic adapter 约定（修改）：** 要求 host adapter 让两个 mesh 保持 candidate SCAD mm，并按该单位传入 octree 根；说明 Mapping Agent 对 mm 字段的解释和 8 个最细格子的半径上限。[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch:351>)

## 实现步骤

以下命令都在仓库根目录执行，使用 zsh。所有新产生的验证输出都写入 `V=outputs/mapping-mm-units-check-2026-09-23/final-verify`，不覆盖任何付费运行目录中的文件。公共变量：

- `PY=experiments/octree-mapping/.venv/bin/python`
- `RUFF="env UV_CACHE_DIR=$PWD/outputs/.uv-cache UV_TOOL_DIR=$PWD/outputs/.uv-tools uvx ruff check --no-cache --output-format concise"`
- `PATCH=.agents/plans/2026-09-23-mapping-native-mm-units.planned.patch`
- `files=(src/agents_mesh2code/mapping-agent.ts src/agents_mesh2code/mapping-inspect-tool.ts src/tools_mesh2code/render_mapping_report.py experiments/octree-mapping/scripts/prepare_mapping_input.py experiments/octree-mapping/README.md)`
- 先创建输出目录：`mkdir -p $V/{pre-apply,default-baseline,default-planned,registration} outputs/.plan-mapping-mm-units/{base,final}`

步骤：

- [x] **应用 Planned Patch。** 输入：当前工作区。改动：先执行 `for f in "${files[@]}" experiments/octree-mapping/scripts/register_reference.py; do mkdir -p $V/pre-apply/$(dirname $f); cp $f $V/pre-apply/$f; done` 备份当前版本；执行 `for f in "${files[@]}"; do git show 9858659:$f > $f; done` 恢复基线内容（不改动真实 index）；删除 `experiments/octree-mapping/scripts/register_reference.py`；执行 `git apply $PATCH`。验证：`git status --short -- "${files[@]}" experiments/octree-mapping/scripts/register_reference.py src/pipeline/refine-direct.ts`。完成：5 个文件为 `M`，新脚本为 `??`，`refine-direct.ts` 仍为 `M` 且内容未变，`git diff --cached` 为空。
- [x] **静态检查。** 验证：
  - `bun run typecheck`；
  - `$PY -m py_compile src/tools_mesh2code/render_mapping_report.py experiments/octree-mapping/scripts/prepare_mapping_input.py experiments/octree-mapping/scripts/register_reference.py`；
  - `(cd experiments/octree-mapping && eval $RUFF scripts/prepare_mapping_input.py scripts/register_reference.py)`；
  - `eval $RUFF src/tools_mesh2code/render_mapping_report.py`。

  完成：typecheck 和编译通过；`register_reference.py` 没有 ruff finding；`prepare_mapping_input.py` 只有基线已有的 1 条 I001，`render_mapping_report.py` 只有基线已有的 EXE001 和 2 条 I001。
- [x] **默认参数逐字节等价。** 输入：`M=$PWD/outputs/paid-retest-2026-09-23-direct-repair-history-16cycles-v3/merged/_refine_steps/step_001/mapping/meshes`（归一化的 GT/candidate OBJ、candidate STL 和使用绝对路径的 parts manifest）。改动：`git show 9858659:experiments/octree-mapping/scripts/prepare_mapping_input.py > $V/prepare_mapping_input.baseline.py`；分别用 `$V/prepare_mapping_input.baseline.py` 和 `experiments/octree-mapping/scripts/prepare_mapping_input.py` 运行 `$PY <script> --gt-obj $M/gt.obj --candidate-obj $M/candidate.obj --candidate-stl $M/candidate.stl --parts-meta $M/parts-meta.tsv --output $V/default-<side>/input.json --metadata $V/default-<side>/metadata.json`，其中 `<side>` 为 `baseline` 或 `planned`。验证：`cmp $V/default-baseline/input.json $V/default-planned/input.json`。完成：`cmp` 退出码为 0。
- [x] **mm 路径与旧归一化路径等价。** 改动：先 `cp outputs/mapping-mm-units-check-2026-09-23/summary.json $V/summary.exploration.json` 保留探索阶段的结果，再运行 `bun run outputs/mapping-mm-units-check-2026-09-23/run-check.ts`（它会重写同目录的 `summary.json`，以及 `unregistered/`、`registered/` 两个 step 目录）。完成：两种情况下 depth 3–6 都是 `sameCells: true`；`maxMassRel < 1e-5`；未配准时 `maxDisplacementDiffMm < 0.01`，两种情况下每个 depth 都满足 `maxDisplacementDiffMm < 0.1 × cellEdgeMm`（实现后修正，原标准“两种情况都 `< 0.01`”配准时未满足，见 Implementation Review 的“标准偏差”）；`endBall.inside == endBall.cells`；`inspect.acceptedOk` 为 `true`，`inspect.rejectedOk` 为 `false`，错误信息包含实际上限；两个 step 目录下都生成了 `mapping-report-{front,side,top}.png`。
- [x] **配准脚本可复现。** 改动：运行 `$PY experiments/octree-mapping/scripts/register_reference.py --reference outputs/paid-retest-2026-09-15/reference-100x.stl --candidate outputs/paid-retest-2026-09-23-registered-mapping-8cycles/merged/_agent_compiles/cycle_001/output.stl --output $V/registration/gt-registered.stl --metadata $V/registration/registration.json`（默认 seed 0、4000 个样本、100 次迭代，与付费运行相同）。验证：`R=outputs/paid-retest-2026-09-23-registered-mapping-8cycles/merged/_refine_steps/step_001/mapping`；执行 `bun -e 'const [a, b] = await Promise.all(process.argv.slice(1).map((p) => Bun.file(p).json())); for (const k of ["scale", "rotation", "translation", "unregisteredRms", "registeredRms", "seedRms"]) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) throw new Error(k); console.log("registration fields equal, iterations =", a.iterations)' $V/registration/registration.json $R/registration.json`，以及 `cmp $V/registration/gt-registered.stl $R/meshes/gt-registered.stl`。完成：`scale`、`rotation`、`translation`、`unregisteredRms`、`registeredRms`、`seedRms` 完全相等（同一代码、同一种子，不设容差）；新元数据多出 `iterations: 100`；两份 STL 逐字节相同（本机为小端）。
- [x] **生成 Final Patch。** 改动：把基线文件和实现后的 6 个文件分别导出到 `outputs/.plan-mapping-mm-units/{base,final}`，用与 Planned Patch 相同的 `git diff --no-index` 方式生成 `.agents/plans/2026-09-23-mapping-native-mm-units.final.patch`，并把路径前缀改回 `a/`、`b/`。验证：临时 index 读取 `9858659` 后执行 `git apply --check --cached <final-patch>`；检查新增行没有行尾空白。完成：Final Patch 只包含这 6 个文件，并能从基线应用。

## 接口与兼容性

- **Mapping Agent prompt：** 行为契约改变。host adapter 必须提供 candidate SCAD mm 的 mesh 和 octree 根，否则 Mapping 会把归一化数值当作 mm。目前 tracked 代码中没有 host adapter，唯一的 adapter 是 `outputs/` 下的付费测试 harness，已按此契约实现。
- **`makeInspectMappingPartTool(evidence, maxRadiusMm)`：** 签名新增必填参数；唯一调用方 `runMappingAgent` 同步修改。
- **`inspect_mapping_part` 工具 schema：** `radiusMm.maximum` 随 frame 变化；`[-1, 1]`、depth 6 时仍为 `0.25`。
- **`prepare_mapping_input.py`：** 新增两个可选参数；`input.json` schema、字段和默认输出不变；私有元数据 frame 新增 `massUnitArea`。
- **`render_mapping_report.py`：** CLI 不变；`[-1, 1]` frame 的图像不变。
- **`register_reference.py`：** 新 CLI，不被任何 tracked 代码调用。

## 验证

- 正常：mm frame 的离线等价检查（实现步骤第 4 项）、配准复现（第 5 项）。
- 回归：默认参数逐字节等价（第 3 项）；`[-1, 1]` frame 下检查半径上限和坐标轴与基线一致（由公式保证：`8 × 2 / 2^6 = 0.25`，坐标轴 `[-1, -1 + 2]`）。
- 失败：超过 8 格的检查半径被拒绝，并返回带上限的错误信息（第 4 项）。
- 静态：`bun run typecheck`、`py_compile`、`ruff`（第 2 项）。
- 已有运行证据（只作参考，不作为本 Patch 的验收）：`2151` 付费运行（mm、不配准，带范围外的 Mapping-first 排序）显示 Patch 的修改量级已变成几十 mm；`2025` 付费运行（归一化、配准）显示 `register_reference.py` 在 8 轮中都稳定。本 Patch 单独合入时 Mapping 诊断排在 visual 之后，这一组合没有付费运行证据。本计划不再做新的付费运行。

## 风险与回滚

- **旧 adapter 仍输出归一化 mesh：** Mapping 会把归一化数值当作 mm，Patch 修改量会小约 100 倍。检测：诊断数值远小于最细格子边长，或 frame 的 `sideMm` 约为 2。缓解：README 写明 adapter 约定；目前没有 tracked adapter 受影响。
- **mm frame 下质量换算错误：** 会改变传输平衡。检测：离线等价检查中的质量相对差和 cell 集合。
- **回滚：** 反向应用 Final Patch 即可恢复基线；改动都集中在 6 个文件，不涉及数据迁移。

### 上游文件改动（AGENTS.md）

- `src/agents_mesh2code/mapping-agent.ts`：旧 prompt 明确否认数值是 SCAD 坐标，且检查半径上限必须由 frame 计算；facts 校验不允许通过 frame 数据传递单位，所以无法在旁路模块中实现。
- `src/agents_mesh2code/mapping-inspect-tool.ts`：上限写死在工具内部，由 `runMappingAgent` 直接构造，host adapter 无法替换，只能改为由调用方传入。
- `src/tools_mesh2code/render_mapping_report.py`：坐标轴写死为 `[-1, 1]`。旁路做法是在 adapter 里复制整个渲染器，但那会分叉一个 tracked 工具，改动反而更大；而且渲染器本来就用 frame 计算格子中心，读取 frame 的坐标轴只是让它与自身输入契约一致（见“方案与决策”）。
- `experiments/octree-mapping/scripts/prepare_mapping_input.py`：旁路做法是 adapter 先归一化，再改写输出 frame。放弃原因是输出会与自身元数据和 mesh 单位不一致，adapter 需要写两份 mesh，且每个 adapter 都要重复这套逻辑（见“方案与决策”）。改动只把已有的内部变量暴露为可选参数，默认输出逐字节不变。
- `experiments/octree-mapping/README.md`：记录新参数、配准脚本和 adapter 约定；没有代码可以替代这份契约说明。
- 移除本能力（反向应用 Patch）后，上游行为和契约恢复为基线。保留 Patch 时，对 `[-1, 1]` frame 只有 prompt 文字不同，检查半径上限和报告图与基线一致。

## Plan Review

- **Mode：** A — Planned Patch Review（独立只读 reviewer，三轮）
- **结果：** `No findings`
- **已修正的 findings：**
  - 第一轮 5 条：付费运行证据的覆盖范围写得过宽；`prepare_mapping_input.py` 和渲染器的上游改动缺少旁路放弃理由；`register_reference.py` 缺少参数校验、`iterations` 元数据和显式小端写入；两条 Intent 与补丁不符；验证步骤缺少可直接运行的命令和独立的输出位置。
  - 第二轮 1 条：验证命令没有预先创建输出目录。
- **校验：** 临时 index 读取 `9858659` 后 `git apply --check --cached` 通过；Patch Intent checker 覆盖 12 个 hunk；新增行没有行尾空白。
- **审查范围：** 单位一致性、`[-1, 1]` frame 下的回归不变量、默认参数逐字节等价、配准数值、TS 类型、AGENTS.md 上游隔离、非目标边界、计划与补丁的一致性。

## 状态

**当前阶段：** 已合并。Issue [#22](https://github.com/87003697/Procedura/issues/22)，PR [#23](https://github.com/87003697/Procedura/pull/23)，提交 `8e30e8d`，merge commit `dd35539`；提交的 tree 与 Final Patch 应用到基线后的 tree 一致

## Implementation Review

- **Mode：** B — Patch Reconciliation（独立只读 reviewer，两轮）
- **结果：** `No findings`。第一轮 2 条 finding 都在计划文本中（第 4 步标准与证据矛盾、状态过时），已修正；代码和两份 Patch 没有因审查而改动。
- **Planned → Final：** 完整代码树没有差异。Final Patch 与冻结的 Planned Patch 逐字节相同（SHA-256 都是 `118840fa…3459`），工作区 6 个文件的 blob 哈希与 Final Patch 的新版哈希一致；没有需要接受或移除的差异。Final Patch 的 12 个 hunk 与 Planned Patch 相同，Patch Intent 中的行号同样适用于 Final Patch，例如 [runMappingAgent](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.final.patch:22>)、[makeInspectMappingPartTool](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.final.patch:68>)、[register_reference main](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-23-mapping-native-mm-units.final.patch:225>)。
- **验证证据：**
  - 应用：6 个文件从基线恢复后应用 Planned Patch，结果与 planned 状态逐字节一致；`refine-direct.ts` 的 SHA-256 未变，真实暂存区为空；
  - 静态：`bun run typecheck`、`py_compile` 通过；ruff 只有基线已有的 finding，`register_reference.py` 无 finding；
  - 默认参数：`input.json` 与基线逐字节相同（136825 字节），`massUnitArea = 1.0`；
  - mm 等价：cell 集合相同，质量相对差不超过 1.5e-6，位移差满足修正后的标准，右端球 cell 全部落在 SCAD 包围盒内，检查半径 3 格接受、9 格拒绝，两种情况都生成了报告图；
  - 配准：数值与付费运行逐字段相等，STL 逐字节相同，非正的 `--iterations` 被拒绝；
  - Final Patch：对基线 apply-check 通过，只含 6 个计划文件，新增行无行尾空白。
- **未验证：** 按计划没有新的付费运行；本 Patch 单独合入（不带范围外的 Mapping-first 排序）时没有付费运行证据。
- **标准偏差（第 4 步）：** 原完成标准要求两种情况下 `maxDisplacementDiffMm < 0.01`。这个阈值只根据未配准情况推出，而探索阶段的 `summary.json` 已经包含配准情况的数值。实现后的结果与探索阶段逐项相同：
  - 未配准：各层最大差 0.0004–0.0008 mm，满足原标准；
  - 配准：各层最大差依次为 0.004、0.016、0.045、0.166 mm（depth 3→6，逐层放大）；depth 6 的中位数 0.0002 mm，p99 0.037 mm，最大值只占最细格子（3.42 mm）的 0.048，集中在被过度匹配的 cell（source marginal ratio 1.33–1.45）；
  - 两种情况下 cell 集合都相同，质量相对差不超过 1.5e-6，求解器配置相同；
  - 解释：推测是两条路径用不同单位写出坐标，浮点舍入不同，造成约 1e-6 的质量差，再在过度匹配区域被多尺度 UOT 放大。差异远小于一个格子的分辨率，与单位错误（约 109 倍的整体比例）无关；
  - 处理：不改代码，把标准修正为“未配准 `< 0.01 mm`，且两种情况每个 depth 都 `< 0.1 × cellEdgeMm`”。修正不改变 Patch、范围或行为；
  - 依据文件：`outputs/mapping-mm-units-check-2026-09-23/summary.json`、`outputs/mapping-mm-units-check-2026-09-23/final-verify/summary.exploration.json`、`outputs/paid-retest-2026-09-23-registered-mapping-8cycles/merged/_refine_steps/step_001/mapping/report/report.json`、`outputs/mapping-mm-units-check-2026-09-23/registered/mapping/report/report.json`。
