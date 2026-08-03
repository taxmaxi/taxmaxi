# Domain Docs

TaxMaxi uses a multi-context documentation layout.

## Before exploring

Read:

- `CONTEXT-MAP.md` at the repository root, if it exists
- Each linked `CONTEXT.md` relevant to the task
- Relevant system-wide decisions under `docs/adr/`
- Relevant context-specific decisions under `apps/*/docs/adr/` or `packages/*/docs/adr/`

If these files do not exist, proceed silently. The domain-modeling skills create them when terms or decisions are resolved.

## File structure

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                     # System-wide decisions
├── apps/
│   └── <app>/
│       ├── CONTEXT.md
│       └── docs/adr/             # App-specific decisions
└── packages/
    └── <package>/
        ├── CONTEXT.md
        └── docs/adr/             # Package-specific decisions
```

Context files are created only when a context has useful domain language to record.

## Use the glossary vocabulary

When naming a domain concept in an issue, proposal, test, or implementation, use the term defined in the relevant `CONTEXT.md`.

If a needed concept is missing, reconsider whether the term belongs in the project or record the gap for `/domain-modeling`.

## Flag ADR conflicts

If proposed work conflicts with an existing ADR, state the conflict instead of silently overriding the decision.
