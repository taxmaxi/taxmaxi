/**
 * SourceNormalizationRepositoryLive - Atomic canonical persistence for normalized sync artifacts.
 *
 * This repository writes provider and canonical facts only. Tax accounting is produced later by
 * immutable calculation runs over the factual ledger.
 *
 * @module SourceNormalizationRepositoryLive
 */

import { createHash } from "node:crypto"
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { canonicalizeAddress } from "@my/core/assets"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  type PersistNormalizedSourceArtifactsParams,
  type PersistNormalizedSourceArtifactsResult,
  type PersistedSourceProviderTransfer,
  type PersistedSourceTransaction,
  type SourceOnchainContextDraft,
  SourceNormalizationRepository,
  type SourceProviderTransferDraft,
  type SourceTransactionDraft,
  type SourceTransactionLegDraft,
  type SourceTransactionReviewDraft,
  type SourceTransferDraft,
  type SourceVenueContextDraft,
  type SourceNormalizationRepositoryShape,
  SourceSyncCreditExhaustedError,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import {
  nowDate,
  toSyncEngineStorageError,
  wrapSyncEngineSqlError,
  wrapSyncEngineStorageError,
} from "./SyncEngineRepositorySupport.ts"
import {
  makePrincipalAssetOverrideDecisionLoader,
  resolvePrincipalAssetId,
} from "./PrincipalAssetOverrideDecisionLoader.ts"

interface PersistedSourceLegRecord {
  readonly id: string
  readonly sourceId: string
  readonly sourceRawRecordId: string | null
  readonly transactionId: string | null
  readonly timestamp: Date
  readonly principalId: string
  readonly assetId: string
  readonly assetRepresentationId: string | null
  readonly amount: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly derivationRule: string | null
}

/**
 * Wrap residual errors in `SyncEngineStorageError`, but let a typed credit-exhaustion
 * outcome pass through so callers can route it to a resumable state instead of a
 * generic storage failure.
 */
const wrapPreservingCreditExhausted =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, SyncEngineStorageError | SourceSyncCreditExhaustedError, R> =>
    Effect.mapError(effect, (error) =>
      Schema.is(SourceSyncCreditExhaustedError)(error)
        ? error
        : toSyncEngineStorageError({ error, operation })
    )

const COMPLETED_PROVIDER_STATUSES = new Set(["completed", "succeeded"])

const hasCompletedProviderStatus = (providerStatus: string | null): boolean =>
  providerStatus !== null && COMPLETED_PROVIDER_STATUSES.has(providerStatus.toLowerCase())

const hasFailedProviderStatus = (providerStatus: string | null): boolean =>
  providerStatus?.toLowerCase() === "failed"

const stableTransactionId = ({
  externalId,
  sourceId,
  sourceRawRecordId,
}: Pick<SourceTransactionDraft, "externalId" | "sourceId" | "sourceRawRecordId">):
  | string
  | null => {
  if (externalId === null && sourceRawRecordId === null) {
    return null
  }

  const identity =
    sourceRawRecordId === null ? `external:${externalId}` : `raw:${sourceRawRecordId}`
  const digest = createHash("sha256")
    .update("taxmaxi:canonical-transaction")
    .update("\0")
    .update(sourceId)
    .update("\0")
    .update(identity)
    .digest("hex")
  const variant = ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

const ProviderTransferMetadataSchema = Schema.Struct({
  role: Schema.optional(Schema.Literals(["principal", "fee", "rent"])),
})

const decodeProviderTransferMetadata = (metadata: unknown) =>
  Schema.decodeUnknownEffect(ProviderTransferMetadataSchema)(metadata).pipe(
    Effect.map((decoded) => ({
      purpose: decoded.role === "fee" ? ("fee" as const) : ("principal" as const),
    })),
    Effect.orElseSucceed(() => ({ purpose: "principal" as const }))
  )

const NumericStringSchema = Schema.Union([Schema.String, Schema.Finite])

const decodeNumericString = ({
  value,
  operation,
}: {
  readonly value: unknown
  readonly operation: string
}): Effect.Effect<string, ReturnType<typeof toSyncEngineStorageError>> =>
  Schema.decodeUnknownEffect(NumericStringSchema)(value).pipe(
    Effect.map(String),
    Effect.mapError(() =>
      toSyncEngineStorageError({
        operation,
        error: `Expected string or number, got ${typeof value}`,
      })
    )
  )

const compareDecimalStrings = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}) =>
  Effect.gen(function* () {
    const leftQuantity = yield* Option.match(BigDecimal.fromString(left), {
      onNone: () =>
        Effect.fail(
          toSyncEngineStorageError({
            error: `Invalid decimal value: ${left}`,
            operation: "sourceNormalizationRepository.compareDecimalStrings",
          })
        ),
      onSome: Effect.succeed,
    })
    const rightQuantity = yield* Option.match(BigDecimal.fromString(right), {
      onNone: () =>
        Effect.fail(
          toSyncEngineStorageError({
            error: `Invalid decimal value: ${right}`,
            operation: "sourceNormalizationRepository.compareDecimalStrings",
          })
        ),
      onSome: Effect.succeed,
    })

    return BigDecimal.Order(leftQuantity, rightQuantity)
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const principalAssetOverrideDecisionLoader = yield* makePrincipalAssetOverrideDecisionLoader

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
    assetRepresentationId: schema.transfers.assetRepresentationId,
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
    processingMode: schema.providerTransfers.processingMode,
    fromAccountRef: schema.providerTransfers.fromAccountRef,
    toAccountRef: schema.providerTransfers.toAccountRef,
    fromAddress: schema.providerTransfers.fromAddress,
    toAddress: schema.providerTransfers.toAddress,
    networkName: schema.providerTransfers.networkName,
    networkHash: schema.providerTransfers.networkHash,
    observedBlockchainId: schema.providerTransfers.observedBlockchainId,
    observedRepresentationType: schema.providerTransfers.observedRepresentationType,
    observedContractAddress: schema.providerTransfers.observedContractAddress,
    observedMintAddress: schema.providerTransfers.observedMintAddress,
    observedDecimals: schema.providerTransfers.observedDecimals,
    amount: schema.providerTransfers.amount,
    metadata: schema.providerTransfers.metadata,
  } as const

  const selectPersistedLegFields = {
    id: schema.transactionLegs.id,
    sourceId: schema.transactionLegs.sourceId,
    sourceRawRecordId: schema.transactionLegs.sourceRawRecordId,
    transactionId: schema.transactionLegs.transactionId,
    timestamp: schema.transactionLegs.timestamp,
    principalId: schema.transactionLegs.principalId,
    assetId: schema.transactionLegs.assetId,
    assetRepresentationId: schema.transactionLegs.assetRepresentationId,
    amount: schema.transactionLegs.amount,
    kind: schema.transactionLegs.kind,
    fiatAmount: schema.transactionLegs.fiatAmount,
    fiatCurrency: schema.transactionLegs.fiatCurrency,
    derivationRule: schema.transactionLegs.derivationRule,
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
      const deterministicTransactionId = stableTransactionId(transaction)
      if (deterministicTransactionId === null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.upsertTransaction.identity",
          error: "Transaction is missing a stable source identity",
        })
      }
      const [existingExternalTransaction] =
        transaction.externalId === null
          ? []
          : yield* executor
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.sourceId, transaction.sourceId),
                  eq(schema.transactions.externalId, transaction.externalId)
                )
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.upsertTransaction.findExternal"
                )
              )
      const transactionId = existingExternalTransaction?.id ?? deterministicTransactionId

      const conflictSet = {
        externalId: sql.raw("excluded.external_id"),
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
        providerFiatAmount: sql.raw("excluded.provider_fiat_amount"),
        providerFiatCurrency: sql.raw("excluded.provider_fiat_currency"),
        principalId: sql.raw("excluded.principal_id"),
        updatedAt: now,
      } as const
      const insert = executor.insert(schema.transactions).values({
        ...transaction,
        id: transactionId,
        createdAt: now,
        updatedAt: now,
      })
      const upsert = insert.onConflictDoUpdate({
        target: schema.transactions.id,
        set: conflictSet,
      })
      const [persisted] = yield* upsert
        .returning(selectPersistedTransactionFields)
        .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertTransaction"))

      if (persisted === undefined) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.upsertTransaction",
          error: "failed to persist transaction",
        })
      }

      return persisted
    })

  const consumeTransactionCredit = ({
    executor,
    externalId,
    mode,
    principalId,
    replayReservationId,
    sourceId,
    sourceRawRecordId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly externalId: string | null
    readonly mode: "persist" | "reserve"
    readonly principalId: string
    readonly replayReservationId: string | null
    readonly sourceId: string
    readonly sourceRawRecordId: string | null
  }) =>
    Effect.gen(function* () {
      const [principal] = yield* executor
        .select({ userId: schema.principals.userId })
        .from(schema.principals)
        .where(eq(schema.principals.id, principalId))
        .limit(1)
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.findPrincipal"
          )
        )

      // Anonymous x402 principals keep their payment-based access path. Every
      // registered user transaction must be backed by a billing credit.
      if (principal?.userId === null || principal === undefined) return null

      if (sourceRawRecordId !== null) {
        const [paidRawRecord] = yield* executor
          .select({ id: schema.sourceRecordsRaw.id })
          .from(schema.sourceRecordsRaw)
          .innerJoin(
            schema.principalClaims,
            and(
              eq(schema.principalClaims.sourceId, schema.sourceRecordsRaw.sourceId),
              eq(schema.principalClaims.claimType, "x402_receipt")
            )
          )
          .where(
            and(
              eq(schema.sourceRecordsRaw.id, sourceRawRecordId),
              eq(schema.sourceRecordsRaw.sourceId, sourceId),
              isNotNull(schema.principalClaims.consumedAt),
              lte(schema.sourceRecordsRaw.createdAt, schema.principalClaims.consumedAt)
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "sourceNormalizationRepository.consumeTransactionCredit.findClaimedX402Payment"
            )
          )

        // The x402 payment covered raw records retained when the source was claimed.
        // Records imported after the claim still use the registered user's credits.
        if (paidRawRecord !== undefined) return null
      }

      const [account] = yield* executor
        .select({ userId: schema.billingAccounts.userId })
        .from(schema.billingAccounts)
        .where(eq(schema.billingAccounts.userId, principal.userId))
        .limit(1)
        .for("update")
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.lockAccount"
          )
        )

      if (account === undefined) {
        return yield* new SourceSyncCreditExhaustedError({
          reasonCode: "no_usable_credits",
          availableCredits: 0,
        })
      }

      const rawReference =
        sourceRawRecordId === null ? null : `transaction:${sourceId}:raw:${sourceRawRecordId}`
      const externalReference =
        externalId === null ? null : `transaction:${sourceId}:external:${externalId}`
      if (rawReference === null && externalReference === null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.consumeTransactionCredit.identity",
          error: "Transaction is missing a stable source identity",
        })
      }

      const [previousForRawRecord] =
        sourceRawRecordId === null
          ? []
          : yield* executor
              .select({ externalId: schema.transactions.externalId })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.sourceId, sourceId),
                  eq(schema.transactions.sourceRawRecordId, sourceRawRecordId)
                )
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.consumeTransactionCredit.findPreviousByRawRecord"
                )
              )
      const [previousForExternalId] =
        externalId === null
          ? []
          : yield* executor
              .select({ sourceRawRecordId: schema.transactions.sourceRawRecordId })
              .from(schema.transactions)
              .where(
                and(
                  eq(schema.transactions.sourceId, sourceId),
                  eq(schema.transactions.externalId, externalId)
                )
              )
              .limit(1)
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.consumeTransactionCredit.findPreviousByExternalId"
                )
              )
      const previousExternalReference =
        previousForRawRecord?.externalId === null || previousForRawRecord?.externalId === undefined
          ? null
          : `transaction:${sourceId}:external:${previousForRawRecord.externalId}`
      const previousRawReference =
        previousForExternalId?.sourceRawRecordId === null ||
        previousForExternalId?.sourceRawRecordId === undefined
          ? null
          : `transaction:${sourceId}:raw:${previousForExternalId.sourceRawRecordId}`
      const candidateReferences = [
        rawReference,
        externalReference,
        previousExternalReference,
        previousRawReference,
      ].filter((reference): reference is string => reference !== null)
      const existingEntries = yield* executor
        .select({
          id: schema.creditLedger.id,
          reference: schema.creditLedger.reference,
          replayReservationId: schema.creditLedger.replayReservationId,
        })
        .from(schema.creditLedger)
        .where(inArray(schema.creditLedger.reference, [...new Set(candidateReferences)]))
        .for("update")
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.findExisting"
          )
        )
      const existingByReference = new Map(
        existingEntries.map((entry) => [entry.reference, entry] as const)
      )
      const existingRaw = rawReference === null ? undefined : existingByReference.get(rawReference)
      const existingExternal =
        externalReference === null ? undefined : existingByReference.get(externalReference)
      const existingForSameExternalRaw =
        previousRawReference === null ? undefined : existingByReference.get(previousRawReference)
      const existingForPreviousExternal =
        previousExternalReference === null
          ? undefined
          : existingByReference.get(previousExternalReference)
      const existing =
        existingRaw ?? existingExternal ?? existingForSameExternalRaw ?? existingForPreviousExternal
      if (existing !== undefined) {
        if (
          mode === "persist" &&
          existing.replayReservationId !== null &&
          existing.replayReservationId !== replayReservationId
        ) {
          return yield* toSyncEngineStorageError({
            operation:
              "sourceNormalizationRepository.consumeTransactionCredit.reservationOwnership",
            error: "Replay transaction credit reservation ownership changed",
          })
        }
        const migratedReference =
          existing === existingForPreviousExternal &&
          existingRaw === undefined &&
          existingExternal === undefined &&
          existingForSameExternalRaw === undefined
            ? (externalReference ?? rawReference ?? existing.reference)
            : existing.reference
        const nextReplayReservationId =
          mode === "persist"
            ? existing.replayReservationId === replayReservationId
              ? null
              : existing.replayReservationId
            : replayReservationId === null
              ? existing.replayReservationId
              : existing.replayReservationId === null
                ? null
                : replayReservationId
        if (
          migratedReference !== existing.reference ||
          nextReplayReservationId !== existing.replayReservationId
        ) {
          const [updated] = yield* executor
            .update(schema.creditLedger)
            .set({
              reference: migratedReference,
              replayReservationId: nextReplayReservationId,
            })
            .where(
              existing.replayReservationId === null
                ? eq(schema.creditLedger.id, existing.id)
                : and(
                    eq(schema.creditLedger.id, existing.id),
                    eq(schema.creditLedger.replayReservationId, existing.replayReservationId)
                  )
            )
            .returning({ id: schema.creditLedger.id })
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.consumeTransactionCredit.updateExisting"
              )
            )
          if (updated === undefined) {
            return yield* toSyncEngineStorageError({
              operation:
                "sourceNormalizationRepository.consumeTransactionCredit.reservationOwnership",
              error: "Replay transaction credit reservation ownership changed",
            })
          }
        }
        return mode === "reserve" &&
          replayReservationId !== null &&
          nextReplayReservationId === replayReservationId
          ? migratedReference
          : null
      }

      if (mode === "persist" && replayReservationId !== null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.consumeTransactionCredit.missingReservation",
          error: "Replay transaction credit reservation no longer exists",
        })
      }

      const reference = externalReference ?? rawReference
      if (reference === null) {
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.consumeTransactionCredit.identity",
          error: "Transaction is missing a stable source identity",
        })
      }

      const now = nowDate()
      const rows = yield* executor
        .select({
          balance: sql<number>`coalesce(sum(${schema.creditLedger.delta}), 0)`,
          expiresAt: schema.creditLedger.expiresAt,
        })
        .from(schema.creditLedger)
        .where(
          and(
            eq(schema.creditLedger.userId, account.userId),
            or(isNull(schema.creditLedger.expiresAt), gt(schema.creditLedger.expiresAt, now))
          )
        )
        .groupBy(schema.creditLedger.expiresAt)
        .orderBy(asc(schema.creditLedger.expiresAt))
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.consumeTransactionCredit.loadBalance"
          )
        )

      const buckets = rows.map((row) => ({
        balance: Number(row.balance),
        expiresAt: row.expiresAt,
      }))
      const totalBalance = buckets.reduce((total, candidate) => total + candidate.balance, 0)
      if (totalBalance <= 0) {
        return yield* new SourceSyncCreditExhaustedError({
          reasonCode: "no_usable_credits",
          availableCredits: Math.max(totalBalance, 0),
        })
      }

      const bucket = buckets.find((candidate) => candidate.balance > 0)
      if (bucket === undefined) {
        return yield* new SourceSyncCreditExhaustedError({
          reasonCode: "no_usable_credits",
          availableCredits: Math.max(totalBalance, 0),
        })
      }

      yield* executor
        .insert(schema.creditLedger)
        .values({
          userId: account.userId,
          delta: -1,
          kind: "transaction_usage",
          reference,
          paymentReference: null,
          replayReservationId,
          expiresAt: bucket.expiresAt,
        })
        .pipe(
          wrapSyncEngineSqlError("sourceNormalizationRepository.consumeTransactionCredit.insert")
        )

      return reference
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
        return yield* toSyncEngineStorageError({
          operation: "sourceNormalizationRepository.upsertVenueContext",
          error: "failed to persist transaction venue context",
        })
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

  const upsertCanonicalTransfers = ({
    executor,
    canonicalTransfers,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly canonicalTransfers: ReadonlyArray<SourceTransferDraft>
  }) =>
    Effect.forEach(canonicalTransfers, (transfer) =>
      Effect.gen(function* () {
        const now = nowDate()
        const [persisted] = yield* executor
          .insert(schema.transfers)
          .values({
            ...transfer,
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
              assetRepresentationId: sql.raw("excluded.asset_representation_id"),
              amount: sql.raw("excluded.amount"),
              tokenId: sql.raw("excluded.token_id"),
              notes: sql.raw("excluded.notes"),
              metadata: sql.raw("excluded.metadata"),
              principalId: sql.raw("excluded.principal_id"),
              updatedAt: now,
            },
          })
          .returning(selectPersistedTransferFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertCanonicalTransfers"))

        if (persisted === undefined) {
          return yield* toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertCanonicalTransfers",
            error: "failed to persist transfer",
          })
        }

        const amount = yield* decodeNumericString({
          value: persisted.amount,
          operation: "sourceNormalizationRepository.upsertCanonicalTransfers.amount",
        })

        return {
          ...persisted,
          amount,
        }
      })
    )

  /**
   * Keep the transaction's provider-asset dependencies in step with the
   * latest normalization pass. Replays can change which provider assets a
   * record depends on, so stale rows are removed instead of accreting.
   */
  const syncProviderAssetTransactionUses = ({
    executor,
    transactionId,
    sourceId,
    providerAssetRowIds,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly sourceId: string
    readonly providerAssetRowIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const distinctProviderAssetRowIds = [...new Set(providerAssetRowIds)]

      yield* executor
        .delete(schema.providerAssetTransactionUses)
        .where(
          and(
            eq(schema.providerAssetTransactionUses.transactionId, transactionId),
            distinctProviderAssetRowIds.length === 0
              ? undefined
              : notInArray(
                  schema.providerAssetTransactionUses.providerAssetRowId,
                  distinctProviderAssetRowIds
                )
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.syncProviderAssetTransactionUses.deleteStale"
          )
        )

      if (distinctProviderAssetRowIds.length === 0) {
        return
      }

      yield* executor
        .insert(schema.providerAssetTransactionUses)
        .values(
          distinctProviderAssetRowIds.map((providerAssetRowId) => ({
            providerAssetRowId,
            transactionId,
            sourceId,
            createdAt: now,
            updatedAt: now,
          }))
        )
        .onConflictDoNothing({
          target: [
            schema.providerAssetTransactionUses.providerAssetRowId,
            schema.providerAssetTransactionUses.transactionId,
          ],
        })
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.syncProviderAssetTransactionUses.insert"
          )
        )
    })

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
        const incomingObservedRepresentationIsAbsent = sql`
          excluded.observed_blockchain_id is null
          and excluded.observed_representation_type is null
          and excluded.observed_contract_address is null
          and excluded.observed_mint_address is null
          and excluded.observed_decimals is null
        `
        const incomingTransferIsAccountingOnly = sql`
          excluded.processing_mode = 'accounting_only'
        `
        const incomingObservedRepresentationMatchesStoredIdentity = sql`
          excluded.observed_blockchain_id is not null
          and excluded.observed_blockchain_id = ${schema.providerTransfers.observedBlockchainId}
          and excluded.observed_contract_address is not distinct from ${schema.providerTransfers.observedContractAddress}
          and excluded.observed_mint_address is not distinct from ${schema.providerTransfers.observedMintAddress}
          and (
            excluded.observed_representation_type is null
            or ${schema.providerTransfers.observedRepresentationType} is null
            or excluded.observed_representation_type = ${schema.providerTransfers.observedRepresentationType}
          )
        `
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
              processingMode: sql.raw("excluded.processing_mode"),
              fromAccountRef: sql.raw("excluded.from_account_ref"),
              toAccountRef: sql.raw("excluded.to_account_ref"),
              fromAddress: sql.raw("excluded.from_address"),
              toAddress: sql.raw("excluded.to_address"),
              networkName: sql.raw("excluded.network_name"),
              networkHash: sql.raw("excluded.network_hash"),
              observedBlockchainId: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent}
                then ${schema.providerTransfers.observedBlockchainId}
                else excluded.observed_blockchain_id
              end`,
              observedRepresentationType: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent} or (
                  ${incomingObservedRepresentationMatchesStoredIdentity}
                  and excluded.observed_representation_type is null
                )
                then ${schema.providerTransfers.observedRepresentationType}
                else excluded.observed_representation_type
              end`,
              observedContractAddress: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent}
                then ${schema.providerTransfers.observedContractAddress}
                else excluded.observed_contract_address
              end`,
              observedMintAddress: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent}
                then ${schema.providerTransfers.observedMintAddress}
                else excluded.observed_mint_address
              end`,
              observedDecimals: sql`case
                when ${incomingTransferIsAccountingOnly} then null
                when ${incomingObservedRepresentationIsAbsent} or (
                  ${incomingObservedRepresentationMatchesStoredIdentity}
                  and excluded.observed_decimals is null
                )
                then ${schema.providerTransfers.observedDecimals}
                else excluded.observed_decimals
              end`,
              amount: sql.raw("excluded.amount"),
              metadata: sql`case
                when (
                  not (${incomingTransferIsAccountingOnly})
                  and (
                    ${incomingObservedRepresentationIsAbsent}
                    or ${incomingObservedRepresentationMatchesStoredIdentity}
                  )
                )
                  and excluded.observed_decimals is null
                  and ${schema.providerTransfers.observedDecimals} is not null
                  and excluded.amount = ${schema.providerTransfers.amount}
                then ${schema.providerTransfers.metadata}
                else excluded.metadata
              end`,
              updatedAt: now,
            },
          })
          .returning(selectPersistedProviderTransferFields)
          .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.upsertProviderTransfers"))

        if (persisted === undefined) {
          return yield* toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertProviderTransfers",
            error: "failed to persist provider transfer",
          })
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
              assetRepresentationId: sql.raw("excluded.asset_representation_id"),
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
          return yield* toSyncEngineStorageError({
            operation: "sourceNormalizationRepository.upsertTransactionLegs",
            error: "failed to persist transaction leg",
          })
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

  const recordSourceRepresentationUses = ({
    executor,
    providerTransfers,
    sourceId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly providerTransfers: ReadonlyArray<SourceProviderTransferDraft>
    readonly sourceId: string
  }) => {
    const observedRepresentations = new Map<
      string,
      {
        readonly sourceId: string
        readonly blockchainId: string
        readonly representationType: "native" | "token" | "nft"
        readonly contractAddress: string | null
        readonly mintAddress: string | null
      }
    >()

    for (const transfer of providerTransfers) {
      if (
        transfer.observedBlockchainId === null ||
        transfer.observedBlockchainId === undefined ||
        transfer.observedRepresentationType === null ||
        transfer.observedRepresentationType === undefined
      ) {
        continue
      }

      const representation = {
        sourceId,
        blockchainId: transfer.observedBlockchainId,
        representationType: transfer.observedRepresentationType,
        contractAddress: canonicalizeAddress(transfer.observedContractAddress ?? null),
        mintAddress: canonicalizeAddress(transfer.observedMintAddress ?? null),
      } as const
      const key = JSON.stringify([
        representation.sourceId,
        representation.blockchainId,
        representation.representationType,
        representation.contractAddress,
        representation.mintAddress,
      ])
      observedRepresentations.set(key, representation)
    }

    if (observedRepresentations.size === 0) {
      return Effect.void
    }

    const now = nowDate()
    return executor
      .insert(schema.sourceRepresentationUses)
      .values(
        Array.from(observedRepresentations.values(), (representation) => ({
          ...representation,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .onConflictDoNothing()
      .pipe(wrapSyncEngineSqlError("sourceNormalizationRepository.recordSourceRepresentationUses"))
  }

  const removeInventoryMovementsForTransaction = ({
    executor,
    transactionId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
  }) =>
    executor
      .delete(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.transactionId, transactionId))
      .pipe(
        wrapSyncEngineSqlError(
          "sourceNormalizationRepository.removeInventoryMovementsForTransaction.deleteMovements"
        )
      )

  const removeInventoryMovementForProviderTransfer = ({
    executor,
    providerTransferId,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly providerTransferId: string
  }) =>
    executor
      .delete(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.providerTransferId, providerTransferId))
      .pipe(
        wrapSyncEngineSqlError(
          "sourceNormalizationRepository.removeInventoryMovementForProviderTransfer.deleteMovement"
        )
      )

  const removeStaleProviderInventoryMovements = ({
    executor,
    transactionId,
    currentProviderTransferIds,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly currentProviderTransferIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const movements = yield* executor
        .select({ providerTransferId: schema.inventoryMovements.providerTransferId })
        .from(schema.inventoryMovements)
        .where(
          and(
            eq(schema.inventoryMovements.transactionId, transactionId),
            sql`${schema.inventoryMovements.providerTransferId} is not null`
          )
        )
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.removeStaleProviderInventoryMovements.selectMovements"
          )
        )

      yield* Effect.forEach(
        movements.flatMap(({ providerTransferId }) =>
          providerTransferId !== null && !currentProviderTransferIds.has(providerTransferId)
            ? [providerTransferId]
            : []
        ),
        (providerTransferId) =>
          removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId,
          })
      )
    })

  const clearStaleObservedProviderTransferRepresentations = ({
    executor,
    transactionId,
    currentProviderTransferIds,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transactionId: string
    readonly currentProviderTransferIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const providerTransfers = yield* executor
        .select({
          id: schema.providerTransfers.id,
          reconciliationStatus: schema.transferReconciliations.status,
        })
        .from(schema.providerTransfers)
        .leftJoin(
          schema.transferReconciliations,
          eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id)
        )
        .where(eq(schema.providerTransfers.transactionId, transactionId))
        .pipe(
          wrapSyncEngineSqlError(
            "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.selectTransfers"
          )
        )

      yield* Effect.forEach(
        providerTransfers.filter(({ id }) => !currentProviderTransferIds.has(id)),
        ({ id, reconciliationStatus }) =>
          Effect.gen(function* () {
            if (reconciliationStatus === "auto_applied" || reconciliationStatus === "approved") {
              return yield* new SyncEngineStorageError({
                operation:
                  "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.activeReconciliation",
                cause: {
                  providerTransferId: id,
                  reconciliationStatus,
                  message:
                    "Cannot remove observed provider transfer evidence while its reconciliation is active.",
                },
              })
            }

            yield* executor
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: null,
                observedRepresentationType: null,
                observedContractAddress: null,
                observedMintAddress: null,
                observedDecimals: null,
                processingMode: "stale",
                updatedAt: nowDate(),
              })
              .where(eq(schema.providerTransfers.id, id))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.clearStaleObservedProviderTransferRepresentations.clearTransfer"
                )
              )
          })
      )
    })

  const persistProviderInventoryMovements = ({
    executor,
    transaction,
    providerTransfers,
    feesOnly,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly transaction: PersistedSourceTransaction
    readonly providerTransfers: ReadonlyArray<PersistedSourceProviderTransfer>
    readonly feesOnly: boolean
  }) => {
    const orderedProviderTransfers = [
      ...providerTransfers.filter((providerTransfer) => providerTransfer.direction === "inbound"),
      ...providerTransfers.filter((providerTransfer) => providerTransfer.direction === "outbound"),
    ]

    return Effect.forEach(orderedProviderTransfers, (providerTransfer) =>
      Effect.gen(function* () {
        if (
          providerTransfer.processingMode === "evidence_only" ||
          providerTransfer.processingMode === "stale"
        ) {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        const metadata = yield* decodeProviderTransferMetadata(providerTransfer.metadata)
        const purpose = metadata.purpose

        if (feesOnly && purpose !== "fee") {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        if (providerTransfer.providerAssetId === null) {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        const [assetMapping] = yield* executor
          .select({
            assetId: schema.providerAssetMappings.canonicalAssetId,
            assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
          })
          .from(schema.providerAssetMappings)
          .where(
            and(
              eq(schema.providerAssetMappings.providerAssetRowId, providerTransfer.providerAssetId),
              eq(schema.providerAssetMappings.mappingKind, "asset"),
              eq(schema.providerAssetMappings.mappingStatus, "approved")
            )
          )
          .limit(1)
          .pipe(
            wrapSyncEngineSqlError(
              "sourceNormalizationRepository.persistProviderInventoryMovements.assetMapping"
            )
          )

        if (assetMapping?.assetId === null || assetMapping?.assetId === undefined) {
          return yield* removeInventoryMovementForProviderTransfer({
            executor,
            providerTransferId: providerTransfer.id,
          })
        }

        const now = nowDate()
        const [movement] = yield* executor
          .insert(schema.inventoryMovements)
          .values({
            principalId: transaction.principalId,
            sourceId: providerTransfer.sourceId,
            sourceRawRecordId: providerTransfer.sourceRawRecordId,
            transactionId: transaction.id,
            providerTransferId: providerTransfer.id,
            assetId: assetMapping.assetId,
            assetRepresentationId: assetMapping.assetRepresentationId,
            timestamp: providerTransfer.timestamp,
            direction: providerTransfer.direction,
            purpose,
            taxTreatment: "pending_review",
            reconciliationStatus: "unmatched",
            amount: providerTransfer.amount,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.inventoryMovements.providerTransferId,
            targetWhere: sql`${schema.inventoryMovements.providerTransferId} is not null`,
            set: {
              principalId: sql.raw("excluded.principal_id"),
              sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
              transactionId: sql.raw("excluded.transaction_id"),
              assetId: sql.raw("excluded.asset_id"),
              assetRepresentationId: sql.raw("excluded.asset_representation_id"),
              timestamp: sql.raw("excluded.timestamp"),
              direction: sql.raw("excluded.direction"),
              purpose: sql.raw("excluded.purpose"),
              reconciliationStatus: sql`case
                  when ${schema.inventoryMovements.sourceRawRecordId} is distinct from excluded.source_raw_record_id
                    or ${schema.inventoryMovements.transactionId} is distinct from excluded.transaction_id
                    or ${schema.inventoryMovements.assetId} is distinct from excluded.asset_id
                    or ${schema.inventoryMovements.assetRepresentationId} is distinct from excluded.asset_representation_id
                    or ${schema.inventoryMovements.timestamp} is distinct from excluded.timestamp
                    or ${schema.inventoryMovements.direction} is distinct from excluded.direction
                    or ${schema.inventoryMovements.purpose} is distinct from excluded.purpose
                    or ${schema.inventoryMovements.amount} is distinct from excluded.amount
                  then 'unmatched'::inventory_movement_reconciliation_status
                  else ${schema.inventoryMovements.reconciliationStatus}
                end`,
              amount: sql.raw("excluded.amount"),
              updatedAt: now,
            },
          })
          .returning({ id: schema.inventoryMovements.id })
          .pipe(
            wrapSyncEngineSqlError(
              "sourceNormalizationRepository.persistProviderInventoryMovements.upsertMovement"
            )
          )

        if (movement === undefined) {
          return yield* toSyncEngineStorageError({
            operation:
              "sourceNormalizationRepository.persistProviderInventoryMovements.upsertMovement",
            error: "failed to persist inventory movement",
          })
        }
      })
    )
  }

  const persistFeeInventoryMovements = ({
    executor,
    legs,
  }: {
    readonly executor: SourceNormalizationExecutor
    readonly legs: ReadonlyArray<PersistedSourceLegRecord>
  }) =>
    Effect.forEach(
      legs.filter((leg) => leg.kind === "fee"),
      (leg) =>
        Effect.gen(function* () {
          const amountComparison = yield* compareDecimalStrings({
            left: leg.amount,
            right: "0",
          })

          if (amountComparison === 0) {
            yield* executor
              .delete(schema.inventoryMovements)
              .where(eq(schema.inventoryMovements.transactionLegId, leg.id))
              .pipe(
                wrapSyncEngineSqlError(
                  "sourceNormalizationRepository.persistFeeInventoryMovements.deleteZeroMovement"
                )
              )
            return
          }

          if (leg.transactionId === null) {
            return yield* toSyncEngineStorageError({
              operation: "sourceNormalizationRepository.persistFeeInventoryMovements.transactionId",
              error: "fee leg is missing its transaction",
            })
          }

          const now = nowDate()
          const [movement] = yield* executor
            .insert(schema.inventoryMovements)
            .values({
              principalId: leg.principalId,
              sourceId: leg.sourceId,
              sourceRawRecordId: leg.sourceRawRecordId,
              transactionId: leg.transactionId,
              providerTransferId: null,
              transactionLegId: leg.id,
              assetId: leg.assetId,
              assetRepresentationId: leg.assetRepresentationId,
              timestamp: leg.timestamp,
              direction: "outbound",
              purpose: "fee",
              taxTreatment: "pending_review",
              reconciliationStatus: "unmatched",
              amount: leg.amount,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.inventoryMovements.transactionLegId,
              targetWhere: sql`${schema.inventoryMovements.transactionLegId} is not null`,
              set: {
                principalId: sql.raw("excluded.principal_id"),
                sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
                transactionId: sql.raw("excluded.transaction_id"),
                assetId: sql.raw("excluded.asset_id"),
                assetRepresentationId: sql.raw("excluded.asset_representation_id"),
                timestamp: sql.raw("excluded.timestamp"),
                reconciliationStatus: sql`case
                  when ${schema.inventoryMovements.sourceRawRecordId} is distinct from excluded.source_raw_record_id
                    or ${schema.inventoryMovements.transactionId} is distinct from excluded.transaction_id
                    or ${schema.inventoryMovements.assetId} is distinct from excluded.asset_id
                    or ${schema.inventoryMovements.assetRepresentationId} is distinct from excluded.asset_representation_id
                    or ${schema.inventoryMovements.timestamp} is distinct from excluded.timestamp
                    or ${schema.inventoryMovements.amount} is distinct from excluded.amount
                  then 'unmatched'::inventory_movement_reconciliation_status
                  else ${schema.inventoryMovements.reconciliationStatus}
                end`,
                amount: sql.raw("excluded.amount"),
                updatedAt: now,
              },
            })
            .returning({ id: schema.inventoryMovements.id })
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.persistFeeInventoryMovements.upsertMovement"
              )
            )

          if (movement === undefined) {
            return yield* toSyncEngineStorageError({
              operation:
                "sourceNormalizationRepository.persistFeeInventoryMovements.upsertMovement",
              error: "failed to persist fee inventory movement",
            })
          }
        })
    )

  const persistNormalizedArtifacts = <E>(
    params: PersistNormalizedSourceArtifactsParams<E>
  ): Effect.Effect<
    PersistNormalizedSourceArtifactsResult,
    E | SyncEngineStorageError | SourceSyncCreditExhaustedError
  > =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const networkMovementLockKeys = [
            ...new Set(
              params.providerTransfers
                .filter(
                  (providerTransfer) =>
                    providerTransfer.networkHash !== null &&
                    providerTransfer.networkHash.trim() !== ""
                )
                .map(
                  (providerTransfer) =>
                    `${params.transaction.principalId}:${providerTransfer.networkName?.toLowerCase() ?? ""}:${providerTransfer.networkHash?.toLowerCase() ?? ""}`
                )
            ),
          ].sort()
          yield* Effect.forEach(
            networkMovementLockKeys,
            (lockKey) =>
              tx
                .execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
                .pipe(
                  wrapSyncEngineSqlError(
                    "sourceNormalizationRepository.persistNormalizedArtifacts.lockNetworkMovement"
                  )
                ),
            { concurrency: 1, discard: true }
          )

          const [ownedSource] = yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(
              and(
                eq(schema.sources.id, params.transaction.sourceId),
                eq(schema.sources.principalId, params.transaction.principalId)
              )
            )
            .limit(1)
            .for("update")
            .pipe(
              wrapSyncEngineSqlError(
                "sourceNormalizationRepository.persistNormalizedArtifacts.lockSourceInventory"
              )
            )

          if (ownedSource === undefined) {
            return yield* toSyncEngineStorageError({
              operation:
                "sourceNormalizationRepository.persistNormalizedArtifacts.lockSourceInventory",
              error: `Source ${params.transaction.sourceId} is no longer owned by principal ${params.transaction.principalId}`,
            })
          }

          if (params.beforePersist !== undefined) {
            yield* params.beforePersist
          }

          const decisions = yield* principalAssetOverrideDecisionLoader.load({
            principalId: params.transaction.principalId,
            assetRepresentationIds: [
              ...params.canonicalTransfers,
              ...("legs" in params ? params.legs : []),
            ].flatMap(({ assetRepresentationId }) =>
              assetRepresentationId === null || assetRepresentationId === undefined
                ? []
                : [assetRepresentationId]
            ),
          })
          const canonicalTransfers = params.canonicalTransfers.map((transfer) => ({
            ...transfer,
            assetId: resolvePrincipalAssetId({
              decisions,
              systemAssetId: transfer.assetId,
              assetRepresentationId: transfer.assetRepresentationId,
            }),
          }))

          const persistedTransaction = yield* upsertTransaction({
            executor: tx,
            transaction: params.transaction,
          })
          yield* consumeTransactionCredit({
            executor: tx,
            externalId: persistedTransaction.externalId,
            mode: "persist",
            principalId: persistedTransaction.principalId,
            replayReservationId: params.replayReservationId ?? null,
            sourceId: persistedTransaction.sourceId,
            sourceRawRecordId: persistedTransaction.sourceRawRecordId,
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
          yield* recordSourceRepresentationUses({
            executor: tx,
            providerTransfers: params.providerTransfers,
            sourceId: persistedTransaction.sourceId,
          })
          yield* syncProviderAssetTransactionUses({
            executor: tx,
            transactionId: persistedTransaction.id,
            sourceId: persistedTransaction.sourceId,
            providerAssetRowIds: params.providerAssetRowIds,
          })
          const persistedProviderTransfers = yield* upsertProviderTransfers({
            executor: tx,
            transactionId: persistedTransaction.id,
            providerTransfers: params.providerTransfers,
          })
          const persistedCanonicalTransfers = yield* upsertCanonicalTransfers({
            executor: tx,
            canonicalTransfers,
          })
          const derivedLegs =
            "deriveLegs" in params
              ? yield* params.deriveLegs({
                  transaction: persistedTransaction,
                  venueContext: persistedVenueContext,
                  providerTransfers: persistedProviderTransfers,
                  canonicalTransfers: persistedCanonicalTransfers,
                })
              : params.legs
          const missingDerivedRepresentationIds = [
            ...new Set(
              derivedLegs.flatMap(({ assetRepresentationId }) =>
                assetRepresentationId === null ||
                assetRepresentationId === undefined ||
                decisions.assetIdByRepresentationId.has(assetRepresentationId)
                  ? []
                  : [assetRepresentationId]
              )
            ),
          ]
          const additionalCatalogPairs =
            missingDerivedRepresentationIds.length === 0
              ? []
              : yield* tx
                  .select({
                    id: schema.assetRepresentations.id,
                    assetId: schema.assetRepresentations.assetId,
                  })
                  .from(schema.assetRepresentations)
                  .where(inArray(schema.assetRepresentations.id, missingDerivedRepresentationIds))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "sourceNormalizationRepository.persistNormalizedArtifacts.loadDerivedLegRepresentations"
                    )
                  )
          const completeDecisions = {
            ...decisions,
            assetIdByRepresentationId: new Map([
              ...decisions.assetIdByRepresentationId,
              ...additionalCatalogPairs.map(({ id, assetId }) => [id, assetId] as const),
            ]),
          }
          const effectiveLegs = derivedLegs.map((leg) => ({
            ...leg,
            assetId: resolvePrincipalAssetId({
              decisions: completeDecisions,
              systemAssetId: leg.assetId,
              assetRepresentationId: leg.assetRepresentationId,
            }),
          }))
          const persistedLegs = yield* upsertTransactionLegs({
            executor: tx,
            legs: effectiveLegs,
          })

          const hasCompletedStatus = hasCompletedProviderStatus(params.transaction.providerStatus)
          const hasFailedStatus = hasFailedProviderStatus(params.transaction.providerStatus)
          const materializesProviderMovements = hasCompletedStatus || hasFailedStatus
          const currentProviderTransferIds = new Set(
            persistedProviderTransfers.map((providerTransfer) => providerTransfer.id)
          )

          yield* clearStaleObservedProviderTransferRepresentations({
            executor: tx,
            transactionId: persistedTransaction.id,
            currentProviderTransferIds,
          })

          if (materializesProviderMovements) {
            yield* removeStaleProviderInventoryMovements({
              executor: tx,
              transactionId: persistedTransaction.id,
              currentProviderTransferIds,
            })
            yield* persistProviderInventoryMovements({
              executor: tx,
              transaction: persistedTransaction,
              providerTransfers: persistedProviderTransfers,
              feesOnly: hasFailedStatus,
            })
            yield* persistFeeInventoryMovements({
              executor: tx,
              legs: persistedLegs,
            })
          } else {
            yield* removeInventoryMovementsForTransaction({
              executor: tx,
              transactionId: persistedTransaction.id,
            })
          }

          yield* upsertTransactionReview({
            executor: tx,
            transactionId: persistedTransaction.id,
            transactionReview: params.transactionReview,
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
            canonicalTransfers: persistedCanonicalTransfers,
            legs: persistedLegs,
          }
        })
      )
      .pipe(
        wrapPreservingCreditExhausted("sourceNormalizationRepository.persistNormalizedArtifacts")
      )

  const reserveReplayTransactionCredits: SourceNormalizationRepositoryShape["reserveReplayTransactionCredits"] =
    ({ reservationId, transactions }) =>
      db
        .transaction((tx) =>
          Effect.forEach(
            transactions,
            (transaction) =>
              consumeTransactionCredit({
                executor: tx,
                externalId: transaction.externalId,
                mode: "reserve",
                principalId: transaction.principalId,
                replayReservationId: reservationId,
                sourceId: transaction.sourceId,
                sourceRawRecordId: transaction.sourceRawRecordId,
              }),
            { concurrency: 1 }
          ).pipe(
            Effect.map((references) =>
              references.flatMap((reference, index) =>
                reference === null
                  ? []
                  : [
                      {
                        reference,
                        sourceRawRecordId: transactions[index]?.sourceRawRecordId ?? null,
                      },
                    ]
              )
            )
          )
        )
        .pipe(
          wrapPreservingCreditExhausted(
            "sourceNormalizationRepository.reserveReplayTransactionCredits"
          )
        )

  const releaseReplayTransactionCredits: SourceNormalizationRepositoryShape["releaseReplayTransactionCredits"] =
    ({ references, reservationId }) =>
      references.length === 0
        ? Effect.void
        : db
            .delete(schema.creditLedger)
            .where(
              and(
                eq(schema.creditLedger.kind, "transaction_usage"),
                eq(schema.creditLedger.replayReservationId, reservationId),
                inArray(schema.creditLedger.reference, references)
              )
            )
            .pipe(
              wrapSyncEngineStorageError(
                "sourceNormalizationRepository.releaseReplayTransactionCredits"
              )
            )

  return SourceNormalizationRepository.of({
    reserveReplayTransactionCredits,
    releaseReplayTransactionCredits,
    persistNormalizedArtifacts,
  } satisfies SourceNormalizationRepositoryShape)
})

export const SourceNormalizationRepositoryLive = Layer.effect(SourceNormalizationRepository, make)
