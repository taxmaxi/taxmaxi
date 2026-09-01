import { expect, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
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
      resolveAssetId: () => Effect.succeed(Option.none()),
      resolveBlockchainId: () => Option.none(),
    })

    return {
      amount: result.transaction.providerFiatAmount,
      currency: result.transaction.providerFiatCurrency,
    }
  }).pipe(Effect.provide(CoinbaseRecordNormalizerLive))

it.effect("converts only a proven advanced-trade SELL debit to observed magnitude", () =>
  Effect.gen(function* () {
    const results = yield* Effect.all([
      normalizeProviderFiat(advancedTradeFill()),
      normalizeProviderFiat(advancedTradeFill({ type: "sell" })),
      normalizeProviderFiat(advancedTradeFill({ side: "sell" })),
      normalizeProviderFiat(advancedTradeFill({ side: "BUY" })),
      normalizeProviderFiat(advancedTradeFill({ productId: "ETH-EUR" })),
      normalizeProviderFiat(advancedTradeFill({ productId: "BTC-USD" })),
      normalizeProviderFiat(advancedTradeFill({ amount: "0.4" })),
      normalizeProviderFiat(advancedTradeFill({ amount: "-0" })),
      normalizeProviderFiat(advancedTradeFill({ nativeAmount: "-0.0" })),
      normalizeProviderFiat(advancedTradeFill({ nativeAmount: "6000" })),
    ])

    expect(results).toEqual([
      { amount: "6000", currency: "EUR" },
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
