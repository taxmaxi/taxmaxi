# Anonymous paid source ownership uses principals

Anonymous paid source creation uses `principals` as the ownership boundary so CLI-first x402 purchases, payer-wallet recovery, account claiming, sync, and tax calculation all use the same durable pipeline.

## Status

Accepted

## Context

TaxMaxi is CLI/API-first. Users can pay anonymously with x402 before creating an account. Later, they may claim the paid source into an account.

The system must not create fake users or a parallel anonymous/demo sync path. Auth users represent login identity; principals represent ownership of sync and tax data.

## Constraints

- `users` remain authentication-only.
- Sync and tax artifacts are owned by `principal_id`.
- Anonymous source creation requires x402.
- x402 proves payment, not wallet ownership.
- SIWX proves payer-wallet control, not tax-wallet ownership.
- Anonymous payer-session access is read-only.
- Additional anonymous sync or replay after the initial paid request is forbidden until a separate paid flow exists.
- Unclaimed anonymous paid sources and their artifacts are retained indefinitely for now.

## Decision

Introduce `principals` as the ownership model.

A registered account has a `user` principal. An anonymous x402 purchase has an `anonymous_wallet` principal. Authenticated APIs resolve `session -> user -> user principal`. Anonymous payer APIs resolve signed payer-session or SIWX-restored payer-session to unclaimed paid anonymous sources.

No-conflict account claiming moves the anonymous source and direct owned artifacts to the user principal. Duplicate-wallet claim resolution is tracked separately in GitHub issue #10.

## Considered Options

1. Keep `users` as the ownership boundary and create synthetic users for anonymous purchases.
2. Make `users.email` nullable and treat anonymous purchases as incomplete users.
3. Create a separate anonymous/demo sync pipeline.
4. Use `principals` as the shared ownership boundary.

## Consequences

- Auth identity and data ownership stay separate.
- Anonymous and authenticated sync use the same source, sync, and tax pipeline.
- Claiming can transfer ownership without resyncing.
- Payer-wallet SIWX can recover access without requiring control of the synced wallet.
- Duplicate-wallet claims need explicit product behavior; they must not blindly merge normalized tax artifacts.
