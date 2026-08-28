# Tax accounting is a stateless engine over a factual ledger

## Status

Accepted

## Context

Accounting rules are spread across sync, reconciliation, persistence, replay, and tax calculation. FIFO lots are created and consumed inside the persist transaction, so one accounting method is fused into the write path. The greedy lot-matching rule is implemented twice — once in source persistence with string fixed-point math and once in transfer reconciliation with `BigDecimal` — and lot restoration is implemented three times. Inventory shortage is raised as a storage error and detected by matching the error message string. The principal-scoped rebuild work in issue #149 had to reproduce ordering, transfer, shortage, and matching rules a further time, which is what surfaced this decision.

## Decision

Tax accounting is one pure calculation, owned by a new `@my/accounting` package:

- The engine's only entry point takes a factual ledger of accounting events, a jurisdiction, a tax year, the taxpayer's recorded accounting choices, and valuation facts. It returns a complete, deterministic result.
- The engine performs no database access, queue operations, or durable writes. Its Effect requirement channel is `never`, so the type checker enforces this rather than review discipline.
- Jurisdiction is data flowing into this one function, not a code path through the system. Sync, replay, fact persistence, and result storage never branch on jurisdiction.
- Fact storage stays in `packages/persistence`. An adapter there converts stored rows (transaction legs, custody movements, reconciliation matches, prices) into engine-owned ledger events. The engine never sees Drizzle rows.
- The shared accounting language — events, jurisdiction and tax-year values, accounting choices, valuation facts, monetary and quantity values — lives in `packages/core`.
- The engine uses one number system: `BigDecimal` via core's monetary values. The string fixed-point implementation is retired. Unifying the number representation happens before any behavior comparison, because differential tests are meaningless while sync and rebuild compute in different arithmetic.

## Considered options

Keeping the incremental in-place FIFO and only extracting shared helper functions was rejected. It would remove the duplicated arithmetic but keep derived accounting state mutable inside the write path, so every future rule change would still need matching invalidation and restore logic, and normal processing and rebuild could still drift apart.

## Consequences

- Normal processing and rebuild call the same code, so they cannot produce different tax numbers. Differential tests assert identical output for both paths during migration.
- Shortages and other unresolved situations become values in the engine result instead of storage errors detected by string matching (see ADR 0007).
- Adding a jurisdiction later means adding an engine module and its valuation data, not touching sync or persistence (see ADR 0006, 0008, 0009).
- Migration is incremental: lift the existing FIFO calculation without changing results first, prove it with differential tests, then move orchestration and result storage.
