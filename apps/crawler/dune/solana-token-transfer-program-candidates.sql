-- Solana token-transfer program candidates for non-DEX tax coverage.
--
-- This query ranks outer programs by token transfer reach. It is useful for
-- finding candidate staking, bridge, lending, reward, and marketplace programs
-- that move user balances but may not appear in curated DEX trade tables.
--
-- Parameters:
--   start_date - inclusive date, for example 2024-01-01
--   end_date   - exclusive date, for example 2024-02-01

WITH parameters AS (
  SELECT
    COALESCE(TRY_CAST('{{start_date}}' AS date), DATE '2024-01-01') AS start_date,
    COALESCE(TRY_CAST('{{end_date}}' AS date), DATE '2024-01-02') AS end_date
),

dex_programs AS (
  SELECT DISTINCT
    dex_trades.project_program_id AS program_id
  FROM dex_solana.trades AS dex_trades
  CROSS JOIN parameters
  WHERE dex_trades.block_date >= parameters.start_date
    AND dex_trades.block_date < parameters.end_date
    AND dex_trades.project_program_id IS NOT NULL
),

transfer_programs AS (
  SELECT
    transfers.outer_executing_account AS program_id,
    transfers.tx_id,
    transfers.tx_signer,
    transfers.from_owner,
    transfers.to_owner,
    transfers.amount_usd
  FROM tokens_solana.transfers AS transfers
  CROSS JOIN parameters
  LEFT JOIN dex_programs
    ON transfers.outer_executing_account = dex_programs.program_id
  WHERE transfers.block_date >= parameters.start_date
    AND transfers.block_date < parameters.end_date
    AND transfers.outer_executing_account IS NOT NULL
    AND dex_programs.program_id IS NULL
    AND transfers.outer_executing_account NOT IN (
      '11111111111111111111111111111111',
      'AddressLookupTab1e1111111111111111111111111',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      'BPFLoader1111111111111111111111111111111111',
      'BPFLoader2111111111111111111111111111111111',
      'BPFLoaderUpgradeab1e11111111111111111111111',
      'ComputeBudget111111111111111111111111111111',
      'Config1111111111111111111111111111111111111',
      'Ed25519SigVerify111111111111111111111111111',
      'KeccakSecp256k11111111111111111111111111111',
      'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
      'NativeLoader1111111111111111111111111111111',
      'Secp256k1SigVerify1111111111111111111111111',
      'Secp256r1SigVerify1111111111111111111111111',
      'Stake11111111111111111111111111111111111111',
      'Sysvar1nstructions1111111111111111111111111',
      'SysvarC1ock11111111111111111111111111111111',
      'SysvarEpochSchedu1e111111111111111111111111',
      'SysvarFees111111111111111111111111111111111',
      'SysvarRecentB1ockHashes11111111111111111111',
      'SysvarRent111111111111111111111111111111111',
      'SysvarRewards111111111111111111111111111111',
      'SysvarS1otHashes111111111111111111111111111',
      'SysvarS1otHistory11111111111111111111111111',
      'SysvarStakeHistory1111111111111111111111111',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'Vote111111111111111111111111111111111111111',
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
    )
),

program_usage AS (
  SELECT
    program_id,
    approx_distinct(tx_id) AS approx_transfer_transactions,
    approx_distinct(tx_signer) AS approx_signers,
    approx_distinct(from_owner) AS approx_from_owners,
    approx_distinct(to_owner) AS approx_to_owners,
    COUNT(*) AS transfer_rows,
    COALESCE(SUM(amount_usd), 0) AS transfer_volume_usd
  FROM transfer_programs
  GROUP BY program_id
),

program_labels AS (
  SELECT
    discriminators.program_id,
    ARRAY_AGG(DISTINCT discriminators.program_name)
      FILTER (WHERE discriminators.program_name IS NOT NULL) AS program_names,
    ARRAY_AGG(DISTINCT discriminators.namespace)
      FILTER (WHERE discriminators.namespace IS NOT NULL) AS namespaces
  FROM solana.discriminators AS discriminators
  INNER JOIN program_usage
    ON program_usage.program_id = discriminators.program_id
  WHERE discriminators.program_id IS NOT NULL
  GROUP BY discriminators.program_id
),

labeled_programs AS (
  SELECT
    program_usage.program_id,
    program_labels.program_names,
    program_labels.namespaces,
    LOWER(
      COALESCE(ARRAY_JOIN(program_labels.program_names, ','), '')
        || ','
        || COALESCE(ARRAY_JOIN(program_labels.namespaces, ','), '')
    ) AS label_text,
    program_usage.approx_signers,
    program_usage.approx_transfer_transactions,
    program_usage.approx_from_owners,
    program_usage.approx_to_owners,
    program_usage.transfer_rows,
    program_usage.transfer_volume_usd
  FROM program_usage
  LEFT JOIN program_labels
    ON program_usage.program_id = program_labels.program_id
),

classified_programs AS (
  SELECT
    labeled_programs.*,
    (
      REGEXP_LIKE(
        label_text,
        'jupiter|raydium|whirlpool|orca|meteora|lifinity|phoenix|openbook|serum|dooar|saber|aldrin|cykura|crema|goosefx|limit_order|dca|amm_v3|raydium_amm|lb_clmm|clmm|dlmm'
      )
        OR labeled_programs.program_id IN (
          '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
          'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
          'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M',
          'Dooar9JkhdZ7J3LHN3A7YCuoGRUggXhQaG4kijfLGU2j',
          'JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo',
          'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
          'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu',
          'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'
        )
    )
      AND NOT REGEXP_LIKE(label_text, 'perp|perpetual|drift|zeta|mango') AS is_curated_swap_protocol,
    CASE
      WHEN REGEXP_LIKE(label_text, 'kamino|marginfi|solend|drift|francium')
        THEN 'lending_or_margin'
      WHEN REGEXP_LIKE(label_text, 'marinade|jito|stake|staking|sanctum|solblaze')
        THEN 'staking_or_lst'
      WHEN REGEXP_LIKE(label_text, 'wormhole|allbridge|debridge|portal|mayan|meson|dln')
        THEN 'bridge'
      WHEN REGEXP_LIKE(label_text, 'tensor|magic_eden|auction|nft|mmm|mooar')
        THEN 'nft_marketplace'
      WHEN REGEXP_LIKE(label_text, 'reward|airdrop|distributor|helium|banana')
        THEN 'reward_or_airdrop'
      WHEN REGEXP_LIKE(label_text, 'perp|perpetual|zeta|mango')
        THEN 'perps_or_trading'
      ELSE 'candidate_review'
    END AS tax_relevance_hint
  FROM labeled_programs
),

candidate_programs AS (
  SELECT
    classified_programs.*,
    CASE
      WHEN tax_relevance_hint <> 'candidate_review'
        THEN 'high'
      WHEN classified_programs.transfer_volume_usd >= 1000000
        OR classified_programs.approx_signers >= 1000
        THEN 'medium'
      ELSE 'low'
    END AS review_priority
  FROM classified_programs
  WHERE NOT is_curated_swap_protocol
),

ranked_programs AS (
  SELECT
    ROW_NUMBER() OVER (
      ORDER BY
        candidate_programs.approx_signers DESC,
        candidate_programs.approx_transfer_transactions DESC,
        candidate_programs.transfer_volume_usd DESC,
        candidate_programs.program_id
    ) AS rank,
    candidate_programs.*
  FROM candidate_programs
  ORDER BY
    approx_signers DESC,
    approx_transfer_transactions DESC,
    transfer_volume_usd DESC,
    program_id
  LIMIT 100
)

SELECT
  ranked_programs.rank,
  ranked_programs.program_id,
  ranked_programs.program_names,
  ranked_programs.namespaces,
  ranked_programs.tax_relevance_hint,
  ranked_programs.review_priority,
  ranked_programs.approx_signers,
  ranked_programs.approx_transfer_transactions,
  ranked_programs.approx_from_owners,
  ranked_programs.approx_to_owners,
  ranked_programs.transfer_rows,
  ranked_programs.transfer_volume_usd,
  CAST(parameters.start_date AS varchar)
    || ' to '
    || CAST(parameters.end_date AS varchar) AS period,
  CURRENT_TIMESTAMP AS retrieved_at
FROM ranked_programs
CROSS JOIN parameters
ORDER BY ranked_programs.rank;
