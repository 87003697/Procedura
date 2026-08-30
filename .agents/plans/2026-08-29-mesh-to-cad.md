# Plan: Procedura Mesh-to-CAD 垂直切片

> **路线更新：** 原 Plan 1A/1B 的拆分记录仍保留用于审计，但当前 Plan 1 权威基线已经切换为 [低侵入完整 Plan 1](./2026-08-30-mesh-to-cad-plan-1-low-intrusion.md) 及其 frozen Planned/Final Patch。Plan 1 已完成；后续 Plan 2/3 必须基于该 Final 状态重新校准后再进入各自的 Mode A。

## 目标与完成标准

在 Procedura 中增加独立的 `mesh-to-cad` 入口：输入一个 CAD Z-up `.stl` 或 `.obj` 参考网格和可选文字说明，复用现有增量 SCAD 草拟及 direct-refine 流程，输出可编辑的 `final.scad`、重建网格和一套 VoxBlame 几何证据。

完成必须同时满足：

- `bun run mesh-to-cad --mesh <path> -o <dir>` 能从 STL/OBJ/PLY/GLB/glTF/3MF 启动，并在导入时统一为 canonical Z-up/mm geometry，不要求用户另行提供图片。
- 参考网格只准备、归一化一次；Step 0 冻结候选坐标变换，后续候选不得独立居中或缩放。
- Step 0 以及每个通过现有编译和回归门的候选都有 Measured Step，全部 Repair Target 页面均被读取并保存。
- critic 与 patcher 同时获得参考视图、当前渲染、深度 8 missing/excess、外部越界和优先 Repair Targets。
- 迭代结束时交付客观误差最低的可编译 SCAD，而不是无条件交付最后一次修改。
- 最终 SCAD 被重新编译，并通过 VoxBlame `verify` 与所选 Measured Step 比较；验证结果保存在 `_mesh_to_cad/final-verification.json`。
- 既有 `bun run procedura` 的文字/图片工作流行为不变。

首版明确不做：Text-to-CAD 的 Workspace Authority、Attempt/Repair Cycle 发布协议、Region Diff、Koala/私有模型传输、STEP/build123d 输出、轴向猜测、断点续跑以及 unit tests。第一阶段输入完整支持 STL/OBJ/PLY/GLB/glTF/3MF，并统一为私有 canonical Z-up/mm triangle soup；首版输出是 Mesh-to-SCAD。

## 关键发现

- Procedura 已有完整的 `SCAD → STL → 多视角渲染 → critic → patch → 编译门 → 回退` 循环，默认入口位于 `runDirectRefine`；重建决策无需再引入一个 Agent loop。
- 现有 `src/mesh/chamfer.ts` 会分别归一化两张网格，适合衡量形状漂移，不适合 Mesh-to-CAD 的固定坐标证据，不能直接充当验收指标。
- VoxBlame 是框架无关的几何引擎，公开命令已经支持任意 trimesh 可读候选；Procedura 的 OpenSCAD 二进制 STL 可以直接测量，无需增加 GLB 转换。
- VoxBlame 的坐标契约是 `[-0.5, 0.5]^3`。参考由引擎归一化一次；Procedura 首个候选需要建立一次初始变换，此后同一变换应用于所有候选副本，SCAD 源码和普通输出不被改写。
- Blender 5.1.1 已核实可导入 PLY 与 glTF/GLB；受控脚本将 glTF 标准 Y-up/meter 转为 Z-up/mm，并用 stdlib 解析 3MF core model。STL/OBJ 复用 TS loader；所有格式统一写 canonical binary STL，再把固定视图合成为 contact sheet。
- `mesh-compare` 当前不是 Procedura 的 npm 依赖。首版将它视为与 OpenSCAD、Blender 类似的外部执行依赖，通过两个显式环境变量定位；Procedura 不复制其 Workspace 或自行增加 SHA 校验。
- 当前仓库指令禁止新增、修改或运行 unit tests，因此验收使用 TypeScript 类型检查、CLI 帮助检查和真实低预算冒烟运行。

## 方案与决策

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 整体迁入 Text-to-CAD Workspace、Agent Surface 和发布协议 | 证据链最完整，直接继承分支 Attempt、Region Diff 和最终发布 | 改动面跨 Python/TS/运行环境，重复 Procedura 已有循环，首版会被基础设施淹没 |
| B. 通过深的 `MeshEvidence` 模块接入 VoxBlame，保留 Procedura direct-refine | 最小改动获得固定坐标、Repair Targets、最佳候选和最终验证；几何复杂性保持局部 | 首版依赖外部 `mesh-compare` 安装；没有 Region Diff 和分支搜索 |
| C. 在 TypeScript 中重写 VoxBlame/体素占用 | 单语言、部署表面小 | 难以证明与原算法等价，会重新制造原生加速、格式和数值契约 |

**采用：B。** 外部 seam 放在 `src/mesh/mesh-evidence.ts`：调用者只学习“准备参考、测量候选、比较候选、验证最终重建”四项行为，子进程参数、候选变换、分页、证据目录和错误解析均隐藏在模块实现中。方案 A 的 Workspace/发布能力只有在垂直切片证明质量收益后才有迁移价值；方案 C 没有合理的首版验证路径。

## 阶段化路线与验收门

采用四个实现阶段。每阶段只在前一阶段验收通过后开始；阶段完成时更新本文的状态表并向用户提交真实产物，用户确认后才进入下一阶段。阶段失败只修复本阶段，不提前实现后续能力。

| 阶段 | 从浅到深的能力 | 用户可观察产物 | 验收门 | 当前状态 |
|---|---|---|---|---|
| Phase 1：四阶段垂直切片 | Plan 1 导入/Viewer、Plan 1B 多格式规范化、Plan 2 受控观察、Plan 3 开放环生成 | 从 [`2026-08-30-mesh-to-cad-reference-viewer.md`](./2026-08-30-mesh-to-cad-reference-viewer.md) 开始 | 四份计划逐一验收，Plan 1B 通过后第一阶段才具备完整六格式合同 | **Plan 1 done; Plan 1B pending** |
| Phase 2：开放环 Mesh→SCAD 基线 | 用 contact sheet 驱动现有 incremental draft，生成参数化 SCAD；只测量 Step 0，不根据证据修改 | `draft.scad`、`draft.obj/.stl`、`steps/000000.json`、VoxBlame Step 0 | SCAD 可重新编译；候选 frame 已冻结；Step 0 含完整 missing/excess/exterior 和全部 Repair Targets | **Blocked by Phase 1** |
| Phase 3：客观证据修复闭环 | 将当前 Measured Step 注入 critic/patch，每个通过门的修改形成有 parent 的新 step | `steps/000001.json` 及后续 step、每轮 SCAD/诊断、分数轨迹 | `--max-steps 1` 至少形成合法 Step 0→1 或明确无修改；视觉 clean 不能覆盖客观未接受；普通 Procedura 不受影响 | **Blocked by Phase 2** |
| Phase 4：最佳候选与可信交付 | 从全部 step 选择最优源码，重新编译并验证，补齐正式 CLI、配置和说明 | `selected.scad`、`selection.json`、`final.scad/.obj/.stl`、`final-verification.json` | 人为构造后一步变差时仍选择较早 step；最终重建验证成功；端到端与普通流程回归通过 | **Blocked by Phase 3** |

后续 Phase 复用前一 Phase 已实现的模块与 Interface，但验收运行使用新的输出目录或 `--redo` 从头执行；首版不把“跨命令继续一个已有 Measured Step 图”混入阶段化方案。

### Phase 1：受控观察闭环（已迁移）

旧的“参考网格证据”阶段已被废止。新的 Phase 1 依次由 [`Plan 1：私有导入与 Viewer`](./2026-08-30-mesh-to-cad-reference-viewer.md)、[`Plan 1B：多格式导入与 Z-up 规范化`](./2026-08-30-mesh-to-cad-multiformat-normalization.md)、[`Plan 2：受控观察与 Brief`](./2026-08-30-mesh-to-cad-controlled-observation.md) 和 [`Plan 3：开放环 CAD 生成`](./2026-08-30-mesh-to-cad-generation.md) 定义；本文件不再重复实现细节。Plan 1 的 frozen planned/final patch 是不可修改的审计检查点；Plan 1B 未验收前，第一阶段仍未完成。

### Phase 2：开放环 Mesh→SCAD 基线

**输入：** Phase 1 已准备的参考、可选文本提示和现有 incremental draft。

**实现：** 增加 `runMeshToCad` 编排和 Mesh-to-CAD CLI 草拟路径；contact sheet 作为唯一视觉参考，不调用图片生成；草拟完成后冻结 Step 0 candidate frame，发布一次测量并读取全部 Repair Target 页。此阶段明确跳过 mesh-guided refine。

**验收：** 用小型机械零件运行一次低预算草拟；重新编译 `draft.scad`；查看 `reference.png` 与 draft 预览；确认 `candidate-frame.json`、Step 0 summary、聚合 targets 和 exterior alerts。普通 `procedura --no-refine` 冒烟不产生 `_mesh_to_cad/`。

**完成标准：** 用户已经得到第一个可编辑的 Mesh→SCAD 基线，并能量化它离参考有多远；还没有自动依据误差修复。

### Phase 3：客观证据修复闭环

**输入：** Phase 2 已证明的开放环能力和 direct-refine 预算；在一个 fresh/`--redo` 运行中重新产生 draft 与 Step 0 后继续。

**实现：** 在 `runDirectRefine` 的现有固定循环中可选注入 `MeshEvidence`；每个通过语法、编译和 facet 门的 patch 都测量成显式 parent step；critic 和 patcher获得当前证据；客观 accepted 才允许提前完成。此阶段先沿单一路径继续迭代，尚不做最佳历史候选回选。

**验收：** `--max-steps 1` 产生 Step 0→1，或留下“模型未提出可接受修改”的清晰结果；核对 parent、分数变化和 prompt 留档；构造“视觉无 HIGH 但 missing/excess 非零”场景，确认循环不会错误宣布接受。

**完成标准：** 用户可以看到自动修改是否真实降低了网格误差，并逐步追溯每次修复；最终交付暂时仍是当前路径末端。

### Phase 4：最佳候选与可信交付

**输入：** Phase 3 已证明的闭环能力；在同一次 fresh/`--redo` 运行中产生的全部 Measured Steps 和对应 SCAD 缓冲区。

**实现：** 增加稳定客观排序、最优历史源码保留、`selected.scad`、最终 clean rebuild、`voxblame-verify`、正式 CLI/README/env 说明和失败语义。相同分数保留更早 step。

**验收：** 选取一个后续 step 变差的真实运行，确认 final 回选较早 step；比较 `selected.scad` 与 `final.scad`；检查 verification；执行类型检查、两个 CLI help、外部依赖失败场景和普通图片 Procedura 回归。

**完成标准：** 首版 Mesh-to-SCAD 可以可信交付；此时才可把功能称为完成。STEP、Region Diff、分支搜索和断点续跑仍是后续独立路线；六种输入格式已由 Plan 1B 完成，其他未列格式必须明确拒绝。

## Code Diff

```diff
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@
   "scripts": {
     "setup": "bash scripts/install-deps.sh",
     "typecheck": "tsc --noEmit",
     "procedura": "bun run scripts/procedura.ts",
+    "mesh-to-cad": "bun run scripts/mesh-to-cad.ts",
     "paint": "bun run scripts/paint.ts",

diff --git a/.env.example b/.env.example
--- a/.env.example
+++ b/.env.example
@@
 # Blender, for the AO / parts-colour / PBR renders the critic looks at.
 # PROCEDURA_BLENDER_PATH=/usr/local/bin/blender
+
+# Mesh-to-CAD geometry evidence. Both are required only by `bun run mesh-to-cad`.
+# Point them at a Text-to-CAD environment containing the native meshscope build
+# and at the public mesh-compare CLI directory respectively.
+# PROCEDURA_MESH_COMPARE_PYTHON=/path/to/text-to-cad/.venv/bin/python
+# PROCEDURA_MESH_COMPARE_CLI=/path/to/text-to-cad/skills/mesh-compare/scripts/mesh-compare

diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@
 ### The default run
@@
 bun run scripts/procedura.ts -o outputs/daybed \
   --prompt "a brutalist brass daybed with tapered legs"
 ```
+
+### Mesh to editable SCAD
+
+Mesh-to-CAD uses the same incremental authoring and direct-refine loop, but
+takes a 3D mesh as the geometric reference and uses VoxBlame evidence to choose
+the best reconstruction. Configure `PROCEDURA_MESH_COMPARE_PYTHON` and
+`PROCEDURA_MESH_COMPARE_CLI`, then run:
+
+```bash
+bun run mesh-to-cad --mesh reference.stl -o outputs/reference-cad \
+  --prompt "reconstruct the object as an editable mechanical assembly"
+```
+
+Use `--prepare-only` to validate and inspect the canonical reference and seven
+fixed views without making any LLM call.
+Use `--no-mesh-refine` to retain an open-loop draft baseline with Step 0
+measurement but no evidence-guided repair.
+
+The first version accepts CAD Z-up STL and OBJ and writes `final.scad`, the
+normal Procedura mesh outputs, and `_mesh_to_cad/` measurement and verification
+evidence. It does not produce STEP.

diff --git a/scripts/_compose_mesh_reference.py b/scripts/_compose_mesh_reference.py
new file mode 100644
--- /dev/null
+++ b/scripts/_compose_mesh_reference.py
@@
+#!/usr/bin/env python3
+"""Compose labeled Procedura mesh-reference views into one PNG."""
+
+from __future__ import annotations
+
+import argparse
+from pathlib import Path
+
+from PIL import Image, ImageDraw
+
+
+def main() -> int:
+    parser = argparse.ArgumentParser()
+    parser.add_argument("--output", type=Path, required=True)
+    parser.add_argument("views", nargs="+")
+    args = parser.parse_args()
+    if len(args.views) != 7:
+        raise SystemExit("exactly seven label=path views are required")
+
+    parsed: list[tuple[str, Image.Image]] = []
+    for token in args.views:
+        label, separator, raw_path = token.partition("=")
+        if not separator or not label or not raw_path:
+            raise SystemExit(f"invalid view token: {token}")
+        parsed.append((label, Image.open(raw_path).convert("RGB")))
+
+    tile = 512
+    label_height = 32
+    canvas = Image.new("RGB", (tile * 4, (tile + label_height) * 2), "black")
+    draw = ImageDraw.Draw(canvas)
+    for index, (label, image) in enumerate(parsed):
+        image.thumbnail((tile, tile))
+        column = index % 4
+        row = index // 4
+        x = column * tile + (tile - image.width) // 2
+        y = row * (tile + label_height) + label_height + (tile - image.height) // 2
+        canvas.paste(image, (x, y))
+        draw.text((column * tile + 12, row * (tile + label_height) + 8), label, fill="white")
+
+    args.output.parent.mkdir(parents=True, exist_ok=True)
+    canvas.save(args.output, format="PNG")
+    return 0
+
+
+if __name__ == "__main__":
+    raise SystemExit(main())

diff --git a/src/mesh/mesh-evidence.ts b/src/mesh/mesh-evidence.ts
new file mode 100644
--- /dev/null
+++ b/src/mesh/mesh-evidence.ts
@@
+import {
+  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
+} from "node:fs";
+import { dirname, extname, join, resolve } from "node:path";
+
+import { renderAOViews } from "../render/ao.ts";
+import { loadSTL, computeBBox, transformInPlace, writeSTL } from "./stl.ts";
+
+const REFERENCE_VIEWS = [
+  "front", "back", "left", "right", "top", "bottom", "isometric",
+] as const;
+const SUPPORTED = new Set([".stl", ".obj"]);
+const COMPOSER = resolve(dirname(new URL(import.meta.url).pathname), "../../scripts/_compose_mesh_reference.py");
+
+type Json = Record<string, unknown>;
+
+interface CandidateFrame {
+  center: [number, number, number];
+  scale: number;
+}
+
+export interface MeshRepairTarget {
+  targetKey: string;
+  kind: string;
+  bounds: { min: number[]; max: number[] };
+  missing: number;
+  excess: number;
+}
+
+export interface MeshMeasurement {
+  step: number;
+  parentStep: number | null;
+  missing: number;
+  excess: number;
+  exterior: number;
+  score: number;
+  accepted: boolean;
+  activeDepth: number | null;
+  targets: MeshRepairTarget[];
+  alerts: Record<string, unknown>[];
+  summaryPath: string;
+  candidatePath: string;
+}
+
+export interface MeshEvidence {
+  readonly rootDir: string;
+  evaluate(candidateStlPath: string, step: number, parentStep: number | null): Promise<MeshMeasurement>;
+  isBetter(candidate: MeshMeasurement, incumbent: MeshMeasurement): boolean;
+  prompt(measurement: MeshMeasurement): string;
+  verify(candidateStlPath: string, selected: MeshMeasurement): Promise<string>;
+}
+
+export interface PreparedMeshReference {
+  evidence: MeshEvidence;
+  contactSheetPath: string;
+}
+
+function configuredCommand(): { python: string; cli: string } {
+  const python = process.env["PROCEDURA_MESH_COMPARE_PYTHON"];
+  const cli = process.env["PROCEDURA_MESH_COMPARE_CLI"];
+  if (!python || !cli) {
+    throw new Error(
+      "Mesh-to-CAD requires PROCEDURA_MESH_COMPARE_PYTHON and " +
+      "PROCEDURA_MESH_COMPARE_CLI",
+    );
+  }
+  if (!existsSync(python)) throw new Error(`mesh-compare Python not found: ${python}`);
+  if (!existsSync(cli)) throw new Error(`mesh-compare CLI not found: ${cli}`);
+  return { python: resolve(python), cli: resolve(cli) };
+}
+
+async function runJson(command: readonly string[], label: string): Promise<Json> {
+  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
+  const [stdout, stderr, exitCode] = await Promise.all([
+    new Response(proc.stdout).text(),
+    new Response(proc.stderr).text(),
+    proc.exited,
+  ]);
+  let value: Json | null = null;
+  try { value = JSON.parse(stdout.trim()) as Json; } catch { value = null; }
+  if (exitCode !== 0 || value?.["ok"] !== true) {
+    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
+    throw new Error(`${label} failed: ${detail.slice(0, 2000)}`);
+  }
+  return value;
+}
+
+async function runProcess(command: readonly string[], label: string): Promise<void> {
+  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
+  const [stdout, stderr, exitCode] = await Promise.all([
+    new Response(proc.stdout).text(),
+    new Response(proc.stderr).text(),
+    proc.exited,
+  ]);
+  if (exitCode !== 0) {
+    const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
+    throw new Error(`${label} failed: ${detail.slice(0, 2000)}`);
+  }
+}
+
+function asObject(value: unknown, label: string): Json {
+  if (value === null || typeof value !== "object" || Array.isArray(value)) {
+    throw new Error(`invalid mesh evidence: ${label}`);
+  }
+  return value as Json;
+}
+
+function asNumber(value: unknown, label: string): number {
+  if (typeof value !== "number" || !Number.isFinite(value)) {
+    throw new Error(`invalid mesh evidence: ${label}`);
+  }
+  return value;
+}
+
+class CliMeshEvidence implements MeshEvidence {
+  readonly rootDir: string;
+  private readonly python: string;
+  private readonly cli: string;
+  private readonly inputDir: string;
+  private readonly voxDir: string;
+  private readonly framePath: string;
+
+  constructor(rootDir: string, command: { python: string; cli: string }) {
+    this.rootDir = rootDir;
+    this.python = command.python;
+    this.cli = command.cli;
+    this.inputDir = join(rootDir, "input");
+    this.voxDir = join(rootDir, "voxblame");
+    this.framePath = join(rootDir, "candidate-frame.json");
+  }
+
+  private candidateFrame(stlPath: string): CandidateFrame {
+    if (existsSync(this.framePath)) {
+      return JSON.parse(readFileSync(this.framePath, "utf8")) as CandidateFrame;
+    }
+    const bounds = computeBBox(loadSTL(stlPath));
+    const longest = Math.max(...bounds.size);
+    if (longest <= 0) throw new Error("Step 0 candidate has zero-size bounds");
+    const frame: CandidateFrame = {
+      center: [
+        (bounds.min[0] + bounds.max[0]) / 2,
+        (bounds.min[1] + bounds.max[1]) / 2,
+        (bounds.min[2] + bounds.max[2]) / 2,
+      ],
+      scale: 1 / longest,
+    };
+    writeFileSync(this.framePath, JSON.stringify(frame, null, 2) + "\n", "utf8");
+    return frame;
+  }
+
+  private canonicalCandidate(source: string, step: number): string {
+    const frame = this.candidateFrame(source);
+    const mesh = loadSTL(source);
+    transformInPlace(mesh, frame.center, frame.scale);
+    const output = join(this.rootDir, "candidates", `${String(step).padStart(6, "0")}.stl`);
+    mkdirSync(dirname(output), { recursive: true });
+    writeSTL(output, mesh);
+    return output;
+  }
+
+  async evaluate(
+    candidateStlPath: string, step: number, parentStep: number | null,
+  ): Promise<MeshMeasurement> {
+    const candidatePath = this.canonicalCandidate(candidateStlPath, step);
+    const command = [
+      this.python, this.cli, "voxblame-measure", candidatePath,
+      "--reference", this.inputDir, "--output", this.voxDir,
+      "--step", String(step),
+      ...(parentStep === null ? [] : ["--compare-to", String(parentStep)]),
+    ];
+    await runJson(command, `VoxBlame step ${step}`);
+
+    const summaryPath = join(this.voxDir, "steps", String(step).padStart(6, "0"), "summary.json");
+    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Json;
+    const depths = summary["errors_by_depth"];
+    if (!Array.isArray(depths) || depths.length !== 8) {
+      throw new Error("invalid mesh evidence: errors_by_depth");
+    }
+    const depth8 = asObject(depths[7], "depth 8");
+    const missing = asNumber(depth8["missing_surface_count"], "missing count");
+    const excess = asNumber(depth8["excess_surface_count"], "excess count");
+    const exteriorDoc = asObject(summary["exterior_surface"], "exterior surface");
+    const exterior = asNumber(exteriorDoc["surface_cell_count"], "exterior count");
+    const facts = asObject(summary["objective_facts"], "objective facts");
+
+    const targets: MeshRepairTarget[] = [];
+    const alerts: Record<string, unknown>[] = [];
+    let activeDepth: number | null = null;
+    let offset: number | null = 0;
+    while (offset !== null) {
+      const page = await runJson([
+        this.python, this.cli, "voxblame-targets", "--output", this.voxDir,
+        "--step", String(step), "--offset", String(offset),
+      ], `VoxBlame targets step ${step}`);
+      const frontier = asObject(page["repair_frontier"], "repair frontier");
+      const depth = frontier["active_depth"];
+      activeDepth = depth === null ? null : asNumber(depth, "active depth");
+      const pageAlerts = page["alerts"];
+      if (!Array.isArray(pageAlerts)) throw new Error("invalid mesh evidence: alerts");
+      if (offset === 0) alerts.push(...pageAlerts.map((value) => asObject(value, "alert")));
+      const repairTargets = asObject(page["repair_targets"], "repair targets");
+      const items = repairTargets["items"];
+      if (!Array.isArray(items)) throw new Error("invalid mesh evidence: target items");
+      for (const itemValue of items) {
+        const item = asObject(itemValue, "repair target");
+        const profile = asObject(item["error_profile"], "target error profile");
+        targets.push({
+          targetKey: String(item["target_key"]),
+          kind: String(item["kind"]),
+          bounds: asObject(item["bounds_canonical"], "target bounds") as unknown as { min: number[]; max: number[] },
+          missing: asNumber(profile["missing_surface_count"], "target missing"),
+          excess: asNumber(profile["excess_surface_count"], "target excess"),
+        });
+      }
+      const next = repairTargets["next_offset"];
+      offset = next === null ? null : asNumber(next, "next target offset");
+    }
+
+    const measurement: MeshMeasurement = {
+      step, parentStep, missing, excess, exterior,
+      score: missing + excess + exterior,
+      accepted: facts["global_depth_8_zero"] === true
+        && facts["out_of_frame_clear"] === true
+        && facts["no_evidence_conflict"] === true,
+      activeDepth, targets, alerts, summaryPath, candidatePath,
+    };
+    writeFileSync(
+      join(this.rootDir, "steps", `${String(step).padStart(6, "0")}.json`),
+      JSON.stringify(measurement, null, 2) + "\n", "utf8",
+    );
+    return measurement;
+  }
+
+  isBetter(candidate: MeshMeasurement, incumbent: MeshMeasurement): boolean {
+    return candidate.score < incumbent.score;
+  }
+
+  prompt(measurement: MeshMeasurement): string {
+    const targets = measurement.targets.slice(0, 8).map((target, index) =>
+      `${index + 1}. ${target.kind} bounds=${JSON.stringify(target.bounds)} ` +
+      `missing=${target.missing} excess=${target.excess}`,
+    ).join("\n");
+    return [
+      "=== OBJECTIVE MESH EVIDENCE ===",
+      `Measured Step: ${measurement.step}; parent: ${measurement.parentStep ?? "none"}`,
+      `Depth-8 missing=${measurement.missing}, excess=${measurement.excess}, exterior=${measurement.exterior}`,
+      `Active repair depth=${measurement.activeDepth ?? "none"}; accepted=${measurement.accepted}`,
+      `Exterior alerts=${JSON.stringify(measurement.alerts)}`,
+      "Repair Targets are geometric facts, not edit instructions. Address the highest-impact coherent target.",
+      targets || "No interior Repair Targets remain.",
+    ].join("\n");
+  }
+
+  async verify(candidateStlPath: string, selected: MeshMeasurement): Promise<string> {
+    const mesh = loadSTL(candidateStlPath);
+    const frame = this.candidateFrame(candidateStlPath);
+    transformInPlace(mesh, frame.center, frame.scale);
+    const candidate = join(this.rootDir, "final-canonical.stl");
+    writeSTL(candidate, mesh);
+    const output = join(this.rootDir, "final-verification.json");
+    await runJson([
+      this.python, this.cli, "voxblame-verify", candidate,
+      "--reference", this.inputDir, "--workspace", this.voxDir,
+      "--against-step", String(selected.step), "--output", output,
+    ], "VoxBlame final verification");
+    writeFileSync(
+      join(this.rootDir, "selection.json"),
+      JSON.stringify({ selectedStep: selected.step, score: selected.score }, null, 2) + "\n",
+      "utf8",
+    );
+    return output;
+  }
+}
+
+export async function prepareMeshReference(args: {
+  meshPath: string;
+  outputDir: string;
+  redo?: boolean;
+}): Promise<PreparedMeshReference> {
+  const source = resolve(args.meshPath);
+  if (!existsSync(source)) throw new Error(`reference mesh not found: ${source}`);
+  if (!SUPPORTED.has(extname(source).toLowerCase())) {
+    throw new Error("Mesh-to-CAD accepts only CAD Z-up STL and OBJ in the first version");
+  }
+  const command = configuredCommand();
+  const rootDir = join(resolve(args.outputDir), "_mesh_to_cad");
+  if (args.redo) rmSync(rootDir, { recursive: true, force: true });
+  const sessionPath = join(rootDir, "session.json");
+  if (existsSync(sessionPath)) {
+    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as Json;
+    if (session["source"] !== source) {
+      throw new Error("output dir was prepared for a different mesh; use a new dir or --redo");
+    }
+    if (existsSync(join(rootDir, "voxblame", "steps"))) {
+      throw new Error("Mesh-to-CAD reconstruction resume is not implemented; use --redo");
+    }
+    const contactSheetPath = String(session["contactSheetPath"]);
+    if (!existsSync(contactSheetPath)) throw new Error("prepared reference image is missing");
+    return { evidence: new CliMeshEvidence(rootDir, command), contactSheetPath };
+  }
+  mkdirSync(join(rootDir, "steps"), { recursive: true });
+
+  await runJson([
+    command.python, command.cli, "voxblame-prepare-reference", source,
+    "--output", join(rootDir, "input"),
+  ], "VoxBlame reference preparation");
+
+  const viewsDir = join(rootDir, "reference-views");
+  const rendered = await renderAOViews({
+    stlPath: source, outDir: viewsDir, views: [...REFERENCE_VIEWS],
+    size: 768, samples: 32, aoSamples: 8,
+  });
+  if (!rendered.ok) throw new Error(`reference render failed: ${rendered.error}`);
+  const contactSheetPath = join(rootDir, "reference.png");
+  const byName = new Map(rendered.views.map((view) => [view.view, view.path]));
+  await runProcess([
+    command.python, COMPOSER, "--output", contactSheetPath,
+    ...REFERENCE_VIEWS.map((name) => `${name}=${byName.get(name)}`),
+  ], "reference contact sheet");
+  writeFileSync(
+    sessionPath,
+    JSON.stringify({ schema: "procedura.mesh-to-cad/1", source, contactSheetPath }, null, 2) + "\n",
+    "utf8",
+  );
+  return { evidence: new CliMeshEvidence(rootDir, command), contactSheetPath };
+}

diff --git a/src/pipeline/refine.ts b/src/pipeline/refine.ts
--- a/src/pipeline/refine.ts
+++ b/src/pipeline/refine.ts
@@
 import { renderAOViews } from "../render/ao.ts";
+import type { MeshEvidence } from "../mesh/mesh-evidence.ts";
@@
 export interface RefineOpts {
   outputDir: string;
+  /** Optional fixed-frame mesh evidence used only by direct refine. */
+  meshEvidence?: MeshEvidence;

diff --git a/src/pipeline/refine-direct.ts b/src/pipeline/refine-direct.ts
--- a/src/pipeline/refine-direct.ts
+++ b/src/pipeline/refine-direct.ts
@@
 import type { RefineOpts, RefineResult } from "./refine.ts";
+import type { MeshMeasurement } from "../mesh/mesh-evidence.ts";
@@
   let accepted = 0;
   let llmCalls = 0;
+  let currentEvidence: MeshMeasurement | null = null;
+  let bestEvidence: MeshMeasurement | null = null;
+  let bestScad = state.scad;
@@
     if (builtStl === null) {
@@
       }
     }
+    if (opts.meshEvidence && currentEvidence === null) {
+      currentEvidence = await opts.meshEvidence.evaluate(builtStl, 0, null);
+      bestEvidence = currentEvidence;
+      bestScad = state.scad;
+    }
+    if (currentEvidence?.accepted) {
+      log(`  objective mesh evidence is accepted — finishing`);
+      verdict = "ok";
+      break;
+    }
@@
     const criticParts: CanonicalPart[] = [
       { kind: "text", text: buildDiagnoseLeadText(state, { fixerHasTools: false }) },
       ...referenceParts,
     ];
+    if (opts.meshEvidence && currentEvidence) {
+      criticParts.push({ kind: "text", text: opts.meshEvidence.prompt(currentEvidence) });
+    }
@@
-    if (!hasHighIssue(diagnosis)) {
+    if (!hasHighIssue(diagnosis) && (!currentEvidence || currentEvidence.accepted)) {
       log(`  no HIGH issues remain — finishing`);
       verdict = "ok";
       break;
     }
+    if (!hasHighIssue(diagnosis) && currentEvidence && !currentEvidence.accepted) {
+      log(`  visual critic is clean, but objective mesh errors remain — continuing from Repair Targets`);
+    }
@@
       patchParts.push({
         kind: "text",
         text:
           `=== REVIEWER DIAGNOSIS (cycle ${cycle}) ===\n${diagnosis}\n\n` +
-          (measurements ? measurements + "\n" : ""),
+          (measurements ? measurements + "\n" : "") +
+          (opts.meshEvidence && currentEvidence
+            ? "\n" + opts.meshEvidence.prompt(currentEvidence) + "\n"
+            : ""),
       });
@@
       if (facetsBefore !== null && facetsAfter !== null && facetsAfter < facetsBefore * floor) {
@@
         continue;
       }
+
+      const nextEvidence = opts.meshEvidence
+        ? await opts.meshEvidence.evaluate(
+            stlPath,
+            (currentEvidence?.step ?? -1) + 1,
+            currentEvidence?.step ?? null,
+          )
+        : null;
 
       // Accepted.
@@
       accepted += 1;
       landed = true;
+      if (nextEvidence) {
+        currentEvidence = nextEvidence;
+        if (!bestEvidence || opts.meshEvidence!.isBetter(nextEvidence, bestEvidence)) {
+          bestEvidence = nextEvidence;
+          bestScad = applied.scad;
+        }
+      }
@@
   }
 
   // ── Finalize. The buffer is whatever survived; write the deliverables. ──
+  if (bestEvidence) {
+    if (bestEvidence.accepted) verdict = "ok";
+    state.scad = bestScad;
+    state.lastGoodScad = bestScad;
+    writeFileSync(join(opts.meshEvidence!.rootDir, "selected.scad"), bestScad, "utf8");
+    log(`  selected Measured Step ${bestEvidence.step} with score ${bestEvidence.score}`);
+  }
@@
   const writeResult = await writeFinalOutputs(workspace, state, {
     verdict,
-    summary: `${accepted} accepted edit(s) over ${llmCalls} LLM call(s). ${summary}`,
+    summary: `${accepted} accepted edit(s) over ${llmCalls} LLM call(s). ${summary}` +
+      (bestEvidence ? ` Selected mesh step ${bestEvidence.step}, score ${bestEvidence.score}.` : ""),
   }, exportStl);
+  if (opts.meshEvidence && bestEvidence) {
+    const verifyBuild = await compileScad(state.scad, {
+      outputDir: join(opts.meshEvidence.rootDir, "final-rebuild"),
+    });
+    await opts.meshEvidence.verify(verifyBuild.stlPath, bestEvidence);
+  }

diff --git a/src/pipeline/procedura.ts b/src/pipeline/procedura.ts
--- a/src/pipeline/procedura.ts
+++ b/src/pipeline/procedura.ts
@@
 import { renderAOViews } from "../render/ao.ts";
+import type { MeshEvidence } from "../mesh/mesh-evidence.ts";
@@
 export interface RunProceduraOpts {
@@
   signal?: AbortSignal;
+  /** Internal Mesh-to-CAD seam; normal text/image callers omit it. */
+  meshEvidence?: MeshEvidence;
@@
       const refineMode = process.env["PROCEDURA_REFINE_MODE"] === "agent" ? "agent" : "direct";
+      if (opts.meshEvidence && refineMode !== "direct") {
+        throw new Error("Mesh-to-CAD requires the direct refine implementation");
+      }
@@
       refineResult = await refineImpl({
         outputDir: outDir,
+        ...(opts.meshEvidence !== undefined ? { meshEvidence: opts.meshEvidence } : {}),

diff --git a/src/pipeline/mesh-to-cad.ts b/src/pipeline/mesh-to-cad.ts
new file mode 100644
--- /dev/null
+++ b/src/pipeline/mesh-to-cad.ts
@@
+import { readFileSync } from "node:fs";
+import { join, resolve } from "node:path";
+
+import { prepareMeshReference } from "../mesh/mesh-evidence.ts";
+import { compileScad } from "../scad/compile.ts";
+import { runProcedura, type RunProceduraResult } from "./procedura.ts";
+
+export interface RunMeshToCadOpts {
+  meshPath: string;
+  outputDir: string;
+  text?: string;
+  maxSteps?: number;
+  agentModel?: string;
+  scadModel?: string;
+  redo?: boolean;
+  exportStl?: boolean;
+  meshRefine?: boolean;
+  signal?: AbortSignal;
+}
+
+export interface RunMeshToCadResult extends RunProceduraResult {
+  evidenceDir: string;
+}
+
+export async function runMeshToCad(opts: RunMeshToCadOpts): Promise<RunMeshToCadResult> {
+  const outputDir = resolve(opts.outputDir);
+  const prepared = await prepareMeshReference({
+    meshPath: opts.meshPath,
+    outputDir,
+    ...(opts.redo ? { redo: true } : {}),
+  });
+  const text = opts.text?.trim()
+    || "Reconstruct the supplied mesh faithfully as an editable, part-structured OpenSCAD model.";
+  const meshRefine = opts.meshRefine ?? true;
+  const result = await runProcedura({
+    text,
+    outputDir,
+    inputImage: prepared.contactSheetPath,
+    incremental: true,
+    refine: meshRefine,
+    ...(meshRefine ? { meshEvidence: prepared.evidence } : {}),
+    exportStl: opts.exportStl ?? true,
+    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
+    ...(opts.agentModel !== undefined ? { agentModel: opts.agentModel } : {}),
+    ...(opts.scadModel !== undefined ? { scadModel: opts.scadModel } : {}),
+    ...(opts.redo ? { redo: true } : {}),
+    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
+  });
+  if (!meshRefine) {
+    const baseline = await compileScad(readFileSync(result.refine.outputs.scadPath, "utf8"), {
+      outputDir: join(prepared.evidence.rootDir, "baseline-build"),
+    });
+    await prepared.evidence.evaluate(baseline.stlPath, 0, null);
+  }
+  return { ...result, evidenceDir: prepared.evidence.rootDir };
+}

diff --git a/scripts/mesh-to-cad.ts b/scripts/mesh-to-cad.ts
new file mode 100755
--- /dev/null
+++ b/scripts/mesh-to-cad.ts
@@
+#!/usr/bin/env bun
+
+import { readFileSync } from "node:fs";
+
+import { prepareMeshReference } from "../src/mesh/mesh-evidence.ts";
+import { runMeshToCad } from "../src/pipeline/mesh-to-cad.ts";
+
+interface Args {
+  meshPath: string;
+  outputDir: string;
+  prompt?: string;
+  promptFile?: string;
+  maxSteps?: number;
+  agentModel?: string;
+  scadModel?: string;
+  redo: boolean;
+  exportStl: boolean;
+  prepareOnly: boolean;
+  meshRefine: boolean;
+}
+
+function help(): never {
+  console.log(`
+Procedura Mesh-to-CAD
+
+Usage:
+  bun run mesh-to-cad --mesh reference.stl -o outputs/reference-cad [options]
+
+Options:
+  --mesh PATH         CAD Z-up reference STL or OBJ
+  -o, --output DIR    output directory
+  --prompt TEXT       optional semantic/engineering guidance
+  --prompt-file PATH  read guidance from a UTF-8 file
+  --max-steps N       mesh-guided refine budget (default 6)
+  --agent-model M     critic/patch model
+  --scad-model M      plan/draft model
+  --redo              discard this output's old Mesh-to-CAD evidence and rebuild
+  --prepare-only      prepare and render the reference without calling an LLM
+  --no-mesh-refine    generate and measure the open-loop baseline; do not repair it
+  --no-export-stl     omit the top-level STL deliverable
+`);
+  process.exit(0);
+}
+
+function parse(argv: string[]): Args {
+  const args: Args = {
+    meshPath: "", outputDir: "", redo: false, exportStl: true,
+    prepareOnly: false, meshRefine: true,
+  };
+  for (let i = 0; i < argv.length; i++) {
+    const token = argv[i]!;
+    if (token === "--mesh") { args.meshPath = argv[++i]!; continue; }
+    if (token === "-o" || token === "--output") { args.outputDir = argv[++i]!; continue; }
+    if (token === "--prompt") { args.prompt = argv[++i]!; continue; }
+    if (token === "--prompt-file") { args.promptFile = argv[++i]!; continue; }
+    if (token === "--max-steps") { args.maxSteps = Number(argv[++i]!); continue; }
+    if (token === "--agent-model") { args.agentModel = argv[++i]!; continue; }
+    if (token === "--scad-model") { args.scadModel = argv[++i]!; continue; }
+    if (token === "--redo") { args.redo = true; continue; }
+    if (token === "--prepare-only") { args.prepareOnly = true; continue; }
+    if (token === "--no-mesh-refine") { args.meshRefine = false; continue; }
+    if (token === "--no-export-stl") { args.exportStl = false; continue; }
+    if (token === "-h" || token === "--help") help();
+    throw new Error(`unknown flag: ${token}`);
+  }
+  if (!args.meshPath || !args.outputDir) help();
+  if (args.prompt && args.promptFile) throw new Error("use --prompt or --prompt-file, not both");
+  if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1)) {
+    throw new Error("--max-steps must be a positive integer");
+  }
+  return args;
+}
+
+const args = parse(process.argv.slice(2));
+if (args.prepareOnly) {
+  const prepared = await prepareMeshReference({
+    meshPath: args.meshPath,
+    outputDir: args.outputDir,
+    ...(args.redo ? { redo: true } : {}),
+  });
+  console.log(`Mesh reference prepared: ${prepared.contactSheetPath}`);
+  process.exit(0);
+}
+const text = args.prompt ?? (args.promptFile ? readFileSync(args.promptFile, "utf8").trim() : undefined);
+const result = await runMeshToCad({
+  meshPath: args.meshPath,
+  outputDir: args.outputDir,
+  exportStl: args.exportStl,
+  meshRefine: args.meshRefine,
+  ...(text ? { text } : {}),
+  ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
+  ...(args.agentModel !== undefined ? { agentModel: args.agentModel } : {}),
+  ...(args.scadModel !== undefined ? { scadModel: args.scadModel } : {}),
+  ...(args.redo ? { redo: true } : {}),
+});
+console.log(`\nMesh-to-CAD complete`);
+console.log(`  SCAD:     ${result.refine.outputs.scadPath}`);
+console.log(`  evidence: ${result.evidenceDir}`);
+process.exit(result.refine.outputs.objPath ? 0 : 1);
```

## 实现步骤

- [ ] Phase 1：依次批准、实现和验收 Plan 1、[`Plan 1B：多格式导入与 Z-up 规范化`](./2026-08-30-mesh-to-cad-multiformat-normalization.md)、Plan 2、Plan 3；Plan 1 已完成，Plan 1B 待处理，本文件不再维护重复实现清单。
- [ ] Phase 2：实现 `runMeshToCad` 的开放环 incremental draft、Step 0 frame 与一次完整测量。输入：Phase 1 参考和可选提示；验证：低预算真实草拟、SCAD clean rebuild、Step 0 summary/targets/alerts、普通 `procedura --no-refine` 回归；完成标准：用户验收首个可编辑基线及其客观误差后更新状态表，并停止。
- [ ] Phase 3：在 `runDirectRefine` 接入当前 MeshEvidence，发布显式 parent 的线性 Measured Steps。输入：Phase 2 draft/Step 0 和修复预算；验证：`--max-steps 1` ancestry、视觉 clean/客观未接受场景、外部证据失败、普通 Procedura 隔离；完成标准：用户能逐步核对自动修复及分数变化后更新状态表，并停止。
- [ ] Phase 4：实现历史最佳候选、selected source、clean rebuild、最终 verify、正式 CLI/配置/说明。输入：Phase 3 全部 steps；验证：后续退化回选、`selected.scad`/`final.scad` 一致、verification、类型检查、CLI help、端到端和普通图片回归；完成标准：所有用户可观察产物齐备，四阶段状态均 Complete，才把首版标记完成。

## 接口与兼容性

- 新增用户入口 `bun run mesh-to-cad --mesh PATH -o DIR`；原 `procedura` 入口无新参数、无行为变化。
- `MeshEvidence` 是几何引擎 seam；`runDirectRefine` 只依赖其 Interface，不知道 Python 包路径、命令结构或证据目录布局。
- 首版候选坐标变换由 Step 0 冻结：`(vertex - step0_bbox_center) / step0_longest_extent`。这是一次初始化对齐，不是每轮拟合；后续全局平移和缩放会被客观证据看到。
- `_mesh_to_cad/session.json` 的 schema 为 `procedura.mesh-to-cad/1`；纯参考准备可幂等复用。Measured Step 已存在时不承诺断点续跑，要求明确 `--redo`。
- VoxBlame 文档与其原生校验保持外部依赖所有权；Procedura 只解析公开 JSON 字段，不复制或重写其 schema，也不自行做 SHA 校验。
- 输入支持 STL/OBJ/PLY/GLB/glTF/3MF；Authority 先生成 canonical Z-up/mm binary STL，输出仍以可编辑 SCAD 为主。GLB/glTF/3MF 的转换由 Plan 1B 定义；STEP 输出不在本计划内。

## 测试

根据仓库指令，不新增、修改或运行 unit tests。实施验证仅包括：

- 静态：`bun run typecheck`。
- CLI：两个 `--help` 路径和必填/冲突参数失败场景。
- 依赖失败：缺少两个环境变量、Python 路径不存在、mesh-compare 非零退出、Blender 渲染失败。
- 几何边界：六种受支持格式均规范化为 canonical Z-up/mm，空/零尺寸或不支持格式均被入口拒绝；Step 0 成功但后续候选越界、没有 interior targets 但存在 exterior alert、完全接受候选。
- 回归：同一小型图片输入运行原 `procedura`，确认未创建 `_mesh_to_cad/`，draft/refine 仍完成。
- 端到端：一个低面数机械零件，`--max-steps 1`；验证固定 frame、step ancestry、最佳选择和 final verify 的真实输出。

真实端到端场景会产生模型调用费用，实施前需使用用户已配置的模型端点，并由用户确认可接受一次低预算运行；不需要分支、commit、push 或网络安装授权。

## 风险与回滚

- **初始单张 contact sheet 丢失细节：** 七视图均保留且有标签；若实际模型仍无法解析小格细节，下一阶段再把 draft 扩展为多图片输入，而不是现在扩大现有接口。
- **Step 0 变换固化了错误姿态：** 首版不做旋转/PCA，也不提供 axis/unit override；Plan 1B 按格式标准确定性转换到唯一 CAD Z-up/mm，未知或不支持的格式直接失败，不能静默猜测。
- **VoxBlame 运行成本高：** 只对通过现有编译/facet 门的候选测量，每轮最多一次；`maxSteps` 保持总成本上限。
- **外部 Text-to-CAD 环境漂移：** 两个显式路径让依赖可观察；类型与 JSON 解析失败即停止。证明价值后再决定发布独立 meshscope 包或 vendor 固定版本。
- **客观分数与感知质量不一致：** 分数只负责最佳候选保底和接受事实，critic 仍负责把 Repair Target 转成参数化编辑；保留每一步证据便于人工比较。
- **回滚：** 新功能由独立 CLI 和可选 `meshEvidence` 参数隔离。删除新增四个文件、package/README/env 三处入口和 direct-refine 的可选分支即可完整回滚，普通 Procedura 数据无需迁移。

## 状态

**总体进度：** Design complete；Implementation 0/4。

**当前阶段：** 低侵入完整 Plan 1 已完成并通过 Mode B；下一步是基于其 Final 状态重新校准 Plan 2，完成新的 Planned Patch 与 Mode A 后再请求实施批准。

**推进规则：** 每次只实施一个 Phase；完成本阶段验证、更新状态表并向用户展示验收产物后停止，等待用户明确确认再进入下一阶段。
