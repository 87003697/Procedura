# Plan: Mesh2Code Mapping Side-Path Integration

## 目标与完成标准

把当前 worktree 中已经形成的 mapping schema、facts tool、mapping agent 和可视化能力整理为两个职责清晰、可独立移除的 side-path：src/agents_mesh2code/* 和 src/tools_mesh2code/*。完成后，宿主可以读取受限 finest-depth /3 facts，并通过独立 renderer 生成 front/top/side PNG；feedback artifact 仍严格校验且不暴露原始 mesh、路径或报告。不得改变 execution/refine upstream 行为。

完成标准：四个模块可从计划基线应用；facts 和 artifact 保留必要边界校验；renderer 可用参数化 CLI 从同一 /3 和两个 OBJ 重建三视图；所有新增逻辑位于两个新 side-path 中，删除它们不影响 upstream。

## 关键发现

- 当前 worktree 有三个未跟踪实现：mapping-feedback-schema.ts、mapping-facts.ts、mapping-agent.ts；它们未注册进 upstream pipeline。
- 临时 render_mapping_report.py 已能基于 finest-depth displacementMm 生成三视图，但 ROOT 硬编码、不可复用，且箭头语义是 candidate→GT 的 displacement target proxy。
- upstream tool 统一采用 ToolDescriptor、factory 注入 source/state、execute 返回 {ok, output|error}；图片通过附件返回。此次 renderer 保持独立 CLI，避免把本地 mesh 路径暴露给 agent。
- .env 和 outputs/example_v1 是 ignored 本地运行资料，不纳入代码 patch；不修改 upstream 文件。

## 方案与决策

采用按职责拆分的最小四文件 side-path：standalone evaluator 与 artifact contract 放在新建的 src/agents_mesh2code/；finest-depth facts adapter 与本地 evidence renderer 放在新建的 src/tools_mesh2code/。facts 只保留 schema/frame、cell budget 和分页边界；agent 只做一次受限 facts 读取和模型调用；不创建 mapping-types.ts，不接入 src/tools/、src/render/ 或生产 pipeline，不恢复真实 barycentric target。两个目录都是本功能专用的新 namespace。

## Patch Artifact

- 计划基线：main HEAD 7030755fd01d8d219e35fd1a4a0382e1a59ffc5f
- 计划 Patch：[2026-09-04-mesh2code-mapping-sidepath.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch>)
- Final Patch：[2026-09-04-mesh2code-mapping-sidepath.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.final.patch>)
- 批准前校验：git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch

## Patch Intent

### src/agents_mesh2code/mapping-feedback-schema.ts
- parseMappingFeedbackArtifact（新增）：保留 artifact 必要的闭合字段、证据引用、confidence、范围和禁止字段校验；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch:15>)
- Final hunk：[查看 Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.final.patch:15>)

### src/tools_mesh2code/mapping-facts.ts
- makeMappingFactsTool（新增）：以 upstream Harness tool 形状提供 finest-depth cells、位置、位移和受限分页；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch:55>)
- Final hunk：[查看 Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.final.patch:55>)

### src/agents_mesh2code/mapping-agent.ts
- runMappingAgent（新增）：分页读取受限 finest-depth facts，执行一次模型调用并解析 artifact；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch:89>)
- Final hunk：[查看 Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.final.patch:89>)

### src/tools_mesh2code/render_mapping_report.py
- render（新增）：将 /3 finest-depth displacement 和 GT/candidate OBJ 渲染为可复现的 front/top/side PNG，并明确 candidate → GT proxy 方向；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch:123>)
- Final hunk：[查看 Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.final.patch:123>)
- main（新增）：提供 --report、--gt、--candidate、--out-dir、--max-arrows 参数；[查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.planned.patch:140>)
- Final hunk：[查看 Final Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-mesh2code-mapping-sidepath.final.patch:140>)

## 实现步骤

- [x] 从计划基线应用四个新增模块；验证：git apply --check；完成：四个文件位于两个职责 side-path，upstream 无 diff。
- [x] 用已保存的 outputs/example_v1/3-report.json、gt-final.obj、candidate-final.obj 运行 renderer；验证：生成 front/top/side 三个 PNG；完成：文件非空且标题/图例说明 proxy 方向。
- [x] 对 facts 和 artifact 做边界 smoke 验证；验证：静态实现检查覆盖未知字段、重复 prefix、超预算、非法 evidence 引用；完成：只观察返回值，不运行 unit tests。
- [x] 检查 side-path 与 upstream 隔离；验证：git diff --stat、导入搜索和已有脚本启动检查；完成：没有修改 src/tools/、src/agents/、src/pipeline/procedura.ts 或 refine 注册点。

## 接口与兼容性

- 新增模块不改变既有公开接口。
- mapping_facts 遵循 ToolDescriptor + executor contract；数据源由宿主注入，agent 不传 raw mesh/path。
- renderer 是本地 Python CLI，依赖现有 numpy/matplotlib；输出 PNG 是可丢弃 evidence，不写入 feedback artifact。
- .env 的 xhub 配置属于 ignored 本地设置，不进入 patch。

## 验证

- 静态：git apply --check、Patch Intent 链接检查、TypeScript 类型检查（不新增或运行 unit tests）。
- renderer：对 outputs/example_v1 运行三视图生成并检查三文件存在、尺寸大于零。
- 失败边界：非法 schema、越界 depth/prefix、重复 ID、无效范围和超过 cell/page budget 必须返回错误。
- 回归：确认 upstream 文件 hash 与计划基线一致，删除 side-path 后原 pipeline 文件集合不变。

## 风险与回滚

- numpy/matplotlib 环境缺失：只影响 renderer，可单独安装依赖或跳过可视化，不影响 facts/agent。
- proxy displacement 可能被误读为真实 barycentric target：标题和文档固定说明语义，后续替换 target 计算即可。
- 当前 agent 是单次 facts snapshot + generateOnce，不是完整 tool-loop：本计划不扩大范围，记录为后续迭代。
- 回滚方式：删除 src/agents_mesh2code/ 和 src/tools_mesh2code/ 下四个新增文件及其计划 patch；不触碰 upstream。

## 状态
当前阶段：Implemented

## Implementation Review

- Planned Patch 与 Final Patch：相同；没有 P→F 差异。
- 验证：`bun run typecheck`、`python3 -m py_compile src/tools_mesh2code/render_mapping_report.py`、干净基线 `git apply --check` 均通过；未运行 unit tests。
- smoke：从 `outputs/example_v1` 读取 `/2` input 与 `/3` report，`mapping_facts` 成功返回 2 个分页 cell；feedback 合法 artifact 可解析，含禁止字段的 payload 被拒绝。
- 真实 renderer：使用 `outputs/example_v1/3-report.json`、`gt-final.obj`、`candidate-final.obj` 生成 `/tmp/mapping-render-smoke/mapping-report-front.png`、`mapping-report-top.png`、`mapping-report-side.png`，三张文件均成功写出。
- implementation-review Mode B：No findings。
- 未验证：尚未接入 Procedura runtime；这是后续入口验证，不改变本次 side-path 实现。
