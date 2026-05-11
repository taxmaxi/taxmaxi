/**
 * CoinbaseLegDerivationServiceLive - Deterministic Coinbase leg derivation.
 *
 * @module CoinbaseLegDerivationServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  absoluteDecimal,
  divideToScale,
  isNegativeAmount,
  makeFixedPointErrorFactory,
  parseDecimal,
  powerOfTen,
} from "../shared/CoinbaseFixedPoint.ts"
import {
  CoinbaseLegDerivationError,
  CoinbaseLegDerivationService,
  type CoinbaseLegDerivationResult,
  type CoinbaseLegDerivationServiceShape,
  type DeriveCoinbaseLegsParams,
} from "../services/CoinbaseLegDerivationService.ts"

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

const CoinbaseMetadataSchema = Schema.Struct({
  amount: CoinbaseMoneySchema,
  nativeAmount: CoinbaseMoneySchema,
  network: Schema.NullOr(Schema.Unknown),
  from: Schema.NullOr(CoinbasePartySchema),
  to: Schema.NullOr(CoinbasePartySchema),
  coinbaseReferenceMapping: Schema.Struct({
    transactionType: Schema.NullOr(Schema.String),
    inventoryEffect: Schema.Literal(
      "acquisition",
      "disposal",
      "income",
      "internal_transfer",
      "non_inventory",
      "unknown"
    ),
    taxTreatment: Schema.Literal(
      "taxable_by_default",
      "non_taxable_by_default",
      "requires_additional_rule_logic"
    ),
    resolutionStrategy: Schema.Literal(
      "static",
      "amount_sign",
      "venue_side",
      "amount_sign_fee",
      "no_leg"
    ),
    pairedRecordRequired: Schema.Boolean,
    mappingStatus: Schema.Literal("approved", "pending_review"),
  }),
})

type CoinbaseMetadata = Schema.Schema.Type<typeof CoinbaseMetadataSchema>

const fixedPointErrorFactory = makeFixedPointErrorFactory(
  ({ message }) =>
    new CoinbaseLegDerivationError({
      message,
    })
)

const decodeCoinbaseMetadata = (
  metadata: unknown
): Effect.Effect<CoinbaseMetadata, CoinbaseLegDerivationError> =>
  Schema.decodeUnknown(CoinbaseMetadataSchema)(metadata).pipe(
    Effect.mapError(
      (cause) =>
        new CoinbaseLegDerivationError({
          message: "Failed to decode normalized Coinbase transaction metadata",
          cause,
        })
    )
  )

const instrumentQuoteCurrency = (instrument: string | null): Option.Option<string> => {
  if (instrument === null) {
    return Option.none()
  }

  for (const separator of ["-", "_", "/"]) {
    const parts = instrument.split(separator)
    if (parts.length === 2 && parts[1] !== undefined && parts[1] !== "") {
      return Option.some(parts[1].toUpperCase())
    }
  }

  return Option.none()
}

const shouldSkipQuoteSideMainLeg = (metadata: CoinbaseMetadata): boolean => {
  const transactionType = metadata.coinbaseReferenceMapping.transactionType

  if (transactionType !== "buy_fiat" && transactionType !== "sell_fiat") {
    return false
  }

  return metadata.amount.currency.toUpperCase() === metadata.nativeAmount.currency.toUpperCase()
}

/**
 * Determine the canonical leg kind for the primary Coinbase amount from the
 * persisted mapping metadata written during normalization.
 */
const deriveMainLegClassification = ({
  providerTransactionType,
  resolutionStrategy,
  inventoryEffect,
  amount,
  side,
}: {
  providerTransactionType: string | null
  resolutionStrategy: CoinbaseMetadata["coinbaseReferenceMapping"]["resolutionStrategy"]
  inventoryEffect: CoinbaseMetadata["coinbaseReferenceMapping"]["inventoryEffect"]
  amount: string
  side: string | null
}): Effect.Effect<
  {
    readonly kind: "acquisition" | "disposal" | "income" | "fee"
    readonly derivationRule: string
  },
  CoinbaseLegDerivationError
> => {
  const normalizedType = providerTransactionType ?? "unknown"
  const normalizedSide = side === null ? null : side.trim().toLowerCase()

  switch (resolutionStrategy) {
    case "static":
      switch (inventoryEffect) {
        case "acquisition":
          return Effect.succeed({
            kind: "acquisition",
            derivationRule: `coinbase_${normalizedType}`,
          })
        case "disposal":
          return Effect.succeed({
            kind: "disposal",
            derivationRule: `coinbase_${normalizedType}`,
          })
        case "income":
          if (isNegativeAmount(amount)) {
            return Effect.fail(
              new CoinbaseLegDerivationError({
                message: `${normalizedType} must have a positive asset amount for income treatment`,
              })
            )
          }
          return Effect.succeed({
            kind: "income",
            derivationRule: `coinbase_${normalizedType}`,
          })
        default:
          return Effect.fail(
            new CoinbaseLegDerivationError({
              message: `Unsupported static Coinbase inventory effect ${inventoryEffect} for type ${normalizedType}`,
            })
          )
      }
    case "venue_side":
      if (normalizedSide === "buy") {
        return Effect.succeed({
          kind: "acquisition",
          derivationRule: `coinbase_${normalizedType}_buy`,
        })
      }
      if (normalizedSide === "sell") {
        return Effect.succeed({
          kind: "disposal",
          derivationRule: `coinbase_${normalizedType}_sell`,
        })
      }
      return Effect.fail(
        new CoinbaseLegDerivationError({
          message: `${normalizedType} is missing a deterministic venue side`,
        })
      )
    case "amount_sign":
      return Effect.succeed(
        isNegativeAmount(amount)
          ? {
              kind: "disposal",
              derivationRule: `coinbase_${normalizedType}_outflow`,
            }
          : {
              kind: "acquisition",
              derivationRule: `coinbase_${normalizedType}_inflow`,
            }
      )
    case "amount_sign_fee":
      return Effect.succeed(
        isNegativeAmount(amount)
          ? {
              kind: "fee",
              derivationRule: `coinbase_${normalizedType}_fee`,
            }
          : {
              kind: "acquisition",
              derivationRule: `coinbase_${normalizedType}_principal`,
            }
      )
    case "no_leg":
      return Effect.fail(
        new CoinbaseLegDerivationError({
          message: `${normalizedType} does not produce a main inventory leg`,
        })
      )
  }
}

/** Derive a fee leg valuation when a deterministic quote price is available. */
const deriveFeeValuation = ({
  feeAmount,
  fillPrice,
  quoteCurrency,
}: {
  feeAmount: string
  fillPrice: string | null
  quoteCurrency: string | null
}): Effect.Effect<
  {
    readonly fiatAmount: string | null
    readonly fiatCurrency: string | null
  },
  CoinbaseLegDerivationError
> =>
  Effect.gen(function* () {
    if (fillPrice === null || quoteCurrency === null) {
      return {
        fiatAmount: null,
        fiatCurrency: null,
      } as const
    }

    const parsedFee = yield* parseDecimal(feeAmount, fixedPointErrorFactory)
    const parsedPrice = yield* parseDecimal(fillPrice, fixedPointErrorFactory)
    const numerator = parsedFee.digits * parsedPrice.digits
    const denominator = powerOfTen(parsedFee.scale + parsedPrice.scale)

    return {
      fiatAmount: divideToScale({
        numerator,
        denominator,
        scale: 8,
      }),
      fiatCurrency: quoteCurrency,
    } as const
  })

/** Build the main Coinbase leg when the mapping indicates inventory impact. */
const buildMainLeg = (
  params: DeriveCoinbaseLegsParams,
  metadata: CoinbaseMetadata
): Effect.Effect<CoinbaseLegDerivationResult["legs"][number], CoinbaseLegDerivationError> =>
  Effect.gen(function* () {
    if (metadata.coinbaseReferenceMapping.resolutionStrategy === "no_leg") {
      return yield* Effect.fail(
        new CoinbaseLegDerivationError({
          message: `${params.transaction.providerTransactionType ?? "unknown"} does not produce a main inventory leg`,
        })
      )
    }

    if (params.primaryAsset === null) {
      return yield* Effect.fail(
        new CoinbaseLegDerivationError({
          message: `No primary asset is available for Coinbase transaction type ${params.transaction.providerTransactionType ?? "unknown"}`,
        })
      )
    }

    const classification = yield* deriveMainLegClassification({
      providerTransactionType: params.transaction.providerTransactionType,
      resolutionStrategy: metadata.coinbaseReferenceMapping.resolutionStrategy,
      inventoryEffect: metadata.coinbaseReferenceMapping.inventoryEffect,
      amount: metadata.amount.amount,
      side: params.venueContext?.side ?? null,
    })

    return {
      sourceId: params.transaction.sourceId,
      sourceRawRecordId: params.transaction.sourceRawRecordId,
      externalId: `${params.transaction.externalId ?? params.transaction.id}:main`,
      txHash: null,
      timestamp: params.transaction.timestamp,
      userId: params.transaction.userId,
      addressId: null,
      assetId: params.primaryAsset.id,
      amount: absoluteDecimal(metadata.amount.amount),
      kind: classification.kind,
      provenance: "deterministic",
      derivationRule: classification.derivationRule,
      metadata: {
        provider: "coinbase",
        providerTransactionType: params.transaction.providerTransactionType,
        transactionType: metadata.coinbaseReferenceMapping.transactionType,
        assetCurrency: metadata.amount.currency,
        nativeCurrency: metadata.nativeAmount.currency,
        venueSide: params.venueContext?.side ?? null,
      },
      transactionId: params.transaction.id,
      sourceTransferId: null,
      fiatAmount: absoluteDecimal(metadata.nativeAmount.amount),
      fiatCurrency: metadata.nativeAmount.currency,
      feeForTransactionId: classification.kind === "fee" ? params.transaction.id : null,
    } as const
  })

/** Build fee legs from normalized Coinbase fee transfer rows. */
const buildFeeLegs = (
  params: DeriveCoinbaseLegsParams,
  metadata: CoinbaseMetadata
): Effect.Effect<
  ReadonlyArray<CoinbaseLegDerivationResult["legs"][number]>,
  CoinbaseLegDerivationError
> =>
  Effect.forEach(params.feeTransfers, ({ transfer, asset }) =>
    Effect.gen(function* () {
      const quoteCurrency = Option.getOrNull(
        instrumentQuoteCurrency(params.venueContext?.instrument ?? null)
      )
      const valuation = yield* deriveFeeValuation({
        feeAmount: String(transfer.amount),
        fillPrice:
          params.venueContext?.fillPrice === null ? null : String(params.venueContext?.fillPrice),
        quoteCurrency,
      })

      return {
        sourceId: transfer.sourceId,
        sourceRawRecordId: transfer.sourceRawRecordId,
        externalId: `${transfer.externalId ?? transfer.id}:fee_leg`,
        txHash: transfer.txHash,
        timestamp: transfer.timestamp,
        userId: params.transaction.userId,
        addressId: transfer.addressId,
        assetId: transfer.assetId,
        amount: absoluteDecimal(String(transfer.amount)),
        kind: "fee",
        provenance: "deterministic",
        derivationRule:
          transfer.externalId?.endsWith(":network_fee") === true
            ? "coinbase_network_fee"
            : "coinbase_commission_fee",
        metadata: {
          provider: "coinbase",
          providerTransactionType: params.transaction.providerTransactionType,
          transactionType: metadata.coinbaseReferenceMapping.transactionType,
          assetCurrency: asset.symbol,
          nativeCurrency: metadata.nativeAmount.currency,
          transferType: transfer.type,
        },
        transactionId: params.transaction.id,
        sourceTransferId: transfer.id,
        fiatAmount: valuation.fiatAmount,
        fiatCurrency: valuation.fiatCurrency,
        feeForTransactionId: params.transaction.id,
      } as const
    })
  )

const deriveLegs: CoinbaseLegDerivationServiceShape["deriveLegs"] = (params) =>
  Effect.gen(function* () {
    const metadata = yield* decodeCoinbaseMetadata(params.transaction.metadata)
    const feeLegs = yield* buildFeeLegs(params, metadata)
    const maybeMainLeg = shouldSkipQuoteSideMainLeg(metadata)
      ? Option.none()
      : yield* buildMainLeg(params, metadata).pipe(
          Effect.map(Option.some),
          Effect.catchTag("CoinbaseLegDerivationError", (error) =>
            metadata.coinbaseReferenceMapping.resolutionStrategy === "no_leg"
              ? Effect.succeed(Option.none())
              : Effect.fail(error)
          )
        )

    return {
      legs: [...Option.toArray(maybeMainLeg), ...feeLegs],
    } satisfies CoinbaseLegDerivationResult
  })

const make = Effect.succeed({
  deriveLegs,
} satisfies CoinbaseLegDerivationServiceShape)

/**
 * CoinbaseLegDerivationServiceLive - Live layer for deterministic Coinbase leg derivation.
 */
export const CoinbaseLegDerivationServiceLive = Layer.effect(CoinbaseLegDerivationService, make)
