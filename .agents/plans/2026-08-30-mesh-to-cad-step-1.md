# Plan: Mesh-to-CAD Step 1 — 已拆分

> **历史状态：** 本文保留拆分过程，不再作为当前推进顺序。Plan 1A 与 Plan 1B 已由 [低侵入完整 Plan 1](./2026-08-30-mesh-to-cad-plan-1-low-intrusion.md) 合并取代并完成；下一项应重新校准 Plan 2，使其基于 canonical handle/summary seam。

本计划已于 2026-08-30 拆分，不再作为实现依据。旧的单体 Planned Patch 已删除，避免与分阶段批准发生冲突。

新的权威实施顺序：

1. [Plan 1：私有参考导入与 Studio Viewer](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-reference-viewer.md>)
2. [Plan 1B：多格式导入与 Z-up 规范化](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-multiformat-normalization.md>)
3. [Plan 2：受控观察与 Reconstruction Brief](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-controlled-observation.md>)
4. [Plan 3：开放环 CAD 生成衔接](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-08-30-mesh-to-cad-generation.md>)

Plan 1 的 STL/OBJ 实现及其 frozen planned/final patch 是不可修改的审计检查点。第一阶段尚未整体完成：必须先完成并验收 Plan 1B，再进入 Plan 2。

每个阶段必须独立完成 Planned Patch 校验、Mode A 审查、用户批准、实现和验收，才能进入下一阶段。

## 状态

**当前阶段：** Plan 1 已完成；Plan 1B 待 Mode A 审查/批准，第一阶段整体仍未完成。
