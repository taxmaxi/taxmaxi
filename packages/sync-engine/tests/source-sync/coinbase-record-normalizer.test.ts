import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { CoinbaseRecordNormalizerLive } from "../../src/providers/coinbase/layers/CoinbaseRecordNormalizerLive.ts"
import { CoinbaseRecordNormalizer } from "../../src/providers/coinbase/services/CoinbaseRecordNormalizer.ts"
import type { SourceRawRecord, SourceSyncSource } from "../../src/services/SourceSyncModels.ts"

const observedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-01T10:00:00.000Z"))

const source: SourceSyncSource = {
  id: "00000000-0000-4000-8000-000000000201",
  principalId: "00000000-0000-4000-8000-000000000102",
  providerKey: "coinbase",
  cexAccountId: "00000000-0000-4000-8000-000000000301",
  addressId: null,
  walletAddress: null,
}

const sourceRecord = (payload: unknown): SourceRawRecord => ({
  id: "00000000-0000-4000-8000-000000000401",
  sourceId: source.id,
  provider: "coinbase",
  recordType: "coinbase_transaction",
  externalAccountId: "coinbase-account-1",
  externalRecordId: "advanced-trade-fill-1",
  externalParentId: null,
  occurredAt: observedAt,
  payload,
  importedAt: observedAt,
  normalizedAt: null,
  normalizationError: null,
  createdAt: observedAt,
  updatedAt: observedAt,
})

const advancedTradeFill = ({
  type = "advanced_trade_fill",
  side = "SELL",
  productId = "BTC-EUR",
  amount = "-0.4",
  amountCurrency = "BTC",
  nativeAmount = "-6000",
  nativeCurrency = "EUR",
}: {
  readonly type?: string
  readonly side?: string
  readonly productId?: string
  readonly amount?: string
  readonly amountCurrency?: string
  readonly nativeAmount?: string
  readonly nativeCurrency?: string
} = {}) => ({
  id: "advanced-trade-fill-1",
  type,
  status: "completed",
  amount: { amount, currency: amountCurrency },
  native_amount: { amount: nativeAmount, currency: nativeCurrency },
  created_at: observedAt.toISOString(),
  resource_path: "/v2/accounts/coinbase-account-1/transactions/advanced-trade-fill-1",
  advanced_trade_fill: {
    order_side: side,
    product_id: productId,
  },
})

const normalizeProviderFiat = (payload: unknown) =>
  Effect.gen(function* () {
    const normalizer = yield* CoinbaseRecordNormalizer
    const result = yield* normalizer.normalize({
      source,
      sourceRecord: sourceRecord(payload),
      resolveAsset: () =>
        Effect.succeed({
          assetId: Option.none(),
          providerAssetRowId: "00000000-0000-4000-8000-000000000501",
        }),
      resolveBlockchainId: () => Option.none(),
    })

    return {
      amount: result.transaction.providerFiatAmount,
      currency: result.transaction.providerFiatCurrency,
    }
  }).pipe(Effect.provide(CoinbaseRecordNormalizerLive))

it.effect("converts only proven advanced-trade SELL and sell debits to observed magnitude", () =>
  Effect.gen(function* () {
    const results = yield* Effect.all([
      normalizeProviderFiat(advancedTradeFill()),
      normalizeProviderFiat(advancedTradeFill({ side: "sell" })),
      normalizeProviderFiat(advancedTradeFill({ type: "sell" })),
      normalizeProviderFiat(advancedTradeFill({ side: "Sell" })),
      normalizeProviderFiat(advancedTradeFill({ side: "BUY" })),
      normalizeProviderFiat(advancedTradeFill({ side: "buy" })),
      normalizeProviderFiat(advancedTradeFill({ productId: "ETH-EUR" })),
      normalizeProviderFiat(advancedTradeFill({ productId: "BTC-USD" })),
      normalizeProviderFiat(advancedTradeFill({ amount: "0.4" })),
      normalizeProviderFiat(advancedTradeFill({ amount: "-0" })),
      normalizeProviderFiat(advancedTradeFill({ nativeAmount: "-0.0" })),
      normalizeProviderFiat(advancedTradeFill({ nativeAmount: "6000" })),
    ])

    expect(results).toEqual([
      { amount: "6000", currency: "EUR" },
      { amount: "6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: "-6000", currency: "EUR" },
      { amount: null, currency: null },
      { amount: "6000", currency: "EUR" },
    ])
  })
)

it.effect("keeps each same-currency fee paired with its resolved provider row", () =>
  Effect.gen(function* () {
    const firstAssetId = "00000000-0000-4000-8000-000000000511"
    const secondAssetId = "00000000-0000-4000-8000-000000000512"
    const firstProviderAssetRowId = "00000000-0000-4000-8000-000000000513"
    const secondProviderAssetRowId = "00000000-0000-4000-8000-000000000514"
    const resolutions = [
      { assetId: firstAssetId, providerAssetRowId: firstProviderAssetRowId },
      { assetId: secondAssetId, providerAssetRowId: secondProviderAssetRowId },
    ] as const
    let resolutionIndex = 0
    const normalizer = yield* CoinbaseRecordNormalizer
    const result = yield* normalizer.normalize({
      source,
      sourceRecord: sourceRecord({
        ...advancedTradeFill(),
        network: {
          status: "confirmed",
          hash: "dual-fee-hash",
          network_name: "bitcoin",
          transaction_fee: { amount: "0.0001", currency: "BTC" },
        },
        advanced_trade_fill: {
          ...advancedTradeFill().advanced_trade_fill,
          commission: { amount: "0.0002", currency: "BTC" },
        },
      }),
      resolveAsset: () =>
        Effect.gen(function* () {
          const resolution = resolutions[resolutionIndex]
          resolutionIndex += 1
          if (resolution === undefined) {
            return yield* Effect.die("Unexpected extra Coinbase fee asset resolution")
          }
          return {
            assetId: Option.some(resolution.assetId),
            providerAssetRowId: resolution.providerAssetRowId,
          }
        }),
      resolveBlockchainId: () => Option.none(),
    })
    const pairs = yield* Effect.forEach(result.canonicalTransfers, (transfer) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({ providerAssetRowId: Schema.String.check(Schema.isUUID()) })
      )(transfer.metadata).pipe(
        Effect.map((metadata) => ({
          assetId: transfer.assetId,
          providerAssetRowId: String(metadata.providerAssetRowId),
        }))
      )
    )

    expect(pairs).toEqual(
      expect.arrayContaining([
        { assetId: firstAssetId, providerAssetRowId: firstProviderAssetRowId },
        { assetId: secondAssetId, providerAssetRowId: secondProviderAssetRowId },
      ])
    )
  }).pipe(Effect.provide(CoinbaseRecordNormalizerLive))
)
