# Local developer tools

This directory contains developer-only helpers that are not public Procedura CLIs.
Run them from the repository root so documented paths and repository discovery
remain predictable.

## Matching workspaces

```text
bash scripts/local/setup-matching-workspaces.sh --help
bash scripts/local/setup-matching-workspaces.sh --ref HEAD /tmp/procedura-work
```

Capability-specific tools and runtime assets belong with the module or
experiment that owns them rather than in this directory.
