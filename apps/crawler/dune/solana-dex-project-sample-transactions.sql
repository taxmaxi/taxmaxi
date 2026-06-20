-- Representative Solana DEX swap transactions for classifier design.
--
-- Use after solana-dex-project-priority.sql identifies a project worth mapping.
-- Samples recent trades for one project, including the trader, program id, pair,
-- token mints, and USD value.
--
-- The sample is intentionally diversified. Pure amount_usd ordering tends to
-- return many copies of the same large route or market-maker pattern, which is
-- less useful for classifier design.
--
-- Parameters:
--   project    - DEX project name, for example jupiter, raydium, meteora, or orca
--   start_date - inclusive date, for example 2024-01-01
--   end_date   - exclusive date, for example 2024-01-02

WITH filtered_trades AS (
  SELECT
    tx_id,
    block_time,
    CASE
      WHEN project = 'whirlpool' THEN 'orca'
      ELSE project
    END AS project,
    trader_id,
    project_program_id,
    token_pair,
    token_sold_symbol,
    token_bought_symbol,
    token_sold_mint_address,
    token_bought_mint_address,
    amount_usd,
    outer_instruction_index,
    inner_instruction_index
  FROM dex_solana.trades
  WHERE block_date >= COALESCE(TRY_CAST('{{start_date}}' AS date), DATE '2024-01-01')
    AND block_date < COALESCE(TRY_CAST('{{end_date}}' AS date), DATE '2024-01-02')
    AND (
      CASE
        WHEN project = 'whirlpool' THEN 'orca'
        ELSE project
      END
    ) = COALESCE(NULLIF('{{project}}', 'default value'), 'jupiter')
),

ranked_trades AS (
  SELECT
    filtered_trades.*,
    ROW_NUMBER() OVER (
      PARTITION BY
        COALESCE(project_program_id, 'unknown'),
        COALESCE(
          token_pair,
          CONCAT(
            COALESCE(token_sold_mint_address, 'unknown'),
            '-',
            COALESCE(token_bought_mint_address, 'unknown')
          )
        )
      ORDER BY amount_usd DESC NULLS LAST, block_time DESC, tx_id
    ) AS route_sample_rank,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(trader_id, 'unknown')
      ORDER BY amount_usd DESC NULLS LAST, block_time DESC, tx_id
    ) AS trader_sample_rank
  FROM filtered_trades
)

SELECT
  tx_id,
  block_time,
  project,
  trader_id,
  project_program_id,
  token_pair,
  token_sold_symbol,
  token_bought_symbol,
  token_sold_mint_address,
  token_bought_mint_address,
  amount_usd,
  outer_instruction_index,
  inner_instruction_index,
  route_sample_rank,
  trader_sample_rank
FROM ranked_trades
WHERE route_sample_rank <= 3
  AND trader_sample_rank <= 5
ORDER BY route_sample_rank, amount_usd DESC NULLS LAST, block_time DESC, tx_id
LIMIT 50;
