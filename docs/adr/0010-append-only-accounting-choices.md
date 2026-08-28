# Taxpayer accounting choices are append-only recorded inputs

## Status

Accepted

## Context

Jurisdictions grant taxpayers elections: Germany's rules fix the method today, but the United States allows specific identification per disposal, and other regimes offer method or scope elections. Issue #149 already established an append-only, evidence-carrying override pattern for asset identity and inclusion. Accounting elections have the same audit needs: who chose, when, on what basis, and what superseded it.

## Decision

Taxpayer accounting choices are stored as append-only records — actor, timestamp, the choice, its evidence, and a supersession link — and flow into the engine as the `accountingChoices` input. Changing a choice appends a superseding record and produces a new calculation run (ADR 0007); it never edits history or mutates an existing result.

The engine, not the caller, validates which choices a jurisdiction legally allows. Callers cannot construct arbitrary method combinations; an invalid choice is a typed engine error, and an absent choice falls back to the jurisdiction's default.

## Consequences

- Future elections (specific identification, method changes, scope elections) are new choice kinds flowing through existing machinery, not new subsystems.
- Every run can name the exact choices it applied, which the reproducibility stamp in ADR 0007 requires.
- Legal availability of methods lives in one place, the jurisdiction module, instead of in API validation scattered across endpoints.
