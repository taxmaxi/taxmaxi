# Accounting events record facts, not tax meaning

## Status

Accepted

## Context

The engine (ADR 0005) consumes a ledger of accounting events defined in `packages/core`. Germany is the only jurisdiction today, so German assumptions can easily freeze into these types without anyone noticing. Core types are the most expensive place in the codebase to migrate later, because everything depends on them.

## Decision

Every accounting event describes what happened, never what it means for taxes.

The litmus test for any event type or field: it must be possible to fill it in using only chain and provider data, with no knowledge of which jurisdiction the taxpayer lives in. A staking reward is "received this quantity of this asset from this protocol at this time" — not "income." A movement between the principal's own custody sources is "custody moved" — not "non-taxable." A `DispositionEvent` means ownership decreased; whether that is taxable is the engine's answer, per jurisdiction.

Fields like `taxable`, `taxFree`, `holdingPeriod`, or `incomeCategory` are forbidden on events. Those are engine outputs (see ADR 0008).

When reviewing a proposed event type or field, apply the paper-US test: could a United States calculation (Form 8949 rows, ordinary-income treatment of rewards, specific identification) consume this event unchanged? If answering requires tax-law reasoning, the field belongs in the engine or its result, not on the event.

## Consequences

- The fact layer — provider records, legs, custody movements, reconciliation — stays jurisdiction-blind, so a second jurisdiction reuses all stored data as-is.
- Transfer handling splits cleanly: matching two movements as the same coins moving is a fact and happens upstream; what a transfer means (keeps acquisition date and cost basis, is not a disposal under German rules) is an engine rule.
- Some events will carry detail one jurisdiction ignores. That is acceptable; recording too much fact is recoverable, recording meaning as fact is not.
