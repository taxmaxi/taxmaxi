/**
 * TransferReconciliationRepositoryLive - Persistence-backed reconciliation queries
 * and durable provider-transfer match state.
 *
 * @module TransferReconciliationRepositoryLive
 */

import {
  aliasedTable,
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  lte,
  ne,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
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
  type OnchainTransferReconciliationCandidate,
  type RecordOnchainRepresentationEvidenceParams,
  type TransferReconciliationRecordDraft,
  type TransferReconciliationRepositoryShape,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import { nowDate, wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"
import { schema } from "../schema/index.ts"

const isUniformCaseBitcoinBech32Address = (address: SQLWrapper) => sql`
  (${address} = lower(${address}) or ${address} = upper(${address}))
  and lower(${address}) ~ '^(bc1|tb1|bcrt1)[023456789acdefghjklmnpqrstuvwxyz]+$'
`

const chainAddressEquals = ({
  addressType,
  left,
  right,
}: {
  readonly addressType: SQLWrapper
  readonly left: SQLWrapper
  readonly right: SQLWrapper
}) => sql`
  case
    when ${addressType} = 'evm'
      then lower(${left}) = lower(${right})
    when ${addressType} = 'bitcoin'
      and (${isUniformCaseBitcoinBech32Address(left)})
      and (${isUniformCaseBitcoinBech32Address(right)})
      then lower(${left}) = lower(${right})
    else ${left} = ${right}
  end
`

class ReconciliationSourceSetChanged extends Schema.TaggedError<ReconciliationSourceSetChanged>()(
  "ReconciliationSourceSetChanged",
  {}
) {}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type TransferReconciliationExecutor = Pick<typeof db, "select">
  type ReconciliationMutationExecutor = Pick<typeof db, "delete" | "select" | "update">
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")
  const onchainProviderTransferTable = aliasedTable(
    schema.providerTransfers,
    "onchain_provider_transfer"
  )

  const INTERNAL_TRANSFER_REASON =
    "Deterministic provider transfer reconciled to a principal-owned onchain transfer."
  const RECONCILIATION_TIME_WINDOW_MILLIS = 12 * 60 * 60 * 1000
  const AutomaticRevalidationMetadataSchema = Schema.Struct({
    revalidateMovementFacts: Schema.optional(Schema.Boolean),
  })

  const lockNetworkMovements = ({
    executor,
    principalId,
    movements,
    operation,
  }: {
    readonly executor: Pick<typeof db, "execute">
    readonly principalId: string
    readonly movements: ReadonlyArray<{
      readonly networkName: string | null
      readonly networkHash: string | null
    }>
    readonly operation: string
  }) => {
    const lockKeys = [
      ...new Set(
        movements
          .filter((movement) => movement.networkHash !== null && movement.networkHash.trim() !== "")
          .map(
            (movement) =>
              `${principalId}:${movement.networkName?.toLowerCase() ?? ""}:${movement.networkHash?.toLowerCase() ?? ""}`
          )
      ),
    ].sort()

    return Effect.forEach(
      lockKeys,
      (lockKey) =>
        executor
          .execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`)
          .pipe(wrapSyncEngineSqlError(operation)),
      { concurrency: 1, discard: true }
    )
  }

  const listUnresolvedTransferReconciliations: TransferReconciliationRepositoryShape["listUnresolvedTransferReconciliations"] =
    ({ status, cursorId, limit }) =>
      db
        .select({
          id: schema.transferReconciliations.id,
          principalId: schema.transferReconciliations.principalId,
          providerTransferId: schema.transferReconciliations.providerTransferId,
          providerSourceId: schema.providerTransfers.sourceId,
          providerTimestamp: schema.providerTransfers.timestamp,
          providerDirection: schema.providerTransfers.direction,
          providerAmount: schema.providerTransfers.amount,
          networkName: schema.providerTransfers.networkName,
          networkHash: schema.providerTransfers.networkHash,
          canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
          canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
          status: sql<"pending" | "needs_review">`${schema.transferReconciliations.status}`,
          matchReason: schema.transferReconciliations.matchReason,
          confidence: schema.transferReconciliations.confidence,
          deterministic: schema.transferReconciliations.deterministic,
          reviewMetadata: schema.transferReconciliations.reviewMetadata,
          createdAt: schema.transferReconciliations.createdAt,
          updatedAt: schema.transferReconciliations.updatedAt,
        })
        .from(schema.transferReconciliations)
        .innerJoin(
          schema.providerTransfers,
          eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
        )
        .where(
          and(
            status === null
              ? inArray(schema.transferReconciliations.status, ["pending", "needs_review"])
              : eq(schema.transferReconciliations.status, status),
            ...(cursorId === null ? [] : [gt(schema.transferReconciliations.id, cursorId)])
          )
        )
        .orderBy(asc(schema.transferReconciliations.id))
        .limit(limit)
        .pipe(
          wrapSyncEngineSqlError(
            "transferReconciliationRepository.listUnresolvedTransferReconciliations"
          )
        )

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
          assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
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
        .innerJoin(
          schema.transactions,
          eq(schema.transactions.id, schema.providerTransfers.transactionId)
        )
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
            eq(schema.sources.sourceableType, "cex"),
            eq(schema.providerTransfers.sourceId, sourceId),
            sql`lower(coalesce(${schema.transactions.providerStatus}, '')) in ('completed', 'succeeded')`,
            sql`coalesce(${schema.providerTransfers.metadata}->>'role', 'principal') = 'principal'`,
            inArray(schema.providerTransfers.processingMode, [
              "accounting_and_evidence",
              "accounting_only",
            ])
          )
        )
        .orderBy(asc(schema.providerTransfers.timestamp))
        .pipe(
          wrapSyncEngineSqlError(
            "transferReconciliationRepository.listProviderTransfersForReconciliation"
          )
        )

  const findOnchainTransferCandidatesWithExecutor = ({
    executor,
    search: {
      principalId,
      direction,
      walletAddress,
      timestampStart,
      timestampEnd,
      networkName,
      networkHash,
    },
  }: {
    readonly executor: TransferReconciliationExecutor
    readonly search: FindOnchainTransferReconciliationCandidatesParams
  }): Effect.Effect<
    ReadonlyArray<OnchainTransferReconciliationCandidate>,
    SyncEngineStorageError
  > => {
    const canonicalOwnershipColumn =
      direction === "outbound" ? schema.transfers.toAddress : schema.transfers.fromAddress
    const observedOwnershipColumn =
      direction === "outbound"
        ? onchainProviderTransferTable.toAddress
        : onchainProviderTransferTable.fromAddress
    const observedDirection = direction === "outbound" ? "inbound" : "outbound"
    const ownedSourceAddressCondition =
      networkHash !== null || walletAddress === null
        ? sql`true`
        : chainAddressEquals({
            addressType: schema.addresses.type,
            left: schema.addresses.address,
            right: sql`${walletAddress}`,
          })
    const canonicalOwnershipCondition = chainAddressEquals({
      addressType: schema.addresses.type,
      left: canonicalOwnershipColumn,
      right: schema.addresses.address,
    })
    const observedOwnershipCondition = chainAddressEquals({
      addressType: schema.addresses.type,
      left: observedOwnershipColumn,
      right: schema.addresses.address,
    })
    const canonicalHashCondition =
      networkHash === null
        ? sql`true`
        : sql`
              case
                when ${schema.addresses.type} in ('evm', 'bitcoin')
                  then lower(${schema.transfers.txHash}) = lower(${networkHash})
                else ${schema.transfers.txHash} = ${networkHash}
              end
            `
    const observedHashCondition =
      networkHash === null
        ? sql`true`
        : sql`
              case
                when ${schema.addresses.type} in ('evm', 'bitcoin')
                  then lower(${onchainProviderTransferTable.networkHash}) = lower(${networkHash})
                else ${onchainProviderTransferTable.networkHash} = ${networkHash}
              end
            `
    const canonicalTimeCondition =
      networkHash === null
        ? and(
            gte(schema.transfers.timestamp, timestampStart),
            lte(schema.transfers.timestamp, timestampEnd)
          )
        : sql`true`
    const observedTimeCondition =
      networkHash === null
        ? and(
            gte(onchainProviderTransferTable.timestamp, timestampStart),
            lte(onchainProviderTransferTable.timestamp, timestampEnd)
          )
        : sql`true`

    const canonicalCandidates = executor
      .select({
        transferId: schema.transfers.id,
        observedProviderTransferId: sql<string | null>`null`,
        transactionId: schema.transactionOnchainContext.transactionId,
        sourceId: schema.transfers.sourceId,
        addressId: schema.addresses.id,
        blockchainId: schema.transfers.blockchainId,
        blockchainName: schema.blockchains.name,
        txHash: schema.transfers.txHash,
        timestamp: schema.transfers.timestamp,
        fromAddress: schema.transfers.fromAddress,
        toAddress: schema.transfers.toAddress,
        providerAssetRowId: sql<string | null>`null`,
        providerAssetMappingStatus: sql<
          "approved" | "pending_review" | "rejected" | null
        >`'approved'`,
        assetId: schema.transfers.assetId,
        assetRepresentationId: schema.transfers.assetRepresentationId,
        representationType: schema.assetRepresentations.type,
        contractAddress: schema.assetRepresentations.contractAddress,
        mintAddress: schema.assetRepresentations.mintAddress,
        decimals: schema.assetRepresentations.decimals,
        amount: schema.transfers.amount,
      })
      .from(schema.transfers)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.transfers.sourceId))
      .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
      .innerJoin(schema.blockchains, eq(schema.blockchains.id, schema.transfers.blockchainId))
      .innerJoin(
        schema.transactionOnchainContext,
        and(
          eq(schema.transactionOnchainContext.addressId, schema.transfers.addressId),
          eq(schema.transactionOnchainContext.blockchainId, schema.transfers.blockchainId),
          eq(schema.transactionOnchainContext.chainTxId, schema.transfers.txHash)
        )
      )
      .leftJoin(
        schema.assetRepresentations,
        eq(schema.assetRepresentations.id, schema.transfers.assetRepresentationId)
      )
      .where(
        and(
          eq(schema.sources.principalId, principalId),
          eq(schema.sources.sourceableType, "onchain"),
          sql`${schema.transfers.addressId} = ${schema.sources.addressId}`,
          ne(schema.transfers.type, "fee"),
          sql`coalesce(${schema.transfers.metadata}->>'role', 'principal') = 'principal'`,
          ownedSourceAddressCondition,
          canonicalOwnershipCondition,
          canonicalTimeCondition,
          networkName === null
            ? sql`true`
            : sql`lower(${schema.blockchains.name}) = lower(${networkName})`,
          canonicalHashCondition
        )
      )
      .orderBy(asc(schema.transfers.timestamp), asc(schema.transfers.id))

    const observedCandidates = executor
      .select({
        transferId: sql<string | null>`null`,
        observedProviderTransferId: onchainProviderTransferTable.id,
        transactionId: onchainProviderTransferTable.transactionId,
        sourceId: onchainProviderTransferTable.sourceId,
        addressId: schema.addresses.id,
        blockchainId: onchainProviderTransferTable.observedBlockchainId,
        blockchainName: schema.blockchains.name,
        txHash: onchainProviderTransferTable.networkHash,
        timestamp: onchainProviderTransferTable.timestamp,
        fromAddress: onchainProviderTransferTable.fromAddress,
        toAddress: onchainProviderTransferTable.toAddress,
        providerAssetRowId: onchainProviderTransferTable.providerAssetId,
        providerAssetMappingStatus: schema.providerAssetMappings.mappingStatus,
        assetId: schema.providerAssetMappings.canonicalAssetId,
        assetRepresentationId: schema.providerAssetMappings.assetRepresentationId,
        representationType: onchainProviderTransferTable.observedRepresentationType,
        contractAddress: onchainProviderTransferTable.observedContractAddress,
        mintAddress: onchainProviderTransferTable.observedMintAddress,
        decimals: onchainProviderTransferTable.observedDecimals,
        amount: onchainProviderTransferTable.amount,
      })
      .from(onchainProviderTransferTable)
      .innerJoin(schema.sources, eq(schema.sources.id, onchainProviderTransferTable.sourceId))
      .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
      .innerJoin(
        schema.blockchains,
        eq(schema.blockchains.id, onchainProviderTransferTable.observedBlockchainId)
      )
      .leftJoin(
        schema.providerAssetMappings,
        eq(
          schema.providerAssetMappings.providerAssetRowId,
          onchainProviderTransferTable.providerAssetId
        )
      )
      .where(
        and(
          eq(schema.sources.principalId, principalId),
          eq(schema.sources.sourceableType, "onchain"),
          eq(onchainProviderTransferTable.direction, observedDirection),
          inArray(onchainProviderTransferTable.processingMode, [
            "accounting_and_evidence",
            "evidence_only",
          ]),
          sql`coalesce(${onchainProviderTransferTable.metadata}->>'role', 'principal') = 'principal'`,
          ownedSourceAddressCondition,
          observedOwnershipCondition,
          sql`(
              ${onchainProviderTransferTable.observedRepresentationType} = 'native'
              or ${onchainProviderTransferTable.observedMintAddress} is not null
              or ${onchainProviderTransferTable.observedContractAddress} is not null
            )`,
          sql`${schema.providerAssetMappings.mappingStatus} is distinct from 'excluded'`,
          observedTimeCondition,
          networkName === null
            ? sql`true`
            : sql`lower(${schema.blockchains.name}) = lower(${networkName})`,
          observedHashCondition,
          sql`not exists (
              select 1
              from ${schema.transfers}
              where ${schema.transfers.sourceId} = ${onchainProviderTransferTable.sourceId}
                and ${schema.transfers.sourceRawRecordId} is not distinct from ${onchainProviderTransferTable.sourceRawRecordId}
                and ${schema.transfers.externalId} is not distinct from coalesce(
                  ${onchainProviderTransferTable.metadata}->>'canonicalTransferExternalId',
                  ${onchainProviderTransferTable.externalId}
                )
                and ${schema.transfers.txHash} is not distinct from ${onchainProviderTransferTable.networkHash}
                and ${schema.transfers.fromAddress} is not distinct from ${onchainProviderTransferTable.fromAddress}
                and ${schema.transfers.toAddress} is not distinct from ${onchainProviderTransferTable.toAddress}
                and ${schema.transfers.amount} = ${onchainProviderTransferTable.amount}
            )`
        )
      )
      .orderBy(asc(onchainProviderTransferTable.timestamp), asc(onchainProviderTransferTable.id))

    return Effect.all([canonicalCandidates, observedCandidates]).pipe(
      Effect.map(([canonical, observed]) => [...canonical, ...observed]),
      wrapSyncEngineSqlError("transferReconciliationRepository.findOnchainTransferCandidates")
    )
  }

  const findOnchainTransferCandidates: TransferReconciliationRepositoryShape["findOnchainTransferCandidates"] =
    (search) => findOnchainTransferCandidatesWithExecutor({ executor: db, search })

  const reconciliationCandidateFingerprint = (
    candidate: OnchainTransferReconciliationCandidate
  ): string =>
    JSON.stringify([
      candidate.transferId,
      candidate.observedProviderTransferId,
      candidate.transactionId,
      candidate.sourceId,
      candidate.addressId,
      candidate.blockchainId,
      candidate.blockchainName,
      candidate.txHash,
      candidate.timestamp.toISOString(),
      candidate.fromAddress,
      candidate.toAddress,
      candidate.providerAssetRowId,
      candidate.providerAssetMappingStatus,
      candidate.assetId,
      candidate.assetRepresentationId,
      candidate.representationType,
      candidate.contractAddress,
      candidate.mintAddress,
      candidate.decimals,
      candidate.amount,
    ])

  const exactAmountCandidateFingerprints = ({
    providerAmount,
    candidates,
  }: {
    readonly providerAmount: string
    readonly candidates: ReadonlyArray<OnchainTransferReconciliationCandidate>
  }): Effect.Effect<ReadonlyArray<string>, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const providerAmountDecimal = yield* decodeBigDecimal({
        value: providerAmount,
        operation: "transferReconciliationRepository.compareCandidateSnapshot.providerAmount",
      })
      const fingerprints: Array<string> = []

      for (const candidate of candidates) {
        const candidateAmount = yield* decodeBigDecimal({
          value: candidate.amount,
          operation: "transferReconciliationRepository.compareCandidateSnapshot.candidateAmount",
        })

        if (BigDecimal.equals(providerAmountDecimal, candidateAmount)) {
          fingerprints.push(reconciliationCandidateFingerprint(candidate))
        }
      }

      return fingerprints
    })

  const recordOnchainRepresentationEvidence: TransferReconciliationRepositoryShape["recordOnchainRepresentationEvidence"] =
    ({
      providerAssetRowId,
      sourceProviderTransferId,
      destinationProviderTransferId,
      proposedCanonicalAssetId,
    }: RecordOnchainRepresentationEvidenceParams) => {
      const evidenceNote =
        `transfer_reconciliation_evidence:${sourceProviderTransferId}:${destinationProviderTransferId} ` +
        `proposes economic asset ${proposedCanonicalAssetId}; pending explicit review.`

      return db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = nowDate()
            yield* tx
              .insert(schema.providerAssetMappings)
              .values({
                providerAssetRowId,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: evidenceNote,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoNothing({
                target: schema.providerAssetMappings.providerAssetRowId,
              })

            const [mapping] = yield* tx
              .select({
                mappingStatus: schema.providerAssetMappings.mappingStatus,
                sourceNotes: schema.providerAssetMappings.sourceNotes,
              })
              .from(schema.providerAssetMappings)
              .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
              .for("update")
              .limit(1)

            if (
              mapping === undefined ||
              mapping.mappingStatus !== "pending_review" ||
              mapping.sourceNotes?.includes(
                `${sourceProviderTransferId}:${destinationProviderTransferId}`
              ) === true
            ) {
              return
            }

            const sourceNotes =
              mapping.sourceNotes === null || mapping.sourceNotes.trim() === ""
                ? evidenceNote
                : `${mapping.sourceNotes}\n${evidenceNote}`

            yield* tx
              .update(schema.providerAssetMappings)
              .set({ sourceNotes, updatedAt: now })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAssetRowId))
          })
        )
        .pipe(
          wrapSyncEngineSqlError(
            "transferReconciliationRepository.recordOnchainRepresentationEvidence"
          )
        )
    }

  type TransferReconciliationUpsertInput = TransferReconciliationRecordDraft & {
    readonly forceAppliedRollback?: boolean
  }

  const deleteLegacyReconciliationLegs = ({
    executor,
    providerTransferId,
  }: {
    readonly executor: ReconciliationMutationExecutor
    readonly providerTransferId: string
  }) =>
    Effect.gen(function* () {
      const internalLegs = yield* executor
        .select({
          id: schema.transactionLegs.id,
          transactionId: schema.transactionLegs.transactionId,
          custodyProviderTransferId: sql<string | null>`
            ${schema.transactionLegs.metadata}->'reconciliation'->>'custodyProviderTransferId'
          `,
        })
        .from(schema.transactionLegs)
        .where(
          and(
            inArray(schema.transactionLegs.derivationRule, [
              "internal_transfer_out",
              "internal_transfer_in",
            ]),
            eq(
              sql<string>`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'`,
              providerTransferId
            )
          )
        )
      if (internalLegs.length > 0) {
        yield* executor.delete(schema.transactionLegs).where(
          inArray(
            schema.transactionLegs.id,
            internalLegs.map(({ id }) => id)
          )
        )
      }

      return internalLegs
    })

  const unmatchReconciliationMovements = ({
    executor,
    principalId,
    providerTransferId,
    canonicalTransferId,
    canonicalTransactionId,
    providerDirection,
    legacyCustodyProviderTransferIds,
  }: {
    readonly executor: ReconciliationMutationExecutor
    readonly principalId: string
    readonly providerTransferId: string
    readonly canonicalTransferId: string
    readonly canonicalTransactionId: string
    readonly providerDirection: "inbound" | "outbound"
    readonly legacyCustodyProviderTransferIds: readonly (string | null)[]
  }) =>
    Effect.gen(function* () {
      const [canonicalTransfer] = yield* executor
        .select({ externalId: schema.transfers.externalId })
        .from(schema.transfers)
        .where(eq(schema.transfers.id, canonicalTransferId))
        .limit(1)
      let custodyProviderTransferId: string | null = null
      if (providerDirection === "inbound" && canonicalTransfer !== undefined) {
        const [custodyMovement] = yield* executor
          .select({ providerTransferId: schema.inventoryMovements.providerTransferId })
          .from(schema.inventoryMovements)
          .innerJoin(
            schema.providerTransfers,
            eq(schema.providerTransfers.id, schema.inventoryMovements.providerTransferId)
          )
          .where(
            and(
              eq(schema.inventoryMovements.principalId, principalId),
              eq(schema.inventoryMovements.transactionId, canonicalTransactionId),
              sql`${schema.providerTransfers.metadata}->>'canonicalTransferExternalId' = ${canonicalTransfer.externalId}`,
              sql`${schema.inventoryMovements.providerTransferId} is not null`
            )
          )
          .limit(1)
        custodyProviderTransferId = custodyMovement?.providerTransferId ?? null
      }

      const movementProviderTransferIds = [
        ...new Set([
          providerTransferId,
          ...(custodyProviderTransferId === null ? [] : [custodyProviderTransferId]),
          ...legacyCustodyProviderTransferIds.flatMap((custodyProviderTransferId) =>
            custodyProviderTransferId === null ? [] : [custodyProviderTransferId]
          ),
        ]),
      ]
      yield* executor
        .update(schema.inventoryMovements)
        .set({ reconciliationStatus: "unmatched", updatedAt: nowDate() })
        .where(inArray(schema.inventoryMovements.providerTransferId, movementProviderTransferIds))
    })

  const removeLegacyReconciliationReviewState = ({
    executor,
    transactionIds,
  }: {
    readonly executor: ReconciliationMutationExecutor
    readonly transactionIds: readonly string[]
  }) =>
    Effect.gen(function* () {
      const reviews = yield* executor
        .select({
          transactionId: schema.transactionReviews.transactionId,
          reviewStatus: schema.transactionReviews.reviewStatus,
          categorizationReason: schema.transactionReviews.categorizationReason,
          matchedLayer: schema.transactionReviews.matchedLayer,
        })
        .from(schema.transactionReviews)
        .where(inArray(schema.transactionReviews.transactionId, transactionIds))

      for (const review of reviews) {
        if (review.reviewStatus === "approved" || review.reviewStatus === "changed") continue

        const existingLayers = (review.matchedLayer ?? "")
          .split(",")
          .map((layer) => layer.trim())
          .filter((layer) => layer !== "")
        if (!existingLayers.includes("transfer_reconciliation")) continue

        const remainingLayers = existingLayers.filter(
          (layer) => layer !== "transfer_reconciliation"
        )
        if (remainingLayers.length === 0) {
          yield* executor
            .update(schema.transactions)
            .set({ transactionType: null, updatedAt: nowDate() })
            .where(
              and(
                eq(schema.transactions.id, review.transactionId),
                eq(schema.transactions.transactionType, "internal_transfer")
              )
            )
          yield* executor
            .delete(schema.transactionReviews)
            .where(eq(schema.transactionReviews.transactionId, review.transactionId))
          continue
        }

        const remainingReasons = (review.categorizationReason ?? "")
          .split("\n")
          .map((reason) => reason.trim())
          .filter((reason) => reason !== "" && reason !== INTERNAL_TRANSFER_REASON)
        yield* executor
          .update(schema.transactionReviews)
          .set({
            reviewStatus: "needs_review",
            categorizationReason:
              remainingReasons.length === 0 ? null : remainingReasons.join("\n"),
            matchedLayer: remainingLayers.join(","),
            needsReview: true,
            updatedAt: nowDate(),
          })
          .where(eq(schema.transactionReviews.transactionId, review.transactionId))
      }
    })

  const rollbackAppliedReconciliation = ({
    executor,
    principalId,
    providerTransferId,
    canonicalTransferId,
    canonicalTransactionId,
    providerTransactionId,
    providerDirection,
  }: {
    readonly executor: ReconciliationMutationExecutor
    readonly principalId: string
    readonly providerTransferId: string
    readonly canonicalTransferId: string
    readonly canonicalTransactionId: string
    readonly providerTransactionId: string
    readonly providerDirection: "inbound" | "outbound"
  }) =>
    Effect.gen(function* () {
      const internalLegs = yield* deleteLegacyReconciliationLegs({
        executor,
        providerTransferId,
      })
      yield* unmatchReconciliationMovements({
        executor,
        principalId,
        providerTransferId,
        canonicalTransferId,
        canonicalTransactionId,
        providerDirection,
        legacyCustodyProviderTransferIds: internalLegs.map(
          ({ custodyProviderTransferId }) => custodyProviderTransferId
        ),
      })
      yield* removeLegacyReconciliationReviewState({
        executor,
        transactionIds: [
          ...new Set([
            providerTransactionId,
            canonicalTransactionId,
            ...internalLegs.flatMap(({ transactionId }) =>
              transactionId === null ? [] : [transactionId]
            ),
          ]),
        ],
      })
    })

  const upsertTransferReconciliation: (
    params: TransferReconciliationUpsertInput
  ) => ReturnType<TransferReconciliationRepositoryShape["upsertTransferReconciliation"]> = ({
    principalId,
    providerTransferId,
    canonicalTransferId,
    canonicalTransactionId,
    status,
    matchReason,
    confidence,
    deterministic,
    reviewMetadata,
    candidateSnapshot,
    forceAppliedRollback = false,
  }: TransferReconciliationUpsertInput) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          let persistedCanonicalTransferId = canonicalTransferId
          let persistedCanonicalTransactionId = canonicalTransactionId
          let persistedStatus = status
          let persistedMatchReason = matchReason
          let persistedConfidence = confidence
          let persistedDeterministic = deterministic
          let persistedReviewMetadata = reviewMetadata
          let candidateSnapshotChanged = false
          let conflictingProviderTransferId: string | null = null
          if (candidateSnapshot !== undefined) {
            yield* lockNetworkMovements({
              executor: tx,
              principalId,
              movements: [candidateSnapshot.search],
              operation:
                "transferReconciliationRepository.upsertTransferReconciliation.lockNetworkMovement",
            })
          }
          const providerScopes = yield* tx
            .select({ sourceId: schema.transactions.sourceId })
            .from(schema.providerTransfers)
            .innerJoin(
              schema.transactions,
              eq(schema.transactions.id, schema.providerTransfers.transactionId)
            )
            .where(eq(schema.providerTransfers.id, providerTransferId))
            .limit(1)
          const existingCanonicalRows = yield* tx
            .select({
              canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
              sourceId: schema.transactions.sourceId,
            })
            .from(schema.transferReconciliations)
            .leftJoin(
              schema.transactions,
              eq(schema.transactions.id, schema.transferReconciliations.canonicalTransactionId)
            )
            .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            .limit(1)
          const incomingCanonicalScopes =
            canonicalTransactionId === null
              ? []
              : yield* tx
                  .select({ sourceId: schema.transactions.sourceId })
                  .from(schema.transactions)
                  .where(eq(schema.transactions.id, canonicalTransactionId))
                  .limit(1)
          const relevantCanonicalTransferIds = [
            canonicalTransferId,
            existingCanonicalRows[0]?.canonicalTransferId,
          ].filter(
            (relevantCanonicalTransferId): relevantCanonicalTransferId is string =>
              relevantCanonicalTransferId !== null && relevantCanonicalTransferId !== undefined
          )
          const relevantAssets =
            relevantCanonicalTransferIds.length === 0
              ? []
              : yield* tx
                  .selectDistinct({ assetId: schema.transfers.assetId })
                  .from(schema.transfers)
                  .where(inArray(schema.transfers.id, relevantCanonicalTransferIds))
          const loadDerivedInternalTransferSourceIds = () =>
            relevantAssets.length === 0
              ? Effect.succeed([])
              : tx
                  .selectDistinct({ sourceId: schema.transactionLegs.sourceId })
                  .from(schema.transactionLegs)
                  .where(
                    and(
                      eq(schema.transactionLegs.principalId, principalId),
                      inArray(
                        schema.transactionLegs.assetId,
                        relevantAssets.map(({ assetId }) => assetId)
                      ),
                      inArray(schema.transactionLegs.derivationRule, [
                        "internal_transfer_out",
                        "internal_transfer_in",
                      ]),
                      sql`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId' is not null`
                    )
                  )
          const derivedInternalTransferSources = yield* loadDerivedInternalTransferSourceIds()
          const affectedSourceIds = [
            ...new Set(
              [
                providerScopes[0]?.sourceId,
                existingCanonicalRows[0]?.sourceId,
                incomingCanonicalScopes[0]?.sourceId,
                ...derivedInternalTransferSources.map(({ sourceId }) => sourceId),
              ].filter(
                (affectedSourceId): affectedSourceId is string =>
                  affectedSourceId !== null && affectedSourceId !== undefined
              )
            ),
          ].sort()
          if (affectedSourceIds.length > 0) {
            yield* tx
              .select({ id: schema.sources.id })
              .from(schema.sources)
              .where(inArray(schema.sources.id, affectedSourceIds))
              .orderBy(asc(schema.sources.id))
              .for("update")
          }
          const lockedSourceIds = new Set(affectedSourceIds)
          const revalidatedDerivedSources = yield* loadDerivedInternalTransferSourceIds()
          if (
            revalidatedDerivedSources.some(
              ({ sourceId }) => sourceId !== null && !lockedSourceIds.has(sourceId)
            )
          ) {
            return yield* new ReconciliationSourceSetChanged()
          }

          if (candidateSnapshot !== undefined) {
            const currentCandidates = yield* findOnchainTransferCandidatesWithExecutor({
              executor: tx,
              search: candidateSnapshot.search,
            })
            const currentCandidateFingerprints = yield* exactAmountCandidateFingerprints({
              providerAmount: candidateSnapshot.providerAmount,
              candidates: currentCandidates,
            })
            const expectedCandidateFingerprints = [
              ...candidateSnapshot.candidateFingerprints,
            ].sort()
            const sortedCurrentCandidateFingerprints = [...currentCandidateFingerprints].sort()
            candidateSnapshotChanged =
              expectedCandidateFingerprints.length !== sortedCurrentCandidateFingerprints.length ||
              expectedCandidateFingerprints.some(
                (candidateFingerprint, index) =>
                  candidateFingerprint !== sortedCurrentCandidateFingerprints[index]
              )

            if (candidateSnapshotChanged) {
              const metadata = yield* Schema.decodeUnknownEffect(
                Schema.Record(Schema.String, Schema.Unknown)
              )(reviewMetadata).pipe(Effect.orElseSucceed(() => ({ evidence: reviewMetadata })))
              persistedCanonicalTransferId = null
              persistedCanonicalTransactionId = null
              persistedStatus = "needs_review"
              persistedMatchReason = "candidate_set_changed_during_reconciliation"
              persistedConfidence = "0.0000"
              persistedDeterministic = false
              persistedReviewMetadata = {
                ...metadata,
                candidateSnapshot: {
                  expectedCandidateFingerprints,
                  currentCandidateFingerprints: sortedCurrentCandidateFingerprints,
                },
              }
            }
          }

          if (
            persistedCanonicalTransferId !== null &&
            (persistedStatus === "auto_applied" || persistedStatus === "approved")
          ) {
            const [existingClaim] = yield* tx
              .select({
                providerTransferId: schema.transferReconciliations.providerTransferId,
                status: schema.transferReconciliations.status,
              })
              .from(schema.transferReconciliations)
              .where(
                and(
                  eq(schema.transferReconciliations.principalId, principalId),
                  eq(
                    schema.transferReconciliations.canonicalTransferId,
                    persistedCanonicalTransferId
                  ),
                  ne(schema.transferReconciliations.providerTransferId, providerTransferId),
                  or(
                    inArray(schema.transferReconciliations.status, ["auto_applied", "approved"]),
                    and(
                      eq(schema.transferReconciliations.status, "needs_review"),
                      eq(
                        schema.transferReconciliations.matchReason,
                        "canonical_transfer_claim_conflict_pending_rollback"
                      )
                    )
                  )
                )
              )
              .for("update")
              .limit(1)

            if (existingClaim !== undefined) {
              if (existingClaim.status !== "approved") {
                conflictingProviderTransferId = existingClaim.providerTransferId
                yield* tx
                  .update(schema.transferReconciliations)
                  .set({
                    status: "needs_review",
                    matchReason: "canonical_transfer_claim_conflict_pending_rollback",
                    confidence: "0.0000",
                    deterministic: false,
                    reviewMetadata: {
                      conflictingProviderTransferId: providerTransferId,
                      rollback: { status: "pending" },
                    },
                    updatedAt: nowDate(),
                  })
                  .where(
                    eq(
                      schema.transferReconciliations.providerTransferId,
                      existingClaim.providerTransferId
                    )
                  )
              }
              const metadata = yield* Schema.decodeUnknownEffect(
                Schema.Record(Schema.String, Schema.Unknown)
              )(persistedReviewMetadata).pipe(
                Effect.orElseSucceed(() => ({ evidence: persistedReviewMetadata }))
              )
              persistedCanonicalTransferId = null
              persistedCanonicalTransactionId = null
              persistedStatus = "needs_review"
              persistedMatchReason =
                existingClaim.status === "approved"
                  ? "canonical_transfer_already_approved"
                  : "canonical_transfer_already_reconciled"
              persistedConfidence = "0.0000"
              persistedDeterministic = false
              persistedReviewMetadata = {
                ...metadata,
                conflictingProviderTransferId: existingClaim.providerTransferId,
              }
            }
          }

          const [existing] = yield* tx
            .select({
              status: schema.transferReconciliations.status,
              matchReason: schema.transferReconciliations.matchReason,
              canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
              canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
              reviewMetadata: schema.transferReconciliations.reviewMetadata,
              providerTransactionId: schema.providerTransfers.transactionId,
              providerDirection: schema.providerTransfers.direction,
            })
            .from(schema.transferReconciliations)
            .innerJoin(
              schema.providerTransfers,
              eq(schema.providerTransfers.id, schema.transferReconciliations.providerTransferId)
            )
            .where(eq(schema.transferReconciliations.providerTransferId, providerTransferId))
            .for("update")
            .limit(1)

          const resumesClaimConflictRollback =
            existing?.status === "needs_review" &&
            existing.matchReason === "canonical_transfer_claim_conflict_pending_rollback"
          if (resumesClaimConflictRollback) {
            persistedCanonicalTransferId = null
            persistedCanonicalTransactionId = null
            persistedStatus = "needs_review"
            persistedMatchReason = "canonical_transfer_claim_conflict"
            persistedConfidence = "0.0000"
            persistedDeterministic = false
          }

          const blockedRollback =
            existing?.status === "needs_review"
              ? yield* Schema.decodeUnknownEffect(
                  Schema.Struct({
                    rollback: Schema.Struct({
                      status: Schema.Literal("blocked"),
                      reason: Schema.Literal("dependent_destination_lot_usage"),
                      appliedEffectsRetained: Schema.Literal(true),
                    }),
                  })
                )(existing.reviewMetadata).pipe(Effect.option)
              : Option.none()
          const invalidatesAppliedMatch =
            existing !== undefined &&
            (existing.status === "auto_applied" ||
              (forceAppliedRollback && existing.status === "approved") ||
              Option.isSome(blockedRollback) ||
              resumesClaimConflictRollback) &&
            (persistedStatus !== "auto_applied" ||
              persistedCanonicalTransferId !== existing.canonicalTransferId ||
              persistedCanonicalTransactionId !== existing.canonicalTransactionId)

          if (
            invalidatesAppliedMatch &&
            existing.canonicalTransferId !== null &&
            existing.canonicalTransactionId !== null
          ) {
            yield* rollbackAppliedReconciliation({
              executor: tx,
              principalId,
              providerTransferId,
              canonicalTransferId: existing.canonicalTransferId,
              canonicalTransactionId: existing.canonicalTransactionId,
              providerTransactionId: existing.providerTransactionId,
              providerDirection: existing.providerDirection,
            })
          }
          const now = nowDate()
          yield* tx
            .insert(schema.transferReconciliations)
            .values({
              principalId,
              providerTransferId,
              canonicalTransferId: persistedCanonicalTransferId,
              canonicalTransactionId: persistedCanonicalTransactionId,
              status: persistedStatus,
              matchReason: persistedMatchReason,
              confidence: persistedConfidence,
              deterministic: persistedDeterministic,
              reviewMetadata: persistedReviewMetadata,
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
              setWhere: sql`${forceAppliedRollback} or ${schema.transferReconciliations.status} not in ('approved', 'rejected')`,
            })

          return {
            candidateSnapshotChanged,
            conflictingProviderTransferId,
            status: persistedStatus,
          }
        })
      )
      .pipe(
        Effect.retry({
          times: 2,
          while: (error) => Schema.is(ReconciliationSourceSetChanged)(error),
        }),
        wrapSyncEngineSqlError("transferReconciliationRepository.upsertTransferReconciliation")
      )

  const rollbackReconciliationsForSourceReplay: TransferReconciliationRepositoryShape["rollbackReconciliationsForSourceReplay"] =
    ({ sourceId }) =>
      Effect.gen(function* () {
        const loadAffectedReconciliations = () =>
          db
            .select({
              principalId: schema.transferReconciliations.principalId,
              providerTransferId: schema.transferReconciliations.providerTransferId,
              reviewMetadata: schema.transferReconciliations.reviewMetadata,
            })
            .from(schema.transferReconciliations)
            .where(
              and(
                or(
                  inArray(schema.transferReconciliations.status, ["auto_applied", "approved"]),
                  and(
                    eq(schema.transferReconciliations.status, "needs_review"),
                    or(
                      eq(
                        schema.transferReconciliations.matchReason,
                        "canonical_transfer_claim_conflict_pending_rollback"
                      ),
                      sql`${schema.transferReconciliations.reviewMetadata}->'rollback'->>'appliedEffectsRetained' = 'true'`
                    )
                  )
                ),
                or(
                  sql`exists (
                    select 1
                    from ${schema.providerTransfers} replay_provider_transfer
                    join ${schema.transactions} replay_provider_transaction
                      on replay_provider_transaction.id = replay_provider_transfer.transaction_id
                    where replay_provider_transfer.id = ${schema.transferReconciliations.providerTransferId}
                      and replay_provider_transaction.source_id = ${sourceId}
                  )`,
                  sql`exists (
                    select 1
                    from ${schema.transactions} replay_canonical_transaction
                    where replay_canonical_transaction.id = ${schema.transferReconciliations.canonicalTransactionId}
                      and replay_canonical_transaction.source_id = ${sourceId}
                  )`
                )
              )
            )
            .orderBy(asc(schema.transferReconciliations.createdAt))
            .pipe(
              wrapSyncEngineSqlError(
                "transferReconciliationRepository.rollbackReconciliationsForSourceReplay.list"
              )
            )

        const loadAffectedSourceIds = (
          reconciliations: Effect.Success<ReturnType<typeof loadAffectedReconciliations>>
        ) =>
          Effect.gen(function* () {
            if (reconciliations.length === 0) {
              return [sourceId]
            }
            const providerTransferIds = reconciliations.map(
              ({ providerTransferId }) => providerTransferId
            )
            const principalIds = [...new Set(reconciliations.map(({ principalId }) => principalId))]
            const providerSources = yield* db
              .selectDistinct({ sourceId: schema.transactions.sourceId })
              .from(schema.providerTransfers)
              .innerJoin(
                schema.transactions,
                eq(schema.transactions.id, schema.providerTransfers.transactionId)
              )
              .where(inArray(schema.providerTransfers.id, providerTransferIds))
            const canonicalSources = yield* db
              .selectDistinct({ sourceId: schema.transactions.sourceId })
              .from(schema.transferReconciliations)
              .innerJoin(
                schema.transactions,
                eq(schema.transactions.id, schema.transferReconciliations.canonicalTransactionId)
              )
              .where(
                inArray(schema.transferReconciliations.providerTransferId, providerTransferIds)
              )
            const relevantAssets = yield* db
              .selectDistinct({ assetId: schema.transfers.assetId })
              .from(schema.transferReconciliations)
              .innerJoin(
                schema.transfers,
                eq(schema.transfers.id, schema.transferReconciliations.canonicalTransferId)
              )
              .where(
                inArray(schema.transferReconciliations.providerTransferId, providerTransferIds)
              )
            const derivedSources =
              relevantAssets.length === 0
                ? []
                : yield* db
                    .selectDistinct({ sourceId: schema.transactionLegs.sourceId })
                    .from(schema.transactionLegs)
                    .where(
                      and(
                        inArray(schema.transactionLegs.principalId, principalIds),
                        inArray(
                          schema.transactionLegs.assetId,
                          relevantAssets.map(({ assetId }) => assetId)
                        ),
                        inArray(schema.transactionLegs.derivationRule, [
                          "internal_transfer_out",
                          "internal_transfer_in",
                        ]),
                        sql`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId' is not null`
                      )
                    )

            return [
              ...new Set([
                sourceId,
                ...providerSources.map(({ sourceId: affectedSourceId }) => affectedSourceId),
                ...canonicalSources.map(({ sourceId: affectedSourceId }) => affectedSourceId),
                ...derivedSources.map(({ sourceId: affectedSourceId }) => affectedSourceId),
              ]),
            ].sort()
          }).pipe(
            wrapSyncEngineSqlError(
              "transferReconciliationRepository.rollbackReconciliationsForSourceReplay.loadAffectedSources"
            )
          )

        const initialReconciliations = yield* loadAffectedReconciliations()
        const initialSourceIds = yield* loadAffectedSourceIds(initialReconciliations)
        yield* db
          .select({ id: schema.sources.id })
          .from(schema.sources)
          .where(inArray(schema.sources.id, initialSourceIds))
          .orderBy(asc(schema.sources.id))
          .for("update")
          .pipe(
            wrapSyncEngineSqlError(
              "transferReconciliationRepository.rollbackReconciliationsForSourceReplay.lockSources"
            )
          )

        const affectedReconciliations = yield* loadAffectedReconciliations()
        const revalidatedSourceIds = yield* loadAffectedSourceIds(affectedReconciliations)
        const newlyAffectedSourceIds = revalidatedSourceIds.filter(
          (affectedSourceId) => !initialSourceIds.includes(affectedSourceId)
        )
        if (newlyAffectedSourceIds.length > 0) {
          yield* db
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(inArray(schema.sources.id, newlyAffectedSourceIds))
            .orderBy(asc(schema.sources.id))
            .for("update", { noWait: true })
            .pipe(
              wrapSyncEngineSqlError(
                "transferReconciliationRepository.rollbackReconciliationsForSourceReplay.lockNewSources"
              )
            )
        }

        yield* Effect.forEach(
          affectedReconciliations,
          (reconciliation) =>
            upsertTransferReconciliation({
              principalId: reconciliation.principalId,
              providerTransferId: reconciliation.providerTransferId,
              canonicalTransferId: null,
              canonicalTransactionId: null,
              status: "needs_review",
              matchReason: "source_replay_pending_reconciliation",
              confidence: "0.0000",
              deterministic: false,
              reviewMetadata: {
                prior: reconciliation.reviewMetadata,
                replay: { sourceId, status: "pending" },
              },
              forceAppliedRollback: true,
            }),
          { concurrency: 1, discard: true }
        )
      })

  type CanonicalizationExecutor = Pick<typeof db, "delete" | "execute" | "select" | "update">

  const loadEligibleReconciliations = ({
    executor,
    principalId,
    sourceId,
    reconciliationId,
  }: {
    readonly executor: CanonicalizationExecutor
    readonly principalId: string
    readonly sourceId: string
    readonly reconciliationId?: string
  }) =>
    executor
      .select({
        reconciliationId: schema.transferReconciliations.id,
        reconciliationStatus: schema.transferReconciliations.status,
        reviewMetadata: schema.transferReconciliations.reviewMetadata,
        providerTransferId: schema.providerTransfers.id,
        providerDirection: schema.providerTransfers.direction,
        providerTimestamp: schema.providerTransfers.timestamp,
        providerFromAddress: schema.providerTransfers.fromAddress,
        providerToAddress: schema.providerTransfers.toAddress,
        providerNetworkName: schema.providerTransfers.networkName,
        providerNetworkHash: schema.providerTransfers.networkHash,
        providerAmount: schema.providerTransfers.amount,
        providerTransactionId: schema.providerTransfers.transactionId,
        canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
        canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
        canonicalTransferExternalId: schema.transfers.externalId,
        assetId: schema.transfers.assetId,
        assetRepresentationId: schema.transfers.assetRepresentationId,
        providerTransactionSourceId: providerTransactionTable.sourceId,
        canonicalTransactionSourceId: canonicalTransactionTable.sourceId,
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
        eq(canonicalTransactionTable.id, schema.transferReconciliations.canonicalTransactionId)
      )
      .where(
        and(
          eq(schema.transferReconciliations.principalId, principalId),
          eq(schema.providerTransfers.sourceId, sourceId),
          reconciliationId === undefined
            ? undefined
            : eq(schema.transferReconciliations.id, reconciliationId),
          or(
            and(
              eq(schema.transferReconciliations.status, "auto_applied"),
              eq(schema.transferReconciliations.deterministic, true)
            ),
            eq(schema.transferReconciliations.status, "approved")
          ),
          sql`${schema.transferReconciliations.canonicalTransferId} is not null`,
          sql`${schema.transferReconciliations.canonicalTransactionId} is not null`,
          inArray(schema.providerTransfers.processingMode, [
            "accounting_and_evidence",
            "accounting_only",
          ])
        )
      )
      .orderBy(asc(schema.providerTransfers.timestamp))

  type EligibleReconciliationRow = Effect.Success<
    ReturnType<typeof loadEligibleReconciliations>
  >[number]

  const loadCustodyProviderTransferId = ({
    executor,
    row,
  }: {
    readonly executor: CanonicalizationExecutor
    readonly row: EligibleReconciliationRow
  }) =>
    Effect.gen(function* () {
      if (row.providerDirection === "outbound") return row.providerTransferId
      if (row.canonicalTransactionId === null) return null

      const rows = yield* executor
        .select({ providerTransferId: schema.inventoryMovements.providerTransferId })
        .from(schema.inventoryMovements)
        .innerJoin(
          schema.providerTransfers,
          eq(schema.providerTransfers.id, schema.inventoryMovements.providerTransferId)
        )
        .where(
          and(
            eq(schema.inventoryMovements.transactionId, row.canonicalTransactionId),
            sql`${schema.providerTransfers.metadata}->>'canonicalTransferExternalId' = ${row.canonicalTransferExternalId}`,
            sql`${schema.inventoryMovements.providerTransferId} is not null`
          )
        )
        .limit(1)
      return rows[0]?.providerTransferId ?? null
    })

  const stillHasOneExactMovementCandidate = ({
    executor,
    principalId,
    row,
  }: {
    readonly executor: CanonicalizationExecutor
    readonly principalId: string
    readonly row: EligibleReconciliationRow
  }) =>
    Effect.gen(function* () {
      const metadata = yield* Schema.decodeUnknownEffect(AutomaticRevalidationMetadataSchema)(
        row.reviewMetadata
      ).pipe(Effect.orElseSucceed(() => ({ revalidateMovementFacts: undefined })))
      if (row.reconciliationStatus === "approved" || metadata.revalidateMovementFacts !== true) {
        return true
      }

      const walletAddress =
        row.providerDirection === "outbound" ? row.providerToAddress : row.providerFromAddress
      if (walletAddress === null && row.providerNetworkHash === null) return false

      const candidates = yield* findOnchainTransferCandidatesWithExecutor({
        executor,
        search: {
          principalId,
          direction: row.providerDirection,
          walletAddress,
          timestampStart: DateTime.toDateUtc(
            DateTime.subtractDuration(
              DateTime.makeUnsafe(row.providerTimestamp),
              RECONCILIATION_TIME_WINDOW_MILLIS
            )
          ),
          timestampEnd: DateTime.toDateUtc(
            DateTime.addDuration(
              DateTime.makeUnsafe(row.providerTimestamp),
              RECONCILIATION_TIME_WINDOW_MILLIS
            )
          ),
          networkName: row.providerNetworkName,
          networkHash: row.providerNetworkHash,
        },
      })
      const providerAmount = yield* decodeBigDecimal({
        value: row.providerAmount,
        operation:
          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.revalidateProviderAmount",
      })
      const exactCandidates: Array<OnchainTransferReconciliationCandidate> = []
      for (const candidate of candidates) {
        const candidateAmount = yield* decodeBigDecimal({
          value: candidate.amount,
          operation:
            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.revalidateCandidateAmount",
        })
        if (BigDecimal.equals(providerAmount, candidateAmount)) exactCandidates.push(candidate)
      }

      const [candidate] = exactCandidates
      return (
        exactCandidates.length === 1 &&
        candidate !== undefined &&
        candidate.transferId === row.canonicalTransferId &&
        candidate.providerAssetMappingStatus === "approved" &&
        candidate.assetId === row.assetId &&
        candidate.assetRepresentationId === row.assetRepresentationId
      )
    })

  const applyEligibleReconciliation = ({
    executor,
    principalId,
    row,
  }: {
    readonly executor: CanonicalizationExecutor
    readonly principalId: string
    readonly row: EligibleReconciliationRow
  }) =>
    Effect.gen(function* () {
      if (row.canonicalTransactionId === null || row.canonicalTransferId === null) return false

      if (!(yield* stillHasOneExactMovementCandidate({ executor, principalId, row }))) {
        yield* rollbackAppliedReconciliation({
          executor,
          principalId,
          providerTransferId: row.providerTransferId,
          canonicalTransferId: row.canonicalTransferId,
          canonicalTransactionId: row.canonicalTransactionId,
          providerTransactionId: row.providerTransactionId,
          providerDirection: row.providerDirection,
        })
        yield* executor
          .update(schema.transferReconciliations)
          .set({
            status: "needs_review",
            matchReason: "movement_facts_changed_before_canonicalization",
            confidence: "0.0000",
            deterministic: false,
            updatedAt: nowDate(),
          })
          .where(eq(schema.transferReconciliations.id, row.reconciliationId))
        return false
      }

      const transactionIds = [row.providerTransactionId, row.canonicalTransactionId]
      const manualReviews = yield* executor
        .select({ transactionId: schema.transactionReviews.transactionId })
        .from(schema.transactionReviews)
        .where(
          and(
            inArray(schema.transactionReviews.transactionId, transactionIds),
            inArray(schema.transactionReviews.reviewStatus, ["approved", "changed"])
          )
        )
        .for("update")
      if (manualReviews.length > 0) {
        yield* executor
          .update(schema.transferReconciliations)
          .set({
            status: "needs_review",
            matchReason: "manual_transaction_review_preserved",
            confidence: "0.0000",
            deterministic: false,
            updatedAt: nowDate(),
          })
          .where(eq(schema.transferReconciliations.id, row.reconciliationId))
        return false
      }

      yield* executor
        .delete(schema.transactionLegs)
        .where(
          and(
            inArray(schema.transactionLegs.transactionId, transactionIds),
            inArray(schema.transactionLegs.derivationRule, [
              "internal_transfer_out",
              "internal_transfer_in",
            ]),
            eq(
              sql<string>`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'`,
              row.providerTransferId
            )
          )
        )

      const custodyProviderTransferId = yield* loadCustodyProviderTransferId({ executor, row })
      const matchedProviderTransferIds =
        custodyProviderTransferId === null || custodyProviderTransferId === row.providerTransferId
          ? [row.providerTransferId]
          : [row.providerTransferId, custodyProviderTransferId]
      yield* executor
        .update(schema.inventoryMovements)
        .set({ reconciliationStatus: "matched", updatedAt: nowDate() })
        .where(inArray(schema.inventoryMovements.providerTransferId, matchedProviderTransferIds))

      return true
    })

  const applyDeterministicInternalTransferCanonicalization: TransferReconciliationRepositoryShape["applyDeterministicInternalTransferCanonicalization"] =
    ({ principalId, sourceId, reconciliationId }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const loadEligible = () =>
              loadEligibleReconciliations({
                executor: tx,
                principalId,
                sourceId,
                ...(reconciliationId === undefined ? {} : { reconciliationId }),
              })
            const beforeLock = yield* loadEligible()
            yield* lockNetworkMovements({
              executor: tx,
              principalId,
              movements: beforeLock.map((row) => ({
                networkName: row.providerNetworkName,
                networkHash: row.providerNetworkHash,
              })),
              operation:
                "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockNetworkMovement",
            })
            const sourceIds = [
              ...new Set(
                beforeLock.flatMap((row) => [
                  row.providerTransactionSourceId,
                  row.canonicalTransactionSourceId,
                ])
              ),
            ].sort()
            const lockedSources =
              sourceIds.length === 0
                ? []
                : yield* tx
                    .select({ id: schema.sources.id })
                    .from(schema.sources)
                    .where(
                      and(
                        eq(schema.sources.principalId, principalId),
                        inArray(schema.sources.id, sourceIds)
                      )
                    )
                    .orderBy(asc(schema.sources.id))
                    .for("update")
            if (lockedSources.length !== sourceIds.length) {
              return yield* new SyncEngineStorageError({
                operation:
                  "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockSourceInventory",
                cause: "Internal transfer sources are not owned by the reconciliation principal",
              })
            }

            const reconciliations = yield* loadEligible()
            const lockedSourceIds = new Set(lockedSources.map(({ id }) => id))
            if (
              reconciliations.some(
                (row) =>
                  !lockedSourceIds.has(row.providerTransactionSourceId) ||
                  !lockedSourceIds.has(row.canonicalTransactionSourceId)
              )
            ) {
              return yield* new ReconciliationSourceSetChanged()
            }
            let canonicalizedPairs = 0
            for (const row of reconciliations) {
              if (yield* applyEligibleReconciliation({ executor: tx, principalId, row })) {
                canonicalizedPairs += 1
              }
            }

            return {
              canonicalizedPairs,
            } satisfies DeterministicTransferCanonicalizationSummary
          })
        )
        .pipe(
          Effect.retry({
            times: 2,
            while: (error) => Schema.is(ReconciliationSourceSetChanged)(error),
          }),
          wrapSyncEngineSqlError(
            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization"
          )
        )

  return TransferReconciliationRepository.of({
    listUnresolvedTransferReconciliations,
    listProviderTransfersForReconciliation,
    findOnchainTransferCandidates,
    recordOnchainRepresentationEvidence,
    upsertTransferReconciliation,
    rollbackReconciliationsForSourceReplay,
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
