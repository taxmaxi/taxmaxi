# TaxMaxi Solana Dune Query Library

Central question that these queries try to answer:

> "Which Solana protocols should TaxMaxi classify because they create tax-relevant user wallet activity?"

These queries help prioritize Solana protocol support for TaxMaxi. The goal is
not to rank every Solana instruction. The goal is to find protocols that create
tax-relevant wallet behavior: swaps, NFT trades, bridge transfers, staking,
lending, rewards, and other balance-changing activity.

Run queries in small windows first. Most files default to `2024-01-01` through
`2024-01-02` so Dune can run them even when text parameters are still set to its
`default value` placeholder.

## Running Safely

In the Dune UI, set `start_date` and `end_date` explicitly before widening a
query. Start with one day so result shape and cost are easy to inspect before
running broader windows.

For local CLI smoke tests, substitute parameters before sending SQL to Dune:

```bash
dune query run-sql --sql "$(sed -e 's/{{start_date}}/2024-01-01/g' -e 's/{{end_date}}/2024-01-02/g' apps/crawler/dune/solana-dex-project-priority.sql)" --timeout 180 -o json
```

## Query Files

### `solana-dex-project-priority.sql`

Ranks Solana DEX projects using `dex_solana.trades`.

Use this as the first source for swap classifier prioritization because the
Spellbook table is already curated and includes project attribution, trader IDs,
stable program IDs, attribution IDs, trade counts, and USD volume.

Primary output:

- `project`
- `approx_unique_traders`
- `approx_trade_transactions`
- `canonical_program_id_count`
- `canonical_program_ids`
- `attributed_pool_or_market_id_count`
- `sample_attributed_pool_or_market_ids`
- `dex_versions`
- `volume_usd`

### `solana-dex-project-sample-transactions.sql`

Samples representative swap transactions for one DEX project.

Use this after `solana-dex-project-priority.sql` identifies a project worth
mapping. Feed the returned `tx_id` values into Helius/TaxMaxi transaction
parsing to design or validate a classifier. The query limits repeated samples
from the same attributed program/token-pair route and trader so the result set
is useful for classifier coverage instead of only showing the largest repeated
trades.

Default project: `jupiter`.

### `solana-token-transfer-program-candidates.sql`

Ranks programs by token-transfer reach using `tokens_solana.transfers`.

Use this to discover non-DEX candidates that still move user balances, such as
bridges, staking/LST protocols, lending protocols, reward distributors, and NFT
marketplaces. This is broader and noisier than the DEX Spellbook query, but much
closer to TaxMaxi's needs than raw instruction invocation counts.

The query uses `dex_solana.trades` plus known swap/router labels to suppress
programs already covered by the swap-priority query. It also emits rough
`tax_relevance_hint` and `review_priority` columns to separate known protocol
classes from unlabeled candidates that still deserve manual sampling.

### `solana-program-sample-transactions.sql`

Samples representative successful transactions for one program id.

Use this after any candidate query returns a program worth investigating. Feed
the returned `tx_id` values into Helius/TaxMaxi parsing and inspect balance
deltas before designing a classifier. Program popularity and labels are not
enough to prove tax relevance.

Default program: Jupiter v6.

### `solana-program-label-lookup.sql`

Looks up Dune discriminator metadata for one program id.

Use this as a secondary manual-review helper after a priority query surfaces a
candidate program. It can identify likely program names, namespaces,
instruction discriminators, and spelling aliases, but it does not prove that an
instruction is tax-relevant or that a classifier is correct.

## Suggested Workflow

1. Discover candidate protocols:
   - Run `solana-dex-project-priority.sql` first for swap coverage.
   - Run `solana-token-transfer-program-candidates.sql` for non-DEX programs
     that still move user balances.
2. Triage candidates:
   - Use volume, user reach, `tax_relevance_hint`, and `review_priority` to
     decide which programs deserve manual review.
   - Use `solana-program-label-lookup.sql` only to understand likely program
     identity and instruction surface. Treat its hints as metadata, not
     classification evidence.
3. Validate behavior:
   - Use `solana-dex-project-sample-transactions.sql` for swap projects.
   - Use `solana-program-sample-transactions.sql` for program-id candidates.
   - Parse sampled `tx_id` values through Helius/TaxMaxi and inspect user
     balance deltas, fees, and instruction context.
4. Implement coverage:
   - Add or update the TaxMaxi protocol registry only after sampled
     transactions confirm a repeatable tax-relevant behavior.
   - Build classifiers from parsed transaction behavior, not from Dune labels
     alone.

## Cost Notes

- Prefer curated Spellbook tables such as `dex_solana.trades` before raw
  `solana.transactions` or `solana.instruction_calls`.
- Keep `block_date` filters explicit and narrow.
- Use larger engines only for intentional backfills or broad discovery.
- For repeated historical analysis, materialize monthly summaries instead of
  repeatedly scanning raw transaction tables.
