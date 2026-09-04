# Plan: Setup-only User Environment Seeding

## 目标与完成标准

让新 worktree 通过现有 `scripts/install-deps.sh` 复用用户级本地配置，而不在任何 CLI 或 pipeline 中增加运行时接缝。安装脚本每次正常运行都读取可选 `$HOME/.secrets/procedura.env`，验证必要的 `export NAME=value` 子集，并重建当前 worktree 的私有 `.env`；已有 `.env` 会被有意覆盖，用户文件不存在时重建为模板。

完成标准：无 `src/config/user-env.ts`、无六个 CLI import diff；setup-only 同步逻辑可在临时 HOME/worktree 中验证首次生成、重复运行覆盖、process env 优先、缺失用户文件和非法行；不复制真实 secret 到 Git，不执行 shell 或变量展开。

## 方案与边界

- 仅修改 `scripts/install-deps.sh`、`.env.example`、`README.md` 和本计划/patch 资产。
- `install-deps.sh` 每次正常运行先完整验证用户文件到权限受限临时文件，再从 `.env.example` 重建 `.env` 并追加声明；process environment 已有的变量不写入，已有 `.env` 不保留。
- 支持空行、注释、`export NAME=value`、单/双引号值；拒绝非法变量名、残余字符、未加引号的空白或 `#`；错误仅含文件和行号，不输出值。
- 现有 Bun dotenv 行为不变：后续 CLI 继续只读取当前 worktree `.env` 和 process environment。`.env` 是每次 setup 生成的本地快照；用户文件修改后重新运行 setup 即可同步。

## 非目标

- 不修改任何 CLI、pipeline、web、Plan1–5 业务逻辑或模型/二进制发现代码。
- 不引入 dotenv、运行时 loader、变量展开、shell 执行、加密存储或新的配置优先级。
- 不创建、修改或运行 unit tests；不 commit、push 或创建 Issue。

## Patch Artifact

- 计划基线：`main` HEAD `4e98b2737ac3dc8889f78138821a2f53c5c8a124`
- Planned Patch：[2026-09-04-user-env-loader.planned.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-user-env-loader.planned.patch>)
- Final Patch：[2026-09-04-user-env-loader.final.patch](</Users/zhiyuanma/Desktop/Codes/Procedura/.agents/plans/2026-09-04-user-env-loader.final.patch>)

## Patch Intent

- `scripts/install-deps.sh`：新增 setup-only 用户文件验证/同步，每次正常运行重建并覆盖当前 `.env`。
- `.env.example`、`README.md`：仅保留变量名、用途、必要示例，说明用户文件格式、`chmod 600`、每次覆盖同步时机和每个 worktree 的本地副本取舍；模板不承载平台探测或默认逻辑。
- 删除上一版的 `src/config/user-env.ts` 与六个 CLI import，确保无 CLI 侵入。

## 验证

- `bash -n scripts/install-deps.sh`
- `bun run typecheck`
- `bun run procedura --help`、`bun run mesh-to-cad --help`、`bun run motion --help`、`bun run batch --help`
- 临时 HOME/worktree：首次生成、再次运行覆盖更新、旧 `.env` 被替换、process env 优先、用户文件缺失重建模板、非法/残余引号行拒绝且不泄露值。
- stale search 确认无 `user-env.ts`、无 CLI loader import；干净基线 `git apply --check` 和 diff-check。

## 状态

当前阶段：Implemented

## Implementation Review

- Mode A：No findings；精简版 `.env.example` 与每次覆盖同步的 Planned Patch 可从基线应用，且无 CLI/pipeline/web diff。
- Mode B：No findings；Planned 与 Final 的 P→F 无实现差异，Final 仅含 setup 脚本、精简配置模板、README 和计划资产。
- 未运行 unit tests；未修改 upstream 业务文件。
