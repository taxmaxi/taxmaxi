# Accounting results are versioned calculation runs from full recompute

## Status

Accepted

## Context

Today `fifo_lots` is live, mutated inventory: `remaining_amount` is decremented during sync, restored in three different code paths during rollback, and bulk re-keyed during principal claims. Because derived state is patched in place, every change needs invalidation machinery — earliest-affected-event boundaries, replay dependency ordering, inventory locks — and a bug in any patch silently corrupts tax numbers. The product is pre-launch, so hard migrations are acceptable and derived data is disposable.

## Decision

Derived accounting state is never mutated in place. It is the output of a calculation run.

- A `calculation_runs` row records one engine invocation: principal, jurisdiction, tax year, reporting currency, engine version, rule-set version, input ledger revision, valuation revision, and status.
- Result tables — derived lots or pools, disposal matches, realized gains, income, blockers — are keyed by run ID and written once.
- A pointer per principal (and scope) marks the active run. New data or an override produces a new run and flips the pointer; old runs can be pruned. A run that a generated report references is never silently changed.
- Runs are full recomputes from the factual ledger. The engine is not fed derived opening state (checkpoints), because feeding derived state back in reintroduces exactly the drift this design removes. If a real principal's ledger ever makes full recompute too slow, checkpointing can be added then, as a measured optimization.
- Sync always succeeds at persisting facts. Situations the engine cannot resolve — inventory shortage, missing prices, blocked assets — make the run partial, with machine-readable blockers in the result, instead of aborting the write transaction with a storage error.
- Readers move to the active run: portfolio positions, tax summaries, and reports read run-scoped tables, never a live inventory table. The run status answers "is this number final or is a recompute in flight?"

The rule for what stays authoritative outside runs: if deleting it loses information, it is a fact table (raw provider records, legs, custody movements, reconciliation matches, prices, override and choice history). If deleting it only costs a recompute, it belongs to a run.

## Considered options

Keeping incremental accounting with checkpointed rebuilds was rejected for now. It is faster per sync but preserves the whole class of boundary and restore bugs, and pre-launch data volumes do not justify it.

## Consequences

- The source dependency graph (issues #149 T03/T04) keeps its sync-layer job — replay ordering, transfer-matching prerequisites, knowing when a principal's ledger is stable — and tells the orchestrator which scopes a change touches. Its accounting-layer job of patching derived lot state in the right order disappears.
- `fifo_lots` as a mutable table, the three lot-restore implementations, and the shortage-as-storage-error pattern are deleted, not bridged. This is a pre-launch hard migration.
- Reproducibility comes free: every persisted number can name the run, versions, and input revisions that produced it.
