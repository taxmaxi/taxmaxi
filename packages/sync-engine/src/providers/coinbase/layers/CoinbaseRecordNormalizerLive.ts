/**
 * CoinbaseRecordNormalizerLive - Coinbase raw-record normalization implementation.
 *
 * @module CoinbaseRecordNormalizerLive
 */

import * as Effect from "effect/Effect"
import * as DateTime from "effect/DateTime"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { isZeroAmount, subtractFeeFromDebit } from "../shared/CoinbaseDecimal.ts"
import { feeIsPartOfDebit } from "../shared/CoinbaseNetworkFee.ts"
import {
  type CoinbaseRecordNormalizationResult,
  CoinbaseRecordNormalizationError,
  CoinbaseRecordNormalizer,
  type CoinbaseRecordNormalizerShape,
  type NormalizeCoinbaseRecordParams,
} from "../services/CoinbaseRecordNormalizer.ts"

// =============================================================================
// Coinbase Payload Schemas
// =============================================================================

const CoinbaseMoneySchema = Schema.Struct({
  amount: Schema.String,
  currency: Schema.String,
})

const CoinbasePartySchema = Schema.Struct({
  resource: Schema.String,
  address: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  resource_path: Schema.optional(Schema.String),
})

const CoinbaseNetworkSchema = Schema.Struct({
  status: Schema.String,
  hash: Schema.optional(Schema.String),
  network_name: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  transaction_fee: Schema.optional(CoinbaseMoneySchema),
})

const CoinbaseAdvancedTradeFillSchema = Schema.Struct({
  fill_price: Schema.optional(Schema.String),
  product_id: Schema.optional(Schema.String),
  order_id: Schema.optional(Schema.String),
  order_side: Schema.optional(Schema.String),
  commission: Schema.optional(Schema.Union([Schema.String, CoinbaseMoneySchema])),
})

const CoinbaseTransactionSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  status: Schema.String,
  amount: CoinbaseMoneySchema,
  native_amount: CoinbaseMoneySchema,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  updated_at: Schema.optional(Schema.String),
  resource_path: Schema.String,
  network: Schema.optional(CoinbaseNetworkSchema),
  to: Schema.optional(CoinbasePartySchema),
  from: Schema.optional(CoinbasePartySchema),
  advanced_trade_fill: Schema.optional(CoinbaseAdvancedTradeFillSchema),
})

const CoinbasePayloadSchema = Schema.Union([
  CoinbaseTransactionSchema,
  Schema.Struct({ data: CoinbaseTransactionSchema }),
  Schema.Struct({ transaction: CoinbaseTransactionSchema }),
])

type CoinbaseMoney = Schema.Schema.Type<typeof CoinbaseMoneySchema>
type CoinbaseTransaction = Schema.Schema.Type<typeof CoinbaseTransactionSchema>
type CoinbasePayload = Schema.Schema.Type<typeof CoinbasePayloadSchema>

/**
 * Narrows union payload into direct Coinbase transaction shape.
 */
const isCoinbaseTransaction = (payload: CoinbasePayload): payload is CoinbaseTransaction =>
  "id" in payload

const extractCoinbaseTransaction = (payload: CoinbasePayload): CoinbaseTransaction => {
  if (isCoinbaseTransaction(payload)) {
    return payload
  }

  if ("data" in payload) {
    return payload.data
  }

  return payload.transaction
}

const toNullable = (value: string | undefined): string | null => value ?? null

const PROVIDER_FIAT_AMOUNT_PATTERN = /^-?[0-9]+(\.[0-9]+)?$/
const NEGATIVE_DECIMAL_AMOUNT_PATTERN = /^-[0-9]+(\.[0-9]+)?$/

const isNegativeZeroAmount = (amount: string): boolean =>
  amount.startsWith("-") && isZeroAmount(amount)

/**
 * Coinbase documents negative amount and native_amount as debit signs for an
 * advanced-trade SELL. Convert only when the raw side and product currencies
 * prove that exact case; every unclear negative value remains signed.
 */
const advancedTradeSellNativeMagnitude = (transaction: CoinbaseTransaction): string | undefined => {
  if (
    transaction.type !== "advanced_trade_fill" ||
    transaction.advanced_trade_fill?.order_side !== "SELL" ||
    !NEGATIVE_DECIMAL_AMOUNT_PATTERN.test(transaction.amount.amount) ||
    !NEGATIVE_DECIMAL_AMOUNT_PATTERN.test(transaction.native_amount.amount) ||
    isZeroAmount(transaction.amount.amount) ||
    isZeroAmount(transaction.native_amount.amount)
  ) {
    return undefined
  }

  const productCurrencies = transaction.advanced_trade_fill.product_id?.split("-")
  if (productCurrencies?.length !== 2) return undefined

  const [baseCurrency, quoteCurrency] = productCurrencies
  if (
    baseCurrency === undefined ||
    quoteCurrency === undefined ||
    baseCurrency === "" ||
    quoteCurrency === "" ||
    baseCurrency.toUpperCase() !== transaction.amount.currency.toUpperCase() ||
    quoteCurrency.toUpperCase() !== transaction.native_amount.currency.toUpperCase()
  ) {
    return undefined
  }

  return transaction.native_amount.amount.slice(1)
}

/**
 * Keep only well-formed provider-native decimals. The one documented SELL
 * debit convention is converted above; no other negative value is changed.
 */
const toProviderFiat = (
  transaction: CoinbaseTransaction
): { amount: string; currency: string } | null =>
  PROVIDER_FIAT_AMOUNT_PATTERN.test(transaction.native_amount.amount) &&
  !isNegativeZeroAmount(transaction.native_amount.amount)
    ? {
        amount: advancedTradeSellNativeMagnitude(transaction) ?? transaction.native_amount.amount,
        currency: transaction.native_amount.currency.toUpperCase(),
      }
    : null

/**
 * Parse and validate required timestamp fields.
 */
const parseTimestamp = (value: string, field: string) =>
  Effect.gen(function* () {
    const epochMillis = Date.parse(value)

    if (Number.isNaN(epochMillis)) {
      return yield* new CoinbaseRecordNormalizationError({
        message: `Failed to parse ${field}`,
        cause: value,
      })
    }

    return DateTime.toDateUtc(DateTime.makeUnsafe(epochMillis))
  })

/**
 * Parse optional timestamp fields when present.
 */
const parseOptionalTimestamp = (value: string | undefined) =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => Effect.succeed<Date | null>(null),
    onSome: (timestamp) => parseTimestamp(timestamp, "provider_updated_at"),
  })

/**
 * Derive quote currency from product id formats like BTC-USD, BTC_USD, BTC/USD.
 */
const deriveQuoteCurrencyFromProduct = (productId: string | undefined): Option.Option<string> => {
  if (productId === undefined) {
    return Option.none()
  }

  const separators = ["-", "_", "/"]
  for (const separator of separators) {
    const parts = productId.split(separator)
    if (parts.length === 2 && parts[1] !== undefined && parts[1] !== "") {
      return Option.some(parts[1].toUpperCase())
    }
  }

  return Option.none()
}

/**
 * Normalize commission payload into money shape.
 */
const toCommissionMoney = (
  commission: string | CoinbaseMoney | undefined,
  fallbackCurrency: string,
  productId: string | undefined
): Option.Option<CoinbaseMoney> => {
  if (commission === undefined) {
    return Option.none()
  }

  if (typeof commission !== "string") {
    return Option.some(commission)
  }

  const quoteCurrency = deriveQuoteCurrencyFromProduct(productId)
  return Option.some({
    amount: commission,
    currency: Option.getOrElse(quoteCurrency, () => fallbackCurrency),
  })
}

const partyAddress = (party: CoinbaseTransaction["from"]): string | null =>
  Option.getOrNull(Option.fromNullishOr(party?.address))

interface CoinbaseFeeTransferBuildResult {
  readonly transfer: CoinbaseRecordNormalizationResult["canonicalTransfers"][number] | null
  readonly unresolvedAssetCurrency: string | null
}

const partyAccountRef = (party: CoinbaseTransaction["from"]) => {
  const id = Option.fromNullishOr(party?.id)
  const resourcePath = Option.fromNullishOr(party?.resource_path)
  return Option.getOrNull(Option.orElse(id, () => resourcePath))
}

const ownAccountRef = ({
  explicitAccountRef,
  fallback,
}: {
  readonly explicitAccountRef: string | null
  readonly fallback: string
}) => explicitAccountRef ?? fallback

const normalizeUnsignedAmount = (amount: string): string =>
  amount.startsWith("-") || amount.startsWith("+") ? amount.slice(1) : amount

const movementDirectionFromSignedAmount = (amount: string): "inbound" | "outbound" | null => {
  if (amount.startsWith("-")) {
    return "outbound"
  }

  if (amount.startsWith("+") || amount.trim() !== "") {
    return "inbound"
  }

  return null
}

const providerTransferMetadata = ({
  normalizeParams,
  transaction,
}: {
  readonly normalizeParams: NormalizeCoinbaseRecordParams
  readonly transaction: CoinbaseTransaction
}) => ({
  provider: "coinbase",
  principalId: normalizeParams.source.principalId,
  coinbaseTransactionId: transaction.id,
  providerStatus: transaction.status,
  providerTransactionType: transaction.type,
})

/**
 * Coinbase reports an outbound `amount` as the full wallet debit including a
 * same-currency network fee. The principal transfer only covers what leaves
 * toward the recipient, so the fee is subtracted here; the fee transfer covers
 * the rest and together they equal the debit. Fees in another currency or in
 * the native fiat currency leave the amount untouched.
 */
const deriveOutboundPrincipalAmount = (
  transaction: CoinbaseTransaction
): Effect.Effect<string, CoinbaseRecordNormalizationError> => {
  const fee = transaction.network?.transaction_fee

  if (
    fee === undefined ||
    !feeIsPartOfDebit({
      feeCurrency: fee.currency,
      amountCurrency: transaction.amount.currency,
      nativeCurrency: transaction.native_amount.currency,
    })
  ) {
    return Effect.succeed(normalizeUnsignedAmount(transaction.amount.amount))
  }

  return subtractFeeFromDebit({
    debitAmount: transaction.amount.amount,
    feeAmount: fee.amount,
    onFeeAboveDebit: () =>
      new CoinbaseRecordNormalizationError({
        message: `Network fee ${fee.amount} ${fee.currency} exceeds the debited amount ${transaction.amount.amount} ${transaction.amount.currency}`,
      }),
    onInvalid: (value) =>
      new CoinbaseRecordNormalizationError({
        message: `Invalid decimal amount: ${value}`,
      }),
  })
}

const buildPrincipalProviderTransfer = ({
  normalizeParams,
  transaction,
  timestamp,
  direction,
  amount,
}: {
  readonly normalizeParams: NormalizeCoinbaseRecordParams
  readonly transaction: CoinbaseTransaction
  readonly timestamp: Date
  readonly direction: "inbound" | "outbound"
  readonly amount: string
}): CoinbaseRecordNormalizationResult["providerTransfers"][number] => {
  const ownAccountFallback = normalizeParams.sourceRecord.externalAccountId ?? "coinbase:account"
  const fromAccountRef =
    direction === "outbound"
      ? ownAccountRef({
          explicitAccountRef: partyAccountRef(transaction.from),
          fallback: ownAccountFallback,
        })
      : ownAccountRef({
          explicitAccountRef: partyAccountRef(transaction.from),
          fallback: "coinbase:source",
        })
  const toAccountRef =
    direction === "inbound"
      ? ownAccountRef({
          explicitAccountRef: partyAccountRef(transaction.to),
          fallback: ownAccountFallback,
        })
      : ownAccountRef({
          explicitAccountRef: partyAccountRef(transaction.to),
          fallback: "coinbase:destination",
        })

  return {
    sourceId: normalizeParams.sourceRecord.sourceId,
    sourceRawRecordId: normalizeParams.sourceRecord.id,
    externalId: `${transaction.id}:principal`,
    externalGroupId: transaction.id,
    providerAssetId: null,
    timestamp,
    direction,
    processingMode: "accounting_and_evidence",
    fromAccountRef,
    toAccountRef,
    fromAddress: partyAddress(transaction.from),
    toAddress: partyAddress(transaction.to),
    networkName: transaction.network?.network_name ?? transaction.network?.name ?? null,
    networkHash: transaction.network?.hash ?? null,
    amount,
    metadata: providerTransferMetadata({
      normalizeParams,
      transaction,
    }),
  }
}

/**
 * Direction of the row's principal movement, or null for types that move no
 * principal. Coinbase reports send deposits with a positive amount and send
 * withdrawals with a negative amount, so the sign decides the direction.
 */
const principalTransferDirection = (
  transaction: CoinbaseTransaction
): "inbound" | "outbound" | null => {
  switch (transaction.type) {
    case "receive":
      return "inbound"
    case "send":
    case "intx_deposit":
    case "intx_withdrawal":
    case "transfer":
      return movementDirectionFromSignedAmount(transaction.amount.amount)
    default:
      return null
  }
}

const networkFeeDirection = (transaction: CoinbaseTransaction): "inbound" | "outbound" | null =>
  transaction.type === "tx"
    ? movementDirectionFromSignedAmount(transaction.amount.amount)
    : principalTransferDirection(transaction)

const buildPrincipalProviderTransfers = ({
  normalizeParams,
  transaction,
  timestamp,
}: {
  readonly normalizeParams: NormalizeCoinbaseRecordParams
  readonly transaction: CoinbaseTransaction
  readonly timestamp: Date
}): Effect.Effect<
  ReadonlyArray<CoinbaseRecordNormalizationResult["providerTransfers"][number]>,
  CoinbaseRecordNormalizationError
> =>
  Effect.gen(function* () {
    const direction = principalTransferDirection(transaction)
    if (direction === null) {
      return []
    }

    // Only an outbound row carries the fee inside its debit; an inbound row's
    // fee was paid by the sender, so the credited amount stays untouched. A
    // debit fully covered by its network fee leaves no principal to move, so
    // the fee transfer alone accounts for the row.
    const amount =
      direction === "outbound"
        ? yield* deriveOutboundPrincipalAmount(transaction)
        : normalizeUnsignedAmount(transaction.amount.amount)

    return isZeroAmount(amount)
      ? []
      : [
          buildPrincipalProviderTransfer({
            normalizeParams,
            transaction,
            timestamp,
            direction,
            amount,
          }),
        ]
  })

/**
 * Build a canonical fee transfer row from Coinbase fee payloads.
 */
const buildFeeTransfer = (params: {
  readonly normalizeParams: NormalizeCoinbaseRecordParams
  readonly transaction: CoinbaseTransaction
  readonly timestamp: Date
  readonly externalSuffix: "network_fee" | "commission"
  readonly money: CoinbaseMoney
  readonly notes: string
  readonly toAccountRef: string
}) =>
  Effect.gen(function* () {
    if (
      params.money.currency.toUpperCase() ===
      params.transaction.native_amount.currency.toUpperCase()
    ) {
      return {
        transfer: null,
        unresolvedAssetCurrency: null,
      } satisfies CoinbaseFeeTransferBuildResult
    }

    const assetId = yield* params.normalizeParams.resolveAssetId(params.money.currency)

    if (Option.isNone(assetId)) {
      return {
        transfer: null,
        unresolvedAssetCurrency: params.money.currency.toUpperCase(),
      } satisfies CoinbaseFeeTransferBuildResult
    }

    const networkName = params.transaction.network?.network_name ?? params.transaction.network?.name
    const blockchainId = Option.getOrNull(
      Option.flatMap(Option.fromNullishOr(networkName), (network) =>
        params.normalizeParams.resolveBlockchainId(network)
      )
    )

    return {
      transfer: {
        sourceId: params.normalizeParams.sourceRecord.sourceId,
        principalId: params.normalizeParams.source.principalId,
        sourceRawRecordId: params.normalizeParams.sourceRecord.id,
        externalId: `${params.transaction.id}:${params.externalSuffix}`,
        externalGroupId: params.transaction.id,
        addressId: params.normalizeParams.source.addressId,
        blockchainId,
        txHash: null,
        timestamp: params.timestamp,
        type: "fee",
        fromAddress: partyAddress(params.transaction.from),
        toAddress: null,
        fromAccountRef: ownAccountRef({
          explicitAccountRef: partyAccountRef(params.transaction.from),
          fallback: params.normalizeParams.sourceRecord.externalAccountId ?? "coinbase:account",
        }),
        toAccountRef: params.toAccountRef,
        fromPartyType: toNullable(params.transaction.from?.resource),
        fromPartyResourcePath: toNullable(params.transaction.from?.resource_path),
        toPartyType: "fee",
        toPartyResourcePath: null,
        assetId: assetId.value,
        assetRepresentationId: null,
        amount: params.money.amount,
        tokenId: null,
        notes: params.notes,
        metadata: {
          provider: "coinbase",
          principalId: params.normalizeParams.source.principalId,
          coinbaseTransactionId: params.transaction.id,
          providerStatus: params.transaction.status,
          networkHash: params.transaction.network?.hash ?? null,
        },
      },
      unresolvedAssetCurrency: null,
    } satisfies CoinbaseFeeTransferBuildResult
  })

/**
 * Normalize a Coinbase raw record into canonical transaction artifacts.
 */
const normalizeCoinbaseRecord = (params: NormalizeCoinbaseRecordParams) =>
  Effect.gen(function* () {
    const decodedPayload = yield* Schema.decodeUnknownEffect(CoinbasePayloadSchema)(
      params.sourceRecord.payload
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CoinbaseRecordNormalizationError({
            message: "Failed to decode Coinbase transaction payload",
            cause,
          })
      )
    )

    const transactionPayload = extractCoinbaseTransaction(decodedPayload)
    const createdAt = yield* parseTimestamp(transactionPayload.created_at, "provider_created_at")
    const updatedAt = yield* parseOptionalTimestamp(transactionPayload.updated_at)

    const commission = toCommissionMoney(
      transactionPayload.advanced_trade_fill?.commission,
      transactionPayload.native_amount.currency,
      transactionPayload.advanced_trade_fill?.product_id
    )

    const feeTransferResults = yield* Effect.all(
      [
        // A network fee on an inbound row was paid by the sender, so it must
        // not become a fee transfer that consumes the recipient's inventory.
        Option.fromNullishOr(transactionPayload.network?.transaction_fee).pipe(
          Option.filter(() => networkFeeDirection(transactionPayload) !== "inbound"),
          Option.map((money) =>
            buildFeeTransfer({
              normalizeParams: params,
              transaction: transactionPayload,
              timestamp: createdAt,
              externalSuffix: "network_fee",
              money,
              notes: "Coinbase network transaction fee",
              toAccountRef: "coinbase:network",
            })
          )
        ),
        Option.map(commission, (money) =>
          buildFeeTransfer({
            normalizeParams: params,
            transaction: transactionPayload,
            timestamp: createdAt,
            externalSuffix: "commission",
            money,
            notes: "Coinbase trade commission",
            toAccountRef: "coinbase:commission",
          })
        ),
      ].flatMap((candidate) => Option.getOrElse(candidate, () => [])),
      { concurrency: 2 }
    )

    const canonicalTransfers = feeTransferResults.flatMap((result) =>
      result.transfer === null ? [] : [result.transfer]
    )
    const providerTransfers = yield* buildPrincipalProviderTransfers({
      normalizeParams: params,
      transaction: transactionPayload,
      timestamp: createdAt,
    })
    const unresolvedAssetCurrencies = Array.from(
      new Set(
        feeTransferResults.flatMap((result) =>
          result.unresolvedAssetCurrency === null ? [] : [result.unresolvedAssetCurrency]
        )
      )
    )

    const providerFiat = toProviderFiat(transactionPayload)

    const result: CoinbaseRecordNormalizationResult = {
      transaction: {
        sourceId: params.source.id,
        sourceRawRecordId: params.sourceRecord.id,
        externalId: transactionPayload.id,
        externalGroupId:
          transactionPayload.advanced_trade_fill?.order_id ??
          params.sourceRecord.externalParentId ??
          transactionPayload.id,
        timestamp: createdAt,
        transactionType: null,
        providerTransactionType: transactionPayload.type,
        providerStatus: transactionPayload.status,
        providerResourcePath: transactionPayload.resource_path,
        providerDescription: transactionPayload.description ?? null,
        providerCreatedAt: createdAt,
        providerUpdatedAt: updatedAt,
        metadata: {
          provider: "coinbase",
          amount: transactionPayload.amount,
          nativeAmount: transactionPayload.native_amount,
          network: transactionPayload.network ?? null,
          from: transactionPayload.from ?? null,
          to: transactionPayload.to ?? null,
        },
        providerFiatAmount: providerFiat?.amount ?? null,
        providerFiatCurrency: providerFiat?.currency ?? null,
        principalId: params.source.principalId,
      },
      venueContext: {
        venueType: "cex",
        cexAccountId: params.source.cexAccountId,
        externalAccountId: params.sourceRecord.externalAccountId,
        externalOrderId: toNullable(transactionPayload.advanced_trade_fill?.order_id),
        externalFillId:
          transactionPayload.type === "advanced_trade_fill" ? transactionPayload.id : null,
        side: toNullable(transactionPayload.advanced_trade_fill?.order_side),
        instrument: toNullable(transactionPayload.advanced_trade_fill?.product_id),
        fillPrice: toNullable(transactionPayload.advanced_trade_fill?.fill_price),
        commissionAmount: Option.getOrNull(Option.map(commission, (it) => it.amount)),
        commissionCurrency: Option.getOrNull(Option.map(commission, (it) => it.currency)),
        metadata: {
          provider: "coinbase",
          recordType: params.sourceRecord.recordType,
          advancedTradeFill: transactionPayload.advanced_trade_fill ?? null,
        },
      },
      providerTransfers,
      canonicalTransfers,
      unresolvedAssetCurrencies,
      primaryAssetCurrency: transactionPayload.amount.currency,
    }

    return result
  })

/**
 * CoinbaseRecordNormalizerLive - Build the Coinbase-only normalizer.
 */
const make = Effect.succeed<CoinbaseRecordNormalizerShape>({
  normalize: normalizeCoinbaseRecord,
})

/**
 * CoinbaseRecordNormalizerLive - Layer providing Coinbase normalization.
 */
export const CoinbaseRecordNormalizerLive = Layer.effect(CoinbaseRecordNormalizer, make)
