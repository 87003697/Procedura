# Plan: 让 Mapping critic 与 visual critic 并行进入 direct refine

## 目标

每个 `runDirectRefine` cycle 先编译并渲染当前 SCAD，然后在同一版 CAD 上并行运行：

1. 现有 visual critic；
2. Mapping critic。

两个 critic 都返回文本 feedback。文本合并后只进入一次现有 patch 模型；原有
patch 解析、应用、编译重试、facet gate、回滚和 finalization 保持不变。

Mapping critic 不读取预先生成的 `mapping.txt`，不接收 `mapping.json` packet，也不创建
第二套 repair loop。它通过一个可删除的 adapter，将当前 cycle 的 `stlPath`、SCAD、渲染
视图和 `stepDir` 交给 host-side `prepare` 函数，由该函数准备目标/候选 Mapping report、
semantic plan 和 Mapping vision views，再调用现有 `runMappingAgent`。

## 接口决策

Direct refine 的新增边界是一个可选 `MappingCritic`。它只返回统一的 critic feedback
形状；visual critic 仍保留在 `refine-direct.ts` 中，不为了接口对齐而迁移其实现：

```ts
type CriticFeedback = {
  text: string;
  actionable: boolean;
};

type MappingCritic = (args: {
  context: {
    cycle: number;
    workspaceDir: string;
    stepDir: string;
    scad: string;
    stlPath: string;
    views: readonly { label: string; path: string }[];
    partsColorLegend: string;
  };
  route: RouteDef<unknown>;
  model: ModelRef;
  signal?: AbortSignal;
}) => Promise<CriticFeedback>;
```

`makeMappingCritic(prepare)` 是现有 Mapping Agent 的薄适配器。`prepare` 必须以当前
cycle context 为输入，返回：

```ts
{
  source: { input: unknown; report: unknown };
  semanticPlan: unknown;
  vision: {
    legend: string;
    views: readonly [
      { name: "front"; partColorPath: string; comparisonPath: string },
      { name: "top"; partColorPath: string; comparisonPath: string },
      { name: "right"; partColorPath: string; comparisonPath: string },
    ];
  };
}
```

visual critic 在 direct refine 内部将原有 `generateWithRetry` 结果转换成同样的
`CriticFeedback`；Mapping Agent 直接返回 text，adapter 只负责 trim text 并计算
`actionable`。这样两者只在调度结果上对齐，visual critic 的原有输入和调用实现保持不变。
Mapping 专用的网格、octree、部件语义和对比图准备留在 adapter/host，不污染 patch loop。

Mapping Agent 继续校验输入、plan coverage 和 inspection tool 参数，但不再要求最终
模型回复是 JSON，也不再在 direct refine 路径中解析或重试 artifact。`STATUS: ok` 且
包含 region 时视为 Mapping 有可修复问题，`STATUS: insufficient-evidence` 不会单独
触发 patch。

## Cycle 数据流

```text
current SCAD
   ↓
compile → current STL → parts-colour render → connectivity
   ↓
build visual critic parts       prepare Mapping input from current cycle
             ↘                 ↙
             Promise.all(visual critic, Mapping critic)
                         ↓
             combined text diagnosis
                         ↓
             existing patch model once
                         ↓
             existing parse/apply/compile/retry/facet/finalize
```

如果没有提供 `mappingCritic`，direct refine 保持原 visual-only 行为。Mapping adapter
失败时沿用 visual critic 的失败策略，结束当前 refine，而不使用旧 Mapping 结果继续修复。

## 文件范围

| 文件 | 改动 |
| --- | --- |
| `src/pipeline/mapping-critic.ts` | 新增 Mapping critic context、输入 builder 和 feedback 状态识别；直接消费 text，不实现第二套修复流程。 |
| `src/agents_mesh2code/mapping-agent.ts` | 将最终模型回复契约改为 plain text；保留输入、evidence 和 inspection tool 校验，删除最终 artifact JSON 解析与重试。 |
| `src/agents_mesh2code/mapping-feedback-schema.ts` | 删除。该 schema 只有 direct refine 的旧 artifact 适配路径使用，清理后无生产消费者。 |
| `src/pipeline/refine-direct.ts` | 保留原 visual critic 实现；增加可选 Mapping critic、同一 cycle 的 `Promise.all` 和统一 feedback 合并；复用原 patch loop。 |
| `src/pipeline/procedura.ts` | 将可选 Mapping critic 透传给 direct refine。 |
| `src/pipeline_mesh2code/procedura_adapter.ts` | 允许 Mesh-to-CAD host 传入 Mapping critic。 |
| `src/pipeline_mesh2code/mesh-to-cad-generation.ts` | 继续向 Mesh-to-CAD host 暴露该可选透传点。 |
| `experiments/octree-mapping/README.md` | 说明 Mapping solver/report 仍由 host 准备，refine 只接收 adapter 的文本结果。 |

## Upstream 修改边界

- `src/pipeline/refine-direct.ts`：必须修改，因为它是 visual critic 与现有 patch model 的唯一 direct orchestration seam；增加可选 Mapping critic 调用和合并文本，不迁移 patch loop，并修正该文件原有 patch prompt 的 `+ +` 拼接错误，避免普通 direct refine 把固定提示变成 `NaN`。
- `src/pipeline/procedura.ts`：必须修改，因为统一 pipeline 需要把可选 Mapping critic 传入 direct refine；默认未提供时行为不变。
- `src/pipeline_mesh2code/procedura_adapter.ts`、`mesh-to-cad-generation.ts`：必须修改，因为 Mesh-to-CAD host 是 Mapping 输入的拥有者，需要有一条明确的可选透传路径；不提供时原调用完全不变。
- `src/agents_mesh2code/mapping-agent.ts`：必须修改，因为 direct refine 的实际契约是 text；保留 Mapping 输入和工具校验，只移除没有消费者的最终 artifact JSON 契约。
- `src/agents_mesh2code/mapping-feedback-schema.ts`：必须删除，因为它只服务于被移除的最终 JSON 解析路径。

删除 `mapping-critic.ts` 和上述可选透传接缝后，普通 visual-only refine、原有
patch contract 和 Mapping Agent/solver contract 恢复；不会保留预生成诊断输入协议。

## Patch Intent

- `src/pipeline/mapping-critic.ts`：新增唯一 Mapping adapter seam。它从当前 cycle context 构造 Mapping Agent 输入，消费 text 结果并返回 `actionable`；不实现第二套修复流程。
- `src/agents_mesh2code/mapping-agent.ts`：让 Mapping 模型直接输出 patch 所需的诊断文本；输入 facts、plan coverage 和 inspection tool 仍由 Mapping Agent 负责校验。
- `src/pipeline/refine-direct.ts`：在现有 compile/render/connectivity 之后启动 visual critic 和可选 Mapping critic；两个结果使用同一 cycle context 并行获取，写入同一轮诊断，之后沿用原测量、patch、compile retry、facet gate 和 finalization。
- `src/pipeline/procedura.ts`：把可选 Mapping critic 从统一入口传给 direct refine；缺省路径不传值。
- `src/pipeline_mesh2code/procedura_adapter.ts`、`mesh-to-cad-generation.ts`：为 Mesh-to-CAD host 增加同一个可选 callback 的透传，不生成 Mapping 输入、不改变 draft 或 reference 生命周期。
- `experiments/octree-mapping/README.md`：记录 host adapter 所需的当前 CAD Mapping 输入和 text handoff，不定义新的 refine 输入文件协议。

## 非目标

- 不把 `mapping.json` 或 `mapping.txt` 作为 refine 输入。
- 不在 patch 模型之外新增修复入口或 `runRepairStep`。
- 不把 Mapping 输入、evidence 或 tool 校验移入 `refine-direct.ts`；direct refine 只接收 Mapping text。
- 不让 Mapping critic 使用旧 CAD 的 report；每轮 host `prepare` 必须依据当前 `stlPath` 生成或取得对应输入。
- 不修改 octree solver 的 schema、求解器算法或 Mapping Agent 的证据规则。
- 不新增、修改或运行 unit tests；不提交、不推送、不做 SHA 校验。

## 验证与完成标准

- `bun run typecheck` 通过。
- `git diff --check` 通过。
- Mapping Agent 可直接返回 text；actionable smoke 通过，且无效的最终 JSON 不再阻断 text handoff。
- direct refine 的 source inspection 确认两个 critic promise 使用同一 `cycle`、`stlPath`、SCAD 和 views，并在同一个 patch prompt 中合并。
- 没有 Mapping critic 时，普通 visual-only direct refine 仍只调用原 visual critic 和原 patch model。
- 当前工作区中与本任务无关的 notes、旧 plans、论文和实验文件保留不动。

## Implementation Review

2026-09-20：Mode A Planned Patch review 返回 **No findings**。reviewer 确认计划、Patch
Intent、原始六个目标文件和非目标一致，planned patch 可以从记录基线应用。

2026-09-20：Mode B reconciliation 返回 **No findings**。Planned 与 Final 字节一致，没有
P→F execution delta；范围与原始六个授权目标文件一致。reviewer 确认每轮 compile/render、
并行 critics、统一 patch feedback、可选透传和原有 retry/finalization 均由 patch 表达，
Mapping Agent `{ artifact }` 和 solver contract 保持不变。

验证证据：

- `bun run typecheck` 通过；
- `git diff --check` 通过；
- Mapping adapter actionable smoke 通过；
- planned patch 在基线干净归档树中通过 `git apply --check`，并与当前实现逐文件一致；
- planned/final patch 字节一致；
- 未新增、修改或运行 unit tests；未提交或推送。

Final Patch：
[2026-09-19-mapping-feedback-to-cad-patch.final.patch](./2026-09-19-mapping-feedback-to-cad-patch.final.patch:1)

## 当前实现状态

2026-09-20：付费 A/B 试跑暴露 Mapping 最终 JSON 校验会阻断 text handoff。随后将 Mapping Agent 的最终输出改为 plain text，保留输入、evidence 和 inspection tool 校验，并删除无消费者的 artifact schema；direct refine、visual critic、patch loop 和 Mapping solver contract 不变。该 cleanup 是用户在试跑后的明确调整，需重新生成 planned/final patch 并重新审查。

Cleanup verification on 2026-09-20：`bun run typecheck`、`git diff --check` 和无付费 fake-fetch text handoff smoke 均通过；removed JSON symbols have no remaining production references，planned/final patch 字节一致；未新增、修改或运行 unit tests，未提交或推送。
