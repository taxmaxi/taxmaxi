-- Solana DEX project priority for TaxMaxi swap classifier coverage.
--
-- Use this first for swap support. dex_solana.trades is curated Spellbook data,
-- so it is much higher signal than raw instruction scans for swap classifiers.
-- `project_main_id` is the stable program-level id to consider for protocol
-- registry work; `project_program_id` is often a pool, market, or attribution
-- id and can be much higher-cardinality.
--
-- Parameters:
--   start_date - inclusive date, for example 2024-01-01
--   end_date   - exclusive date, for example 2024-02-01

WITH parameters AS (
  SELECT
    COALESCE(TRY_CAST('{{start_date}}' AS date), DATE '2024-01-01') AS start_date,
    COALESCE(TRY_CAST('{{end_date}}' AS date), DATE '2024-01-02') AS end_date
),

dex_trades AS (
  SELECT
    CASE
      WHEN project = 'whirlpool' THEN 'orca'
      ELSE project
    END AS project,
    tx_id,
    trader_id,
    version_name,
    project_main_id,
    project_program_id,
    amount_usd
  FROM dex_solana.trades
  CROSS JOIN parameters
  WHERE block_date >= parameters.start_date
    AND block_date < parameters.end_date
    AND project IS NOT NULL
)

SELECT
  project,
  'swap' AS tax_category,
  approx_distinct(trader_id) AS approx_unique_traders,
  approx_distinct(tx_id) AS approx_trade_transactions,
  COUNT(*) AS trade_rows,
  COUNT(DISTINCT project_main_id) AS canonical_program_id_count,
  SLICE(
    ARRAY_SORT(
      ARRAY_AGG(DISTINCT project_main_id)
        FILTER (WHERE project_main_id IS NOT NULL)
    ),
    1,
    20
  ) AS canonical_program_ids,
  COUNT(DISTINCT project_program_id) AS attributed_pool_or_market_id_count,
  SLICE(
    ARRAY_SORT(
      ARRAY_AGG(DISTINCT project_program_id)
        FILTER (WHERE project_program_id IS NOT NULL)
    ),
    1,
    20
  ) AS sample_attributed_pool_or_market_ids,
  SLICE(
    ARRAY_SORT(
      ARRAY_AGG(DISTINCT version_name)
        FILTER (WHERE version_name IS NOT NULL)
    ),
    1,
    20
  ) AS dex_versions,
  COALESCE(SUM(amount_usd), 0) AS volume_usd,
  CAST(parameters.start_date AS varchar)
    || ' to '
    || CAST(parameters.end_date AS varchar) AS period,
  CURRENT_TIMESTAMP AS retrieved_at
FROM dex_trades
CROSS JOIN parameters
GROUP BY
  project,
  parameters.start_date,
  parameters.end_date
ORDER BY
  approx_unique_traders DESC,
  approx_trade_transactions DESC,
  volume_usd DESC
LIMIT 100;
