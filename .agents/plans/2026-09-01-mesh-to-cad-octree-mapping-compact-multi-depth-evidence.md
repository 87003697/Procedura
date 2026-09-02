# Plan: Mesh-to-CAD Plan 5 v2 — compact multi-depth evidence

## 目标与完成标准

把 shadow-only sparse multiscale mapper 已经完成的每层 depth 3–6 求解结果，保存为每层一份紧凑、可重建的 candidate/GT cell evidence，而不是只在 resolved depth 输出逐-cell 明细。完成时，真实 depth-6 report 必须包含 d3、d4、d5、d6 四层；每种记录的字段集合严格等于冻结合同；solver 数值不因报告重构改变；不含完整 target coupling 或 per-cell entropy；同一真实输入和配置下，JSON 文件至少比旧 verbose report 小 50%。

本 follow-up 只改变实验报告 shape、README 和两个 non-unit 验证消费者。它不改变 mapping 算法、candidate pair generation、cost、support、Sinkhorn、mesh adapter、输入合同、Plan 1–4 或默认 pipeline；不新增任何 part-level 聚合、平均位移、离散度、刚体/缩放拟合或 `not_expressible`。显式运行 CLI 时 canonical 行为固定为 schema `/3` 的 d3–d6 compact cell evidence；不提供可选旧输出模式。

## 关键发现

- 当前 solver 已逐层执行 `startDepth..resolvedDepth`，但 `levels` 只保存 solver summary，`candidateNodes` / `gtNodes` 只在最终深度生成，并且 candidate node 携带完整 `targets` 列表。
- 当前逐-cell evidence 与 part-level summary 耦合；本 follow-up 删除该新增能力，仅保留 cell-level marginal ratio、displacement 和 spread。
- coarse aggregate 的内部 `Node.center` 是 occupied depth-max leaf center 的质量加权质心，并非可由 frame/depth/prefix 推导的 grid cell center。它可继续供 solver 的几何代价使用，但公开的每层 `displacementMm` 必须以可推导 grid cell center 为起点。
- candidate part provenance 对纯 cell-level evidence 没有消费者；按“不改变输入合同/mesh adapter”的边界，保留其私有 input parsing 与准备 metadata 作为输入兼容数据，但 mapper 不读取、不聚合且 report 不携带语义 part 信息。
- `validate_scenarios.py` 当前从 final-only arrays 读取结果，并有一个 neighborhood 场景直接检查 target coupling；删除 `targets` 后，应改成具有互为镜像局部结构的 fixture，以公开 displacement 验证消歧。
- `run_plan4_ablation.py` 的 cross-side mass 和 abdomen target bucket 依赖完整 coupling，删除 targets 后无法忠实重建。新 summary 不近似替代这些指标，也不重新给出历史 pass/fail；冻结 geometric-signals 资产仍是这些诊断的权威证据。
- 既有 geometric-signals Plan、Planned Patch 和 Final Patch 保持冻结。本 Planned Patch 为从原始 git 基线 `7030755fd01d8d219e35fd1a4a0382e1a59ffc5f` 生成的累计 patch，因此可独立 apply-check；其中未涉及 follow-up 的实验文件只是原样承载既有已审实现。

### Simplification evidence

- `expressible_error_cells` 只由旧 `_fit_models`/CLI 参数/part-level assertions 使用；纯 cell-level producer/consumer 搜索无保留用途，因此整条配置和拟合代码删除。
- `NodeEvidence.entropy`、`transported_mass`、完整 `targets` 只服务旧 verbose node 与 part summary；compact serializer、ablation、black-box consumer 均不读取，故删除。
- candidate `parts` provenance 在现有 compact cell contract 中没有 cell-level consumer；它仅保留在私有 input compatibility seam，mapper 不读取、不聚合且 report 不携带语义 part 信息。

## 方案与决策

报告 schema 从 `procedura.octree-mapping-report/2` 升级为 `/3`。顶层保留 `schema`、`frame`、`solver`、`levels`，CLI 继续附加 `runtime`；移除顶层 `candidateNodes`、`gtNodes` 和任何 part summary。每个 `levels[]` 固定为：

```text
{
  summary: {
    depth, cellSizeMm, candidateCellCount, gtCellCount,
    candidatePairCount, supportPairCount, iterations, solverError
  },
  candidateCells: [
    { prefix, mass, displacementMm, spreadCells, sourceMarginalRatio }
  ],
  gtCells: [
    { prefix, mass, targetMarginalRatio }
  ]
}
```

`prefix` 是该层的 depth-local Morton prefix；父级为 `prefix >> 3`，center 可由 shared frame、depth 和 prefix 推导。`displacementMm` 是 GT transport barycenter 减由 frame/depth/prefix 推导出的 candidate grid cell center 的三维毫米向量，跨层直接比较；它不使用不可公开重建的 occupied-surface centroid。`spreadCells` 是该层 spread mm 除以 `cellSizeMm`。没有 transport 的 candidate cell 仍保留记录，displacement 和 spread 为 `null`，source marginal ratio 为 0。

明确不序列化 `center`、`parentPrefix`、单独 distance/direction、per-cell entropy、完整 `targets`、transported mass、parts、part summary、part-level translation/fit、rigid/similarity fit 或 `not_expressible`。输出不携带语义 provenance。

实现先在每层保存 solver-only 的内部 `LevelEvidence`，再序列化 compact arrays；不生成或聚合 candidate provenance。内部 evidence 不保存完整 targets 或 entropy，也不驱动任何 part-level计算。

## Patch Artifact

- **计划基线：** git commit `7030755fd01d8d219e35fd1a4a0382e1a59ffc5f`；Planned Patch 累计包含 removable experiment 的目标状态，既有冻结规划资产不在 patch 内。
- **计划 Patch：** [2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch>)
- **Final Patch：** [2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.final.patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.final.patch>)
- **批准前校验：** 在由上述 commit 导出的干净临时树运行 `git apply --check /Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch`。

## Patch Intent

### `experiments/octree-mapping/README.md`
- **实验报告与隐私合同（新增模块文档）：** 说明 schema `/3` 的逐层 compact shape、可推导字段、删除的 coupling/entropy 和全部 part-level 输出，以及 ablation 仅报告 cell-level 数值；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:7>)

### `experiments/octree-mapping/octree_mapping/__init__.py`
- **实验包导出（累计新增模块）：** 原样承载 `MappingInput`、`SolverConfig`、`load_mapping_input`、`map_octrees` 的既有 removable package seam；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:115>)

### `experiments/octree-mapping/octree_mapping/__main__.py`
- **模块入口（累计新增模块）：** 原样承载 module execution 对 CLI `main` 的委托；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:124>)

### `experiments/octree-mapping/octree_mapping/cli.py`
- **`_parser`、`main`（累计新增函数）：** 原样承载既有配置入口、private JSON 写出、elapsed time 和 peak RSS；报告 shape 只由 mapper `/3` 决定；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:150>)

### `experiments/octree-mapping/octree_mapping/contract.py`
- **`Frame`、`PartWeight`、`Cell`、`MappingInput` 及 `_object`、`_finite`、`_frame`、`_cells`、`parse_mapping_input`、`load_mapping_input`（累计新增类型/函数）：** 原样承载闭合 input schema `/2`，证明本 follow-up 不迁移输入或 adapter contract；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:220>)

### `experiments/octree-mapping/octree_mapping/mapping.py`
- **`SolverConfig`、`Node`、`SparsePlan` 及 `_decode`、`_cell_center`、`_leaf_center`、`_aggregate`、`_validate_config`、`_candidate_pairs`、`_starts`、`_segment_logsumexp`、`_occupancy_descriptors`、`_log_sinkhorn`、`_solve_level`、`_support`（累计新增/修改类型与函数）：** 原样承载既有 sparse multiscale UOT 算法和 geometry-only correspondence seam；新增 `_cell_center` 只负责从 prefix 重建 grid center，schema 常量升级到 `/3`；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:356>)
- **`NodeEvidence`、`LevelEvidence`、`_node_evidence`、`_target_marginal_ratios`（新增/修改类型与函数）：** 仅保存每层 cell-level evidence 所需的 marginal ratio、displacement 和 spread，不保留 transported mass、targets、entropy 或 provenance；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:393>)
- **`_level_report`（新增函数）：** 严格输出每层 8/6/3 字段记录，把 displacement 起点换为可推导 grid cell center，并把 spread 换算为当前 depth 的 cell units；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:713>)
- **`map_octrees`（修改函数）：** 主循环保存全部层并构造 `/3` cell-level report，不生成 provenance 或 part-level summary；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:760>)

### `experiments/octree-mapping/octree_mapping/mesh_adapter.py`
- **`TriangleMesh`、`SurfaceCell` 及 `load_obj`、`load_stl`、`uniform_bounds_transform_values`、`uniform_bounds_transform`、`transform`、`label_triangles_by_nearest_part`、`_triangle_hits_box`、`morton_prefix`、`surface_cells`、`load_part_manifest`（累计新增类型/函数）：** 原样承载 trusted mesh-to-surface-cell adapter，证明输入 geometry/provenance 生成不在本 follow-up 修改范围；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:840>)

### `experiments/octree-mapping/prepare_plan4_shadow.py`
- **`bounds`、`parser`、`main`（累计新增函数）：** 原样承载私有 Plan 4 input/metadata preparation，不改变 frame、mesh、triangle 或 part provenance；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:1056>)

### `experiments/octree-mapping/pyproject.toml`
- **实验包与 CLI 声明（累计新增配置）：** 原样承载隔离 Python package、固定依赖和 entry point；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:1152>)

### `experiments/octree-mapping/run_plan4_ablation.py`
- **`parser`、`resolved_level`、`summarize`、`main`（新增/修改函数）：** 迁移到 compact levels，仅保留 solver/runtime/marginal cell-level summary；删除所有 part-level spread、fit、cross-side、abdomen bucket 和 pass/fail 派生；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:1203>)

### `experiments/octree-mapping/validate_scenarios.py`
- **`morton`、`decode`、`document`、`run_case`、`run_failure`、`resolved_level`、`require`（累计/修改函数）与 `validate_compact_levels`（新增函数）：** 每个成功 black-box case 校验 schema `/3`、exact level wrapper、完整 solved-depth coverage、严格 inner 字段集合、数组计数、可推导父 prefix、三维毫米 displacement，并确认旧顶层 verbose arrays 和 part-level output 消失；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:1418>)
- **`axis_values`、`grid_center`、`displacement`、`max_displacement`（修改/新增函数）：** 所有 synthetic assertions 都逐 cell 读取 compact arrays；不按 provenance 计算均值或任何 part-level 聚合；用 d3–d6 固定 8 mm translation 并允许不超过半个当前 cell 的量化误差验证跨层毫米可比，再以非对称 partial coarse cell 证明 `gridCenter + displacement` 重建已知 GT barycenter；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:1459>)
- **`main`（修改函数）：** 保留既有 identity/translated/legs/missing/extra/coarse/provenance/depth/normal/neighborhood/failure 场景；neighborhood 改成镜像局部 occupancy fixture，通过 displacement 而非已删除 targets 验证 correspondence；新增 multi-depth mm 与 grid-center reconstruction 场景；[查看 Planned Patch](</Users/zhiyuanma/.codex/worktrees/9285/Procedura/.agents/plans/2026-09-01-mesh-to-cad-octree-mapping-compact-multi-depth-evidence.planned.patch:1532>)

## 实现步骤

- [x] 保留 schema `/2` position-only 基准并完成私有输入审计。
- [x] 引入 schema `/3` d3–d6 compact serialization，保持 solver/candidate graph/cost/support/Sinkhorn 不变。
- [x] 更新 README、black-box validation 和 ablation consumer；无 forbidden verbose/part output。
- [x] 完成允许的非-unit入口验证与私有报告合同检查。
- [x] 完成数值/字段/资源与 stale-symbol 检查；14 个 black-box scenarios 全部通过。
- [x] 生成同基线 Final Patch 并完成 Mode B 全范围审查。

## Implementation Review

- **Mode A：** 全范围复审最终返回 `No findings`；Planned Patch 与基线 apply-check、Intent link checker 均通过。
- **Planned → Final：** 仅保留两处必要的验证消费者修正：多深度平移场景采用单 cell 并按半 cell 量化误差验证毫米可比；neighborhood 场景按实际镜像方向检查 displacement。另删除一个实施后发现的未使用局部变量；无算法或接口扩展，无 egg-info 生成物。
- **Mode B：** 全范围复审返回 `No findings`；Final Patch 对同一基线 apply-check 通过。
- **验证证据：** 隔离 venv 安装声明依赖成功；py_compile、CLI help、git diff --check 成功；14 个 subprocess black-box scenarios 全部 PASS；stale symbol search 仅命中有意保留的 forbidden-name 文档/断言。
- **真实 shadow：** 使用冻结输入 `/tmp/plan4-depth6-mapping-input-v2.json`，输出保存在 `/tmp/plan5-compact-real-run/reports/`，汇总为 `/tmp/plan5-compact-real-run/summary.json`。四个 profile 均完成 d3–d6；每层 candidate/GT 数分别为 80/100、350/436、1598/2031、7493/8397，schema `/3` exact keys 通过。position/normal/neighborhood/unmatched 的总耗时约 17.59/17.16/17.87/3.38 秒，峰值 RSS 约 486.8/488.7/359.2/404.7 MB；d6 candidate edges/support 分别为 1,315,700/269,747、1,299,163/268,119、1,273,284/262,053、1,240,504/252,618，最大 solver error 均低于 `1e-7`。该运行未改变输入或 upstream；完整 reconstructive reports 保持 host-private。

## 接口与兼容性

- 输出 schema 为 breaking migration `/2 → /3`：消费者必须从 `levels[-1].candidateCells` / `gtCells` 读取最终 cell，或遍历所有层；不提供双写、兼容 alias 或 legacy mode。
- 每层 `summary`、candidate cell 和 GT cell 的 key set 必须严格等于冻结合同；不得追加便利字段或重复推导字段。
- 输入 schema `/2`、CLI 参数（移除仅用于 part expressibility 的参数）、solver config、mesh adapter 和 runtime shape 不变。
- 不再有顶层 `parts` summary；candidate cell 仅含合同规定的五个 cell-level 字段，不含 provenance。
- 输出继续是 host-private reconstructive evidence，不进入 Agent prompt 或公开 run artifact。
- 修改 upstream 文件为零；删除整个 `experiments/octree-mapping/` 仍可完整移除此能力，Plan 1–4 默认行为不变。

## 验证

- Planned Patch 对 git baseline apply-check；Patch Intent link checker 覆盖全部 11 个累计 new-file hunks。
- Python syntax compilation、CLI help 和 package dependency check；这些不是 unit tests。
- `validate_scenarios.py` 全套 subprocess black-box scenarios；禁止新增、修改或运行 unit tests。
- 私有 Plan 4 depth-6 position-only shadow run：精确检查 d3–d6 四层、字段集合、parent prefix、数值稳定性、solver 收敛、时间、peak RSS 和文件字节数。
- 迁移前后 position-only 数值对比必须在 `1e-12` 内；cell displacement 的跨层合成 fixture 允许半 cell 的 coarse quantization 误差，但迁移前后同层数值仍须在 `1e-12` 内。
- 文件大小以同一 JSON indent/sort 配置的实际字节数比较；新报告必须至少缩小 50%，不预先承诺具体 MB。
- 不调用 LLM、Blender 或 OpenSCAD，不 commit/push，不操作 GitHub Issue。

## 风险与回滚

- 风险：缓存全部层 evidence 会增加运行期内存。真实 run 必须记录 peak RSS；若超出现有可运行边界，先报告失败，不扩张为 sparse/native 重写。
- 风险：删除 coupling 使某些历史诊断无法重算。检测方式是 consumer 不再输出这些指标；冻结旧 report/summary 保留历史证据，不能用 barycenter 近似冒充。
- 风险：删除 part-level 输出使旧消费者无法读取拟合建议。通过 schema `/3` 明确 breaking migration；冻结旧报告保留历史结果，不提供兼容 alias。
- 回滚：删除本 follow-up 对 `mapping.py`、README 和两个验证消费者的变更并恢复 schema `/2`；由于没有 upstream 注册，Plan 1–4 行为与合同始终不受影响。

## 状态

**当前阶段：** Implemented and reviewed

### Refactor follow-up (2026-09-02)

本轮只做可读性提取：`_solve_level` 的代价构造和有限性检查分别移入
`_matching_cost`、`_require_finite_plan`，UOT 尺度计算移入 `unmatched.scales`。Planned Patch 未改变；Final
Patch 已从同一基线重新生成并包含该提取。Planned→Final 仅有这一项结构性差异，无数学、输入
合同或 schema 变化。

验证证据：隔离 `/tmp/plan5-refactor-venv` 安装 numpy/scipy；提取前后 14 个 non-unit
black-box scenarios 均通过；真实 Plan 4 depth-6 四 profile 的 d3–d6 summary、cell
identity、mass、displacement、marginals、iterations/error 全部一致，逐 profile 最大数值
差异为 `0.0`。两侧均通过 py_compile；Final Patch 对基线 apply-check 通过。

### Profile/config refactor (2026-09-02)

按批准范围新增 `octree_mapping/config.py`、`costs.py`、`unmatched.py`：profile 默认值和
不可变 `MappingConfig` 集中管理，三种几何 cost 与 UOT unmatched scale 独立实现；CLI
仅解析 profile/公共覆盖项，`mapping.py` 只消费已解析配置。`SolverConfig` 保留为同义导出
以维持实验内调用兼容。mesh adapter 现以 `load_mesh`、`normalize_mesh`、`rasterize_surface_cells`、
`aggregate_surface_cells` 明确分阶段，`surface_cells` 保留为同结果组合入口。

实现后验证：14 个 non-unit black-box 全部通过；同一 Plan 4 depth-6 输入四 profile 的
d3–d6 summary、cell identity/mass/displacement/marginals、iterations/error 与重构前一致，
每 profile 39,527 项数值检查最大差异 `0.0`。本轮新增接口仍限于 experiments/octree-mapping，
不改变 schema /3、solver 数学或 Plan 1–4。Mode A 与 Mode B 均为 `No findings`；Planned/Final
对基线 apply-check 通过。

### Contract parser refactor (2026-09-02)

`contract.py::_cells` 仅做流程编排；公共 prefix/mass/normal 解析移入
`_parse_cell_geometry`，candidate 专属 parts 校验移入 `_parse_parts`。保留原有字段集合、
错误条件、排序、去重和 `Cell` 结果；candidate provenance 仍只属于输入兼容合同，mapping
不读取。14 个 non-unit black-box 场景重新通过，py_compile 通过；该改动不触及 solver 数值路径。

### Runtime validation (2026-09-02)

使用既有私有输入 `/tmp/plan4-depth6-mapping-input-v2.json` 对 contract parser 简化后的
实现运行四个 canonical profile。`position`、`normal`、`neighborhood`、`unmatched` 均输出
完整 d3–d6 四层，schema 均为 `/3`，无空或半成品 JSON。逐 profile 检查 39,527 个数值/身份
项目：cell prefix、mass、displacement、source/target marginal、iterations 和 solverError
与上次真实报告完全一致，最大差异均为 `0.0`。本次耗时/RSS 分别为：position 18.658s/444.8MB，
normal 18.055s/426.8MB，neighborhood 18.339s/455.7MB，unmatched 4.062s/338.2MB。
未修改代码逻辑、Planned Patch 或 Final Patch。

原始 mesh 回归补充：使用 Plan 4 记录的真实输入路径——GT/reference
`/Users/zhiyuanma/Desktop/Codes/Procedura/outputs/transformer-robot-smoke-20260830/final.obj`，
candidate `.../mesh-to-cad-plan4-refine-runtime-retry/final.obj` 及其 `_final_build/output.stl`，
和 `parts_color_meta.txt`——重新执行 `prepare_plan4_shadow.py` 的 load→normalize→rasterize→aggregate。
生成 `/tmp/plan5-rawmesh-regression/input.json` 后运行 canonical position profile：schema `/3`，
d3–d6 cell 数分别为 80/100、350/436、1598/2031、7493/8397（candidate/GT），字段集合符合
compact 合同；mapping 耗时 35.521s，峰值 RSS 502,710,272 bytes。该回归未修改代码、计划或补丁，
也未调用 LLM、Blender、OpenSCAD 或 unit tests。这里的 GT 是 Plan 4 约定的 baseline reference mesh，
不是外部 CAD 真值。
