# Domain Docs

This repository uses a single-context domain documentation layout.

## Before exploring

Read these resources when they exist:

- `CONTEXT.md` at the repository root.
- Relevant architectural decisions under `docs/adr/`.

If these files do not exist, proceed silently. The domain-modeling workflow creates them when domain terminology or architectural decisions are actually resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Use the glossary’s vocabulary

When naming domain concepts in issues, plans, refactors, hypotheses, or implementation work, use the terms defined in `CONTEXT.md`.

If a required concept is absent, reconsider whether new language is necessary or record the gap for domain modeling.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.
