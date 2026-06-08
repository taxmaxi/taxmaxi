-- Representative Solana transactions for one program id.
--
-- Use this after a candidate program appears in a priority query. The output is
-- intended for classifier design: inspect signatures, signer, balance-change
-- presence, logs, and instruction context in Helius/TaxMaxi.
--
-- The sample is intentionally diversified. Pure latest-time ordering tends to
-- return many copies of the same bot/router pattern when a high-throughput
-- program is active near the end of the requested window.
--
-- Parameters:
--   program_id  - Solana program id to sample
--   start_date  - inclusive date, for example 2024-01-01
--   end_date    - exclusive date, for example 2024-01-02

WITH parameters AS (
  SELECT
    COALESCE(
      NULLIF('{{program_id}}', 'default value'),
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
    ) AS program_id,
    COALESCE(TRY_CAST('{{start_date}}' AS date), DATE '2024-01-01') AS start_date,
    COALESCE(TRY_CAST('{{end_date}}' AS date), DATE '2024-01-02') AS end_date
),

matching_transactions AS (
  SELECT
    transactions.id AS tx_id,
    transactions.block_time,
    DATE_TRUNC('hour', transactions.block_time) AS block_hour,
    transactions.signer,
    transactions.fee,
    transactions.compute_units_consumed,
    COALESCE(CARDINALITY(transactions.pre_token_balances), 0) > 0
      OR COALESCE(CARDINALITY(transactions.post_token_balances), 0) > 0 AS has_token_balance_change,
    COALESCE(CARDINALITY(transactions.log_messages), 0) AS log_message_count,
    ARRAY_DISTINCT(
      TRANSFORM(
        FILTER(
          transactions.log_messages,
          log_message -> (
            REGEXP_LIKE(log_message, 'Instruction: ')
              AND NOT REGEXP_LIKE(
                log_message,
                'Instruction: (GetAccountDataSize|InitializeImmutableOwner|InitializeAccount3|CreateIdempotent|SyncNative|Transfer|TransferChecked|MintTo|Burn|CloseAccount|Approve|Revoke)'
              )
            )
              OR REGEXP_LIKE(log_message, 'PhoenixInstruction::')
        ),
        log_message -> CASE
          WHEN REGEXP_LIKE(log_message, 'PhoenixInstruction::')
            THEN REGEXP_REPLACE(log_message, '^.*PhoenixInstruction::', '')
          ELSE REGEXP_REPLACE(log_message, '^.*Instruction: ', '')
        END
      )
    ) AS classifier_instruction_names,
    SLICE(
      FILTER(
        transactions.log_messages,
        log_message -> REGEXP_LIKE(log_message, 'Memo|PhoenixInstruction|ray_log|AMM:|Amount:|TotalFee:|fee_growth')
          OR (
            REGEXP_LIKE(log_message, 'Instruction:')
              AND NOT REGEXP_LIKE(
                log_message,
                'Instruction: (GetAccountDataSize|InitializeImmutableOwner|InitializeAccount3|CreateIdempotent|SyncNative|Transfer|TransferChecked|MintTo|Burn|CloseAccount|Approve|Revoke)'
              )
          )
      ),
      1,
      30
    ) AS high_signal_log_messages
  FROM solana.transactions AS transactions
  CROSS JOIN parameters
  CROSS JOIN UNNEST(transactions.instructions) AS outer_instruction(
    data,
    executing_account,
    account_arguments,
    inner_instructions
  )
  WHERE transactions.block_date >= parameters.start_date
    AND transactions.block_date < parameters.end_date
    AND transactions.success = true
    AND outer_instruction.executing_account = parameters.program_id
),

deduped_transactions AS (
  SELECT DISTINCT
    tx_id,
    block_time,
    block_hour,
    signer,
    fee,
    compute_units_consumed,
    has_token_balance_change,
    log_message_count,
    classifier_instruction_names,
    high_signal_log_messages
  FROM matching_transactions
),

ranked_transactions AS (
  SELECT
    deduped_transactions.*,
    ROW_NUMBER() OVER (
      PARTITION BY signer
      ORDER BY block_time DESC, tx_id
    ) AS signer_sample_rank,
    ROW_NUMBER() OVER (
      PARTITION BY block_hour
      ORDER BY block_time DESC, tx_id
    ) AS time_bucket_sample_rank
  FROM deduped_transactions
)

SELECT
  tx_id,
  block_time,
  block_hour,
  signer,
  fee,
  compute_units_consumed,
  has_token_balance_change,
  log_message_count,
  classifier_instruction_names,
  high_signal_log_messages,
  signer_sample_rank,
  time_bucket_sample_rank
FROM ranked_transactions
WHERE signer_sample_rank <= 3
  AND time_bucket_sample_rank <= 5
ORDER BY
  time_bucket_sample_rank,
  block_hour DESC,
  signer_sample_rank,
  block_time DESC,
  tx_id
LIMIT 50;
