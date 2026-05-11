/**
 * Checked-in Coinbase transaction type catalog snapshot sourced from
 * https://docs.cdp.coinbase.com/coinbase-business/track-apis/transactions#transaction-types
 * on 2026-03-21.
 *
 * This is intentionally deterministic so catalog refreshes remain safe even if
 * the docs page is unavailable during a sync.
 *
 * @module CoinbaseTransactionTypeCatalogSnapshot
 */

export interface CoinbaseTransactionTypeCatalogSnapshotEntry {
  readonly providerTransactionType: string
  readonly description: string
}

export const COINBASE_TRANSACTION_TYPE_SOURCE_URL =
  "https://docs.cdp.coinbase.com/coinbase-business/track-apis/transactions#transaction-types"

export const COINBASE_TRANSACTION_TYPE_SNAPSHOT_RETRIEVED_AT = "2026-03-21T00:00:00.000Z"

export const coinbaseTransactionTypeCatalogSnapshot: ReadonlyArray<CoinbaseTransactionTypeCatalogSnapshotEntry> =
  [
    {
      providerTransactionType: "advanced_trade_fill",
      description: "Fills for an advanced trade order",
    },
    { providerTransactionType: "buy", description: "Buy a digital asset" },
    { providerTransactionType: "clawback", description: "Recover money already disbursed" },
    {
      providerTransactionType: "derivatives_settlement",
      description:
        "Daily cash transfers between futures and spot accounts for the US-regulated futures product",
    },
    { providerTransactionType: "earn_payout", description: "Payout for user earn on Coinbase" },
    {
      providerTransactionType: "fiat_deposit",
      description: "Deposit funds into a fiat account from a financial institution",
    },
    {
      providerTransactionType: "fiat_withdrawal",
      description: "Withdraw funds from a fiat account",
    },
    {
      providerTransactionType: "incentives_rewards_payout",
      description: "Redemptions for Incentive & Referral campaigns",
    },
    {
      providerTransactionType: "incentives_shared_clawback",
      description: "Clawback incentive payout from customer account",
    },
    {
      providerTransactionType: "intx_deposit",
      description: "Deposit crypto to customer international account",
    },
    {
      providerTransactionType: "intx_withdrawal",
      description: "Withdraw crypto from customer international account",
    },
    { providerTransactionType: "receive", description: "Receive a digital asset" },
    {
      providerTransactionType: "request",
      description: "Request a digital asset from a user or email",
    },
    {
      providerTransactionType: "retail_simple_dust",
      description: "Sweep of dust balance from the account",
    },
    { providerTransactionType: "sell", description: "Sell a digital asset" },
    {
      providerTransactionType: "send",
      description: "Send a supported digital asset to a corresponding address or email",
    },
    {
      providerTransactionType: "staking_transfer",
      description: "Funds from primary account moved to staked account",
    },
    {
      providerTransactionType: "subscription_rebate",
      description: "Transaction for Coinbase subscription rebate",
    },
    {
      providerTransactionType: "subscription",
      description: "Transaction for Coinbase subscription",
    },
    {
      providerTransactionType: "trade",
      description: "Exchange one cryptocurrency for another cryptocurrency or fiat currency",
    },
    {
      providerTransactionType: "transfer",
      description: "Transfer funds between two of your own accounts",
    },
    { providerTransactionType: "tx", description: "Default transaction type, uncategorized" },
    {
      providerTransactionType: "unstaking_transfer",
      description: "Funds from staked funds moved to primary account",
    },
    {
      providerTransactionType: "unsupported_asset_recovery",
      description: "Recover unsupported ERC-20s deposited to Coinbase on ethereum mainnet",
    },
    {
      providerTransactionType: "unwrap_asset",
      description: "Unwrap wrapped assets to the underlying wrappable asset",
    },
    {
      providerTransactionType: "vault_withdrawal",
      description: "Withdraw funds from a vault account",
    },
    {
      providerTransactionType: "wrap_asset",
      description: "Wrap wrappable assets to the wrapped asset representation",
    },
    {
      providerTransactionType: "fcm_futures_usdc_sell",
      description: "Conversion of USDC to USD to support anticipated futures margin requirements",
    },
    {
      providerTransactionType: "fcm_futures_usdc_sell_additional_encumberment_rollup",
      description:
        "Conversion of USDC to USD to support additional futures margin requirements or cover losses",
    },
  ]

export const coinbaseObservedExtraTransactionTypes: ReadonlyArray<CoinbaseTransactionTypeCatalogSnapshotEntry> =
  [
    {
      providerTransactionType: "staking_reward",
      description: "Observed Coinbase live transaction type for staking income rewards",
    },
    {
      providerTransactionType: "retail_instant_unstaking",
      description:
        "Observed Coinbase live transaction type for instant unstaking principal/spread flows",
    },
    {
      providerTransactionType: "retail_eth2_deprecation",
      description: "Observed Coinbase live transaction type for ETH2 deprecation / migration flows",
    },
  ]
