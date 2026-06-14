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
- `tax_category`
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

### `solana-program-sample-transactions.sql`

Samples representative successful transactions for one program id.

Use this manually after a candidate surfaces a program worth investigating.
Feed the returned `tx_id` values into Helius/TaxMaxi parsing and inspect
balance deltas before designing a classifier. Program popularity and labels are
not enough to prove tax relevance.

Default program: Jupiter v6.

### `solana-program-label-lookup.sql`

Looks up Dune discriminator metadata for one program id.

Use this as a secondary manual-review helper after a candidate surfaces a
program. It can identify likely program names, namespaces, instruction
discriminators, and spelling aliases, but it does not prove that an instruction
is tax-relevant or that a classifier is correct.

## DEX Discovery Workflow (crawler `crawl solana`)

The crawler command `crawl solana` is the automated discovery path. It runs
only the two curated DEX queries and imports the result into the
`protocol_candidates` review queue:

1. `solana-dex-project-priority.sql` ranks DEX projects per date window.
2. `solana-dex-project-sample-transactions.sql` samples diversified swap
   transactions for each ranked project until the requested unique sample cap is
   reached.
3. Every ranked project with canonical program ids becomes one candidate with
   `protocol_name_hint` (project), `category_hint` (`swap`), project-level
   counts, USD volume, canonical program ids, and sample transaction signatures
   attached as observation evidence.

Dune output is discovery evidence only. It cannot classify production
transactions; runtime classification reads approved protocol mappings, never
candidates.

Aggregator caveat: `dex_solana.trades` attributes trades to the executing DEX
(raydium, orca, meteora, ...), not to routers such as Jupiter. Many sampled
transactions are router-entry transactions, so the sample signatures are the
way to discover aggregator entrypoint programs: feed them into Helius/TaxMaxi
normalization and inspect the top-level instruction programs.

API note: the TaxMaxi Dune API key can only execute saved queries. Editing
query SQL must happen in the Dune UI first; mirror the change into this folder
and bump the query version used by the crawler afterwards.

Window and cost notes: Dune API executions time out after 2 minutes on the
current plan. The crawler splits a date range into windows (default 7 days) and
halves any window that times out, so high-volume periods crawl automatically
with smaller windows. Each execution consumes Dune credits, including timed-out
ones, and each ranked project is sampled in later windows until it has the
requested number of unique signatures. Lower `--samples-per-project` to reduce
sample-query executions. The import is idempotent per window, so repeated and
overlapping runs only add or update observations.

Replay: a rankings file written with `--out` records every raw Dune execution,
including timed-out ones. `crawl solana-replay --from-file <path>` re-runs the
import from those recordings with zero Dune credits, applying the current mapping
logic to the original raw data. Use it to reseed a database, re-import after a
schema migration, or re-process after classifier mapping changes. A replay
always uses the file's original date range and window settings. The file name
includes the crawled date range, so runs for different ranges never overwrite
each other even when they share an `--out` directory.

## Suggested Workflow

Dune is an upstream evidence pipeline for the TaxMaxi protocol classification
registry. It is not the registry itself, and query output should not directly
create approved mappings.

1. Run `crawl solana` over the date ranges that matter for users to fill
   the `protocol_candidates` review queue with `swap` candidates.
2. For each candidate, collect review evidence:
   - Use `solana-program-label-lookup.sql` to inspect likely program identity,
     namespaces, instruction names, aliases, and discriminator hints.
   - Use `solana-dex-project-sample-transactions.sql` for swap projects.
   - Use `solana-program-sample-transactions.sql` for program-id candidates.
3. Approve into the TaxMaxi protocol registry only after checking
   representative Helius/TaxMaxi-normalized transactions. Inspect user balance
   deltas, fees, instruction context, and whether the behavior is repeatable.

Future category-specific discovery queries (NFT, bridge, lending, staking/LST,
liquidity, rewards) are tracked in #56 and should follow the same pattern:
curated source tables, narrow windows, candidates plus sample signatures.

## Cost Notes

- Prefer curated Spellbook tables such as `dex_solana.trades` before raw
  `solana.transactions` or `solana.instruction_calls`.
- Keep `block_date` filters explicit and narrow.
- Use larger engines only for intentional backfills or broad discovery.
- For repeated historical analysis, materialize monthly summaries instead of
  repeatedly scanning raw transaction tables.

## Dune Query IDs:

solana-dex-project-priority.sql: https://dune.com/queries/7647495
solana-dex-project-sample-transactions.sql: https://dune.com/queries/7648044
solana-program-sample-transactions.sql: https://dune.com/queries/7648230
solana-program-label-lookup.sql: https://dune.com/queries/7648242
