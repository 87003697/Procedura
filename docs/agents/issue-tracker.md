# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `87003697/Procedura`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `origin` points to `87003697/Procedura`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When changed to `yes`, external pull requests run through the same labels and states as issues, using the corresponding `gh pr` commands.

GitHub shares one number space across issues and pull requests. A bare `#42` may be either; resolve it with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

The map is one issue labelled `wayfinder:map`, with child issues representing tickets.

- **Map**: create one issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: link an issue to the map as a GitHub sub-issue. If sub-issues are unavailable, add it to a task list in the map and start its body with `Part of #<map>`.
- **Ticket type**: apply one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub’s native issue dependencies. If unavailable, add `Blocked by: #<n>` at the top of the child issue.
- **Frontier**: choose the first open, unassigned child in map order that has no open blocker.
- **Claim**: assign the issue to the active developer.
- **Resolve**: comment with the result, close the issue, and add a context pointer to the map’s Decisions-so-far section.
