/**
 * SourceNormalizationRepositoryLive - Atomic canonical persistence for normalized sync artifacts.
 *
 * @module SourceNormalizationRepositoryLive
 */

import { and, asc, eq, gt, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  divideToScale,
  formatScaled,
  makeFixedPointErrorFactory,
  parseDecimal,
  powerOfTen,
} from "./SourceNormalizationFixedPoint.ts"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  type PersistNormalizedSourceArtifactsParams,
  type PersistNormalizedSourceArtifactsResult,
  type PersistedSourceProviderTransfer,
  type SourceOnchainContextDraft,
  SourceNormalizationRepository,
  type SourceProviderTransferDraft,
  type SourceTransactionDraft,
  type SourceTransactionLegDraft,
  type SourceTransactionReviewDraft,
  type SourceTransferDraft,
  type SourceVenueContextDraft,
  type SourceNormalizationRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"

interface PersistedSourceLegRecord {
  readonly id: string
  readonly sourceId: string
  readonly timestamp: Date
  readonly principalId: string
  readonly assetId: string
  readonly amount: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
}

interface OpenFifoLotRecord {
  readonly id: string
  readonly acquiredAt: Date
  readonly originalAmount: string
  readonly remainingAmount: string
  readonly costBasisPerToken: string
}

interface FifoLotAllocation {
  readonly fifoLotId: string
  readonly matchedAmount: string
  readonly costBasis: string
  readonly proceeds: string
  readonly gainLoss: string
  readonly remainingAmount: string
}

const INSUFFICIENT_FIFO_INVENTORY_OPERATION =
  "sourceNormalizationRepository.buildFifoLotAllocations"

const NumericStringSchema = Schema.Union(
  Schema.String,
  Schema.transform(Schema.Number, Schema.String, {
    strict: true,
    decode: (value) => String(value),
    encode: (value) => Number(value),
  })
)

const decodeNumericString = ({
  value,
  operation,
}: {
  readonly value: unknown
  readonly operation: string
}): Effect.Effect<string, ReturnType<typeof toSyncEngineStorageError>> =>
  Schema.decodeUnknown(NumericStringSchema)(value).pipe(
    Effect.mapError(() =>
      toSyncEngineStorageError({
        operation,
        error: `Expected string or number, got ${typeof value}`,
      })
    )
  )

const isInsufficientFifoInventoryError = (error: SyncEngineStorageError): boolean =>
  error.operation === INSUFFICIENT_FIFO_INVENTORY_OPERATION

const buildInsufficientInventoryReview = ({
  transaction,
  existingReview,
  resolvedTransactionType,
  error,
}: {
  readonly transaction: {
    readonly principalId: string
  }
  readonly existingReview: SourceTransactionReviewDraft | null
  readonly resolvedTransactionType: {
    readonly transactionType: string | null
  }
  readonly error: SyncEngineStorageError
}): SourceTransactionReviewDraft | null => {
  const principalId = transaction.principalId

  const inventoryReason =
    "Tax review required because the transaction disposes more inventory than the synced FIFO lots currently cover. " +
    "This usually means an opening balance, transfer in, or historical acquisition is missing. " +
    String(error.cause)
  const categorizationReason =
    existingReview?.categorizationReason === null ||
    existingReview?.categorizationReason === undefined
      ? inventoryReason
      : `${existingReview.categorizationReason} ${inventoryReason}`

  return {
    principalId,
    reviewStatus: "needs_review",
    originalTypeKey: existingReview?.originalTypeKey ?? resolvedTransactionType.transactionType,
    originalConfidence: existingReview?.originalConfidence ?? null,
    currentTypeKey: existingReview?.currentTypeKey ?? resolvedTransactionType.transactionType,
    legalRuleSetVersion: existingReview?.legalRuleSetVersion ?? null,
    categorizationReason,
    matchedLayer: "fifo_inventory",
    needsReview: true,
    userNotes: existingReview?.userNotes ?? null,
    reviewedAt: null,
  }
}

const fixedPointErrorFactory = makeFixedPointErrorFactory(({ kind, message }) =>
  toSyncEngineStorageError({
    operation: `sourceNormalizationRepository.fixedPoint.${kind}`,
    error: message,
  })
)

const signedDigits = (params: { readonly sign: 1 | -1; readonly digits: bigint }): bigint =>
  params.sign === -1 ? -params.digits : params.digits

const subtractScaledDecimals = ({
  left,
  right,
  scale,
}: {
  readonly left: string
  readonly right: string
  readonly scale: number
}) =>
  Effect.gen(function* () {
    const parsedLeft = yield* parseDecimal(left, fixedPointErrorFactory)
    const parsedRight = yield* parseDecimal(right, fixedPointErrorFactory)
    const leftDigits = parsedLeft.digits * powerOfTen(scale - parsedLeft.scale)
    const rightDigits = parsedRight.digits * powerOfTen(scale - parsedRight.scale)

    return formatScaled({ digits: leftDigits - rightDigits, scale })
  })

const compareDecimalQuantities = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}) =>
  Effect.gen(function* () {
    const parsedLeft = yield* parseDecimal(left, fixedPointErrorFactory)
    const parsedRight = yield* parseDecimal(right, fixedPointErrorFactory)
    const scale = Math.max(parsedLeft.scale, parsedRight.scale)
    const leftDigits = signedDigits(parsedLeft) * powerOfTen(scale - parsedLeft.scale)
    const rightDigits = signedDigits(parsedRight) * powerOfTen(scale - parsedRight.scale)

    if (leftDigits < rightDigits) {
      return -1
    }

    if (leftDigits > rightDigits) {
      return 1
    }

    return 0
  })

const subtractDecimalQuantities = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}) =>
  Effect.gen(function* () {
    const parsedLeft = yield* parseDecimal(left, fixedPointErrorFactory)
    const parsedRight = yield* parseDecimal(right, fixedPointErrorFactory)
    const scale = Math.max(parsedLeft.scale, parsedRight.scale)
    const leftDigits = signedDigits(parsedLeft) * powerOfTen(scale - parsedLeft.scale)
    const rightDigits = signedDigits(parsedRight) * powerOfTen(scale - parsedRight.scale)

    return formatScaled({ digits: leftDigits - rightDigits, scale })
  })

const toCostBasisPerToken = ({
  fiatAmount,
  quantityAmount,
}: {
  readonly fiatAmount: string | null
  readonly quantityAmount: string
}) =>
  Effect.gen(function* () {
    if (fiatAmount === null) {
      return "0.000000000000000000"
    }

    const parsedFiat = yield* parseDecimal(fiatAmount, fixedPointErrorFactory)
    const parsedQuantity = yield* parseDecimal(quantityAmount, fixedPointErrorFactory)
    return divideToScale({
      numerator: parsedFiat.digits * powerOfTen(parsedQuantity.scale),
      denominator: parsedQuantity.digits * powerOfTen(parsedFiat.scale),
      scale: 18,
    })
  })

const allocateProceeds = ({
  totalFiat,
  matchedAmount,
  totalAmount,
}: {
  readonly totalFiat: string | null
  readonly matchedAmount: string
  readonly totalAmount: string
}) =>
  Effect.gen(function* () {
    if (totalFiat === null) {
      return "0.00000000"
    }

    const parsedFiat = yield* parseDecimal(totalFiat, fixedPointErrorFactory)
    const parsedMatched = yield* parseDecimal(matchedAmount, fixedPointErrorFactory)
    const parsedTotal = yield* parseDecimal(totalAmount, fixedPointErrorFactory)
    return divideToScale({
      numerator: parsedFiat.digits * parsedMatched.digits * powerOfTen(parsedTotal.scale),
      denominator: parsedTotal.digits * powerOfTen(parsedFiat.scale + parsedMatched.scale),
      scale: 8,
    })
  })

const calculateMatchedCostBasis = ({
  costBasisPerToken,
  matchedAmount,
}: {
  readonly costBasisPerToken: string
  readonly matchedAmount: string
}) =>
  Effect.gen(function* () {
    const parsedCostBasisPerToken = yield* parseDecimal(costBasisPerToken, fixedPointErrorFactory)
    const parsedMatched = yield* parseDecimal(matchedAmount, fixedPointErrorFactory)
    return divideToScale({
      numerator: parsedCostBasisPerToken.digits * parsedMatched.digits,
      denominator: powerOfTen(parsedCostBasisPerToken.scale + parsedMatched.scale),
      scale: 8,
    })
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  type SourceNormalizationExecutor = Pick<typeof db, "delete" | "insert" | "select" | "update">

  const selectPersistedTransactionFields = {
    id: schema.transactions.id,
    sourceId: schema.transactions.sourceId,
    sourceRawRecordId: schema.transactions.sourceRawRecordId,
    externalId: schema.transactions.externalId,
    timestamp: schema.transactions.timestamp,
    providerTransactionType: schema.transactions.providerTransactionType,
    metadata: schema.transactions.metadata,
    principalId: schema.transactions.principalId,
  } as const

  const selectPersistedVenueContextFields = {
    transactionId: schema.transactionVenueContext.transactionId,
    side: schema.transactionVenueContext.side,
    instrument: schema.transactionVenueContext.instrument,
    fillPrice: schema.transactionVenueContext.fillPrice,
  } as const

  const selectPersistedTransferFields = {
    id: schema.transfers.id,
    sourceId: schema.transfers.sourceId,
    principalId: schema.transfers.principalId,
    sourceRawRecordId: schema.transfers.sourceRawRecordId,
    externalId: schema.transfers.externalId,
    txHash: schema.transfers.txHash,
    timestamp: schema.transfers.timestamp,
    addressId: schema.transfers.addressId,
    assetId: schema.transfers.assetId,
    amount: schema.transfers.amount,
    type: schema.transfers.type,
  } as const

  const selectPersistedProviderTransferFields = {
    id: schema.providerTransfers.id,
    sourceId: schema.providerTransfers.sourceId,
    sourceRawRecordId: schema.providerTransfers.sourceRawRecordId,
    transactionId: schema.providerTransfers.transactionId,
    externalId: schema.providerTransfers.externalId,
    externalGroupId: schema.providerTransfers.externalGroupId,
    providerAssetId: schema.providerTransfers.providerAssetId,
    timestamp: schema.providerTransfers.timestamp,
    direction: schema.providerTransfers.direction,
    fromAccountRef: schema.providerTransfers.fromAccountRef,
    toAccountRef: schema.providerTransfers.toAccountRef,
    fromAddress: schema.providerTransfers.fromAddress,
    toAddress: schema.providerTransfers.toAddress,
    networkName: schema.providerTransfers.networkName,
    networkHash: schema.providerTransfers.networkHash,
    amount: schema.providerTransfers.amount,
    metadata: schema.providerTransfers.metadata,
  } as const

  const selectPersistedLegFields = {
    id: schema.transactionLegs.id,
    sourceId: schema.transactionLegs.sourceId,
    timestamp: schema.transactionLegs.timestamp,
    principalId: schema.transactionLegs.principalId,
    assetId: schema.transactionLegs.assetId,
    amount: schema.transactionLegs.amount,
    kind: schema.transactionLegs.kind,
    fiatAmount: schema.transactionLegs.fiatAmount,
    fiatCurrency: schema.transactionLegs.fiatCurrency,
  } as const

  const upsertTransaction = ({
    executor,
    transaction,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transaction: SourceTransactionDraft
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const [persisted] = yield* executor
        .insert(schema.transactions)
        .values({
          ...transaction,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.transactions.sourceId, schema.transactions.externalId],
          targetWhere: sql`${schema.transactions.externalId} is not null`,
          set: {
            sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
            externalGroupId: sql.raw("excluded.external_group_id"),
            timestamp: sql.raw("excluded.timestamp"),
            transactionType: sql.raw("excluded.transaction_type"),
            providerTransactionType: sql.raw("excluded.provider_transaction_type"),
            providerStatus: sql.raw("excluded.provider_status"),
            providerResourcePath: sql.raw("excluded.provider_resource_path"),
            providerDescription: sql.raw("excluded.provider_description"),
            providerCreatedAt: sql.raw("excluded.provider_created_at"),
            providerUpdatedAt: sql.raw("excluded.provider_updated_at"),
            metadata: sql.raw("excluded.metadata"),
            principalId: sql.raw("excluded.principal_id"),
            updatedAt: now,
          },
        })
        .returning(selectPersistedTransactionFields)
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransaction"))

      if (persisted === undefined) {
        return yield* Effect.fail(
          toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertTransaction",
            error: "failed to persist transaction",
          })
        )
      }

      return persisted
    })

  const upsertVenueContext = ({
    executor,
    venueContext,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly venueContext: SourceVenueContextDraft & {
      readonly transactionId: string
    }
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const [persisted] = yield* executor
        .insert(schema.transactionVenueContext)
        .values({
          ...venueContext,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.transactionVenueContext.transactionId,
          set: {
            venueType: sql.raw("excluded.venue_type"),
            cexAccountId: sql.raw("excluded.cex_account_id"),
            externalAccountId: sql.raw("excluded.external_account_id"),
            externalOrderId: sql.raw("excluded.external_order_id"),
            externalFillId: sql.raw("excluded.external_fill_id"),
            side: sql.raw("excluded.side"),
            instrument: sql.raw("excluded.instrument"),
            fillPrice: sql.raw("excluded.fill_price"),
            commissionAmount: sql.raw("excluded.commission_amount"),
            commissionCurrency: sql.raw("excluded.commission_currency"),
            metadata: sql.raw("excluded.metadata"),
            updatedAt: now,
          },
        })
        .returning(selectPersistedVenueContextFields)
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertVenueContext"))

      if (persisted === undefined) {
        return yield* Effect.fail(
          toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertVenueContext",
            error: "failed to persist transaction venue context",
          })
        )
      }

      return {
        ...persisted,
        fillPrice: persisted.fillPrice === null ? null : String(persisted.fillPrice),
      }
    })

  const upsertOnchainContext = ({
    executor,
    transactionId,
    onchainContext,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly onchainContext: SourceOnchainContextDraft | null | undefined
  }) =>
    onchainContext === null || onchainContext === undefined
      ? executor
          .delete(schema.transactionOnchainContext)
          .where(eq(schema.transactionOnchainContext.transactionId, transactionId))
          .pipe(
            wrapSyncEngineSqlError("sourceNormalizationRepository.upsertOnchainContext.delete"),
            Effect.asVoid
          )
      : Effect.gen(function* () {
          const now = nowDate()
          yield* executor
            .insert(schema.transactionOnchainContext)
            .values({
              transactionId,
              blockchainId: onchainContext.blockchainId,
              addressId: onchainContext.addressId,
              chainTxId: onchainContext.chainTxId,
              blockHeight: onchainContext.blockHeight,
              blockHash: onchainContext.blockHash,
              positionInBlock: onchainContext.positionInBlock,
              fromAddress: onchainContext.fromAddress,
              toAddress: onchainContext.toAddress,
              gasUsed: onchainContext.gasUsed,
              gasPrice: onchainContext.gasPrice,
              feeAmount: onchainContext.feeAmount,
              feeAssetId: onchainContext.feeAssetId,
              feeCostBasisAmount: onchainContext.feeCostBasisAmount,
              feeCostBasisCurrency: onchainContext.feeCostBasisCurrency,
              isError: onchainContext.isError,
              functionName: onchainContext.functionName,
              metadata: onchainContext.metadata,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.transactionOnchainContext.transactionId,
              set: {
                blockchainId: sql.raw("excluded.blockchain_id"),
                addressId: sql.raw("excluded.address_id"),
                chainTxId: sql.raw("excluded.tx_hash"),
                blockHeight: sql.raw("excluded.block_number"),
                blockHash: sql.raw("excluded.block_hash"),
                positionInBlock: sql.raw("excluded.position_in_block"),
                fromAddress: sql.raw("excluded.from_address"),
                toAddress: sql.raw("excluded.to_address"),
                gasUsed: sql.raw("excluded.gas_used"),
                gasPrice: sql.raw("excluded.gas_price"),
                feeAmount: sql.raw("excluded.gas_fee_in_native"),
                feeAssetId: sql.raw("excluded.fee_asset_id"),
                feeCostBasisAmount: sql.raw("excluded.gas_fee_cost_basis_amount"),
                feeCostBasisCurrency: sql.raw("excluded.gas_fee_cost_basis_currency"),
                isError: sql.raw("excluded.is_error"),
                functionName: sql.raw("excluded.function_name"),
                metadata: sql.raw("excluded.metadata"),
                updatedAt: now,
              },
            })
            .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertOnchainContext"))
        })

  const upsertFeeTransfers = ({
    executor,
    feeTransfers,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly feeTransfers: ReadonlyArray<SourceTransferDraft>
  }) =>
    Effect.forEach(feeTransfers, (feeTransfer) =>
      Effect.gen(function* () {
        const now = nowDate()
        const [persisted] = yield* executor
          .insert(schema.transfers)
          .values({
            ...feeTransfer,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.transfers.sourceId, schema.transfers.externalId],
            targetWhere: sql`${schema.transfers.externalId} is not null`,
            set: {
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              externalGroupId: sql.raw("excluded.external_group_id"),
              addressId: sql.raw("excluded.address_id"),
              blockchainId: sql.raw("excluded.blockchain_id"),
              txHash: sql.raw("excluded.tx_hash"),
              timestamp: sql.raw("excluded.timestamp"),
              type: sql.raw("excluded.type"),
              fromAddress: sql.raw("excluded.from_address"),
              toAddress: sql.raw("excluded.to_address"),
              fromAccountRef: sql.raw("excluded.from_account_ref"),
              toAccountRef: sql.raw("excluded.to_account_ref"),
              fromPartyType: sql.raw("excluded.from_party_type"),
              fromPartyResourcePath: sql.raw("excluded.from_party_resource_path"),
              toPartyType: sql.raw("excluded.to_party_type"),
              toPartyResourcePath: sql.raw("excluded.to_party_resource_path"),
              assetId: sql.raw("excluded.asset_id"),
              amount: sql.raw("excluded.amount"),
              tokenId: sql.raw("excluded.token_id"),
              notes: sql.raw("excluded.notes"),
              metadata: sql.raw("excluded.metadata"),
              principalId: sql.raw("excluded.principal_id"),
              updatedAt: now,
            },
          })
          .returning(selectPersistedTransferFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertFeeTransfers"))

        if (persisted === undefined) {
          return yield* Effect.fail(
            toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.upsertFeeTransfers",
              error: "failed to persist transfer",
            })
          )
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertFeeTransfers.amount",
        })

        return {
          ...persisted,
          amount,
        }
      })
    )

  const upsertProviderTransfers = ({
    executor,
    transactionId,
    providerTransfers,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
  }) =>
    Effect.forEach(providerTransfers, (providerTransfer) =>
      Effect.gen(function* () {
        const now = nowDate()
        const [persisted] = yield* executor
          .insert(schema.providerTransfers)
          .values({
            ...providerTransfer,
            transactionId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.providerTransfers.sourceId, schema.providerTransfers.externalId],
            targetWhere: sql`${schema.providerTransfers.externalId} is not null`,
            set: {
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              transactionId: sql.raw("excluded.transaction_id"),
              externalGroupId: sql.raw("excluded.external_group_id"),
              providerAssetId: sql.raw("excluded.provider_asset_id"),
              timestamp: sql.raw("excluded.timestamp"),
              direction: sql.raw("excluded.direction"),
              fromAccountRef: sql.raw("excluded.from_account_ref"),
              toAccountRef: sql.raw("excluded.to_account_ref"),
              fromAddress: sql.raw("excluded.from_address"),
              toAddress: sql.raw("excluded.to_address"),
              networkName: sql.raw("excluded.network_name"),
              networkHash: sql.raw("excluded.network_hash"),
              amount: sql.raw("excluded.amount"),
              metadata: sql.raw("excluded.metadata"),
              updatedAt: now,
            },
          })
          .returning(selectPersistedProviderTransferFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertProviderTransfers"))

        if (persisted === undefined) {
          return yield* Effect.fail(
            toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.upsertProviderTransfers",
              error: "failed to persist provider transfer",
            })
          )
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertProviderTransfers.amount",
        })

        return {
          ...persisted,
          amount,
        } satisfies PersistedSourceProviderTransfer
      })
    )

  const upsertTransactionLegs = ({
    executor,
    legs,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly legs: ReadonlyArray<SourceTransactionLegDraft>
  }) =>
    Effect.forEach(legs, (leg) =>
      Effect.gen(function* () {
        const now = nowDate()
        const [persisted] = yield* executor
          .insert(schema.transactionLegs)
          .values({
            ...leg,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.transactionLegs.sourceId, schema.transactionLegs.externalId],
            targetWhere: sql`${schema.transactionLegs.externalId} is not null`,
            set: {
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              txHash: sql.raw("excluded.tx_hash"),
              timestamp: sql.raw("excluded.timestamp"),
              principalId: sql.raw("excluded.principal_id"),
              addressId: sql.raw("excluded.address_id"),
              assetId: sql.raw("excluded.asset_id"),
              amount: sql.raw("excluded.amount"),
              kind: sql.raw("excluded.kind"),
              provenance: sql.raw("excluded.provenance"),
              derivationRule: sql.raw("excluded.derivation_rule"),
              metadata: sql.raw("excluded.metadata"),
              transactionId: sql.raw("excluded.transaction_id"),
              sourceTransferId: sql.raw("excluded.source_transfer_id"),
              fiatAmount: sql.raw("excluded.fiat_amount"),
              fiatCurrency: sql.raw("excluded.fiat_currency"),
              feeForTransactionId: sql.raw("excluded.fee_for_transaction_id"),
              updatedAt: now,
            },
          })
          .returning(selectPersistedLegFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransactionLegs"))

        if (persisted === undefined) {
          return yield* Effect.fail(
            toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.upsertTransactionLegs",
              error: "failed to persist transaction leg",
            })
          )
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertTransactionLegs.amount",
        })
        const fiatAmount =
          persisted.fiatAmount === null
            ? null
            : yield* decodeNumericString({
                value: persisted.fiatAmount,
                operation: "sourceNormalizationRepository.upsertTransactionLegs.fiatAmount",
              })

        return {
          ...persisted,
          amount,
          fiatAmount,
        } satisfies PersistedSourceLegRecord
      })
    )

  const upsertTransactionReview = ({
    executor,
    transactionId,
    transactionReview,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly transactionReview: SourceTransactionReviewDraft | null
  }) =>
    transactionReview === null
      ? executor
          .delete(schema.transactionReviews)
          .where(eq(schema.transactionReviews.transactionId, transactionId))
          .pipe(
            wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransactionReview.delete"),
            Effect.asVoid
          )
      : Effect.gen(function* () {
          const now = nowDate()
          yield* executor
            .insert(schema.transactionReviews)
            .values({
              transactionId,
              principalId: transactionReview.principalId,
              reviewStatus: transactionReview.reviewStatus,
              originalTypeKey: transactionReview.originalTypeKey,
              originalConfidence: transactionReview.originalConfidence,
              currentTypeKey: transactionReview.currentTypeKey,
              legalRuleSetVersion: transactionReview.legalRuleSetVersion,
              categorizationReason: transactionReview.categorizationReason,
              matchedLayer: transactionReview.matchedLayer,
              needsReview: transactionReview.needsReview,
              userNotes: transactionReview.userNotes,
              reviewedAt: transactionReview.reviewedAt,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.transactionReviews.transactionId,
              set: {
                reviewStatus: sql.raw("excluded.review_status"),
                originalTypeKey: sql.raw("excluded.original_type_key"),
                originalConfidence: sql.raw("excluded.original_confidence"),
                currentTypeKey: sql.raw("excluded.current_type_key"),
                legalRuleSetVersion: sql.raw("excluded.legal_rule_set_version"),
                categorizationReason: sql.raw("excluded.categorization_reason"),
                matchedLayer: sql.raw("excluded.matched_layer"),
                needsReview: sql.raw("excluded.needs_review"),
                userNotes: sql.raw("excluded.user_notes"),
                reviewedAt: sql.raw("excluded.reviewed_at"),
                updatedAt: now,
              },
            })
            .pipe(
              wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransactionReview.upsert")
            )
        })

  const loadOpenFifoLots = ({
    executor,
    principalId,
    assetId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly principalId: string
    readonly assetId: string
  }) =>
    Effect.gen(function* () {
      const rows = yield* executor
        .select({
          id: schema.fifoLots.id,
          acquiredAt: schema.fifoLots.acquiredAt,
          originalAmount: schema.fifoLots.originalAmount,
          remainingAmount: schema.fifoLots.remainingAmount,
          costBasisPerToken: schema.fifoLots.costBasisPerToken,
        })
        .from(schema.fifoLots)
        .where(
          and(
            eq(schema.fifoLots.principalId, principalId),
            eq(schema.fifoLots.assetId, assetId),
            gt(schema.fifoLots.remainingAmount, "0")
          )
        )
        .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.loadOpenFifoLots"))

      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const originalAmount = yield* decodeNumericString({
            value: row.originalAmount,
            operation: "sourceNormalizationRepository.loadOpenFifoLots.originalAmount",
          })
          const remainingAmount = yield* decodeNumericString({
            value: row.remainingAmount,
            operation: "sourceNormalizationRepository.loadOpenFifoLots.remainingAmount",
          })
          const costBasisPerToken = yield* decodeNumericString({
            value: row.costBasisPerToken,
            operation: "sourceNormalizationRepository.loadOpenFifoLots.costBasisPerToken",
          })

          return {
            ...row,
            originalAmount,
            remainingAmount,
            costBasisPerToken,
          } satisfies OpenFifoLotRecord
        })
      )
    })

  const buildFifoLotAllocations = ({
    lots,
    disposalAmount,
    disposalFiatAmount,
  }: {
    readonly lots: ReadonlyArray<OpenFifoLotRecord>
    readonly disposalAmount: string
    readonly disposalFiatAmount: string | null
  }) =>
    Effect.gen(function* () {
      const allocations = yield* Effect.reduce(
        lots,
        {
          remainingAmount: disposalAmount,
          items: [] as ReadonlyArray<FifoLotAllocation>,
        },
        (state, lot) =>
          Effect.gen(function* () {
            const remainingComparison = yield* compareDecimalQuantities({
              left: state.remainingAmount,
              right: "0",
            })
            if (remainingComparison === 0) {
              return state
            }

            const lotComparison = yield* compareDecimalQuantities({
              left: lot.remainingAmount,
              right: "0",
            })
            if (lotComparison === 0) {
              return state
            }

            const matchedAmountComparison = yield* compareDecimalQuantities({
              left: lot.remainingAmount,
              right: state.remainingAmount,
            })
            const matchedAmount =
              matchedAmountComparison <= 0 ? lot.remainingAmount : state.remainingAmount
            const costBasis = yield* calculateMatchedCostBasis({
              costBasisPerToken: lot.costBasisPerToken,
              matchedAmount,
            })
            const proceeds = yield* allocateProceeds({
              totalFiat: disposalFiatAmount,
              matchedAmount,
              totalAmount: disposalAmount,
            })
            const gainLoss = yield* subtractScaledDecimals({
              left: proceeds,
              right: costBasis,
              scale: 8,
            })
            const nextRemainingAmount = yield* subtractDecimalQuantities({
              left: state.remainingAmount,
              right: matchedAmount,
            })
            const nextLotRemainingAmount = yield* subtractDecimalQuantities({
              left: lot.remainingAmount,
              right: matchedAmount,
            })

            return {
              remainingAmount: nextRemainingAmount,
              items: [
                ...state.items,
                {
                  fifoLotId: lot.id,
                  matchedAmount,
                  costBasis,
                  proceeds,
                  gainLoss,
                  remainingAmount: nextLotRemainingAmount,
                },
              ],
            }
          })
      )

      const remainingComparison = yield* compareDecimalQuantities({
        left: allocations.remainingAmount,
        right: "0",
      })
      if (remainingComparison > 0) {
        return yield* Effect.fail(
          toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.buildFifoLotAllocations",
            error: `Insufficient FIFO inventory for disposal amount ${allocations.remainingAmount}`,
          })
        )
      }

      return allocations.items
    })

  const ensureFifoLotForLeg = ({
    executor,
    leg,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly leg: PersistedSourceLegRecord
  }) =>
    Effect.gen(function* () {
      if (leg.kind !== "acquisition" && leg.kind !== "income") {
        return
      }

      const now = nowDate()
      const costBasisPerToken = yield* toCostBasisPerToken({
        fiatAmount: leg.fiatAmount,
        quantityAmount: leg.amount,
      })

      yield* executor
        .insert(schema.fifoLots)
        .values({
          principalId: leg.principalId,
          sourceId: leg.sourceId,
          assetId: leg.assetId,
          acquiredAt: leg.timestamp,
          originalAmount: leg.amount,
          remainingAmount: leg.amount,
          costBasisPerToken,
          costBasisCurrency: leg.fiatCurrency ?? "EUR",
          sourceLegId: leg.id,
          sourceLegSequence: 0,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [schema.fifoLots.sourceLegId, schema.fifoLots.sourceLegSequence],
        })
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.ensureFifoLotForLeg"))
    })

  const matchDisposalLeg = ({
    executor,
    leg,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly leg: PersistedSourceLegRecord
  }) =>
    Effect.gen(function* () {
      if (leg.kind !== "disposal") {
        return
      }

      const [existingMatch] = yield* executor
        .select({ id: schema.disposalMatches.id })
        .from(schema.disposalMatches)
        .where(eq(schema.disposalMatches.disposalLegId, leg.id))
        .limit(1)
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.matchDisposalLeg.findExisting"))

      if (existingMatch !== undefined) {
        return
      }

      const openLots = yield* loadOpenFifoLots({
        executor,
        principalId: leg.principalId,
        assetId: leg.assetId,
      })
      const allocations = yield* buildFifoLotAllocations({
        lots: openLots,
        disposalAmount: leg.amount,
        disposalFiatAmount: leg.fiatAmount,
      })

      yield* Effect.forEach(allocations, (allocation) =>
        Effect.gen(function* () {
          const now = nowDate()

          yield* executor
            .insert(schema.disposalMatches)
            .values({
              disposalLegId: leg.id,
              fifoLotId: allocation.fifoLotId,
              matchedAmount: allocation.matchedAmount,
              costBasis: allocation.costBasis,
              proceeds: allocation.proceeds,
              gainLoss: allocation.gainLoss,
              createdAt: now,
            })
            .onConflictDoNothing({
              target: [schema.disposalMatches.fifoLotId, schema.disposalMatches.disposalLegId],
            })
            .pipe(
              wrapSyncEngineSqlError("sourceNormalizationRepository.matchDisposalLeg.insertMatch")
            )

          yield* executor
            .update(schema.fifoLots)
            .set({
              remainingAmount: allocation.remainingAmount,
              updatedAt: now,
            })
            .where(eq(schema.fifoLots.id, allocation.fifoLotId))
            .pipe(
              wrapSyncEngineSqlError("sourceNormalizationRepository.matchDisposalLeg.updateLot")
            )
        })
      )
    })

  const feedFifoLegs = ({
    executor,
    legs,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly legs: ReadonlyArray<PersistedSourceLegRecord>
  }) =>
    Effect.forEach(legs, (leg) =>
      Effect.gen(function* () {
        yield* ensureFifoLotForLeg({ executor, leg })
        yield* matchDisposalLeg({ executor, leg })
      })
    )

  const persistNormalizedArtifacts = <E>(
    params: PersistNormalizedSourceArtifactsParams<E>
  ): Effect.Effect<PersistNormalizedSourceArtifactsResult, E | SyncEngineStorageError> =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const persistedTransaction = yield* upsertTransaction({
            executor: tx,
            transaction: params.transaction,
          })
          const persistedVenueContext = yield* upsertVenueContext({
            executor: tx,
            venueContext: {
              ...params.venueContext,
              transactionId: persistedTransaction.id,
            },
          })
          yield* upsertOnchainContext({
            executor: tx,
            transactionId: persistedTransaction.id,
            onchainContext: params.onchainContext,
          })
          const persistedProviderTransfers = yield* upsertProviderTransfers({
            executor: tx,
            transactionId: persistedTransaction.id,
            providerTransfers: params.providerTransfers,
          })
          const persistedFeeTransfers = yield* upsertFeeTransfers({
            executor: tx,
            feeTransfers: params.feeTransfers,
          })
          const derivedLegs =
            "deriveLegs" in params
              ? yield* params.deriveLegs({
                  transaction: persistedTransaction,
                  venueContext: persistedVenueContext,
                  providerTransfers: persistedProviderTransfers,
                  feeTransfers: persistedFeeTransfers,
                })
              : params.legs
          const persistedLegs = yield* upsertTransactionLegs({
            executor: tx,
            legs: derivedLegs,
          })

          const transactionReview = yield* feedFifoLegs({
            executor: tx,
            legs: persistedLegs,
          }).pipe(
            Effect.as(params.transactionReview),
            Effect.catchTag("SyncEngineStorageError", (error) =>
              isInsufficientFifoInventoryError(error)
                ? Effect.succeed(
                    buildInsufficientInventoryReview({
                      transaction: persistedTransaction,
                      existingReview: params.transactionReview,
                      resolvedTransactionType: params.resolvedTransactionType,
                      error,
                    })
                  )
                : Effect.fail(error)
            )
          )

          yield* upsertTransactionReview({
            executor: tx,
            transactionId: persistedTransaction.id,
            transactionReview,
          })
          if (persistedTransaction.sourceRawRecordId !== null) {
            yield* tx
              .update(schema.sourceRecordsRaw)
              .set({
                normalizedAt: nowDate(),
                normalizationError: null,
                updatedAt: nowDate(),
              })
              .where(eq(schema.sourceRecordsRaw.id, persistedTransaction.sourceRawRecordId))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.persistNormalizedArtifacts.markRawRecordNormalized"
                )
              )
          }

          return {
            transaction: persistedTransaction,
            venueContext: persistedVenueContext,
            providerTransfers: persistedProviderTransfers,
            feeTransfers: persistedFeeTransfers,
            legs: persistedLegs,
          }
        })
      )
      .pipe(wrapSyncEngineStorageError("sourceNormalizationRepository.persistNormalizedArtifacts"))

  return SourceNormalizationRepository.of({
    persistNormalizedArtifacts,
  } satisfies SourceNormalizationRepositoryShape)
})

export const SourceNormalizationRepositoryLive = Layer.effect(SourceNormalizationRepository, make)
