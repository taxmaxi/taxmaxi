-- Solana program ranking by year for priority-only mapping discovery.
--
-- Parameters:
--   year  - calendar year to rank, for example 2024
--   limit - maximum programs to return, for example 100

WITH params AS (
  SELECT
    CAST({{year}} AS integer) AS target_year,
    FROM_ISO8601_DATE(CONCAT(CAST(CAST({{year}} AS integer) AS varchar), '-01-01')) AS start_date,
    FROM_ISO8601_DATE(CONCAT(CAST(CAST({{year}} AS integer) + 1 AS varchar), '-01-01')) AS end_date
),

calls AS (
  SELECT
    instruction_calls.executing_account AS program_id,
    instruction_calls.tx_id,
    instruction_calls.tx_signer,
    instruction_calls.block_time,
    instruction_calls.is_inner
  FROM solana.instruction_calls AS instruction_calls
  CROSS JOIN params
  WHERE instruction_calls.block_date >= params.start_date
    AND instruction_calls.block_date < params.end_date
    AND instruction_calls.tx_success = true
    AND instruction_calls.executing_account IS NOT NULL
),

ranked_programs AS (
  SELECT
    program_id,
    CAST((SELECT target_year FROM params) AS varchar) AS period,
    COUNT(*) AS invocation_count,
    COUNT(DISTINCT tx_id) AS transaction_count,
    approx_distinct(tx_signer) AS unique_signer_count,
    COUNT_IF(COALESCE(is_inner, false)) AS inner_invocation_count,
    COUNT_IF(NOT COALESCE(is_inner, false)) AS outer_invocation_count
  FROM calls
  GROUP BY program_id
),

sampled_transactions AS (
  SELECT
    program_id,
    tx_id,
    ROW_NUMBER() OVER (
      PARTITION BY program_id
      ORDER BY block_time DESC, tx_id
    ) AS sample_rank
  FROM (
    SELECT DISTINCT
      program_id,
      tx_id,
      block_time
    FROM calls
  )
),

program_samples AS (
  SELECT
    program_id,
    ARRAY_AGG(tx_id ORDER BY sample_rank) AS sample_signatures
  FROM sampled_transactions
  WHERE sample_rank <= 10
  GROUP BY program_id
)

SELECT
  ranked_programs.program_id,
  ranked_programs.period,
  ranked_programs.invocation_count,
  ranked_programs.transaction_count,
  ranked_programs.unique_signer_count,
  ranked_programs.outer_invocation_count,
  ranked_programs.inner_invocation_count,
  program_samples.sample_signatures,
  CURRENT_TIMESTAMP AS retrieved_at
FROM ranked_programs
LEFT JOIN program_samples
  ON ranked_programs.program_id = program_samples.program_id
ORDER BY ranked_programs.invocation_count DESC
LIMIT {{limit}};
