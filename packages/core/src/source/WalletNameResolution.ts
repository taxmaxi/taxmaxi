/**
 * WalletNameResolution - Shared contract for wallet name resolution outcomes.
 *
 * @module source/WalletNameResolution
 */

import * as Schema from "effect/Schema"

/**
 * Stable machine-readable codes for wallet name resolution failures.
 */
export const WALLET_NAME_RESOLUTION_ERROR_CODES = [
  "invalid_name",
  "name_unresolved",
  "network_unavailable",
  "rate_limited",
  "resolution_failed",
] as const

/**
 * WalletNameResolutionErrorCode - Why a wallet name could not be resolved.
 */
export const WalletNameResolutionErrorCode = Schema.Literals(
  WALLET_NAME_RESOLUTION_ERROR_CODES
).annotate({
  identifier: "WalletNameResolutionErrorCode",
  title: "Wallet Name Resolution Error Code",
  description: "Machine-readable reason code explaining why a wallet name did not resolve",
})

/**
 * The WalletNameResolutionErrorCode type.
 */
export type WalletNameResolutionErrorCode = typeof WalletNameResolutionErrorCode.Type

/**
 * Type guard for WalletNameResolutionErrorCode using Schema.is.
 */
export const isWalletNameResolutionErrorCode = Schema.is(WalletNameResolutionErrorCode)
