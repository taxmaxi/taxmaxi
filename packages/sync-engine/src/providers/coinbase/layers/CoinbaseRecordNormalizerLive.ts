/**
 * CoinbaseRecordNormalizerLive - Coinbase raw-record normalization implementation.
 *
 * @module CoinbaseRecordNormalizerLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
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
  commission: Schema.optional(Schema.Union(Schema.String, CoinbaseMoneySchema)),
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

const CoinbasePayloadSchema = Schema.Union(
  CoinbaseTransactionSchema,
  Schema.Struct({ data: CoinbaseTransactionSchema }),
  Schema.Struct({ transaction: CoinbaseTransactionSchema })
)

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

/**
 * Parse and validate required timestamp fields.
 */
const parseTimestamp = (value: string, field: string) =>
  Effect.gen(function* () {
    const epochMillis = Date.parse(value)

    if (Number.isNaN(epochMillis)) {
      return yield* Effect.fail(
        new CoinbaseRecordNormalizationError({
          message: `Failed to parse ${field}`,
          cause: value,
        })
      )
    }

    return new Date(epochMillis)
  })

/**
 * Parse optional timestamp fields when present.
 */
const parseOptionalTimestamp = (value: string | undefined) =>
  Option.match(Option.fromNullable(value), {
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

const partyAddress = (
  party: CoinbaseTransaction["from"] | CoinbaseTransaction["to"]
): string | null => Option.getOrNull(Option.fromNullable(party?.address))

interface CoinbaseFeeTransferBuildResult {
  readonly transfer: CoinbaseRecordNormalizationResult["feeTransfers"][number] | null
  readonly unresolvedAssetCurrency: string | null
}

const partyAccountRef = (party: CoinbaseTransaction["from"] | CoinbaseTransaction["to"]) => {
  const id = Option.fromNullable(party?.id)
  const resourcePath = Option.fromNullable(party?.resource_path)
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

const buildPrincipalProviderTransfer = ({
  normalizeParams,
  transaction,
  timestamp,
  direction,
}: {
  readonly normalizeParams: NormalizeCoinbaseRecordParams
  readonly transaction: CoinbaseTransaction
  readonly timestamp: Date
  readonly direction: "inbound" | "outbound"
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
    fromAccountRef,
    toAccountRef,
    fromAddress: partyAddress(transaction.from),
    toAddress: partyAddress(transaction.to),
    networkName: transaction.network?.network_name ?? transaction.network?.name ?? null,
    networkHash: transaction.network?.hash ?? null,
    amount: normalizeUnsignedAmount(transaction.amount.amount),
    metadata: providerTransferMetadata({
      normalizeParams,
      transaction,
    }),
  }
}

const buildPrincipalProviderTransfers = ({
  normalizeParams,
  transaction,
  timestamp,
}: {
  readonly normalizeParams: NormalizeCoinbaseRecordParams
  readonly transaction: CoinbaseTransaction
  readonly timestamp: Date
}): ReadonlyArray<CoinbaseRecordNormalizationResult["providerTransfers"][number]> => {
  switch (transaction.type) {
    case "send":
      return [
        buildPrincipalProviderTransfer({
          normalizeParams,
          transaction,
          timestamp,
          direction: "outbound",
        }),
      ]
    case "receive":
      return [
        buildPrincipalProviderTransfer({
          normalizeParams,
          transaction,
          timestamp,
          direction: "inbound",
        }),
      ]
    case "intx_deposit":
    case "intx_withdrawal":
    case "transfer": {
      const direction = movementDirectionFromSignedAmount(transaction.amount.amount)
      return direction === null
        ? []
        : [
            buildPrincipalProviderTransfer({
              normalizeParams,
              transaction,
              timestamp,
              direction,
            }),
          ]
    }
    default:
      return []
  }
}

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
      Option.flatMap(Option.fromNullable(networkName), (network) =>
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
    const decodedPayload = yield* Schema.decodeUnknown(CoinbasePayloadSchema)(
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
        Option.fromNullable(transactionPayload.network?.transaction_fee).pipe(
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

    const feeTransfers = feeTransferResults.flatMap((result) =>
      result.transfer === null ? [] : [result.transfer]
    )
    const providerTransfers = buildPrincipalProviderTransfers({
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
      feeTransfers,
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
