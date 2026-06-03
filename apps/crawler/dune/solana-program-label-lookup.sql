-- Solana program label lookup from Dune discriminators.
--
-- Use this to enrich candidate program IDs with decoded program/namespace names
-- before deciding whether to add them to the TaxMaxi protocol registry. Dune
-- may expose several aliases for the same discriminator, so this query groups
-- aliases together instead of returning one row per spelling variant.
--
-- Parameters:
--   program_id - Solana program id to inspect

WITH parameters AS (
  SELECT
    COALESCE(
      NULLIF('{{program_id}}', 'default value'),
      'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
    ) AS program_id
),

matching_discriminators AS (
  SELECT
    discriminators.program_id,
    discriminators.namespace,
    discriminators.program_name,
    discriminators.instruction_name,
    discriminators.dispatcher_type,
    discriminators.discriminator,
    REGEXP_REPLACE(LOWER(discriminators.instruction_name), '[^a-z0-9]', '') AS normalized_instruction_name
  FROM solana.discriminators AS discriminators
  CROSS JOIN parameters
  WHERE discriminators.program_id = parameters.program_id
),

deduped_discriminators AS (
  SELECT
    program_id,
    ARRAY_SORT(ARRAY_AGG(DISTINCT namespace) FILTER (WHERE namespace IS NOT NULL)) AS namespaces,
    ARRAY_SORT(ARRAY_AGG(DISTINCT program_name) FILTER (WHERE program_name IS NOT NULL)) AS program_names,
    dispatcher_type,
    discriminator,
    normalized_instruction_name,
    ARRAY_SORT(ARRAY_AGG(DISTINCT instruction_name) FILTER (WHERE instruction_name IS NOT NULL)) AS instruction_aliases
  FROM matching_discriminators
  GROUP BY
    program_id,
    dispatcher_type,
    discriminator,
    normalized_instruction_name
),

hinted_discriminators AS (
  SELECT
    program_id,
    namespaces,
    program_names,
    dispatcher_type,
    discriminator,
    ELEMENT_AT(instruction_aliases, 1) AS primary_instruction_name,
    instruction_aliases,
    CARDINALITY(instruction_aliases) AS instruction_alias_count,
    CASE
      WHEN REGEXP_LIKE(normalized_instruction_name, 'swap|route|exchange|wrappedbuy|wrappedsell')
        THEN 'swap_or_route'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'claim|reward|distribut|airdrop')
        THEN 'reward_or_claim'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'stake|unstake|delegate|redeem|marinade|jito|sanctum|lst')
        THEN 'staking_or_lst'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'borrow|repay|lend|flash|margin|liquidat')
        THEN 'lending_or_margin'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'deposit|withdraw')
        THEN 'deposit_or_withdraw'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'liquidity|position')
        THEN 'liquidity_or_position'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'bid|auction|list|nft|marketplace')
        THEN 'nft_marketplace'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'bridge|send|receive|transfer')
        THEN 'bridge_or_transfer'
      WHEN REGEXP_LIKE(normalized_instruction_name, 'create|open|close|initialize|update|set|cancel')
        THEN 'account_or_order_management'
      ELSE 'needs_review'
    END AS instruction_hint
  FROM deduped_discriminators
)

SELECT
  program_id,
  namespaces,
  program_names,
  dispatcher_type,
  discriminator,
  primary_instruction_name,
  instruction_aliases,
  instruction_alias_count,
  instruction_hint
FROM hinted_discriminators
ORDER BY
  CASE instruction_hint
    WHEN 'swap_or_route' THEN 1
    WHEN 'reward_or_claim' THEN 2
    WHEN 'staking_or_lst' THEN 3
    WHEN 'lending_or_margin' THEN 4
    WHEN 'deposit_or_withdraw' THEN 5
    WHEN 'liquidity_or_position' THEN 6
    WHEN 'nft_marketplace' THEN 7
    WHEN 'bridge_or_transfer' THEN 8
    WHEN 'account_or_order_management' THEN 9
    ELSE 10
  END,
  primary_instruction_name
LIMIT 200;
