/**
 * CoinbaseProviderAssetEvidence - Typed origin evidence for persisted Coinbase assets.
 *
 * @module CoinbaseProviderAssetEvidence
 */

import * as Schema from "effect/Schema"

/** Origin of a Coinbase provider-asset observation. */
export const CoinbaseProviderAssetEvidenceSourceSchema = Schema.Literals([
  "coinbase_fiat_currency_catalog",
  "coinbase_crypto_currency_catalog",
  "coinbase_transaction_observation",
])

export type CoinbaseProviderAssetEvidenceSource =
  typeof CoinbaseProviderAssetEvidenceSourceSchema.Type

/** Persisted envelope that keeps TaxMaxi-owned origin separate from provider payloads. */
export const CoinbaseProviderAssetEvidenceSchema = Schema.Struct({
  source: CoinbaseProviderAssetEvidenceSourceSchema,
  providerPayload: Schema.Unknown,
})

export type CoinbaseProviderAssetEvidence = typeof CoinbaseProviderAssetEvidenceSchema.Type

/** Wrap an unknown provider payload with its trusted TaxMaxi ingestion source. */
export const makeCoinbaseProviderAssetEvidence = ({
  source,
  providerPayload,
}: {
  readonly source: CoinbaseProviderAssetEvidenceSource
  readonly providerPayload: unknown
}): CoinbaseProviderAssetEvidence => ({ source, providerPayload })
