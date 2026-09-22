# Plan: Mapping critic integrated into direct refine milestone
## 目标与完成标准
记录并冻结当前 Mapping→direct refine milestone：visual critic 与 Mapping critic 在同一轮 CAD 状态下并行运行；Mapping 复用 visual critic 的完整上下文并补充 octree evidence 与 comparison views；两者输出有序纯文本 issue；direct refine 合并诊断并继续使用现有 patch 入口。完成标准是接口、诊断契约和验证结果可追溯。Patch agent 的稳定多轮收敛、失败 patch feedback loop 和 PARAM patch 类型属于后续工作。

非目标：不新增 PARAM patch block，不改变 Patch parser，不自动跨 critic 合并 issue，不修复 rollback/facet gate 策略，不清理无关运行产物和 notes。
## 关键发现
- Mapping 需要完整 visual context、semantic plan、aligned comparison views 和 bounded cell evidence；全局平均 arrow summary 会掩盖累计误差。
- 付费验证证明 Mapping 能指出下游累计 placement，并能影响 Patch agent 选择结构性修改；四轮验证也证明 Patch agent 的稳定装配修复仍未完成，最终 gate 能恢复 draft。
- 计划基线是当前 HEAD `a8a0fdac6c11009c062aa85853ff5af3722387e2`，工作区已有实现改动，Planned Patch 用于记录和后续冻结。
## 方案与决策
采用薄 Mapping critic adapter、独立 diagnosis-format module 和 prompt 级契约调整。保留 HIGH/MED/LOW 作为标签，用 issue 顺序表达优先级；Mapping 在源码有依据时填写 CAUSE/TARGET/CONSTRAINTS；Patch 仍使用 MODULE/PLACE/ADD，本 milestone 不扩展 patch parser。
## Patch Artifact
- **计划基线：** `a8a0fdac6c11009c062aa85853ff5af3722387e2`
- **计划 Patch：** [2026-09-21-mapping-refine-milestone.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch>)
- **Final Patch：** [2026-09-21-mapping-refine-milestone.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.final.patch>)
- **批准前校验：** `git apply --check /Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch`（在干净基线 worktree 中运行）
## Patch Intent

### `experiments/octree-mapping/README.md`
- **hunk 1（experiments/octree-mapping/README.md）：** 记录 Mapping host adapter 的输入准备、纯文本 diagnosis 形状和 direct refine 接入方式，保持普通 visual-only 路径不变。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:7>)

### `src/agents_mesh2code/mapping-agent.ts`
- **hunk 2（src/agents_mesh2code/mapping-agent.ts）：** 让 Mapping 保留空间证据、源码依赖和 reasoning，同时把输出契约与 visual critic 对齐。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:25>)
- **hunk 3（src/agents_mesh2code/mapping-agent.ts）：** 让 Mapping 保留空间证据、源码依赖和 reasoning，同时把输出契约与 visual critic 对齐。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:50>)
- **hunk 4（src/agents_mesh2code/mapping-agent.ts）：** 让 Mapping 保留空间证据、源码依赖和 reasoning，同时把输出契约与 visual critic 对齐。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:61>)
- **hunk 5（src/agents_mesh2code/mapping-agent.ts）：** 让 Mapping 保留空间证据、源码依赖和 reasoning，同时把输出契约与 visual critic 对齐。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:69>)
- **hunk 6（src/agents_mesh2code/mapping-agent.ts）：** 让 Mapping 保留空间证据、源码依赖和 reasoning，同时把输出契约与 visual critic 对齐。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:81>)
- **hunk 7（src/agents_mesh2code/mapping-agent.ts）：** 让 Mapping 保留空间证据、源码依赖和 reasoning，同时把输出契约与 visual critic 对齐。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:97>)

### `src/agents_mesh2code/mapping-arrow-summary.ts`
- **hunk 8（src/agents_mesh2code/mapping-arrow-summary.ts）：** 删除全局平均箭头入口，避免把局部或累计误差压平为单一模块向量。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:121>)

### `src/agents_mesh2code/mapping-evidence.ts`
- **hunk 9（src/agents_mesh2code/mapping-evidence.ts）：** 保留 evidence 数量信息，使模型能区分代表性样本和完整模块几何。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:135>)

### `src/agents_mesh2code/mapping-vision.ts`
- **hunk 10（src/agents_mesh2code/mapping-vision.ts）：** 让 Mapping 复用 visual critic 的多模态上下文并追加自己的 comparison views。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:148>)
- **hunk 11（src/agents_mesh2code/mapping-vision.ts）：** 让 Mapping 复用 visual critic 的多模态上下文并追加自己的 comparison views。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:157>)

### `src/pipeline/diagnose-prompt.md`
- **hunk 12（src/pipeline/diagnose-prompt.md）：** 让 visual critic 输出稳定 issue 名、问题、证据和修复方向，并按 issue 顺序表达优先级。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:187>)

### `src/pipeline/mapping-critic.ts`
- **hunk 13（src/pipeline/mapping-critic.ts）：** 让 Mapping adapter 与 visual critic 使用同形输入和 GenerateResult 返回值，隐藏 Mapping 专属准备逻辑。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:223>)
- **hunk 14（src/pipeline/mapping-critic.ts）：** 让 Mapping adapter 与 visual critic 使用同形输入和 GenerateResult 返回值，隐藏 Mapping 专属准备逻辑。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:234>)
- **hunk 15（src/pipeline/mapping-critic.ts）：** 让 Mapping adapter 与 visual critic 使用同形输入和 GenerateResult 返回值，隐藏 Mapping 专属准备逻辑。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:247>)
- **hunk 16（src/pipeline/mapping-critic.ts）：** 让 Mapping adapter 与 visual critic 使用同形输入和 GenerateResult 返回值，隐藏 Mapping 专属准备逻辑。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:261>)

### `src/pipeline/refine-direct.ts`
- **hunk 17（src/pipeline/refine-direct.ts）：** 在同一编译 CAD 状态下配对视图、并行调用两个 critic，并用统一 issue parser 控制后续 refine。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:295>)
- **hunk 18（src/pipeline/refine-direct.ts）：** 在同一编译 CAD 状态下配对视图、并行调用两个 critic，并用统一 issue parser 控制后续 refine。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:305>)
- **hunk 19（src/pipeline/refine-direct.ts）：** 在同一编译 CAD 状态下配对视图、并行调用两个 critic，并用统一 issue parser 控制后续 refine。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:352>)
- **hunk 20（src/pipeline/refine-direct.ts）：** 在同一编译 CAD 状态下配对视图、并行调用两个 critic，并用统一 issue parser 控制后续 refine。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:374>)
- **hunk 21（src/pipeline/refine-direct.ts）：** 在同一编译 CAD 状态下配对视图、并行调用两个 critic，并用统一 issue parser 控制后续 refine。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:400>)

### `src/pipeline/refine-patch-prompt.md`
- **hunk 22（src/pipeline/refine-patch-prompt.md）：** 让 Patch agent 按一个根因和 issue 顺序执行，并优先保持共享参数、父级或累计 placement 依赖。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:464>)
- **hunk 23（src/pipeline/refine-patch-prompt.md）：** 让 Patch agent 按一个根因和 issue 顺序执行，并优先保持共享参数、父级或累计 placement 依赖。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:475>)
- **hunk 24（src/pipeline/refine-patch-prompt.md）：** 让 Patch agent 按一个根因和 issue 顺序执行，并优先保持共享参数、父级或累计 placement 依赖。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:496>)

### `src/pipeline/diagnosis-format.ts`
- **hunk 25（src/pipeline/diagnosis-format.ts）：** 提供集中式诊断 issue header 解析，兼容新旧文本格式，避免 pipeline 复制格式判断。 [查看 Planned Patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-21-mapping-refine-milestone.planned.patch:520>)

## 实现步骤
- [x] 从当前实现、历史 notes 和 paid fixture 结果提炼 milestone 范围。
- [x] 生成同一基线 Planned Patch，并在干净 HEAD worktree 执行 apply check。
- [x] 计划获批后由 implement-patch 应用并验证 `bun run typecheck`、`git diff --check`。
- [x] 使用已有 paid fixture 四轮结果检查 diagnosis、mapping、patch、facet、连接性和最终 fallback；本次实现未重新发起付费模型调用。
## 接口与兼容性
- 普通调用者未提供 Mapping critic 时，visual-only direct refine 保持原路径。
- Mapping diagnosis 仍是纯文本；diagnosis-format 只解析 issue header，不改变 patch block 语法。
- upstream patch parser 不变；Mapping adapter 是可移除的新增能力接缝。
## 验证
- 已验证：`bun run typecheck`、`git diff --check`。
- 已验证：干净 HEAD worktree 上 Planned Patch 可应用。
- 已验证：paid fixture 四轮运行中前两轮产生结构性 placement patch，后续触发模块/细节回归并恢复 draft；这证明 Mapping 诊断契约生效但 Patch 稳定收敛仍未达标。
- 已验证：批准后的实现与 Planned Patch 的 10 个文件逐一一致；Final Patch 可从同一基线应用。
- 已验证：`implementation-review` Mode B 返回 `No findings`；Planned → Final 没有代码语义差异。
- 未执行：`scripts/check_patch_intent_links.py`，仓库中不存在该脚本。
## 风险与回滚
- 风险：模型不遵守文本契约或 Mapping TARGET 诱导过大重写；compile、facet、connectivity 和 final fallback 继续作为安全门禁。
- 回滚：移除 Mapping adapter 注册、诊断契约和新增 diagnosis seam，恢复 visual-only direct refine；保留 upstream patch block 语法。
## 状态
**当前阶段：** Implemented and reviewed

## Implementation Review

- **Mode：** B — Patch Reconciliation
- **结果：** `No findings`
- **Planned → Final：** 仅有 unified diff 的 index 缩写和新增文件 hunk 顺序差异，没有代码语义差异。
- **审查结论：** Final Patch 覆盖批准方案；没有发现遗漏、越界修改、调试遗留或新增 PARAM patch 类型。
- **验证：** `bun run typecheck`、`git diff --check`、Planned Patch 基线 apply check、Final Patch 基线 apply check 均通过。
- **限制：** paid fixture 使用已有四轮运行证据，本次没有重新发起付费模型调用；patch agent 的稳定多轮收敛仍属于后续工作。
