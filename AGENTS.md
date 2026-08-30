## Upstream isolation

Treat existing upstream code and public contracts as a stable milestone. Add new
capabilities through new, removable modules, routes, CLIs, or viewers whenever
that can satisfy the requirement. Limit edits to existing upstream files to the
smallest unavoidable registration or data-passing seams; keep feature logic out
of those seams. Prefer small, local duplication inside the new module over an
upstream refactor made only to support the new capability.

Before changing an existing upstream file, verify that a new side-path module
cannot meet the requirement. At completion, list every modified upstream file,
state why each edit is unavoidable, and confirm that removing the new capability
would leave upstream behavior and contracts unchanged.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `87003697/Procedura`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels defined for this repository. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.
