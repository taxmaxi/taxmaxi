/**
 * HeliusSolanaAssetResolutionService - Solana asset metadata and mapping resolution.
 *
 * @module HeliusSolanaAssetResolutionService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ProviderAssetMappingStatus } from "../../../services/ProviderAssetRepository.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import type { HeliusSolanaSyncClientError } from "./HeliusSolanaSyncClient.ts"

/**
 * Canonical Solana blockchain reference name.
 */
export const SOLANA_BLOCKCHAIN_NAME = "solana"

/**
 * Native SOL reference data.
 */
export const SOLANA_NATIVE_SYMBOL = "SOL"

/**
 * Wrapped/native SOL mint used by Solana tooling when a mint-like id is required.
 */
export const SOLANA_WRAPPED_NATIVE_MINT = "So11111111111111111111111111111111111111112"

/**
 * Stable Solana USDC mint.
 */
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

/**
 * Stable Solana USDT mint.
 */
export const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

/**
 * HeliusSolanaAssetKind - Asset reference kind observed during Solana normalization.
 */
export type HeliusSolanaAssetKind = "native" | "spl"

/**
 * HeliusSolanaAssetReference - Minimal asset identity from a raw Solana record.
 */
export interface HeliusSolanaAssetReference {
  readonly kind: HeliusSolanaAssetKind
  readonly mintAddress: string | null
  readonly rawProviderPayload?: unknown
}

/**
 * HeliusSolanaResolvedAsset - Asset resolution result used by Solana normalization.
 */
export interface HeliusSolanaResolvedAsset {
  readonly kind: "canonical" | "review_required"
  readonly assetKind: "native" | "token" | "nft"
  readonly mintAddress: string | null
  readonly providerAssetRowId: string
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
  readonly currencyCode: string
  readonly name: string | null
  readonly decimals: number | null
  readonly tokenProgram: string | null
  readonly nftHint: boolean
  readonly mappingStatus: ProviderAssetMappingStatus
  readonly mappingKind: "asset" | "fiat"
  readonly canonicalAssetId: string | null
  readonly canonicalAssetSymbol: string | null
  readonly canonicalFiatCurrency: string | null
}

/**
 * HeliusSolanaAssetReferenceDataRefreshResult - Counts from Solana asset reference refresh.
 */
export interface HeliusSolanaAssetReferenceDataRefreshResult {
  readonly providerAssetCatalogCount: number
  readonly defaultProviderAssetMappingCount: number
}

/**
 * HeliusSolanaAssetMetadataDecodeError - Helius DAS asset payload was malformed.
 */
export class HeliusSolanaAssetMetadataDecodeError extends Schema.TaggedError<HeliusSolanaAssetMetadataDecodeError>()(
  "HeliusSolanaAssetMetadataDecodeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * HeliusSolanaBrokenApprovedProviderAssetMappingError - Approved mapping points at a missing target.
 */
export class HeliusSolanaBrokenApprovedProviderAssetMappingError extends Schema.TaggedError<HeliusSolanaBrokenApprovedProviderAssetMappingError>()(
  "HeliusSolanaBrokenApprovedProviderAssetMappingError",
  {
    mintAddress: Schema.NullOr(Schema.String),
    providerAssetRowId: Schema.String,
    message: Schema.String,
  }
) {}

/**
 * HeliusSolanaAssetResolutionError - Asset metadata, mapping, and storage failures.
 */
export type HeliusSolanaAssetResolutionError =
  | HeliusSolanaSyncClientError
  | HeliusSolanaAssetMetadataDecodeError
  | HeliusSolanaBrokenApprovedProviderAssetMappingError
  | SyncEngineStorageError

/**
 * HeliusSolanaAssetResolutionServiceShape - Solana asset mapping lifecycle and resolution.
 */
export interface HeliusSolanaAssetResolutionServiceShape {
  /**
   * Ensure built-in SOL/USDC/USDT provider assets and default mapping rows exist.
   */
  readonly ensureDefaultMappings: () => Effect.Effect<
    HeliusSolanaAssetReferenceDataRefreshResult,
    HeliusSolanaAssetResolutionError
  >

  /**
   * Resolve one Solana asset without treating unknown mints as failures.
   */
  readonly resolveAsset: (
    params: HeliusSolanaAssetReference
  ) => Effect.Effect<HeliusSolanaResolvedAsset, HeliusSolanaAssetResolutionError>

  /**
   * Resolve several Solana assets, fetching missing SPL metadata through one DAS batch call.
   */
  readonly resolveAssets: (params: {
    readonly assets: ReadonlyArray<HeliusSolanaAssetReference>
  }) => Effect.Effect<ReadonlyArray<HeliusSolanaResolvedAsset>, HeliusSolanaAssetResolutionError>
}

/**
 * HeliusSolanaAssetResolutionService - Context tag for Solana asset mapping resolution.
 */
export class HeliusSolanaAssetResolutionService extends Context.Tag(
  "HeliusSolanaAssetResolutionService"
)<HeliusSolanaAssetResolutionService, HeliusSolanaAssetResolutionServiceShape>() {}
