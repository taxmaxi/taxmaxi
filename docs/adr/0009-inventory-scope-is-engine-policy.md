# Inventory scope is decided by the engine, not baked into the data

## Status

Accepted

## Context

Germany scopes FIFO per wallet (`de.private.section23.wallet-fifo-method`): a transfer between the principal's own wallets moves lots from one wallet's inventory to another's, carrying acquisition date and cost basis. The United States requires per-account basis tracking from 2025. These are the same policy — each custody source is its own inventory — with different legal names for the unit. Other regimes, such as UK pooling, instead keep one pool per asset across the whole taxpayer. If per-source grouping is built into the ledger or result schemas as structure, that choice is fossilized and a second scope needs a schema migration.

## Decision

Inventory scope has two settings: **per custody source** and **whole taxpayer**. Wallet-scoped and account-scoped rules are both per-custody-source; they are not separate scopes.

Accounting events record **which custody source holds the assets** as a plain fact. Whether disposals match within one source's inventory or against a taxpayer-wide pool is a policy the engine derives from the jurisdiction and the taxpayer's recorded choices.

Which addresses form one custody source — an HD wallet spanning several addresses is one source, an exchange account with invisible internal addresses is one source — is a fact decided when the source is connected, in source modeling. The engine never groups addresses; it receives events already tagged with their source.

The unit that per-custody-source matching groups by is not hardwired to one `sources` row. Several sources may form one custody unit — for example, a wallet app holding an EVM address and a Solana address that presents them as one wallet, which a jurisdiction may treat as one account. The custody unit defaults to a single source; grouping sources into a shared unit is a recorded fact or taxpayer choice, and derived inventories reference the unit, not the source directly.

The ledger and the run result schemas never pre-group by scope. Derived lots and pools in a run result reference the custody source and the scope the engine chose, as data.

## Consequences

- Germany's wallet FIFO and the US per-account rule are one engine policy over identical stored facts; a whole-taxpayer scheme is the other. Adding either direction later touches no schema.
- A transfer between the principal's own custody sources is one event type; whether it crosses an inventory boundary is the engine's call per jurisdiction.
- Address-to-source grouping can have tax consequences under per-source scoping, so it stays an explicit, recorded fact of the source connection rather than an inference inside accounting.
- Reviewers should reject schema or core-type changes that group inventory by wallet or account structurally, even when they look like harmless denormalization for Germany.
