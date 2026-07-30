/**
 * TransferReconciliationRepositoryLive - Persistence-backed reconciliation queries
 * and durable provider-transfer match state.
 *
 * @module TransferReconciliationRepositoryLive
 */

import { aliasedTable, and, asc, count, eq, gt, gte, inArray, lte, ne, or, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  SyncEngineStorageError,
  TransferReconciliationRepository,
  type DeterministicTransferCanonicalizationSummary,
  type FindOnchainTransferReconciliationCandidatesParams,
  type ListProviderTransfersForReconciliationParams,
  type TransferReconciliationRecordDraft,
  type TransferReconciliationRepositoryShape,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import { nowDate, wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")

  const INTERNAL_TRANSFER_REASON =
    "Deterministic provider transfer reconciled to a principal-owned onchain transfer."
  const FIFO_INVENTORY_REVIEW_LAYER = "fifo_inventory"
  const FIFO_INVENTORY_REVIEW_REASON_PREFIX = "fifo_inventory:"

  const decodeBigDecimal = ({
    value,
    operation,
  }: {
    readonly value: string
    readonly operation: string
  }) =>
    Option.match(BigDecimal.fromString(value.trim()), {
      onNone: () =>
        Effect.fail(
          new SyncEngineStorageError({
            operation,
            cause: `Invalid decimal value: ${value}`,
          })
        ),
      onSome: Effect.succeed,
    })

  const formatDecimal = ({
    value,
    operation,
  }: {
    readonly value: unknown
    readonly operation: string
  }) =>
    Schema.decodeUnknown(Schema.Union(Schema.String, Schema.Number))(value).pipe(
      Effect.map(String),
      Effect.mapError(
        () =>
          new SyncEngineStorageError({
            operation,
            cause: `Invalid numeric value: ${String(value)}`,
          })
      )
    )

  const listProviderTransfersForReconciliation: TransferReconciliationRepositoryShape["listProviderTransfersForReconciliation"] =
    ({ principalId, sourceId }: ListProviderTransfersForReconciliationParams) =>
      db
        .select({
          principalId: schema.sources.principalId,
          providerTransferId: schema.providerTransfers.id,
          providerSourceId: schema.providerTransfers.sourceId,
          providerTransactionId: schema.providerTransfers.transactionId,
          providerAssetId: schema.providerTransfers.providerAssetId,
          canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
          timestamp: schema.providerTransfers.timestamp,
          direction: schema.providerTransfers.direction,
          fromAddress: schema.providerTransfers.fromAddress,
          toAddress: schema.providerTransfers.toAddress,
          networkName: schema.providerTransfers.networkName,
          networkHash: schema.providerTransfers.networkHash,
          amount: schema.providerTransfers.amount,
        })
        .from(schema.providerTransfers)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.providerTransfers.sourceId))
        .leftJoin(
          schema.providerAssetMappings,
          and(
            sql`${schema.providerAssetMappings.providerAssetRowId} = ${schema.providerTransfers.providerAssetId}`,
            eq(schema.providerAssetMappings.mappingStatus, "approved"),
            eq(schema.providerAssetMappings.mappingKind, "asset")
          )
        )
        .where(
          and(
            eq(schema.sources.principalId, principalId),
            eq(schema.providerTransfers.sourceId, sourceId)
          )
        )
        .orderBy(asc(schema.providerTransfers.timestamp))
        .pipe(
          wrapSyncEngineSqlError(
            "transferReconciliationRepository.listProviderTransfersForReconciliation"
          ),
          Effect.map((rows) =>
            rows.map((row) => ({
              ...row,
              amount: String(row.amount),
            }))
          )
        )

  const findOnchainTransferCandidates: TransferReconciliationRepositoryShape["findOnchainTransferCandidates"] =
    ({
      principalId,
      canonicalAssetId,
      direction,
      walletAddress,
      timestampStart,
      timestampEnd,
      networkName,
      networkHash,
    }: FindOnchainTransferReconciliationCandidatesParams) => {
      const ownershipColumn =
        direction === "outbound" ? schema.transfers.toAddress : schema.transfers.fromAddress

      const networkNameCondition =
        networkName === null
          ? sql`true`
          : sql`lower(${schema.blockchains.name}) = lower(${networkName})`
      const networkHashCondition =
        networkHash === null ? sql`true` : eq(schema.transfers.txHash, networkHash)

      return db
        .select({
          transferId: schema.transfers.id,
          transactionId: schema.transactionOnchainContext.transactionId,
          sourceId: schema.transfers.sourceId,
          addressId: schema.addresses.id,
          blockchainId: schema.transfers.blockchainId,
          blockchainName: schema.blockchains.name,
          txHash: schema.transfers.txHash,
          timestamp: schema.transfers.timestamp,
          fromAddress: schema.transfers.fromAddress,
          toAddress: schema.transfers.toAddress,
          assetId: schema.transfers.assetId,
          amount: schema.transfers.amount,
        })
        .from(schema.transfers)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.transfers.sourceId))
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .leftJoin(schema.blockchains, eq(schema.blockchains.id, schema.transfers.blockchainId))
        .leftJoin(
          schema.transactionOnchainContext,
          and(
            eq(schema.transactionOnchainContext.addressId, schema.transfers.addressId),
            eq(schema.transactionOnchainContext.blockchainId, schema.transfers.blockchainId),
            eq(schema.transactionOnchainContext.chainTxId, schema.transfers.txHash)
          )
        )
        .where(
          and(
            eq(schema.sources.principalId, principalId),
            eq(schema.transfers.assetId, canonicalAssetId),
            sql`${schema.transfers.addressId} = ${schema.sources.addressId}`,
            eq(schema.addresses.address, walletAddress),
            sql`lower(${ownershipColumn}) = lower(${walletAddress})`,
            gte(schema.transfers.timestamp, timestampStart),
            lte(schema.transfers.timestamp, timestampEnd),
            networkNameCondition,
            networkHashCondition
          )
        )
        .orderBy(asc(schema.transfers.timestamp), asc(schema.transfers.id))
        .pipe(
          wrapSyncEngineSqlError("transferReconciliationRepository.findOnchainTransferCandidates"),
          Effect.map((rows) =>
            rows.map((row) => ({
              ...row,
              blockchainId: row.blockchainId,
              blockchainName: row.blockchainName,
              amount: String(row.amount),
            }))
          )
        )
    }

  const upsertTransferReconciliation: TransferReconciliationRepositoryShape["upsertTransferReconciliation"] =
    ({
      principalId,
      providerTransferId,
      canonicalTransferId,
      canonicalTransactionId,
      status,
      matchReason,
      confidence,
      deterministic,
      reviewMetadata,
    }: TransferReconciliationRecordDraft) =>
      Effect.gen(function* () {
        const now = nowDate()
        yield* db
          .insert(schema.transferReconciliations)
          .values({
            principalId,
            providerTransferId,
            canonicalTransferId,
            canonicalTransactionId,
            status,
            matchReason,
            confidence,
            deterministic,
            reviewMetadata,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.transferReconciliations.providerTransferId,
            set: {
              principalId: sql.raw("excluded.principal_id"),
              canonicalTransferId: sql.raw("excluded.canonical_transfer_id"),
              canonicalTransactionId: sql.raw("excluded.canonical_transaction_id"),
              status: sql.raw("excluded.status"),
              matchReason: sql.raw("excluded.match_reason"),
              confidence: sql.raw("excluded.confidence"),
              deterministic: sql.raw("excluded.deterministic"),
              reviewMetadata: sql.raw("excluded.review_metadata"),
              updatedAt: now,
            },
            setWhere: sql`${schema.transferReconciliations.status} not in ('approved', 'rejected')`,
          })
          .pipe(
            wrapSyncEngineSqlError("transferReconciliationRepository.upsertTransferReconciliation")
          )
      })

  const applyDeterministicInternalTransferCanonicalization: TransferReconciliationRepositoryShape["applyDeterministicInternalTransferCanonicalization"] =
    ({ principalId, sourceId, reconciliationId }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = nowDate()

            const loadReconciliations = () =>
              tx
                .select({
                  providerTransferId: schema.providerTransfers.id,
                  providerDirection: schema.providerTransfers.direction,
                  providerTransactionId: schema.providerTransfers.transactionId,
                  canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
                  canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
                  canonicalTransferExternalId: schema.transfers.externalId,
                  assetId: schema.transfers.assetId,
                  amount: schema.transfers.amount,
                  providerTransactionSourceId: providerTransactionTable.sourceId,
                  providerTransactionSourceRawRecordId: providerTransactionTable.sourceRawRecordId,
                  providerTransactionExternalId: providerTransactionTable.externalId,
                  providerTransactionTimestamp: providerTransactionTable.timestamp,
                  providerTransactionPrincipalId: providerTransactionTable.principalId,
                  canonicalTransactionSourceId: canonicalTransactionTable.sourceId,
                  canonicalTransactionSourceRawRecordId:
                    canonicalTransactionTable.sourceRawRecordId,
                  canonicalTransactionExternalId: canonicalTransactionTable.externalId,
                  canonicalTransactionTimestamp: canonicalTransactionTable.timestamp,
                  canonicalTransactionPrincipalId: canonicalTransactionTable.principalId,
                })
                .from(schema.transferReconciliations)
                .innerJoin(
                  schema.providerTransfers,
                  eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
                )
                .innerJoin(
                  schema.transfers,
                  eq(schema.transfers.id, schema.transferReconciliations.canonicalTransferId)
                )
                .innerJoin(
                  providerTransactionTable,
                  eq(providerTransactionTable.id, schema.providerTransfers.transactionId)
                )
                .innerJoin(
                  canonicalTransactionTable,
                  eq(
                    canonicalTransactionTable.id,
                    schema.transferReconciliations.canonicalTransactionId
                  )
                )
                .where(
                  and(
                    eq(schema.transferReconciliations.principalId, principalId),
                    eq(schema.providerTransfers.sourceId, sourceId),
                    reconciliationId === undefined
                      ? sql`true`
                      : eq(schema.transferReconciliations.id, reconciliationId),
                    // Admin-approved rows stay eligible here so later sync or replay passes can
                    // materialize the canonical side effects. Auto-applied rows remain restricted
                    // to deterministic matches only.
                    or(
                      and(
                        eq(schema.transferReconciliations.status, "auto_applied"),
                        eq(schema.transferReconciliations.deterministic, true)
                      ),
                      eq(schema.transferReconciliations.status, "approved")
                    ),
                    sql`${schema.transferReconciliations.canonicalTransferId} is not null`,
                    sql`${schema.transferReconciliations.canonicalTransactionId} is not null`
                  )
                )
                .orderBy(asc(schema.providerTransfers.timestamp))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.selectReconciliations"
                  )
                )

            const reconciliationsBeforeLock = yield* loadReconciliations()
            const inventorySourceIds = [
              ...new Set([
                sourceId,
                ...reconciliationsBeforeLock.flatMap((reconciliation) => [
                  reconciliation.providerTransactionSourceId,
                  reconciliation.canonicalTransactionSourceId,
                ]),
              ]),
            ].sort()

            const lockedSources = yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(
                and(
                  eq(schema.sources.principalId, principalId),
                  inArray(schema.sources.id, inventorySourceIds)
                )
              )
              .orderBy(asc(schema.sources.id))
              .for("update")
              .pipe(
                wrapSyncEngineSqlError(
                  "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockSourceInventory"
                )
              )

            if (lockedSources.length !== inventorySourceIds.length) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation:
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockSourceInventory",
                  cause: "Internal transfer sources are not owned by the reconciliation principal",
                })
              )
            }

            // The initial read only discovers which source rows must be locked. Replay or
            // normalization may have changed the joined transactions while this transaction
            // waited, so all canonicalization decisions use a fresh read under those locks.
            const reconciliations = yield* loadReconciliations()
            const lockedSourceIdSet = new Set(lockedSources.map(({ id }) => id))
            const hasUnlockedReconciliationSource = reconciliations.some(
              (reconciliation) =>
                !lockedSourceIdSet.has(reconciliation.providerTransactionSourceId) ||
                !lockedSourceIdSet.has(reconciliation.canonicalTransactionSourceId)
            )

            if (hasUnlockedReconciliationSource) {
              return yield* Effect.fail(
                new SyncEngineStorageError({
                  operation:
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockSourceInventory",
                  cause:
                    "Internal transfer reconciliation state changed while source locks were acquired",
                })
              )
            }

            const loadDependentUsageCount = (legId: string) =>
              // A leg with no FIFO lots should not block canonicalization. The aggregate returns
              // a single total count across all lots linked to the acquisition leg when they exist.
              tx
                .select({
                  disposalMatchCount: count(schema.disposalMatches.id),
                  custodyAllocationCount: count(schema.inventoryMovementAllocations.id),
                })
                .from(schema.fifoLots)
                .leftJoin(
                  schema.disposalMatches,
                  eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id)
                )
                .leftJoin(
                  schema.inventoryMovementAllocations,
                  eq(schema.inventoryMovementAllocations.fifoLotId, schema.fifoLots.id)
                )
                .where(eq(schema.fifoLots.sourceLegId, legId))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.loadDependentUsageCount"
                  )
                )

            const removeUnusedInboundProviderLot = ({
              providerTransferId,
            }: {
              readonly providerTransferId: string
            }) =>
              Effect.gen(function* () {
                const [existingLot] = yield* tx
                  .select({ id: schema.fifoLots.id })
                  .from(schema.fifoLots)
                  .where(eq(schema.fifoLots.sourceProviderTransferId, providerTransferId))
                  .limit(1)
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.removeUnusedInboundProviderLot.selectLot"
                    )
                  )

                if (existingLot === undefined) {
                  return
                }

                const [deletedLot] = yield* tx
                  .delete(schema.fifoLots)
                  .where(
                    and(
                      eq(schema.fifoLots.id, existingLot.id),
                      eq(schema.fifoLots.remainingAmount, schema.fifoLots.originalAmount),
                      sql`not exists (
                        select 1
                        from ${schema.disposalMatches}
                        where ${schema.disposalMatches.fifoLotId} = ${schema.fifoLots.id}
                      )`,
                      sql`not exists (
                        select 1
                        from ${schema.inventoryMovementAllocations}
                        where ${schema.inventoryMovementAllocations.fifoLotId} = ${schema.fifoLots.id}
                      )`
                    )
                  )
                  .returning({ id: schema.fifoLots.id })
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.removeUnusedInboundProviderLot.deleteLot"
                    )
                  )

                if (deletedLot === undefined) {
                  return yield* Effect.fail(
                    new SyncEngineStorageError({
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.removeUnusedInboundProviderLot.dependentUsage",
                      cause: `Cannot remove inbound provider lot ${existingLot.id} because later inventory usage depends on it`,
                    })
                  )
                }
              })

            const roundFiatAmount = (value: BigDecimal.BigDecimal) =>
              BigDecimal.format(BigDecimal.round(value, { scale: 8 }))

            const loadPrincipalLegs = ({ transactionId }: { readonly transactionId: string }) =>
              tx
                .select({
                  id: schema.transactionLegs.id,
                  kind: schema.transactionLegs.kind,
                  derivationRule: schema.transactionLegs.derivationRule,
                  externalId: schema.transactionLegs.externalId,
                  assetId: schema.transactionLegs.assetId,
                  amount: schema.transactionLegs.amount,
                  sourceTransferId: schema.transactionLegs.sourceTransferId,
                })
                .from(schema.transactionLegs)
                .where(
                  and(
                    eq(schema.transactionLegs.transactionId, transactionId),
                    ne(schema.transactionLegs.kind, "fee")
                  )
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.loadPrincipalLegs"
                  )
                )

            const loadInternalTransferDisposalMatches = ({
              disposalLegId,
            }: {
              readonly disposalLegId: string
            }) =>
              tx
                .select({
                  fifoLotId: schema.disposalMatches.fifoLotId,
                  matchedAmount: schema.disposalMatches.matchedAmount,
                  costBasis: schema.disposalMatches.costBasis,
                  acquiredAt: schema.fifoLots.acquiredAt,
                  costBasisPerToken: schema.fifoLots.costBasisPerToken,
                  costBasisCurrency: schema.fifoLots.costBasisCurrency,
                })
                .from(schema.disposalMatches)
                .innerJoin(
                  schema.fifoLots,
                  eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId)
                )
                .where(eq(schema.disposalMatches.disposalLegId, disposalLegId))
                .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.loadInternalTransferDisposalMatches"
                  )
                )

            const restoreDisposalMatches = (legId: string) =>
              Effect.gen(function* () {
                const matches = yield* tx
                  .select({
                    id: schema.disposalMatches.id,
                    fifoLotId: schema.disposalMatches.fifoLotId,
                    matchedAmount: schema.disposalMatches.matchedAmount,
                  })
                  .from(schema.disposalMatches)
                  .where(eq(schema.disposalMatches.disposalLegId, legId))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.restoreDisposalMatches.select"
                    )
                  )

                yield* Effect.forEach(matches, (match) =>
                  tx
                    .update(schema.fifoLots)
                    .set({
                      remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${match.matchedAmount}`,
                      updatedAt: nowDate(),
                    })
                    .where(eq(schema.fifoLots.id, match.fifoLotId))
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.restoreDisposalMatches.updateLot"
                      ),
                      Effect.asVoid
                    )
                )
              })

            const canClearPrincipalLegs = ({
              legs,
            }: {
              readonly legs: ReadonlyArray<{
                readonly id: string
                readonly kind: string
              }>
            }) =>
              Effect.gen(function* () {
                for (const leg of legs) {
                  if (leg.kind === "acquisition" || leg.kind === "income") {
                    const [dependent] = yield* loadDependentUsageCount(leg.id)
                    if (
                      Number(dependent?.disposalMatchCount ?? 0) > 0 ||
                      Number(dependent?.custodyAllocationCount ?? 0) > 0
                    ) {
                      return false
                    }
                  }
                }

                return true
              })

            const clearPrincipalLegs = ({
              legs,
            }: {
              readonly legs: ReadonlyArray<{
                readonly id: string
                readonly kind: string
              }>
            }) =>
              Effect.gen(function* () {
                yield* Effect.forEach(
                  legs.filter((leg) => leg.kind === "disposal"),
                  (leg) => restoreDisposalMatches(leg.id)
                )

                if (legs.length > 0) {
                  yield* tx
                    .delete(schema.transactionLegs)
                    .where(
                      inArray(
                        schema.transactionLegs.id,
                        legs.map((leg) => leg.id)
                      )
                    )
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.clearPrincipalLegs.delete"
                      )
                    )
                }
              })

            const isExpectedPrincipalLeg = ({
              leg,
              externalId,
              kind,
              derivationRule,
              assetId,
              amount,
              sourceTransferId,
            }: {
              readonly leg: {
                readonly externalId: string | null
                readonly kind: string
                readonly derivationRule: string | null
                readonly assetId: string
                readonly amount: unknown
                readonly sourceTransferId: string | null
              }
              readonly externalId: string
              readonly kind: "acquisition" | "disposal"
              readonly derivationRule: "internal_transfer_in" | "internal_transfer_out"
              readonly assetId: string
              readonly amount: string
              readonly sourceTransferId: string | null
            }) =>
              Effect.gen(function* () {
                const legAmount = yield* formatDecimal({
                  value: leg.amount,
                  operation:
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.isExpectedPrincipalLeg.amount",
                })
                const [expectedAmountDecimal, actualAmountDecimal] = yield* Effect.all([
                  decodeBigDecimal({
                    value: amount,
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.isExpectedPrincipalLeg.expectedAmount",
                  }),
                  decodeBigDecimal({
                    value: legAmount,
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.isExpectedPrincipalLeg.actualAmount",
                  }),
                ])

                return (
                  leg.externalId === externalId &&
                  leg.kind === kind &&
                  leg.derivationRule === derivationRule &&
                  leg.assetId === assetId &&
                  BigDecimal.equals(expectedAmountDecimal, actualAmountDecimal) &&
                  leg.sourceTransferId === sourceTransferId
                )
              })

            const loadOpenLots = ({
              lotPrincipalId,
              sourceId,
              assetId,
              maxAcquiredAt,
            }: {
              readonly lotPrincipalId: string
              readonly sourceId: string
              readonly assetId: string
              readonly maxAcquiredAt: Date
            }) =>
              tx
                .select({
                  id: schema.fifoLots.id,
                  acquiredAt: schema.fifoLots.acquiredAt,
                  originalAmount: schema.fifoLots.originalAmount,
                  remainingAmount: schema.fifoLots.remainingAmount,
                  costBasisPerToken: schema.fifoLots.costBasisPerToken,
                  costBasisCurrency: schema.fifoLots.costBasisCurrency,
                })
                .from(schema.fifoLots)
                .where(
                  and(
                    eq(schema.fifoLots.principalId, lotPrincipalId),
                    eq(schema.fifoLots.sourceId, sourceId),
                    eq(schema.fifoLots.assetId, assetId),
                    sql`${schema.fifoLots.sourceLegId} is not null`,
                    gt(schema.fifoLots.remainingAmount, "0"),
                    lte(schema.fifoLots.acquiredAt, maxAcquiredAt)
                  )
                )
                .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.loadOpenLots"
                  )
                )

            const ensureInternalTransferDisposition = ({
              originLegId,
              custodyProviderTransferId,
              principalId: lotPrincipalId,
              sourceId,
              assetId,
              amount,
              maxAcquiredAt,
            }: {
              readonly originLegId: string
              readonly custodyProviderTransferId: string | null
              readonly principalId: string
              readonly sourceId: string
              readonly assetId: string
              readonly amount: string
              readonly maxAcquiredAt: Date
            }) =>
              Effect.gen(function* () {
                const existingMatches = yield* loadInternalTransferDisposalMatches({
                  disposalLegId: originLegId,
                })

                const custodyAllocations =
                  custodyProviderTransferId === null
                    ? []
                    : yield* tx
                        .select({
                          movementId: schema.inventoryMovements.id,
                          fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
                          matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
                          acquiredAt: schema.fifoLots.acquiredAt,
                          costBasisPerToken: schema.fifoLots.costBasisPerToken,
                          costBasisCurrency: schema.fifoLots.costBasisCurrency,
                        })
                        .from(schema.inventoryMovements)
                        .innerJoin(
                          schema.inventoryMovementAllocations,
                          eq(
                            schema.inventoryMovementAllocations.inventoryMovementId,
                            schema.inventoryMovements.id
                          )
                        )
                        .innerJoin(
                          schema.fifoLots,
                          eq(schema.fifoLots.id, schema.inventoryMovementAllocations.fifoLotId)
                        )
                        .where(
                          eq(
                            schema.inventoryMovements.providerTransferId,
                            custodyProviderTransferId
                          )
                        )
                        .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.loadCustodyAllocations"
                          )
                        )

                if (existingMatches.length > 0) {
                  yield* Effect.forEach(custodyAllocations, (allocation) =>
                    tx
                      .update(schema.fifoLots)
                      .set({
                        remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${allocation.matchedAmount}`,
                        updatedAt: nowDate(),
                      })
                      .where(eq(schema.fifoLots.id, allocation.fifoLotId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.restoreDuplicateCustodyAllocation"
                        )
                      )
                  )

                  if (custodyAllocations.length > 0) {
                    yield* tx
                      .delete(schema.inventoryMovementAllocations)
                      .where(
                        inArray(
                          schema.inventoryMovementAllocations.inventoryMovementId,
                          custodyAllocations.map((allocation) => allocation.movementId)
                        )
                      )
                      .pipe(
                        wrapSyncEngineSqlError(
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.clearDuplicateCustodyAllocations"
                        )
                      )
                  }

                  let totalCostBasis = BigDecimal.fromBigInt(0n)
                  let fiatCurrency: string | null = null

                  for (const match of existingMatches) {
                    const costBasis = yield* decodeBigDecimal({
                      value: yield* formatDecimal({
                        value: match.costBasis,
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.existingCostBasis",
                      }),
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.existingCostBasis",
                    })

                    totalCostBasis = BigDecimal.sum(totalCostBasis, costBasis)

                    if (fiatCurrency === null) {
                      fiatCurrency = match.costBasisCurrency
                    } else if (fiatCurrency !== match.costBasisCurrency) {
                      return yield* Effect.fail(
                        new SyncEngineStorageError({
                          operation:
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.existingCurrency",
                          cause:
                            "Internal transfer disposal matches use multiple cost basis currencies",
                        })
                      )
                    }
                  }

                  return {
                    matches: existingMatches,
                    fiatAmount: roundFiatAmount(totalCostBasis),
                    fiatCurrency,
                  }
                }

                if (custodyAllocations.length > 0) {
                  const custodyMovementId = custodyAllocations[0]?.movementId
                  if (custodyMovementId === undefined) {
                    return yield* Effect.fail(
                      new SyncEngineStorageError({
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyMovementId",
                        cause: "Custody allocation is missing its movement",
                      })
                    )
                  }

                  let remainingToMove = yield* decodeBigDecimal({
                    value: amount,
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyAmount",
                  })
                  let totalCostBasis = BigDecimal.fromBigInt(0n)
                  let fiatCurrency: string | null = null
                  const allocations: Array<(typeof existingMatches)[number]> = []

                  for (const allocation of custodyAllocations) {
                    const matchedAmount = yield* decodeBigDecimal({
                      value: yield* formatDecimal({
                        value: allocation.matchedAmount,
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyMatchedAmount",
                      }),
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyMatchedAmount",
                    })
                    const costBasisPerToken = yield* decodeBigDecimal({
                      value: yield* formatDecimal({
                        value: allocation.costBasisPerToken,
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyCostBasisPerToken",
                      }),
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyCostBasisPerToken",
                    })
                    const costBasis = BigDecimal.round(
                      BigDecimal.multiply(matchedAmount, costBasisPerToken),
                      { scale: 8 }
                    )

                    if (fiatCurrency === null) {
                      fiatCurrency = allocation.costBasisCurrency
                    } else if (fiatCurrency !== allocation.costBasisCurrency) {
                      return yield* Effect.fail(
                        new SyncEngineStorageError({
                          operation:
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyCurrency",
                          cause: "Custody movement allocations use multiple cost basis currencies",
                        })
                      )
                    }

                    allocations.push({
                      fifoLotId: allocation.fifoLotId,
                      matchedAmount: BigDecimal.format(matchedAmount),
                      costBasis: roundFiatAmount(costBasis),
                      acquiredAt: allocation.acquiredAt,
                      costBasisPerToken: allocation.costBasisPerToken,
                      costBasisCurrency: allocation.costBasisCurrency,
                    })
                    totalCostBasis = BigDecimal.sum(totalCostBasis, costBasis)
                    remainingToMove = BigDecimal.subtract(remainingToMove, matchedAmount)
                  }

                  if (!BigDecimal.isZero(remainingToMove)) {
                    return yield* Effect.fail(
                      new SyncEngineStorageError({
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyAmountMismatch",
                        cause: `Custody allocations differ from internal transfer amount by ${BigDecimal.format(remainingToMove)}`,
                      })
                    )
                  }

                  yield* Effect.forEach(allocations, (allocation) =>
                    tx
                      .insert(schema.disposalMatches)
                      .values({
                        disposalLegId: originLegId,
                        fifoLotId: allocation.fifoLotId,
                        matchedAmount: allocation.matchedAmount,
                        costBasis: allocation.costBasis,
                        proceeds: allocation.costBasis,
                        gainLoss: "0",
                        createdAt: nowDate(),
                      })
                      .onConflictDoNothing({
                        target: [
                          schema.disposalMatches.fifoLotId,
                          schema.disposalMatches.disposalLegId,
                        ],
                      })
                      .pipe(
                        wrapSyncEngineSqlError(
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.insertCustodyMatch"
                        )
                      )
                  )

                  yield* tx
                    .delete(schema.inventoryMovementAllocations)
                    .where(
                      eq(schema.inventoryMovementAllocations.inventoryMovementId, custodyMovementId)
                    )
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.clearCustodyAllocations"
                      )
                    )

                  return {
                    matches: allocations,
                    fiatAmount: roundFiatAmount(totalCostBasis),
                    fiatCurrency,
                  }
                }

                const availableLots = yield* loadOpenLots({
                  lotPrincipalId,
                  sourceId,
                  assetId,
                  maxAcquiredAt,
                })
                let remainingToMove = yield* decodeBigDecimal({
                  value: amount,
                  operation:
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.amount",
                })
                let totalCostBasis = BigDecimal.fromBigInt(0n)
                let fiatCurrency: string | null = null
                const allocations: Array<(typeof existingMatches)[number]> = []

                for (const lot of availableLots) {
                  if (!BigDecimal.greaterThan(remainingToMove, BigDecimal.fromBigInt(0n))) {
                    break
                  }

                  const lotRemaining = yield* decodeBigDecimal({
                    value: yield* formatDecimal({
                      value: lot.remainingAmount,
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.lotRemaining",
                    }),
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.lotRemaining",
                  })
                  const lotCostBasisPerToken = yield* decodeBigDecimal({
                    value: yield* formatDecimal({
                      value: lot.costBasisPerToken,
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.lotCostBasisPerToken",
                    }),
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.lotCostBasisPerToken",
                  })
                  const amountToMove = BigDecimal.lessThanOrEqualTo(remainingToMove, lotRemaining)
                    ? remainingToMove
                    : lotRemaining
                  const updatedRemainingAmount = BigDecimal.subtract(lotRemaining, amountToMove)
                  const costBasis = BigDecimal.round(
                    BigDecimal.multiply(amountToMove, lotCostBasisPerToken),
                    { scale: 8 }
                  )

                  if (fiatCurrency === null) {
                    fiatCurrency = lot.costBasisCurrency
                  } else if (fiatCurrency !== lot.costBasisCurrency) {
                    return yield* Effect.fail(
                      new SyncEngineStorageError({
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.newCurrency",
                        cause: "Internal transfer source lots use multiple cost basis currencies",
                      })
                    )
                  }

                  yield* tx
                    .update(schema.fifoLots)
                    .set({
                      remainingAmount: BigDecimal.format(updatedRemainingAmount),
                      updatedAt: nowDate(),
                    })
                    .where(eq(schema.fifoLots.id, lot.id))
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.updateSourceLot"
                      )
                    )

                  yield* tx
                    .insert(schema.disposalMatches)
                    .values({
                      disposalLegId: originLegId,
                      fifoLotId: lot.id,
                      matchedAmount: BigDecimal.format(amountToMove),
                      // Internal transfers carry basis forward without realizing gain/loss.
                      costBasis: roundFiatAmount(costBasis),
                      proceeds: roundFiatAmount(costBasis),
                      gainLoss: "0",
                      createdAt: nowDate(),
                    })
                    .onConflictDoNothing({
                      target: [
                        schema.disposalMatches.fifoLotId,
                        schema.disposalMatches.disposalLegId,
                      ],
                    })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.insertMatch"
                      )
                    )

                  allocations.push({
                    fifoLotId: lot.id,
                    matchedAmount: BigDecimal.format(amountToMove),
                    costBasis: roundFiatAmount(costBasis),
                    acquiredAt: lot.acquiredAt,
                    costBasisPerToken: lot.costBasisPerToken,
                    costBasisCurrency: lot.costBasisCurrency,
                  })
                  totalCostBasis = BigDecimal.sum(totalCostBasis, costBasis)
                  remainingToMove = BigDecimal.subtract(remainingToMove, amountToMove)
                }

                if (BigDecimal.greaterThan(remainingToMove, BigDecimal.fromBigInt(0n))) {
                  return yield* Effect.fail(
                    new SyncEngineStorageError({
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.remainingAmount",
                      cause: `Insufficient FIFO inventory for internal transfer amount ${BigDecimal.format(remainingToMove)}`,
                    })
                  )
                }

                return {
                  matches: allocations,
                  fiatAmount: roundFiatAmount(totalCostBasis),
                  fiatCurrency,
                }
              })

            const syncInternalTransferDisposalValuation = ({
              originLegId,
              fiatAmount,
              fiatCurrency,
            }: {
              readonly originLegId: string
              readonly fiatAmount: string
              readonly fiatCurrency: string | null
            }) =>
              tx
                .update(schema.transactionLegs)
                .set({
                  fiatAmount,
                  fiatCurrency,
                  updatedAt: nowDate(),
                })
                .where(eq(schema.transactionLegs.id, originLegId))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.syncInternalTransferDisposalValuation"
                  ),
                  Effect.asVoid
                )

            const upsertInternalTransferReview = ({
              transactionId,
            }: {
              readonly transactionId: string
            }) =>
              tx
                .insert(schema.transactionReviews)
                .values({
                  transactionId,
                  principalId,
                  reviewStatus: "auto_applied",
                  originalTypeKey: "internal_transfer",
                  originalConfidence: "1.00",
                  currentTypeKey: "internal_transfer",
                  legalRuleSetVersion: null,
                  categorizationReason: INTERNAL_TRANSFER_REASON,
                  matchedLayer: "transfer_reconciliation",
                  needsReview: false,
                  userNotes: null,
                  reviewedAt: now,
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoUpdate({
                  target: schema.transactionReviews.transactionId,
                  set: {
                    reviewStatus: sql`case
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      then ${schema.transactionReviews.reviewStatus}
                    else 'auto_applied'
                  end`,
                    originalTypeKey: "internal_transfer",
                    originalConfidence: "1.00",
                    currentTypeKey: sql`case
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      then ${schema.transactionReviews.currentTypeKey}
                    else 'internal_transfer'
                  end`,
                    categorizationReason: INTERNAL_TRANSFER_REASON,
                    matchedLayer: "transfer_reconciliation",
                    needsReview: sql`case
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      then ${schema.transactionReviews.needsReview}
                    else false
                  end`,
                    userNotes: schema.transactionReviews.userNotes,
                    reviewedAt: sql`case
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      then ${schema.transactionReviews.reviewedAt}
                    else ${now}
                  end`,
                    updatedAt: now,
                  },
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.upsertReview"
                  ),
                  Effect.asVoid
                )

            const upsertInternalTransferLeg = ({
              transactionId,
              sourceId: legSourceId,
              sourceRawRecordId,
              externalId,
              timestamp,
              principalId,
              assetId,
              amount,
              kind,
              sourceTransferId,
              reconciliationProviderTransferId,
              reconciliationCanonicalTransferId,
            }: {
              readonly transactionId: string
              readonly sourceId: string
              readonly sourceRawRecordId: string | null
              readonly externalId: string
              readonly timestamp: Date
              readonly principalId: string
              readonly assetId: string
              readonly amount: string
              readonly kind: "acquisition" | "disposal"
              readonly sourceTransferId: string | null
              readonly reconciliationProviderTransferId: string
              readonly reconciliationCanonicalTransferId: string
            }) =>
              Effect.gen(function* () {
                const [leg] = yield* tx
                  .insert(schema.transactionLegs)
                  .values({
                    sourceId: legSourceId,
                    sourceRawRecordId,
                    externalId,
                    txHash: null,
                    timestamp,
                    principalId,
                    addressId: null,
                    assetId,
                    amount,
                    kind,
                    provenance: "deterministic",
                    derivationRule:
                      kind === "disposal" ? "internal_transfer_out" : "internal_transfer_in",
                    metadata: {
                      reconciliation: {
                        providerTransferId: reconciliationProviderTransferId,
                        canonicalTransferId: reconciliationCanonicalTransferId,
                      },
                    },
                    transactionId,
                    sourceTransferId,
                    fiatAmount: null,
                    fiatCurrency: null,
                    feeForTransactionId: null,
                    createdAt: nowDate(),
                    updatedAt: nowDate(),
                  })
                  .onConflictDoUpdate({
                    target: [schema.transactionLegs.sourceId, schema.transactionLegs.externalId],
                    targetWhere: sql`${schema.transactionLegs.externalId} is not null`,
                    set: {
                      sourceRawRecordId: sql.raw("excluded.source_raw_record_id"),
                      timestamp: sql.raw("excluded.timestamp"),
                      principalId: sql.raw("excluded.principal_id"),
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
                      updatedAt: nowDate(),
                    },
                  })
                  .returning({
                    id: schema.transactionLegs.id,
                  })
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.upsertInternalTransferLeg"
                    )
                  )

                return leg?.id
              })

            const moveLotsForInternalTransfer = ({
              originLegId,
              assetId,
              destinationSourceId,
              destinationLegId,
              disposition,
            }: {
              readonly originLegId: string
              readonly assetId: string
              readonly destinationSourceId: string
              readonly destinationLegId: string
              readonly disposition: {
                readonly matches: ReadonlyArray<{
                  readonly fifoLotId: string
                  readonly matchedAmount: unknown
                  readonly acquiredAt: Date
                  readonly costBasisPerToken: unknown
                  readonly costBasisCurrency: string
                }>
                readonly fiatAmount: string
                readonly fiatCurrency: string | null
              }
            }) =>
              Effect.gen(function* () {
                yield* syncInternalTransferDisposalValuation({
                  originLegId,
                  fiatAmount: disposition.fiatAmount,
                  fiatCurrency: disposition.fiatCurrency,
                })

                const existingLots = yield* tx
                  .select({ id: schema.fifoLots.id })
                  .from(schema.fifoLots)
                  .where(eq(schema.fifoLots.sourceLegId, destinationLegId))
                  .orderBy(asc(schema.fifoLots.sourceLegSequence))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.findExistingLots"
                    )
                  )

                if (existingLots.length > 0) {
                  return
                }

                let sequence = 0

                for (const match of disposition.matches) {
                  const matchedAmount = yield* formatDecimal({
                    value: match.matchedAmount,
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.matchedAmount",
                  })
                  const costBasisPerToken = yield* formatDecimal({
                    value: match.costBasisPerToken,
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.costBasisPerToken",
                  })
                  yield* tx
                    .insert(schema.fifoLots)
                    .values({
                      principalId,
                      sourceId: destinationSourceId,
                      assetId,
                      acquiredAt: match.acquiredAt,
                      originalAmount: matchedAmount,
                      remainingAmount: matchedAmount,
                      costBasisPerToken,
                      costBasisCurrency: match.costBasisCurrency,
                      sourceLegId: destinationLegId,
                      sourceLegSequence: sequence,
                      createdAt: nowDate(),
                      updatedAt: nowDate(),
                    })
                    .onConflictDoNothing({
                      target: [schema.fifoLots.sourceLegId, schema.fifoLots.sourceLegSequence],
                      where: sql`${schema.fifoLots.sourceLegId} is not null`,
                    })
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.insertDestinationLot"
                      )
                    )

                  sequence += 1
                }
              })

            const hasUnmatchedFifoEffects = ({
              transactionId,
            }: {
              readonly transactionId: string
            }) =>
              Effect.gen(function* () {
                const legs = yield* tx
                  .select({
                    id: schema.transactionLegs.id,
                    kind: schema.transactionLegs.kind,
                    assetId: schema.transactionLegs.assetId,
                    amount: schema.transactionLegs.amount,
                  })
                  .from(schema.transactionLegs)
                  .where(eq(schema.transactionLegs.transactionId, transactionId))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.loadLegs"
                    )
                  )
                const movements = yield* tx
                  .select({
                    id: schema.inventoryMovements.id,
                    assetId: schema.inventoryMovements.assetId,
                    amount: schema.inventoryMovements.amount,
                  })
                  .from(schema.inventoryMovements)
                  .where(
                    and(
                      eq(schema.inventoryMovements.transactionId, transactionId),
                      eq(schema.inventoryMovements.direction, "outbound")
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.loadMovements"
                    )
                  )
                const disposalLegs = legs.filter((leg) => leg.kind === "disposal")
                const disposalMatches =
                  disposalLegs.length === 0
                    ? []
                    : yield* tx
                        .select({ disposalLegId: schema.disposalMatches.disposalLegId })
                        .from(schema.disposalMatches)
                        .where(
                          inArray(
                            schema.disposalMatches.disposalLegId,
                            disposalLegs.map((leg) => leg.id)
                          )
                        )
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.loadDisposalMatches"
                          )
                        )
                const movementAllocations =
                  movements.length === 0
                    ? []
                    : yield* tx
                        .select({
                          inventoryMovementId:
                            schema.inventoryMovementAllocations.inventoryMovementId,
                        })
                        .from(schema.inventoryMovementAllocations)
                        .where(
                          inArray(
                            schema.inventoryMovementAllocations.inventoryMovementId,
                            movements.map((movement) => movement.id)
                          )
                        )
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.loadMovementAllocations"
                          )
                        )
                const matchedDisposalLegIds = new Set(
                  disposalMatches.map((match) => match.disposalLegId)
                )
                const allocatedMovementIds = new Set(
                  movementAllocations.map((allocation) => allocation.inventoryMovementId)
                )

                if (disposalLegs.some((leg) => !matchedDisposalLegIds.has(leg.id))) {
                  return true
                }

                for (const movement of movements) {
                  if (allocatedMovementIds.has(movement.id)) {
                    continue
                  }

                  const movementAmount = yield* decodeBigDecimal({
                    value: yield* formatDecimal({
                      value: movement.amount,
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.movementAmount",
                    }),
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.movementAmount",
                  })
                  const matchingDisposalResults = yield* Effect.forEach(
                    disposalLegs.filter(
                      (leg) => leg.assetId === movement.assetId && matchedDisposalLegIds.has(leg.id)
                    ),
                    (leg) =>
                      Effect.gen(function* () {
                        const amount = yield* decodeBigDecimal({
                          value: yield* formatDecimal({
                            value: leg.amount,
                            operation:
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.disposalAmount",
                          }),
                          operation:
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.disposalAmount",
                        })
                        return BigDecimal.equals(amount, movementAmount)
                      })
                  )

                  if (!matchingDisposalResults.some(Boolean)) {
                    return true
                  }
                }

                return false
              })

            const rebuildReviewedDestinationFifoEffects = ({
              destinationSourceId,
            }: {
              readonly destinationSourceId: string
            }) =>
              Effect.gen(function* () {
                const reviewedTransactions = yield* tx
                  .select({
                    transactionId: schema.transactionReviews.transactionId,
                  })
                  .from(schema.transactionReviews)
                  .innerJoin(
                    schema.transactions,
                    eq(schema.transactions.id, schema.transactionReviews.transactionId)
                  )
                  .where(
                    and(
                      eq(schema.transactions.sourceId, destinationSourceId),
                      eq(schema.transactionReviews.needsReview, true),
                      sql`${FIFO_INVENTORY_REVIEW_LAYER} = any(
                        string_to_array(${schema.transactionReviews.matchedLayer}, ',')
                      )`
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadReviewedTransactions"
                    )
                  )

                if (reviewedTransactions.length === 0) {
                  return
                }

                const reviewedTransactionIds = reviewedTransactions.map(
                  ({ transactionId }) => transactionId
                )
                const allDisposals = yield* tx
                  .select({
                    id: schema.transactionLegs.id,
                    transactionId: schema.transactionLegs.transactionId,
                    principalId: schema.transactionLegs.principalId,
                    assetId: schema.transactionLegs.assetId,
                    amount: schema.transactionLegs.amount,
                    fiatAmount: schema.transactionLegs.fiatAmount,
                    timestamp: schema.transactionLegs.timestamp,
                    createdAt: schema.transactionLegs.createdAt,
                  })
                  .from(schema.transactionLegs)
                  .where(
                    and(
                      eq(schema.transactionLegs.sourceId, destinationSourceId),
                      eq(schema.transactionLegs.kind, "disposal"),
                      sql`${schema.transactionLegs.transactionId} is not null`
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadDisposals"
                    )
                  )
                const allMovements = yield* tx
                  .select({
                    id: schema.inventoryMovements.id,
                    transactionId: schema.inventoryMovements.transactionId,
                    principalId: schema.inventoryMovements.principalId,
                    assetId: schema.inventoryMovements.assetId,
                    amount: schema.inventoryMovements.amount,
                    timestamp: schema.inventoryMovements.timestamp,
                    createdAt: schema.inventoryMovements.createdAt,
                    transactionLegId: schema.inventoryMovements.transactionLegId,
                  })
                  .from(schema.inventoryMovements)
                  .where(
                    and(
                      eq(schema.inventoryMovements.sourceId, destinationSourceId),
                      eq(schema.inventoryMovements.direction, "outbound")
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadMovements"
                    )
                  )

                const reviewedTransactionIdSet = new Set(reviewedTransactionIds)
                const earliestReviewedTimestampByInventory = new Map<string, Date>()
                const recordReviewedTimestamp = ({
                  transactionId,
                  principalId: effectPrincipalId,
                  assetId,
                  timestamp,
                }: {
                  readonly transactionId: string | null
                  readonly principalId: string
                  readonly assetId: string
                  readonly timestamp: Date
                }) => {
                  if (transactionId === null || !reviewedTransactionIdSet.has(transactionId)) {
                    return
                  }

                  const inventoryKey = `${effectPrincipalId}:${assetId}`
                  const current = earliestReviewedTimestampByInventory.get(inventoryKey)
                  if (current === undefined || timestamp < current) {
                    earliestReviewedTimestampByInventory.set(inventoryKey, timestamp)
                  }
                }

                for (const disposal of allDisposals) {
                  recordReviewedTimestamp(disposal)
                }
                for (const movement of allMovements) {
                  recordReviewedTimestamp(movement)
                }

                const disposalsToRebuild = allDisposals.filter((disposal) => {
                  const cutoff = earliestReviewedTimestampByInventory.get(
                    `${disposal.principalId}:${disposal.assetId}`
                  )
                  return cutoff !== undefined && disposal.timestamp >= cutoff
                })
                const movementsToRebuild = []
                for (const movement of allMovements) {
                  const cutoff = earliestReviewedTimestampByInventory.get(
                    `${movement.principalId}:${movement.assetId}`
                  )
                  if (cutoff === undefined || movement.timestamp < cutoff) {
                    continue
                  }

                  if (movement.transactionLegId === null) {
                    const movementAmount = yield* decodeBigDecimal({
                      value: yield* formatDecimal({
                        value: movement.amount,
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.movementAmount",
                      }),
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.movementAmount",
                    })
                    const matchingDisposals = disposalsToRebuild.filter(
                      (disposal) =>
                        disposal.transactionId === movement.transactionId &&
                        disposal.assetId === movement.assetId
                    )
                    const matchingDisposalResults = yield* Effect.forEach(
                      matchingDisposals,
                      (disposal) =>
                        Effect.gen(function* () {
                          const disposalAmount = yield* decodeBigDecimal({
                            value: yield* formatDecimal({
                              value: disposal.amount,
                              operation:
                                "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.disposalAmount",
                            }),
                            operation:
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.disposalAmount",
                          })
                          return BigDecimal.equals(disposalAmount, movementAmount)
                        })
                    )
                    if (matchingDisposalResults.some(Boolean)) {
                      continue
                    }
                  }
                  movementsToRebuild.push(movement)
                }

                const disposalMatches =
                  disposalsToRebuild.length === 0
                    ? []
                    : yield* tx
                        .select({
                          id: schema.disposalMatches.id,
                          fifoLotId: schema.disposalMatches.fifoLotId,
                          matchedAmount: schema.disposalMatches.matchedAmount,
                        })
                        .from(schema.disposalMatches)
                        .where(
                          inArray(
                            schema.disposalMatches.disposalLegId,
                            disposalsToRebuild.map(({ id }) => id)
                          )
                        )
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadDisposalMatches"
                          )
                        )
                const movementAllocations =
                  movementsToRebuild.length === 0
                    ? []
                    : yield* tx
                        .select({
                          id: schema.inventoryMovementAllocations.id,
                          fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
                          matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
                        })
                        .from(schema.inventoryMovementAllocations)
                        .where(
                          inArray(
                            schema.inventoryMovementAllocations.inventoryMovementId,
                            movementsToRebuild.map(({ id }) => id)
                          )
                        )
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadMovementAllocations"
                          )
                        )

                yield* Effect.forEach([...disposalMatches, ...movementAllocations], (allocation) =>
                  tx
                    .update(schema.fifoLots)
                    .set({
                      remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${allocation.matchedAmount}`,
                      updatedAt: nowDate(),
                    })
                    .where(eq(schema.fifoLots.id, allocation.fifoLotId))
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.restoreLot"
                      )
                    )
                )

                if (disposalMatches.length > 0) {
                  yield* tx
                    .delete(schema.disposalMatches)
                    .where(
                      inArray(
                        schema.disposalMatches.id,
                        disposalMatches.map(({ id }) => id)
                      )
                    )
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.deleteDisposalMatches"
                      )
                    )
                }
                if (movementAllocations.length > 0) {
                  yield* tx
                    .delete(schema.inventoryMovementAllocations)
                    .where(
                      inArray(
                        schema.inventoryMovementAllocations.id,
                        movementAllocations.map(({ id }) => id)
                      )
                    )
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.deleteMovementAllocations"
                      )
                    )
                }

                const effects = [
                  ...disposalsToRebuild.map((disposal) => ({
                    kind: "disposal" as const,
                    ...disposal,
                  })),
                  ...movementsToRebuild.map((movement) => ({
                    kind: "movement" as const,
                    fiatAmount: null,
                    ...movement,
                  })),
                ].sort(
                  (left, right) =>
                    left.timestamp.getTime() - right.timestamp.getTime() ||
                    left.createdAt.getTime() - right.createdAt.getTime() ||
                    left.kind.localeCompare(right.kind)
                )
                const blockedInventoryKeys = new Set<string>()

                for (const effect of effects) {
                  const inventoryKey = `${effect.principalId}:${effect.assetId}`
                  if (blockedInventoryKeys.has(inventoryKey)) {
                    continue
                  }

                  const effectAmount = yield* decodeBigDecimal({
                    value: yield* formatDecimal({
                      value: effect.amount,
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.effectAmount",
                    }),
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.effectAmount",
                  })
                  const availableLots = yield* loadOpenLots({
                    lotPrincipalId: effect.principalId,
                    sourceId: destinationSourceId,
                    assetId: effect.assetId,
                    maxAcquiredAt: effect.timestamp,
                  })
                  let remainingAmount = effectAmount
                  const allocations = []

                  for (const lot of availableLots) {
                    if (!BigDecimal.greaterThan(remainingAmount, BigDecimal.fromBigInt(0n))) {
                      break
                    }

                    const lotRemaining = yield* decodeBigDecimal({
                      value: yield* formatDecimal({
                        value: lot.remainingAmount,
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.lotRemaining",
                      }),
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.lotRemaining",
                    })
                    const costBasisPerToken = yield* decodeBigDecimal({
                      value: yield* formatDecimal({
                        value: lot.costBasisPerToken,
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.costBasisPerToken",
                      }),
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.costBasisPerToken",
                    })
                    const matchedAmount = BigDecimal.lessThanOrEqualTo(
                      remainingAmount,
                      lotRemaining
                    )
                      ? remainingAmount
                      : lotRemaining
                    const nextLotRemaining = BigDecimal.subtract(lotRemaining, matchedAmount)

                    allocations.push({
                      fifoLotId: lot.id,
                      matchedAmount: BigDecimal.format(matchedAmount),
                      remainingAmount: BigDecimal.format(nextLotRemaining),
                      costBasisPerToken,
                    })
                    remainingAmount = BigDecimal.subtract(remainingAmount, matchedAmount)
                  }

                  if (BigDecimal.greaterThan(remainingAmount, BigDecimal.fromBigInt(0n))) {
                    blockedInventoryKeys.add(inventoryKey)
                    continue
                  }

                  const totalProceeds =
                    effect.fiatAmount === null
                      ? BigDecimal.fromBigInt(0n)
                      : yield* decodeBigDecimal({
                          value: yield* formatDecimal({
                            value: effect.fiatAmount,
                            operation:
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.fiatAmount",
                          }),
                          operation:
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.fiatAmount",
                        })

                  yield* Effect.forEach(allocations, (allocation) =>
                    Effect.gen(function* () {
                      if (effect.kind === "disposal") {
                        const matchedAmount = yield* decodeBigDecimal({
                          value: allocation.matchedAmount,
                          operation:
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.matchedAmount",
                        })
                        const costBasis = BigDecimal.round(
                          BigDecimal.multiply(matchedAmount, allocation.costBasisPerToken),
                          { scale: 8 }
                        )
                        const proceedsRatio = Option.getOrElse(
                          BigDecimal.divide(matchedAmount, effectAmount),
                          () => BigDecimal.fromBigInt(0n)
                        )
                        const proceeds = BigDecimal.round(
                          BigDecimal.multiply(totalProceeds, proceedsRatio),
                          { scale: 8 }
                        )
                        yield* tx
                          .insert(schema.disposalMatches)
                          .values({
                            disposalLegId: effect.id,
                            fifoLotId: allocation.fifoLotId,
                            matchedAmount: allocation.matchedAmount,
                            costBasis: roundFiatAmount(costBasis),
                            proceeds: roundFiatAmount(proceeds),
                            gainLoss: roundFiatAmount(BigDecimal.subtract(proceeds, costBasis)),
                            createdAt: nowDate(),
                          })
                          .pipe(
                            wrapSyncEngineSqlError(
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.insertDisposalMatch"
                            )
                          )
                      } else {
                        yield* tx
                          .insert(schema.inventoryMovementAllocations)
                          .values({
                            inventoryMovementId: effect.id,
                            fifoLotId: allocation.fifoLotId,
                            matchedAmount: allocation.matchedAmount,
                            createdAt: nowDate(),
                          })
                          .pipe(
                            wrapSyncEngineSqlError(
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.insertMovementAllocation"
                            )
                          )
                      }

                      yield* tx
                        .update(schema.fifoLots)
                        .set({
                          remainingAmount: allocation.remainingAmount,
                          updatedAt: nowDate(),
                        })
                        .where(eq(schema.fifoLots.id, allocation.fifoLotId))
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.updateLot"
                          )
                        )
                    })
                  )
                }

                for (const { transactionId } of reviewedTransactions) {
                  const reviewedInventoryKeys = [
                    ...allDisposals.filter((disposal) => disposal.transactionId === transactionId),
                    ...allMovements.filter((movement) => movement.transactionId === transactionId),
                  ].map(({ principalId: effectPrincipalId, assetId }) => {
                    return `${effectPrincipalId}:${assetId}`
                  })

                  if (reviewedInventoryKeys.some((key) => blockedInventoryKeys.has(key))) {
                    continue
                  }

                  if (
                    !(yield* hasUnmatchedFifoEffects({
                      transactionId,
                    }))
                  ) {
                    const [review] = yield* tx
                      .select({
                        reviewStatus: schema.transactionReviews.reviewStatus,
                        categorizationReason: schema.transactionReviews.categorizationReason,
                        matchedLayer: schema.transactionReviews.matchedLayer,
                        userNotes: schema.transactionReviews.userNotes,
                      })
                      .from(schema.transactionReviews)
                      .where(eq(schema.transactionReviews.transactionId, transactionId))
                      .limit(1)
                      .pipe(
                        wrapSyncEngineSqlError(
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadReview"
                        )
                      )

                    if (review === undefined) {
                      continue
                    }

                    const remainingLayers = (review.matchedLayer ?? "")
                      .split(",")
                      .map((layer) => layer.trim())
                      .filter((layer) => layer !== "" && layer !== FIFO_INVENTORY_REVIEW_LAYER)
                    const remainingReasons = (review.categorizationReason ?? "")
                      .split("\n")
                      .filter(
                        (reason) =>
                          reason.trim() !== "" &&
                          !reason.trimStart().startsWith(FIFO_INVENTORY_REVIEW_REASON_PREFIX)
                      )
                    const preservesUserReview =
                      review.reviewStatus === "approved" || review.reviewStatus === "changed"
                    const shouldKeepReview =
                      remainingLayers.length > 0 ||
                      remainingReasons.length > 0 ||
                      review.userNotes !== null ||
                      preservesUserReview

                    if (!shouldKeepReview) {
                      yield* tx
                        .delete(schema.transactionReviews)
                        .where(eq(schema.transactionReviews.transactionId, transactionId))
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.deleteFifoOnlyReview"
                          )
                        )
                      continue
                    }

                    yield* tx
                      .update(schema.transactionReviews)
                      .set({
                        categorizationReason:
                          remainingReasons.length === 0 ? null : remainingReasons.join("\n"),
                        matchedLayer:
                          remainingLayers.length === 0 ? null : remainingLayers.join(","),
                        needsReview: review.reviewStatus === "needs_review",
                        updatedAt: nowDate(),
                      })
                      .where(eq(schema.transactionReviews.transactionId, transactionId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.clearFifoReviewSegment"
                        )
                      )
                  }
                }
              })

            const applyPair = (row: (typeof reconciliations)[number]) =>
              Effect.gen(function* () {
                const amount = yield* formatDecimal({
                  value: row.amount,
                  operation:
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.applyPair.amount",
                })
                const canonicalTransactionId = row.canonicalTransactionId
                const canonicalTransferId = row.canonicalTransferId

                if (canonicalTransactionId === null || canonicalTransferId === null) {
                  yield* Effect.logWarning(
                    {
                      providerTransferId: row.providerTransferId,
                      canonicalTransferId,
                      canonicalTransactionId,
                    },
                    "Skipping deterministic internal transfer canonicalization because reconciliation is missing canonical identifiers"
                  )
                  return false
                }

                const originTransaction =
                  row.providerDirection === "outbound"
                    ? {
                        id: row.providerTransactionId,
                        sourceId: row.providerTransactionSourceId,
                        sourceRawRecordId: row.providerTransactionSourceRawRecordId,
                        externalId: row.providerTransactionExternalId,
                        timestamp: row.providerTransactionTimestamp,
                        principalId: row.providerTransactionPrincipalId,
                      }
                    : {
                        id: canonicalTransactionId,
                        sourceId: row.canonicalTransactionSourceId,
                        sourceRawRecordId: row.canonicalTransactionSourceRawRecordId,
                        externalId: row.canonicalTransactionExternalId,
                        timestamp: row.canonicalTransactionTimestamp,
                        principalId: row.canonicalTransactionPrincipalId,
                      }
                const destinationTransaction =
                  row.providerDirection === "outbound"
                    ? {
                        id: canonicalTransactionId,
                        sourceId: row.canonicalTransactionSourceId,
                        sourceRawRecordId: row.canonicalTransactionSourceRawRecordId,
                        externalId: row.canonicalTransactionExternalId,
                        timestamp: row.canonicalTransactionTimestamp,
                        principalId: row.canonicalTransactionPrincipalId,
                      }
                    : {
                        id: row.providerTransactionId,
                        sourceId: row.providerTransactionSourceId,
                        sourceRawRecordId: row.providerTransactionSourceRawRecordId,
                        externalId: row.providerTransactionExternalId,
                        timestamp: row.providerTransactionTimestamp,
                        principalId: row.providerTransactionPrincipalId,
                      }

                const originExternalId = `${originTransaction.externalId ?? originTransaction.id}:internal_transfer_out`
                const destinationExternalId = `${destinationTransaction.externalId ?? destinationTransaction.id}:internal_transfer_in`
                const originSourceTransferId =
                  originTransaction.id === canonicalTransactionId ? canonicalTransferId : null
                const destinationSourceTransferId =
                  destinationTransaction.id === canonicalTransactionId ? canonicalTransferId : null

                const custodyProviderTransferId =
                  row.providerDirection === "outbound"
                    ? row.providerTransferId
                    : yield* tx
                        .select({
                          providerTransferId: schema.inventoryMovements.providerTransferId,
                        })
                        .from(schema.inventoryMovements)
                        .innerJoin(
                          schema.providerTransfers,
                          eq(
                            schema.providerTransfers.id,
                            schema.inventoryMovements.providerTransferId
                          )
                        )
                        .where(
                          and(
                            eq(schema.inventoryMovements.transactionId, originTransaction.id),
                            sql`${schema.providerTransfers.metadata}->>'canonicalTransferExternalId' = ${row.canonicalTransferExternalId}`,
                            sql`${schema.inventoryMovements.providerTransferId} is not null`
                          )
                        )
                        .limit(1)
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.findOriginCustodyMovement"
                          ),
                          Effect.map((rows) => rows[0]?.providerTransferId ?? null)
                        )

                const originPrincipalLegs = yield* loadPrincipalLegs({
                  transactionId: originTransaction.id,
                })
                const destinationPrincipalLegs = yield* loadPrincipalLegs({
                  transactionId: destinationTransaction.id,
                })
                const [originPrincipalLeg] = originPrincipalLegs
                const [destinationPrincipalLeg] = destinationPrincipalLegs
                const originAlreadyCanonical =
                  originPrincipalLeg !== undefined &&
                  originPrincipalLegs.length === 1 &&
                  (yield* isExpectedPrincipalLeg({
                    leg: originPrincipalLeg,
                    externalId: originExternalId,
                    kind: "disposal",
                    derivationRule: "internal_transfer_out",
                    assetId: row.assetId,
                    amount,
                    sourceTransferId: originSourceTransferId,
                  }))
                const destinationAlreadyCanonical =
                  destinationPrincipalLeg !== undefined &&
                  destinationPrincipalLegs.length === 1 &&
                  (yield* isExpectedPrincipalLeg({
                    leg: destinationPrincipalLeg,
                    externalId: destinationExternalId,
                    kind: "acquisition",
                    derivationRule: "internal_transfer_in",
                    assetId: row.assetId,
                    amount,
                    sourceTransferId: destinationSourceTransferId,
                  }))

                const originCanBeCleared = originAlreadyCanonical
                  ? true
                  : yield* canClearPrincipalLegs({
                      legs: originPrincipalLegs,
                    })
                const destinationCanBeCleared = destinationAlreadyCanonical
                  ? true
                  : yield* canClearPrincipalLegs({
                      legs: destinationPrincipalLegs,
                    })

                if (!originCanBeCleared || !destinationCanBeCleared) {
                  yield* Effect.logWarning(
                    {
                      providerTransferId: row.providerTransferId,
                      canonicalTransferId,
                      canonicalTransactionId,
                      originAlreadyCanonical,
                      destinationAlreadyCanonical,
                    },
                    "Skipping deterministic internal transfer canonicalization because dependent downstream usage prevents a required rewrite"
                  )
                  return false
                }

                if (!originAlreadyCanonical) {
                  yield* clearPrincipalLegs({
                    legs: originPrincipalLegs,
                  })
                }

                if (!destinationAlreadyCanonical) {
                  yield* clearPrincipalLegs({
                    legs: destinationPrincipalLegs,
                  })
                }

                yield* tx
                  .update(schema.transactions)
                  .set({
                    transactionType: sql`case
                    when exists (
                      select 1
                      from ${schema.transactionReviews}
                      where ${schema.transactionReviews.transactionId} = ${schema.transactions.id}
                        and ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                        and ${schema.transactionReviews.currentTypeKey} is not null
                    )
                      then (
                        select ${schema.transactionReviews.currentTypeKey}
                        from ${schema.transactionReviews}
                        where ${schema.transactionReviews.transactionId} = ${schema.transactions.id}
                      )
                    else 'internal_transfer'
                  end`,
                    updatedAt: nowDate(),
                  })
                  .where(
                    inArray(schema.transactions.id, [
                      originTransaction.id,
                      destinationTransaction.id,
                    ])
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.applyPair.updateTransactions"
                    )
                  )

                yield* upsertInternalTransferReview({
                  transactionId: originTransaction.id,
                })
                yield* upsertInternalTransferReview({
                  transactionId: destinationTransaction.id,
                })

                const originLegId = yield* upsertInternalTransferLeg({
                  transactionId: originTransaction.id,
                  sourceId: originTransaction.sourceId,
                  sourceRawRecordId: originTransaction.sourceRawRecordId,
                  externalId: originExternalId,
                  timestamp: originTransaction.timestamp,
                  principalId: originTransaction.principalId,
                  assetId: row.assetId,
                  amount,
                  kind: "disposal",
                  sourceTransferId: originSourceTransferId,
                  reconciliationProviderTransferId: row.providerTransferId,
                  reconciliationCanonicalTransferId: canonicalTransferId,
                })
                const destinationLegId = yield* upsertInternalTransferLeg({
                  transactionId: destinationTransaction.id,
                  sourceId: destinationTransaction.sourceId,
                  sourceRawRecordId: destinationTransaction.sourceRawRecordId,
                  externalId: destinationExternalId,
                  timestamp: destinationTransaction.timestamp,
                  principalId: destinationTransaction.principalId,
                  assetId: row.assetId,
                  amount,
                  kind: "acquisition",
                  sourceTransferId: destinationSourceTransferId,
                  reconciliationProviderTransferId: row.providerTransferId,
                  reconciliationCanonicalTransferId: canonicalTransferId,
                })

                if (originLegId === undefined || destinationLegId === undefined) {
                  yield* Effect.logWarning(
                    {
                      providerTransferId: row.providerTransferId,
                      canonicalTransferId,
                      canonicalTransactionId,
                      originTransactionId: originTransaction.id,
                      destinationTransactionId: destinationTransaction.id,
                      originLegId,
                      destinationLegId,
                    },
                    "Skipping deterministic internal transfer canonicalization because canonical legs could not be materialized"
                  )
                  return false
                }

                const disposition = yield* ensureInternalTransferDisposition({
                  originLegId,
                  custodyProviderTransferId,
                  principalId: originTransaction.principalId,
                  sourceId: originTransaction.sourceId,
                  assetId: row.assetId,
                  amount,
                  maxAcquiredAt: originTransaction.timestamp,
                }).pipe(
                  Effect.catchTag("SyncEngineStorageError", (error) =>
                    error.operation ===
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.remainingAmount"
                      ? Effect.logWarning(
                          {
                            providerTransferId: row.providerTransferId,
                            canonicalTransferId,
                            canonicalTransactionId,
                            originTransactionId: originTransaction.id,
                            missingAmount: String(error.cause),
                          },
                          "Skipping deterministic internal transfer canonicalization because FIFO inventory before the transfer timestamp is insufficient"
                        ).pipe(Effect.as(null))
                      : Effect.fail(error)
                  )
                )

                if (disposition === null) {
                  return false
                }

                yield* moveLotsForInternalTransfer({
                  originLegId,
                  assetId: row.assetId,
                  destinationSourceId: destinationTransaction.sourceId,
                  destinationLegId,
                  disposition,
                })
                yield* rebuildReviewedDestinationFifoEffects({
                  destinationSourceId: destinationTransaction.sourceId,
                })

                if (row.providerDirection === "inbound") {
                  yield* removeUnusedInboundProviderLot({
                    providerTransferId: row.providerTransferId,
                  })
                }

                const matchedProviderTransferIds =
                  custodyProviderTransferId === null ||
                  custodyProviderTransferId === row.providerTransferId
                    ? [row.providerTransferId]
                    : [row.providerTransferId, custodyProviderTransferId]

                yield* tx
                  .update(schema.inventoryMovements)
                  .set({
                    taxTreatment: "non_taxable",
                    reconciliationStatus: "matched",
                    updatedAt: nowDate(),
                  })
                  .where(
                    inArray(
                      schema.inventoryMovements.providerTransferId,
                      matchedProviderTransferIds
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.markCustodyMovementsMatched"
                    )
                  )

                return true
              })

            const appliedResults = yield* Effect.forEach(reconciliations, applyPair)

            return {
              canonicalizedPairs: appliedResults.filter(Boolean).length,
            } satisfies DeterministicTransferCanonicalizationSummary
          })
        )
        .pipe(
          wrapSyncEngineSqlError(
            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization"
          )
        )

  return TransferReconciliationRepository.of({
    listProviderTransfersForReconciliation,
    findOnchainTransferCandidates,
    upsertTransferReconciliation,
    applyDeterministicInternalTransferCanonicalization,
  } satisfies TransferReconciliationRepositoryShape)
})

/**
 * TransferReconciliationRepositoryLive - Live reconciliation persistence layer.
 */
export const TransferReconciliationRepositoryLive = Layer.effect(
  TransferReconciliationRepository,
  make
)
