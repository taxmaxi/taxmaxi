/**
 * TransferReconciliationRepositoryLive - Persistence-backed reconciliation queries
 * and durable provider-transfer match state.
 *
 * @module TransferReconciliationRepositoryLive
 */

import {
  FifoInputRejectedError,
  isFifoInputRejectedError,
  matchFifoLots,
  type FifoMatchError,
  type FifoMatchResult,
} from "@my/accounting"
import {
  AccountingQuantity,
  add as addAccountingQuantities,
  format as formatAccountingQuantity,
  MonetaryAmount,
} from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import {
  aliasedTable,
  and,
  asc,
  count,
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
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")
  const onchainProviderTransferTable = aliasedTable(
    schema.providerTransfers,
    "onchain_provider_transfer"
  )

  const INTERNAL_TRANSFER_REASON =
    "Deterministic provider transfer reconciled to a principal-owned onchain transfer."
  const FIFO_INVENTORY_REVIEW_LAYER = "fifo_inventory"
  const FIFO_INVENTORY_REVIEW_REASON_PREFIX = "fifo_inventory:"
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

  const formatDecimal = ({
    value,
    operation,
  }: {
    readonly value: unknown
    readonly operation: string
  }) =>
    Schema.decodeUnknownEffect(Schema.Union([Schema.String, Schema.Finite]))(value).pipe(
      Effect.map(String),
      Effect.mapError(
        () =>
          new SyncEngineStorageError({
            operation,
            cause: `Invalid numeric value: ${String(value)}`,
          })
      )
    )

  const RECONCILIATION_FIFO_CURRENCY = CurrencyCode.make("EUR")

  const decodeFifoQuantity = ({
    value,
    operation,
  }: {
    readonly value: unknown
    readonly operation: string
  }) =>
    Effect.gen(function* () {
      const amount = yield* formatDecimal({ value, operation }).pipe(
        Effect.mapError(
          (error) =>
            new SyncEngineStorageError({
              operation,
              cause: new FifoInputRejectedError({ cause: error.cause }),
            })
        )
      )

      return yield* Schema.decodeEffect(AccountingQuantity)(amount).pipe(
        Effect.mapError(
          (cause) =>
            new SyncEngineStorageError({
              operation,
              cause: new FifoInputRejectedError({ cause }),
            })
        )
      )
    })

  // T05 preserves the rebuild's currency-blind numeric output. Result rows do not
  // carry a currency here, so the adapter gives every matcher input one currency.
  const decodeReconciliationFifoMoney = ({
    value,
    operation,
  }: {
    readonly value: unknown
    readonly operation: string
  }) =>
    Effect.gen(function* () {
      const amount = yield* formatDecimal({ value, operation }).pipe(
        Effect.mapError(
          (error) =>
            new SyncEngineStorageError({
              operation,
              cause: new FifoInputRejectedError({ cause: error.cause }),
            })
        )
      )

      return yield* Schema.decodeEffect(MonetaryAmount)({
        amount,
        currency: RECONCILIATION_FIFO_CURRENCY,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SyncEngineStorageError({
              operation,
              cause: new FifoInputRejectedError({ cause }),
            })
        )
      )
    })

  const wrapFifoMatchError = ({
    error,
    operation,
  }: {
    readonly error: FifoMatchError
    readonly operation: string
  }) => new SyncEngineStorageError({ operation, cause: error })

  type ReconciliationLegEffect = {
    readonly id: string
    readonly kind: string
    readonly providerTransferId: string | null
    readonly custodyProviderTransferId: string | null
    readonly dispositionSource: "custody_allocations" | "open_lots" | null
  }
  type ReconciliationMutationExecutor = Pick<typeof db, "delete" | "insert" | "select" | "update">
  type RebuildableFifoEffect = {
    readonly id: string
    readonly kind: "disposal" | "movement"
    readonly transactionId: string | null
    readonly sourceId: string
    readonly principalId: string
    readonly assetId: string
    readonly amount: unknown
    readonly fiatAmount: unknown
    readonly timestamp: Date
    readonly createdAt: Date
  }
  type RebuildFifoMatchRow = {
    readonly id: string
    readonly effectId: string
    readonly fifoLotId: string
    readonly matchedAmount: unknown
  }
  type RebuildFifoLotRow = {
    readonly id: string
    readonly sourceId: string
    readonly principalId: string
    readonly assetId: string
    readonly acquiredAt: Date
    readonly availableAt: Date
    readonly remainingAmount: unknown
    readonly costBasisPerToken: unknown
    readonly createdAt: Date
  }
  type DecodedRebuildFifoLotRow = Omit<
    RebuildFifoLotRow,
    "remainingAmount" | "costBasisPerToken"
  > & {
    readonly remainingQuantity: AccountingQuantity
    readonly costBasisPerUnit: MonetaryAmount
  }
  type DecodedRebuildableFifoEffect = RebuildableFifoEffect & {
    readonly quantity: AccountingQuantity
    readonly proceeds: MonetaryAmount | null
  }

  const optionalRejectedFifoInput = <A>(
    input: Effect.Effect<A, SyncEngineStorageError>
  ): Effect.Effect<Option.Option<A>, SyncEngineStorageError> =>
    input.pipe(
      Effect.map(Option.some),
      Effect.catchTag("SyncEngineStorageError", (error) =>
        isFifoInputRejectedError(error.cause) ? Effect.succeed(Option.none()) : Effect.fail(error)
      )
    )

  const decodeRebuildFifoMatchRow = (row: RebuildFifoMatchRow) =>
    optionalRejectedFifoInput(
      decodeFifoQuantity({
        value: row.matchedAmount,
        operation:
          "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.matchRow.matchedAmount",
      }).pipe(Effect.map((matchedAmount) => ({ ...row, matchedAmount })))
    )

  const decodeRebuildFifoLotRow = (row: RebuildFifoLotRow) =>
    optionalRejectedFifoInput(
      Effect.gen(function* () {
        const remainingQuantity = yield* decodeFifoQuantity({
          value: row.remainingAmount,
          operation:
            "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.lotRow.remainingAmount",
        })
        const costBasisPerUnit = yield* decodeReconciliationFifoMoney({
          value: row.costBasisPerToken,
          operation:
            "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.lotRow.costBasisPerToken",
        })

        return {
          id: row.id,
          sourceId: row.sourceId,
          principalId: row.principalId,
          assetId: row.assetId,
          acquiredAt: row.acquiredAt,
          availableAt: row.availableAt,
          createdAt: row.createdAt,
          remainingQuantity,
          costBasisPerUnit,
        } satisfies DecodedRebuildFifoLotRow
      })
    )

  const decodeRebuildFifoEffectRow = (row: RebuildableFifoEffect) =>
    optionalRejectedFifoInput(
      Effect.gen(function* () {
        const quantity = yield* decodeFifoQuantity({
          value: row.amount,
          operation:
            "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.effectRow.amount",
        })
        const proceeds =
          row.fiatAmount === null
            ? null
            : yield* decodeReconciliationFifoMoney({
                value: row.fiatAmount,
                operation:
                  "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.effectRow.fiatAmount",
              })

        return { ...row, quantity, proceeds } satisfies DecodedRebuildableFifoEffect
      })
    )

  const matchRebuildFifoEffect = ({
    lots,
    effect,
  }: {
    readonly lots: ReadonlyArray<{
      readonly id: string
      readonly remainingQuantity: AccountingQuantity
      readonly costBasisPerUnit: MonetaryAmount
    }>
    readonly effect: DecodedRebuildableFifoEffect
  }) =>
    optionalRejectedFifoInput(
      matchFifoLots({
        lots,
        disposal: { quantity: effect.quantity, proceeds: effect.proceeds },
      }).pipe(
        Effect.mapError((error) =>
          wrapFifoMatchError({
            error,
            operation:
              "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.match",
          })
        )
      )
    )

  const makeReconciliationEffectMutations = (tx: ReconciliationMutationExecutor) => {
    const clearLegs = ({ legs }: { readonly legs: ReadonlyArray<ReconciliationLegEffect> }) =>
      Effect.gen(function* () {
        const disposalLegs = legs.filter((leg) => leg.kind === "disposal")
        const disposalLegIds = disposalLegs.map(({ id }) => id)
        const matches =
          disposalLegIds.length === 0
            ? []
            : yield* tx
                .select({
                  id: schema.disposalMatches.id,
                  disposalLegId: schema.disposalMatches.disposalLegId,
                  fifoLotId: schema.disposalMatches.fifoLotId,
                  matchedAmount: schema.disposalMatches.matchedAmount,
                })
                .from(schema.disposalMatches)
                .where(inArray(schema.disposalMatches.disposalLegId, disposalLegIds))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.loadMatches"
                  )
                )
        const disposalLegsById = new Map(disposalLegs.map((leg) => [leg.id, leg] as const))
        const custodyProviderTransferIds = [
          ...new Set(
            disposalLegs.flatMap((leg) => {
              if (leg.dispositionSource !== "custody_allocations") {
                return []
              }
              const custodyProviderTransferId =
                leg.custodyProviderTransferId ?? leg.providerTransferId
              return custodyProviderTransferId === null ? [] : [custodyProviderTransferId]
            })
          ),
        ]
        const custodyMovements =
          custodyProviderTransferIds.length === 0
            ? []
            : yield* tx
                .select({
                  id: schema.inventoryMovements.id,
                  providerTransferId: schema.inventoryMovements.providerTransferId,
                })
                .from(schema.inventoryMovements)
                .where(
                  inArray(schema.inventoryMovements.providerTransferId, custodyProviderTransferIds)
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.loadCustodyMovements"
                  )
                )
        const custodyMovementsByProviderTransferId = new Map(
          custodyMovements.flatMap((movement) =>
            movement.providerTransferId === null
              ? []
              : [[movement.providerTransferId, movement] as const]
          )
        )

        yield* Effect.forEach(matches, (match) =>
          Effect.gen(function* () {
            const leg = disposalLegsById.get(match.disposalLegId)
            const custodyProviderTransferId =
              leg?.custodyProviderTransferId ?? leg?.providerTransferId ?? null
            const custodyMovement =
              leg?.dispositionSource === "custody_allocations" && custodyProviderTransferId !== null
                ? custodyMovementsByProviderTransferId.get(custodyProviderTransferId)
                : undefined

            if (leg?.dispositionSource === "custody_allocations") {
              if (custodyMovement === undefined) {
                return yield* new SyncEngineStorageError({
                  operation:
                    "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.restoreCustodyAllocation",
                  cause: "Converted custody allocation is missing its inventory movement.",
                })
              }
              yield* tx
                .insert(schema.inventoryMovementAllocations)
                .values({
                  inventoryMovementId: custodyMovement.id,
                  fifoLotId: match.fifoLotId,
                  matchedAmount: match.matchedAmount,
                  createdAt: nowDate(),
                })
                .onConflictDoUpdate({
                  target: [
                    schema.inventoryMovementAllocations.inventoryMovementId,
                    schema.inventoryMovementAllocations.fifoLotId,
                  ],
                  set: { matchedAmount: sql.raw("excluded.matched_amount") },
                })
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.restoreCustodyAllocation"
                  )
                )
              return
            }

            yield* tx
              .update(schema.fifoLots)
              .set({
                remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${match.matchedAmount}`,
                updatedAt: nowDate(),
              })
              .where(eq(schema.fifoLots.id, match.fifoLotId))
              .pipe(
                wrapSyncEngineSqlError(
                  "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.restoreLot"
                )
              )
          })
        )

        if (matches.length > 0) {
          yield* tx
            .delete(schema.disposalMatches)
            .where(
              inArray(
                schema.disposalMatches.id,
                matches.map(({ id }) => id)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.deleteMatches"
              )
            )
        }
        if (legs.length > 0) {
          yield* tx
            .delete(schema.transactionLegs)
            .where(
              inArray(
                schema.transactionLegs.id,
                legs.map(({ id }) => id)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "transferReconciliationRepository.reconciliationEffectMutations.clearLegs.deleteLegs"
              )
            )
        }
      })

    const inventoryKeyForEffect = (effect: RebuildableFifoEffect) =>
      `${effect.sourceId}:${effect.principalId}:${effect.assetId}`

    const rebuildFifoEffects = ({
      effects: unsortedEffects,
      shortageMode,
    }: {
      readonly effects: ReadonlyArray<RebuildableFifoEffect>
      readonly shortageMode: "clear" | "preserve"
    }) =>
      Effect.gen(function* () {
        const effects = [...unsortedEffects].sort(
          (left, right) =>
            left.timestamp.getTime() - right.timestamp.getTime() ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.kind.localeCompare(right.kind) ||
            left.id.localeCompare(right.id)
        )
        const disposals = effects.filter((effect) => effect.kind === "disposal")
        const movements = effects.filter((effect) => effect.kind === "movement")
        const disposalIds = disposals.map(({ id }) => id)
        const movementIds = movements.map(({ id }) => id)
        const disposalMatches =
          disposalIds.length === 0
            ? []
            : yield* tx
                .select({
                  id: schema.disposalMatches.id,
                  effectId: schema.disposalMatches.disposalLegId,
                  fifoLotId: schema.disposalMatches.fifoLotId,
                  matchedAmount: schema.disposalMatches.matchedAmount,
                })
                .from(schema.disposalMatches)
                .where(inArray(schema.disposalMatches.disposalLegId, disposalIds))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.loadDisposalMatches"
                  )
                )
        const movementAllocations =
          movementIds.length === 0
            ? []
            : yield* tx
                .select({
                  id: schema.inventoryMovementAllocations.id,
                  effectId: schema.inventoryMovementAllocations.inventoryMovementId,
                  fifoLotId: schema.inventoryMovementAllocations.fifoLotId,
                  matchedAmount: schema.inventoryMovementAllocations.matchedAmount,
                })
                .from(schema.inventoryMovementAllocations)
                .where(
                  inArray(schema.inventoryMovementAllocations.inventoryMovementId, movementIds)
                )
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.loadMovementAllocations"
                  )
                )
        const effectById = new Map(effects.map((effect) => [effect.id, effect] as const))
        const blockedInventoryKeys = new Set<string>()
        const blockedEffectIds = new Set<string>()
        const rejectedInventoryKeys = new Set<string>()
        const blockRejectedEffect = (effect: RebuildableFifoEffect) => {
          const inventoryKey = inventoryKeyForEffect(effect)
          rejectedInventoryKeys.add(inventoryKey)
          blockedInventoryKeys.add(inventoryKey)
          blockedEffectIds.add(effect.id)
        }
        const allocations = [...disposalMatches, ...movementAllocations]
        const allocationKey = (allocation: RebuildFifoMatchRow) =>
          `${allocation.effectId}:${allocation.fifoLotId}:${allocation.id}`
        const decodedMatchedAmountByAllocationKey = new Map<string, AccountingQuantity>()
        const restoredAmountByLotId = new Map<string, AccountingQuantity>()
        for (const allocation of allocations) {
          const decodedAllocation = yield* decodeRebuildFifoMatchRow(allocation)
          if (Option.isNone(decodedAllocation)) {
            const effect = effectById.get(allocation.effectId)
            if (effect === undefined) {
              return yield* new SyncEngineStorageError({
                operation:
                  "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.matchRow.effect",
                cause: `Missing FIFO effect ${allocation.effectId}`,
              })
            }
            blockRejectedEffect(effect)
            continue
          }
          decodedMatchedAmountByAllocationKey.set(
            allocationKey(allocation),
            decodedAllocation.value.matchedAmount
          )
          const restoredAmount = restoredAmountByLotId.get(decodedAllocation.value.fifoLotId)
          restoredAmountByLotId.set(
            decodedAllocation.value.fifoLotId,
            restoredAmount === undefined
              ? decodedAllocation.value.matchedAmount
              : addAccountingQuantities(restoredAmount, decodedAllocation.value.matchedAmount)
          )
        }

        const windows = [
          ...new Map(
            effects.map((effect) => [
              inventoryKeyForEffect(effect),
              {
                sourceId: effect.sourceId,
                principalId: effect.principalId,
                assetId: effect.assetId,
              },
            ])
          ).values(),
        ]
        const candidateLots =
          windows.length === 0
            ? []
            : yield* tx
                .select({
                  id: schema.fifoLots.id,
                  sourceId: schema.fifoLots.sourceId,
                  principalId: schema.fifoLots.principalId,
                  assetId: schema.fifoLots.assetId,
                  acquiredAt: schema.fifoLots.acquiredAt,
                  availableAt: schema.transactionLegs.timestamp,
                  remainingAmount: schema.fifoLots.remainingAmount,
                  costBasisPerToken: schema.fifoLots.costBasisPerToken,
                  createdAt: schema.fifoLots.createdAt,
                })
                .from(schema.fifoLots)
                .innerJoin(
                  schema.transactionLegs,
                  eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
                )
                .where(
                  or(
                    ...windows.map((window) =>
                      and(
                        eq(schema.fifoLots.sourceId, window.sourceId),
                        eq(schema.fifoLots.principalId, window.principalId),
                        eq(schema.fifoLots.assetId, window.assetId)
                      )
                    )
                  )
                )
                .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.createdAt))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.loadCandidateLots"
                  )
                )
        const decodedCandidateLots: Array<DecodedRebuildFifoLotRow> = []
        const virtualRemainingByLotId = new Map<string, AccountingQuantity>()
        for (const lot of candidateLots) {
          const decodedLot = yield* decodeRebuildFifoLotRow(lot)
          if (Option.isNone(decodedLot)) {
            const inventoryKey = `${lot.sourceId}:${lot.principalId}:${lot.assetId}`
            rejectedInventoryKeys.add(inventoryKey)
            blockedInventoryKeys.add(inventoryKey)
            continue
          }
          decodedCandidateLots.push(decodedLot.value)
          const restoredAmount = restoredAmountByLotId.get(lot.id)
          virtualRemainingByLotId.set(
            lot.id,
            restoredAmount === undefined
              ? decodedLot.value.remainingQuantity
              : addAccountingQuantities(decodedLot.value.remainingQuantity, restoredAmount)
          )
        }

        const decodedEffectById = new Map<string, DecodedRebuildableFifoEffect>()
        for (const effect of effects) {
          const decodedEffect = yield* decodeRebuildFifoEffectRow(effect)
          if (Option.isNone(decodedEffect)) {
            blockRejectedEffect(effect)
            continue
          }
          decodedEffectById.set(effect.id, decodedEffect.value)
        }

        const matchResultByEffectId = new Map<string, FifoMatchResult>()
        for (const effect of effects) {
          const inventoryKey = inventoryKeyForEffect(effect)
          if (blockedInventoryKeys.has(inventoryKey)) {
            blockedEffectIds.add(effect.id)
            continue
          }
          const decodedEffect = decodedEffectById.get(effect.id)
          if (decodedEffect === undefined) {
            blockRejectedEffect(effect)
            continue
          }
          const preflightResult = yield* matchRebuildFifoEffect({
            lots: decodedCandidateLots.flatMap((lot) => {
              const remainingQuantity = virtualRemainingByLotId.get(lot.id)
              return remainingQuantity === undefined ||
                BigDecimal.isZero(remainingQuantity) ||
                lot.sourceId !== effect.sourceId ||
                lot.principalId !== effect.principalId ||
                lot.assetId !== effect.assetId ||
                lot.acquiredAt > effect.timestamp ||
                lot.availableAt > effect.timestamp
                ? []
                : [
                    {
                      id: lot.id,
                      remainingQuantity,
                      costBasisPerUnit: lot.costBasisPerUnit,
                    },
                  ]
            }),
            effect: decodedEffect,
          })
          if (Option.isNone(preflightResult)) {
            blockRejectedEffect(effect)
            continue
          }
          const result = preflightResult.value
          if (result._tag === "InventoryShortage") {
            blockedInventoryKeys.add(inventoryKey)
            blockedEffectIds.add(effect.id)
            continue
          }
          matchResultByEffectId.set(effect.id, result)
          for (const allocation of result.allocations) {
            virtualRemainingByLotId.set(allocation.lotId, allocation.remainingQuantity)
          }
        }
        if (shortageMode === "preserve") {
          for (const effect of effects) {
            if (blockedInventoryKeys.has(inventoryKeyForEffect(effect))) {
              blockedEffectIds.add(effect.id)
            }
          }
        }

        const shouldRemoveAllocation = (effectId: string) => {
          const effect = effectById.get(effectId)
          if (effect === undefined || rejectedInventoryKeys.has(inventoryKeyForEffect(effect))) {
            return false
          }

          return shortageMode === "clear" || !blockedEffectIds.has(effect.id)
        }
        const selectValidatedAllocationsToRebuild = <Row extends RebuildFifoMatchRow>(
          rows: ReadonlyArray<Row>
        ) =>
          rows.flatMap((row) => {
            const matchedAmount = decodedMatchedAmountByAllocationKey.get(allocationKey(row))
            return shouldRemoveAllocation(row.effectId) && matchedAmount !== undefined
              ? [{ ...row, matchedAmount: formatAccountingQuantity(matchedAmount) }]
              : []
          })
        const disposalMatchesToRebuild = selectValidatedAllocationsToRebuild(disposalMatches)
        const movementAllocationsToRebuild =
          selectValidatedAllocationsToRebuild(movementAllocations)
        yield* Effect.forEach(
          [...disposalMatchesToRebuild, ...movementAllocationsToRebuild],
          (allocation) =>
            tx
              .update(schema.fifoLots)
              .set({
                remainingAmount: sql`${schema.fifoLots.remainingAmount} + ${allocation.matchedAmount}`,
                updatedAt: nowDate(),
              })
              .where(eq(schema.fifoLots.id, allocation.fifoLotId))
              .pipe(
                wrapSyncEngineSqlError(
                  "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.restoreLot"
                )
              )
        )
        if (disposalMatchesToRebuild.length > 0) {
          yield* tx
            .delete(schema.disposalMatches)
            .where(
              inArray(
                schema.disposalMatches.id,
                disposalMatchesToRebuild.map(({ id }) => id)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.deleteDisposalMatches"
              )
            )
        }
        if (movementAllocationsToRebuild.length > 0) {
          yield* tx
            .delete(schema.inventoryMovementAllocations)
            .where(
              inArray(
                schema.inventoryMovementAllocations.id,
                movementAllocationsToRebuild.map(({ id }) => id)
              )
            )
            .pipe(
              wrapSyncEngineSqlError(
                "transferReconciliationRepository.reconciliationEffectMutations.rebuildFifoEffects.deleteMovementAllocations"
              )
            )
        }

        for (const effect of effects) {
          if (blockedEffectIds.has(effect.id)) {
            continue
          }
          const result = matchResultByEffectId.get(effect.id)
          if (result === undefined) {
            continue
          }
          for (const allocation of result.allocations) {
            if (effect.kind === "disposal") {
              yield* tx.insert(schema.disposalMatches).values({
                disposalLegId: effect.id,
                fifoLotId: allocation.lotId,
                matchedAmount: formatAccountingQuantity(allocation.matchedQuantity),
                costBasis: allocation.costBasis.format(),
                proceeds: allocation.proceeds.format(),
                gainLoss: allocation.gainLoss.format(),
                createdAt: nowDate(),
              })
            } else {
              yield* tx.insert(schema.inventoryMovementAllocations).values({
                inventoryMovementId: effect.id,
                fifoLotId: allocation.lotId,
                matchedAmount: formatAccountingQuantity(allocation.matchedQuantity),
                createdAt: nowDate(),
              })
            }
            yield* tx
              .update(schema.fifoLots)
              .set({
                remainingAmount: formatAccountingQuantity(allocation.remainingQuantity),
                updatedAt: nowDate(),
              })
              .where(eq(schema.fifoLots.id, allocation.lotId))
          }
        }

        return { blockedEffectIds, blockedInventoryKeys }
      })

    return { clearLegs, rebuildFifoEffects }
  }

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
            const [existingCanonicalTransfer] = yield* tx
              .select({
                externalId: schema.transfers.externalId,
                assetId: schema.transfers.assetId,
              })
              .from(schema.transfers)
              .where(eq(schema.transfers.id, existing.canonicalTransferId))
              .limit(1)

            if (existingCanonicalTransfer !== undefined) {
              const originTransactionId =
                existing.providerDirection === "outbound"
                  ? existing.providerTransactionId
                  : existing.canonicalTransactionId
              const destinationTransactionId =
                existing.providerDirection === "outbound"
                  ? existing.canonicalTransactionId
                  : existing.providerTransactionId
              const reconciliationProviderTransferIds = new Set([providerTransferId])
              let internalLegs = yield* tx
                .select({
                  id: schema.transactionLegs.id,
                  kind: schema.transactionLegs.kind,
                  transactionId: schema.transactionLegs.transactionId,
                  sourceId: schema.transactionLegs.sourceId,
                  timestamp: schema.transactionLegs.timestamp,
                  derivationRule: schema.transactionLegs.derivationRule,
                  providerTransferId: sql<string | null>`
                      ${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'
                    `,
                  dispositionSource: sql<"custody_allocations" | "open_lots" | null>`
                      ${schema.transactionLegs.metadata}->'reconciliation'->>'dispositionSource'
                    `,
                  custodyProviderTransferId: sql<string | null>`
                      ${schema.transactionLegs.metadata}->'reconciliation'->>'custodyProviderTransferId'
                    `,
                })
                .from(schema.transactionLegs)
                .where(
                  and(
                    inArray(schema.transactionLegs.transactionId, [
                      originTransactionId,
                      destinationTransactionId,
                    ]),
                    inArray(schema.transactionLegs.derivationRule, [
                      "internal_transfer_out",
                      "internal_transfer_in",
                    ]),
                    inArray(
                      sql<string>`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'`,
                      [providerTransferId]
                    )
                  )
                )

              while (true) {
                const acquisitionLegs = internalLegs.filter(
                  ({ derivationRule }) => derivationRule === "internal_transfer_in"
                )
                const acquisitionLegIds = acquisitionLegs.map(({ id }) => id)
                const suffixCutoffBySourceId = new Map<string, Date>()
                for (const leg of acquisitionLegs) {
                  if (leg.sourceId === null) {
                    continue
                  }
                  const currentCutoff = suffixCutoffBySourceId.get(leg.sourceId)
                  if (currentCutoff === undefined || leg.timestamp < currentCutoff) {
                    suffixCutoffBySourceId.set(leg.sourceId, leg.timestamp)
                  }
                }
                const suffixWindows = [...suffixCutoffBySourceId].map(
                  ([destinationSourceId, cutoff]) =>
                    and(
                      eq(schema.transactionLegs.sourceId, destinationSourceId),
                      gte(schema.transactionLegs.timestamp, cutoff)
                    )
                )
                const movementSuffixWindows = [...suffixCutoffBySourceId].map(
                  ([destinationSourceId, cutoff]) =>
                    and(
                      eq(schema.inventoryMovements.sourceId, destinationSourceId),
                      gte(schema.inventoryMovements.timestamp, cutoff)
                    )
                )
                const destinationLots =
                  acquisitionLegIds.length === 0
                    ? []
                    : yield* tx
                        .select({ id: schema.fifoLots.id })
                        .from(schema.fifoLots)
                        .where(inArray(schema.fifoLots.sourceLegId, acquisitionLegIds))
                const destinationLotIds = destinationLots.map(({ id }) => id)
                if (suffixCutoffBySourceId.size === 0) {
                  break
                }

                const downstreamDisposals =
                  destinationLotIds.length === 0
                    ? []
                    : yield* tx
                        .select({
                          providerTransferId: sql<string | null>`
                              ${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'
                            `,
                        })
                        .from(schema.disposalMatches)
                        .innerJoin(
                          schema.transactionLegs,
                          eq(schema.transactionLegs.id, schema.disposalMatches.disposalLegId)
                        )
                        .where(
                          and(
                            inArray(schema.disposalMatches.fifoLotId, destinationLotIds),
                            eq(schema.transactionLegs.derivationRule, "internal_transfer_out")
                          )
                        )
                const suffixDisposals = yield* tx
                  .select({
                    providerTransferId: sql<string | null>`
                        ${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'
                      `,
                  })
                  .from(schema.transactionLegs)
                  .where(
                    and(
                      or(...suffixWindows),
                      eq(schema.transactionLegs.principalId, principalId),
                      eq(schema.transactionLegs.assetId, existingCanonicalTransfer.assetId),
                      eq(schema.transactionLegs.derivationRule, "internal_transfer_out")
                    )
                  )
                const downstreamMovements =
                  destinationLotIds.length === 0
                    ? []
                    : yield* tx
                        .select({
                          providerTransferId: schema.inventoryMovements.providerTransferId,
                        })
                        .from(schema.inventoryMovementAllocations)
                        .innerJoin(
                          schema.inventoryMovements,
                          eq(
                            schema.inventoryMovements.id,
                            schema.inventoryMovementAllocations.inventoryMovementId
                          )
                        )
                        .where(
                          and(
                            inArray(
                              schema.inventoryMovementAllocations.fifoLotId,
                              destinationLotIds
                            ),
                            eq(schema.inventoryMovements.reconciliationStatus, "matched")
                          )
                        )
                const suffixMovements = yield* tx
                  .select({
                    providerTransferId: schema.inventoryMovements.providerTransferId,
                  })
                  .from(schema.inventoryMovements)
                  .where(
                    and(
                      or(...movementSuffixWindows),
                      eq(schema.inventoryMovements.principalId, principalId),
                      eq(schema.inventoryMovements.assetId, existingCanonicalTransfer.assetId),
                      eq(schema.inventoryMovements.direction, "outbound"),
                      eq(schema.inventoryMovements.reconciliationStatus, "matched")
                    )
                  )
                const downstreamProviderTransferIds = [
                  ...downstreamDisposals.map(({ providerTransferId }) => providerTransferId),
                  ...suffixDisposals.map(({ providerTransferId }) => providerTransferId),
                  ...downstreamMovements.map(({ providerTransferId }) => providerTransferId),
                  ...suffixMovements.map(({ providerTransferId }) => providerTransferId),
                ].filter(
                  (downstreamProviderTransferId): downstreamProviderTransferId is string =>
                    downstreamProviderTransferId !== null &&
                    !reconciliationProviderTransferIds.has(downstreamProviderTransferId)
                )

                if (downstreamProviderTransferIds.length === 0) {
                  break
                }

                const uniqueDownstreamProviderTransferIds = [
                  ...new Set(downstreamProviderTransferIds),
                ]
                for (const downstreamProviderTransferId of uniqueDownstreamProviderTransferIds) {
                  reconciliationProviderTransferIds.add(downstreamProviderTransferId)
                }
                const downstreamInternalLegs = yield* tx
                  .select({
                    id: schema.transactionLegs.id,
                    kind: schema.transactionLegs.kind,
                    transactionId: schema.transactionLegs.transactionId,
                    sourceId: schema.transactionLegs.sourceId,
                    timestamp: schema.transactionLegs.timestamp,
                    derivationRule: schema.transactionLegs.derivationRule,
                    providerTransferId: sql<string | null>`
                        ${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'
                      `,
                    dispositionSource: sql<"custody_allocations" | "open_lots" | null>`
                        ${schema.transactionLegs.metadata}->'reconciliation'->>'dispositionSource'
                      `,
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
                      eq(schema.transactionLegs.assetId, existingCanonicalTransfer.assetId),
                      inArray(
                        sql<string>`${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'`,
                        uniqueDownstreamProviderTransferIds
                      )
                    )
                  )
                const existingInternalLegIds = new Set(internalLegs.map(({ id }) => id))
                internalLegs = [
                  ...internalLegs,
                  ...downstreamInternalLegs.filter(({ id }) => !existingInternalLegIds.has(id)),
                ]
              }

              const transactionIds = [
                ...new Set(
                  [
                    originTransactionId,
                    destinationTransactionId,
                    ...internalLegs.map(({ transactionId }) => transactionId),
                  ].filter((transactionId): transactionId is string => transactionId !== null)
                ),
              ]

              const destinationLegs = internalLegs.filter(
                ({ derivationRule }) => derivationRule === "internal_transfer_in"
              )
              const rollbackCutoffBySourceId = new Map<string, Date>()
              for (const leg of destinationLegs) {
                if (leg.sourceId === null) {
                  continue
                }
                const currentCutoff = rollbackCutoffBySourceId.get(leg.sourceId)
                if (currentCutoff === undefined || leg.timestamp < currentCutoff) {
                  rollbackCutoffBySourceId.set(leg.sourceId, leg.timestamp)
                }
              }
              const disposalRollbackWindows = [...rollbackCutoffBySourceId].map(
                ([destinationSourceId, cutoff]) =>
                  and(
                    eq(schema.transactionLegs.sourceId, destinationSourceId),
                    gte(schema.transactionLegs.timestamp, cutoff)
                  )
              )
              const movementRollbackWindows = [...rollbackCutoffBySourceId].map(
                ([destinationSourceId, cutoff]) =>
                  and(
                    eq(schema.inventoryMovements.sourceId, destinationSourceId),
                    gte(schema.inventoryMovements.timestamp, cutoff)
                  )
              )
              const dependentDestinationDisposals =
                rollbackCutoffBySourceId.size === 0
                  ? []
                  : yield* tx
                      .select({
                        disposalLegId: schema.transactionLegs.id,
                        transactionId: schema.transactionLegs.transactionId,
                        derivationRule: schema.transactionLegs.derivationRule,
                        sourceId: schema.transactionLegs.sourceId,
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
                          or(...disposalRollbackWindows),
                          eq(schema.transactionLegs.principalId, principalId),
                          eq(schema.transactionLegs.assetId, existingCanonicalTransfer.assetId),
                          eq(schema.transactionLegs.kind, "disposal")
                        )
                      )
              const dependentDestinationAllocations =
                rollbackCutoffBySourceId.size === 0
                  ? []
                  : yield* tx
                      .select({
                        inventoryMovementId: schema.inventoryMovements.id,
                        transactionId: schema.inventoryMovements.transactionId,
                        reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
                        sourceId: schema.inventoryMovements.sourceId,
                        principalId: schema.inventoryMovements.principalId,
                        assetId: schema.inventoryMovements.assetId,
                        amount: schema.inventoryMovements.amount,
                        transactionLegId: schema.inventoryMovements.transactionLegId,
                        providerTransferId: schema.inventoryMovements.providerTransferId,
                        purpose: schema.inventoryMovements.purpose,
                        timestamp: schema.inventoryMovements.timestamp,
                        createdAt: schema.inventoryMovements.createdAt,
                      })
                      .from(schema.inventoryMovements)
                      .where(
                        and(
                          or(...movementRollbackWindows),
                          eq(schema.inventoryMovements.principalId, principalId),
                          eq(schema.inventoryMovements.assetId, existingCanonicalTransfer.assetId),
                          eq(schema.inventoryMovements.direction, "outbound")
                        )
                      )

              const dependentMovementsToRebuild = []
              for (const movement of dependentDestinationAllocations) {
                if (
                  movement.transactionLegId === null &&
                  movement.providerTransferId !== null &&
                  movement.purpose === "principal"
                ) {
                  const matchingDisposals = dependentDestinationDisposals.filter(
                    (disposal) =>
                      disposal.transactionId === movement.transactionId &&
                      disposal.assetId === movement.assetId &&
                      disposal.derivationRule !== "internal_transfer_out"
                  )
                  const movementAmount = yield* decodeBigDecimal({
                    value: yield* formatDecimal({
                      value: movement.amount,
                      operation:
                        "transferReconciliationRepository.upsertTransferReconciliation.deduplicateMovementAmount",
                    }),
                    operation:
                      "transferReconciliationRepository.upsertTransferReconciliation.deduplicateMovementAmount",
                  })
                  const matchingDisposalResults = yield* Effect.forEach(
                    matchingDisposals,
                    (disposal) =>
                      Effect.gen(function* () {
                        const disposalAmount = yield* decodeBigDecimal({
                          value: yield* formatDecimal({
                            value: disposal.amount,
                            operation:
                              "transferReconciliationRepository.upsertTransferReconciliation.deduplicateDisposalAmount",
                          }),
                          operation:
                            "transferReconciliationRepository.upsertTransferReconciliation.deduplicateDisposalAmount",
                        })
                        return BigDecimal.equals(disposalAmount, movementAmount)
                      })
                  )
                  if (matchingDisposalResults.some(Boolean)) {
                    continue
                  }
                }
                dependentMovementsToRebuild.push(movement)
              }

              const custodyProviderTransferIds = [
                ...new Set([
                  ...reconciliationProviderTransferIds,
                  ...internalLegs.flatMap(({ custodyProviderTransferId }) =>
                    custodyProviderTransferId === null ? [] : [custodyProviderTransferId]
                  ),
                ]),
              ]
              const { clearLegs } = makeReconciliationEffectMutations(tx)
              yield* clearLegs({ legs: internalLegs })

              const reviews = yield* tx
                .select({
                  transactionId: schema.transactionReviews.transactionId,
                  reviewStatus: schema.transactionReviews.reviewStatus,
                  currentTypeKey: schema.transactionReviews.currentTypeKey,
                  categorizationReason: schema.transactionReviews.categorizationReason,
                  matchedLayer: schema.transactionReviews.matchedLayer,
                })
                .from(schema.transactionReviews)
                .where(inArray(schema.transactionReviews.transactionId, transactionIds))

              for (const review of reviews) {
                const layers = (review.matchedLayer ?? "")
                  .split(",")
                  .map((layer) => layer.trim())
                  .filter((layer) => layer !== "" && layer !== "transfer_reconciliation")
                const isReconciliationReview =
                  review.reviewStatus !== "approved" &&
                  review.reviewStatus !== "changed" &&
                  layers.length !==
                    (review.matchedLayer ?? "")
                      .split(",")
                      .map((layer) => layer.trim())
                      .filter((layer) => layer !== "").length

                if (!isReconciliationReview) {
                  continue
                }

                if (layers.length === 0) {
                  yield* tx
                    .update(schema.transactions)
                    .set({ transactionType: null, updatedAt: nowDate() })
                    .where(eq(schema.transactions.id, review.transactionId))
                  yield* tx
                    .delete(schema.transactionReviews)
                    .where(eq(schema.transactionReviews.transactionId, review.transactionId))
                  continue
                }

                const remainingReasons = (review.categorizationReason ?? "")
                  .split("\n")
                  .map((reason) => reason.trim())
                  .filter((reason) => reason !== "" && reason !== INTERNAL_TRANSFER_REASON)

                yield* tx
                  .update(schema.transactionReviews)
                  .set({
                    reviewStatus: "needs_review",
                    categorizationReason:
                      remainingReasons.length === 0 ? null : remainingReasons.join("\n"),
                    matchedLayer: layers.join(","),
                    needsReview: true,
                    updatedAt: nowDate(),
                  })
                  .where(eq(schema.transactionReviews.transactionId, review.transactionId))
              }

              const matchedProviderTransferIds = [
                ...new Set(
                  [...reconciliationProviderTransferIds, ...custodyProviderTransferIds].filter(
                    (matchedProviderTransferId): matchedProviderTransferId is string =>
                      matchedProviderTransferId !== null && matchedProviderTransferId !== undefined
                  )
                ),
              ]

              yield* tx
                .update(schema.inventoryMovements)
                .set({
                  taxTreatment: "pending_review",
                  reconciliationStatus: "unmatched",
                  updatedAt: nowDate(),
                })
                .where(
                  inArray(schema.inventoryMovements.providerTransferId, matchedProviderTransferIds)
                )

              const dependentDisposalsById = new Map(
                dependentDestinationDisposals
                  .filter(({ derivationRule }) => derivationRule !== "internal_transfer_out")
                  .map((disposal) => [disposal.disposalLegId, disposal])
              )
              const rollbackFifoReviewReason =
                "fifo_inventory: Review required because reconciliation rollback left insufficient replacement inventory."
              const markRollbackFifoReview = (transactionId: string | null) =>
                transactionId === null
                  ? Effect.void
                  : tx
                      .insert(schema.transactionReviews)
                      .values({
                        transactionId,
                        principalId,
                        reviewStatus: "needs_review",
                        categorizationReason: rollbackFifoReviewReason,
                        matchedLayer: "fifo_inventory",
                        needsReview: true,
                        createdAt: nowDate(),
                        updatedAt: nowDate(),
                      })
                      .onConflictDoUpdate({
                        target: schema.transactionReviews.transactionId,
                        set: {
                          reviewStatus: sql`case
                              when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                                then ${schema.transactionReviews.reviewStatus}
                              else 'needs_review'
                            end`,
                          categorizationReason: sql`case
                              when strpos(
                                coalesce(${schema.transactionReviews.categorizationReason}, ''),
                                cast(${rollbackFifoReviewReason} as text)
                              ) > 0 then ${schema.transactionReviews.categorizationReason}
                              when coalesce(${schema.transactionReviews.categorizationReason}, '') = ''
                                then cast(${rollbackFifoReviewReason} as text)
                              else ${schema.transactionReviews.categorizationReason}
                                || E'\n'
                                || cast(${rollbackFifoReviewReason} as text)
                            end`,
                          matchedLayer: sql`case
                              when cast('fifo_inventory' as text) = any(
                                string_to_array(coalesce(${schema.transactionReviews.matchedLayer}, ''), ',')
                              ) then ${schema.transactionReviews.matchedLayer}
                              when coalesce(${schema.transactionReviews.matchedLayer}, '') = ''
                                then 'fifo_inventory'
                              else ${schema.transactionReviews.matchedLayer} || ',fifo_inventory'
                            end`,
                          needsReview: true,
                          updatedAt: nowDate(),
                        },
                      })
              const dependentEffects: ReadonlyArray<RebuildableFifoEffect> = [
                ...[...dependentDisposalsById.entries()].map(([id, disposal]) => ({
                  id,
                  kind: "disposal" as const,
                  transactionId: disposal.transactionId,
                  sourceId: disposal.sourceId,
                  principalId: disposal.principalId,
                  assetId: disposal.assetId,
                  amount: disposal.amount,
                  fiatAmount: disposal.fiatAmount,
                  timestamp: disposal.timestamp,
                  createdAt: disposal.createdAt,
                })),
                ...dependentMovementsToRebuild.map((movement) => ({
                  id: movement.inventoryMovementId,
                  kind: "movement" as const,
                  transactionId: movement.transactionId,
                  sourceId: movement.sourceId,
                  principalId: movement.principalId,
                  assetId: movement.assetId,
                  amount: movement.amount,
                  fiatAmount: null,
                  timestamp: movement.timestamp,
                  createdAt: movement.createdAt,
                })),
              ]
              const { rebuildFifoEffects } = makeReconciliationEffectMutations(tx)
              const { blockedEffectIds } = yield* rebuildFifoEffects({
                effects: dependentEffects,
                shortageMode: "clear",
              })
              for (const effect of dependentEffects) {
                if (blockedEffectIds.has(effect.id)) {
                  yield* markRollbackFifoReview(effect.transactionId)
                }
              }
            }
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

  const applyDeterministicInternalTransferCanonicalization: TransferReconciliationRepositoryShape["applyDeterministicInternalTransferCanonicalization"] =
    ({ principalId, sourceId, reconciliationId }) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const now = nowDate()

            const loadEligibleReconciliations = () =>
              tx
                .select({
                  reconciliationId: schema.transferReconciliations.id,
                  reconciliationStatus: schema.transferReconciliations.status,
                  reviewMetadata: schema.transferReconciliations.reviewMetadata,
                  providerTransferId: schema.providerTransfers.id,
                  providerTransferSourceId: schema.providerTransfers.sourceId,
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
                    sql`${schema.transferReconciliations.canonicalTransactionId} is not null`,
                    inArray(schema.providerTransfers.processingMode, [
                      "accounting_and_evidence",
                      "accounting_only",
                    ])
                  )
                )
                .orderBy(asc(schema.providerTransfers.timestamp))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.selectEligibleReconciliations"
                  )
                )

            type EligibleReconciliationRow = Effect.Success<
              ReturnType<typeof loadEligibleReconciliations>
            >[number]

            const stillHasOneExactMovementCandidate = (row: EligibleReconciliationRow) =>
              Effect.gen(function* () {
                const metadata = yield* Schema.decodeUnknownEffect(
                  AutomaticRevalidationMetadataSchema
                )(row.reviewMetadata).pipe(
                  Effect.orElseSucceed(() => ({ revalidateMovementFacts: undefined }))
                )
                if (
                  row.reconciliationStatus === "approved" ||
                  metadata.revalidateMovementFacts !== true
                ) {
                  return true
                }

                const walletAddress =
                  row.providerDirection === "outbound"
                    ? row.providerToAddress
                    : row.providerFromAddress
                if (walletAddress === null && row.providerNetworkHash === null) {
                  return false
                }

                const candidates = yield* findOnchainTransferCandidatesWithExecutor({
                  executor: tx,
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
                  if (BigDecimal.equals(providerAmount, candidateAmount)) {
                    exactCandidates.push(candidate)
                  }
                }

                const [candidate] = exactCandidates
                const movementFactsStillMatch =
                  exactCandidates.length === 1 && candidate?.transferId === row.canonicalTransferId
                return (
                  movementFactsStillMatch &&
                  candidate !== undefined &&
                  candidate.providerAssetMappingStatus === "approved" &&
                  candidate.assetId === row.assetId &&
                  candidate.assetRepresentationId === row.assetRepresentationId
                )
              })

            const selectRequestedReconciliations = (
              rows: ReadonlyArray<EligibleReconciliationRow>
            ) =>
              rows.filter(
                (row) =>
                  row.providerTransferSourceId === sourceId &&
                  (reconciliationId === undefined || row.reconciliationId === reconciliationId)
              )

            const originSourceIdForReconciliation = (row: EligibleReconciliationRow) =>
              row.providerDirection === "outbound"
                ? row.providerTransactionSourceId
                : row.canonicalTransactionSourceId

            const destinationSourceIdForReconciliation = (row: EligibleReconciliationRow) =>
              row.providerDirection === "outbound"
                ? row.canonicalTransactionSourceId
                : row.providerTransactionSourceId

            const selectConnectedReconciliations = ({
              eligibleRows,
              requestedRows,
            }: {
              readonly eligibleRows: ReadonlyArray<EligibleReconciliationRow>
              readonly requestedRows: ReadonlyArray<EligibleReconciliationRow>
            }) => {
              const connectedRows = [...requestedRows]
              const connectedIds = new Set(requestedRows.map((row) => row.reconciliationId))

              for (let index = 0; index < connectedRows.length; index += 1) {
                const connectedRow = connectedRows[index]
                if (connectedRow === undefined) {
                  continue
                }
                for (const row of eligibleRows) {
                  const isDownstream =
                    originSourceIdForReconciliation(row) ===
                      destinationSourceIdForReconciliation(connectedRow) &&
                    row.providerTimestamp.getTime() >= connectedRow.providerTimestamp.getTime()
                  const isUpstream =
                    destinationSourceIdForReconciliation(row) ===
                      originSourceIdForReconciliation(connectedRow) &&
                    row.providerTimestamp.getTime() <= connectedRow.providerTimestamp.getTime()
                  if (connectedIds.has(row.reconciliationId) || (!isDownstream && !isUpstream)) {
                    continue
                  }

                  connectedIds.add(row.reconciliationId)
                  connectedRows.push(row)
                }
              }

              const remainingRows = [...connectedRows]
              const orderedRows: Array<EligibleReconciliationRow> = []
              while (remainingRows.length > 0) {
                const readyRows = remainingRows.filter(
                  (row) =>
                    !remainingRows.some(
                      (possiblePredecessor) =>
                        possiblePredecessor.reconciliationId !== row.reconciliationId &&
                        destinationSourceIdForReconciliation(possiblePredecessor) ===
                          originSourceIdForReconciliation(row) &&
                        possiblePredecessor.providerTimestamp.getTime() <=
                          row.providerTimestamp.getTime()
                    )
                )
                const candidates = readyRows.length === 0 ? remainingRows : readyRows
                candidates.sort(
                  (left, right) =>
                    left.providerTimestamp.getTime() - right.providerTimestamp.getTime() ||
                    left.reconciliationId.localeCompare(right.reconciliationId)
                )
                const nextRow = candidates[0]
                if (nextRow === undefined) {
                  break
                }
                orderedRows.push(nextRow)
                remainingRows.splice(
                  remainingRows.findIndex(
                    (row) => row.reconciliationId === nextRow.reconciliationId
                  ),
                  1
                )
              }

              return orderedRows
            }

            // Recovery may invalidate and replay later transfers from the destination source.
            // Discover that reachable chain before locking so every affected source is locked in
            // the same deterministic order.
            const eligibleReconciliationsBeforeLock = yield* loadEligibleReconciliations()
            const reconciliationsBeforeLock = selectRequestedReconciliations(
              eligibleReconciliationsBeforeLock
            )
            const connectedReconciliationsBeforeLock =
              reconciliationId === undefined
                ? selectConnectedReconciliations({
                    eligibleRows: eligibleReconciliationsBeforeLock,
                    requestedRows: reconciliationsBeforeLock,
                  })
                : reconciliationsBeforeLock
            yield* lockNetworkMovements({
              executor: tx,
              principalId,
              movements: connectedReconciliationsBeforeLock.map((reconciliation) => ({
                networkName: reconciliation.providerNetworkName,
                networkHash: reconciliation.providerNetworkHash,
              })),
              operation:
                "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockNetworkMovement",
            })
            const inventorySourceIds = [
              ...new Set([
                sourceId,
                ...connectedReconciliationsBeforeLock.flatMap((reconciliation) => [
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
              return yield* new SyncEngineStorageError({
                operation:
                  "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockSourceInventory",
                cause: "Internal transfer sources are not owned by the reconciliation principal",
              })
            }

            // The initial read only discovers which source rows must be locked. Replay or
            // normalization may have changed the joined transactions while this transaction
            // waited, so all canonicalization decisions use a fresh read under those locks.
            const eligibleReconciliations = yield* loadEligibleReconciliations()
            const reconciliations = selectRequestedReconciliations(eligibleReconciliations)
            const connectedReconciliations =
              reconciliationId === undefined
                ? selectConnectedReconciliations({
                    eligibleRows: eligibleReconciliations,
                    requestedRows: reconciliations,
                  })
                : reconciliations
            const lockedSourceIdSet = new Set(lockedSources.map(({ id }) => id))
            const hasUnlockedReconciliationSource = connectedReconciliations.some(
              (reconciliation) =>
                !lockedSourceIdSet.has(reconciliation.providerTransactionSourceId) ||
                !lockedSourceIdSet.has(reconciliation.canonicalTransactionSourceId)
            )

            if (hasUnlockedReconciliationSource) {
              return yield* new SyncEngineStorageError({
                operation:
                  "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.lockSourceInventory",
                cause:
                  "Internal transfer reconciliation state changed while source locks were acquired",
              })
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
                  return yield* new SyncEngineStorageError({
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.removeUnusedInboundProviderLot.dependentUsage",
                    cause: `Cannot remove inbound provider lot ${existingLot.id} because later inventory usage depends on it`,
                  })
                }
              })

            const roundFiatAmount = (value: BigDecimal.BigDecimal) =>
              BigDecimal.format(BigDecimal.round(value, { scale: 8 }))

            const loadPrincipalLegs = ({
              transactionId,
              assetId,
              amount,
              kind,
              sourceTransferId,
            }: {
              readonly transactionId: string
              readonly assetId: string
              readonly amount: string
              readonly kind: "acquisition" | "disposal"
              readonly sourceTransferId: string | null
            }) =>
              tx
                .select({
                  id: schema.transactionLegs.id,
                  kind: schema.transactionLegs.kind,
                  derivationRule: schema.transactionLegs.derivationRule,
                  externalId: schema.transactionLegs.externalId,
                  assetId: schema.transactionLegs.assetId,
                  amount: schema.transactionLegs.amount,
                  sourceTransferId: schema.transactionLegs.sourceTransferId,
                  providerTransferId: sql<string | null>`
                    ${schema.transactionLegs.metadata}->'reconciliation'->>'providerTransferId'
                  `,
                  custodyProviderTransferId: sql<string | null>`
                    ${schema.transactionLegs.metadata}->'reconciliation'->>'custodyProviderTransferId'
                  `,
                  dispositionSource: sql<"custody_allocations" | "open_lots" | null>`
                    ${schema.transactionLegs.metadata}->'reconciliation'->>'dispositionSource'
                  `,
                })
                .from(schema.transactionLegs)
                .where(
                  and(
                    eq(schema.transactionLegs.transactionId, transactionId),
                    eq(schema.transactionLegs.assetId, assetId),
                    eq(schema.transactionLegs.amount, amount),
                    eq(schema.transactionLegs.kind, kind),
                    sql`${schema.transactionLegs.sourceTransferId} is not distinct from ${sourceTransferId}`
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
                  costBasisStatus: schema.fifoLots.costBasisStatus,
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

            const { clearLegs: clearPrincipalLegs } = makeReconciliationEffectMutations(tx)

            const canClearPrincipalLegs = ({
              legs,
            }: {
              readonly legs: ReadonlyArray<{
                readonly id: string
                readonly kind: string
                readonly providerTransferId: string | null
                readonly custodyProviderTransferId: string | null
                readonly dispositionSource: "custody_allocations" | "open_lots" | null
              }>
            }) =>
              Effect.gen(function* () {
                for (const leg of legs) {
                  if (leg.kind === "acquisition" || leg.kind === "income") {
                    const [dependent] = yield* loadDependentUsageCount(leg.id)
                    if (
                      (dependent?.disposalMatchCount ?? 0) > 0 ||
                      (dependent?.custodyAllocationCount ?? 0) > 0
                    ) {
                      return false
                    }
                  }
                }

                return true
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
                  costBasisStatus: schema.fifoLots.costBasisStatus,
                })
                .from(schema.fifoLots)
                .innerJoin(
                  schema.transactionLegs,
                  eq(schema.transactionLegs.id, schema.fifoLots.sourceLegId)
                )
                .where(
                  and(
                    eq(schema.fifoLots.principalId, lotPrincipalId),
                    eq(schema.fifoLots.sourceId, sourceId),
                    eq(schema.fifoLots.assetId, assetId),
                    sql`${schema.fifoLots.sourceLegId} is not null`,
                    gt(schema.fifoLots.remainingAmount, "0"),
                    lte(schema.fifoLots.acquiredAt, maxAcquiredAt),
                    lte(schema.transactionLegs.timestamp, maxAcquiredAt)
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
                const [originLegMetadata] = yield* tx
                  .select({
                    dispositionSource: sql<"custody_allocations" | "open_lots" | null>`
                      ${schema.transactionLegs.metadata}->'reconciliation'->>'dispositionSource'
                    `,
                  })
                  .from(schema.transactionLegs)
                  .where(eq(schema.transactionLegs.id, originLegId))
                  .limit(1)

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
                          costBasisStatus: schema.fifoLots.costBasisStatus,
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
                      return yield* new SyncEngineStorageError({
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.existingCurrency",
                        cause:
                          "Internal transfer disposal matches use multiple cost basis currencies",
                      })
                    }
                  }

                  return {
                    dispositionSource: originLegMetadata?.dispositionSource ?? "open_lots",
                    matches: existingMatches,
                    fiatAmount: roundFiatAmount(totalCostBasis),
                    fiatCurrency,
                  }
                }

                if (custodyAllocations.length > 0) {
                  const custodyMovementId = custodyAllocations[0]?.movementId
                  if (custodyMovementId === undefined) {
                    return yield* new SyncEngineStorageError({
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyMovementId",
                      cause: "Custody allocation is missing its movement",
                    })
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
                      return yield* new SyncEngineStorageError({
                        operation:
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyCurrency",
                        cause: "Custody movement allocations use multiple cost basis currencies",
                      })
                    }

                    allocations.push({
                      fifoLotId: allocation.fifoLotId,
                      matchedAmount: BigDecimal.format(matchedAmount),
                      costBasis: roundFiatAmount(costBasis),
                      acquiredAt: allocation.acquiredAt,
                      costBasisPerToken: allocation.costBasisPerToken,
                      costBasisCurrency: allocation.costBasisCurrency,
                      costBasisStatus: allocation.costBasisStatus,
                    })
                    totalCostBasis = BigDecimal.sum(totalCostBasis, costBasis)
                    remainingToMove = BigDecimal.subtract(remainingToMove, matchedAmount)
                  }

                  if (!BigDecimal.isZero(remainingToMove)) {
                    return yield* new SyncEngineStorageError({
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.custodyAmountMismatch",
                      cause: `Custody allocations differ from internal transfer amount by ${BigDecimal.format(remainingToMove)}`,
                    })
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
                    dispositionSource: "custody_allocations" as const,
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
                const allocations: Array<
                  (typeof existingMatches)[number] & { readonly remainingAmount: string }
                > = []

                for (const lot of availableLots) {
                  if (!BigDecimal.isGreaterThan(remainingToMove, BigDecimal.fromBigInt(0n))) {
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
                  const amountToMove = BigDecimal.isLessThanOrEqualTo(remainingToMove, lotRemaining)
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
                    return yield* new SyncEngineStorageError({
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.newCurrency",
                      cause: "Internal transfer source lots use multiple cost basis currencies",
                    })
                  }

                  allocations.push({
                    fifoLotId: lot.id,
                    matchedAmount: BigDecimal.format(amountToMove),
                    costBasis: roundFiatAmount(costBasis),
                    acquiredAt: lot.acquiredAt,
                    costBasisPerToken: lot.costBasisPerToken,
                    costBasisCurrency: lot.costBasisCurrency,
                    costBasisStatus: lot.costBasisStatus,
                    remainingAmount: BigDecimal.format(updatedRemainingAmount),
                  })
                  totalCostBasis = BigDecimal.sum(totalCostBasis, costBasis)
                  remainingToMove = BigDecimal.subtract(remainingToMove, amountToMove)
                }

                if (BigDecimal.isGreaterThan(remainingToMove, BigDecimal.fromBigInt(0n))) {
                  return yield* new SyncEngineStorageError({
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.remainingAmount",
                    cause: `Insufficient FIFO inventory for internal transfer amount ${BigDecimal.format(remainingToMove)}`,
                  })
                }

                yield* Effect.forEach(allocations, (allocation) =>
                  Effect.gen(function* () {
                    yield* tx
                      .update(schema.fifoLots)
                      .set({
                        remainingAmount: allocation.remainingAmount,
                        updatedAt: nowDate(),
                      })
                      .where(eq(schema.fifoLots.id, allocation.fifoLotId))
                      .pipe(
                        wrapSyncEngineSqlError(
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.updateSourceLot"
                        )
                      )

                    yield* tx
                      .insert(schema.disposalMatches)
                      .values({
                        disposalLegId: originLegId,
                        fifoLotId: allocation.fifoLotId,
                        matchedAmount: allocation.matchedAmount,
                        // Internal transfers carry basis forward without realizing gain/loss.
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
                          "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition.insertMatch"
                        )
                      )
                  })
                )

                return {
                  dispositionSource: "open_lots" as const,
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

            const hasFifoInventoryReview = sql`
              ${schema.transactionReviews.needsReview} = true
              and cast(${FIFO_INVENTORY_REVIEW_LAYER} as text) = any(
                string_to_array(coalesce(${schema.transactionReviews.matchedLayer}, ''), ',')
              )
            `
            const hasUnresolvedNonFifoReviewLayer = sql`
              ${schema.transactionReviews.needsReview} = true
              and exists (
                select 1
                from unnest(
                  string_to_array(coalesce(${schema.transactionReviews.matchedLayer}, ''), ',')
                ) as review_layers(layer)
                where btrim(review_layers.layer) not in (
                  '',
                  cast(${FIFO_INVENTORY_REVIEW_LAYER} as text),
                  'transfer_reconciliation'
                )
              )
            `

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
                    when ${hasUnresolvedNonFifoReviewLayer}
                      then ${schema.transactionReviews.reviewStatus}
                    else 'auto_applied'
                  end`,
                    originalTypeKey: "internal_transfer",
                    originalConfidence: "1.00",
                    currentTypeKey: sql`case
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      or ${hasUnresolvedNonFifoReviewLayer}
                      then ${schema.transactionReviews.currentTypeKey}
                    else 'internal_transfer'
                  end`,
                    categorizationReason: sql`case
                    when ${hasFifoInventoryReview} or ${hasUnresolvedNonFifoReviewLayer}
                      then case
                        when strpos(
                          coalesce(${schema.transactionReviews.categorizationReason}, ''),
                          cast(${INTERNAL_TRANSFER_REASON} as text)
                        ) > 0
                          then ${schema.transactionReviews.categorizationReason}
                        when coalesce(${schema.transactionReviews.categorizationReason}, '') = ''
                          then cast(${INTERNAL_TRANSFER_REASON} as text)
                        else ${schema.transactionReviews.categorizationReason}
                          || E'\n'
                          || cast(${INTERNAL_TRANSFER_REASON} as text)
                      end
                    else cast(${INTERNAL_TRANSFER_REASON} as text)
                  end`,
                    matchedLayer: sql`case
                    when ${hasFifoInventoryReview} or ${hasUnresolvedNonFifoReviewLayer}
                      then case
                        when 'transfer_reconciliation' = any(
                          string_to_array(
                            coalesce(${schema.transactionReviews.matchedLayer}, ''),
                            ','
                          )
                        )
                          then ${schema.transactionReviews.matchedLayer}
                        else concat_ws(
                          ',',
                          nullif(${schema.transactionReviews.matchedLayer}, ''),
                          'transfer_reconciliation'
                        )
                      end
                    else 'transfer_reconciliation'
                  end`,
                    needsReview: sql`case
                    when ${hasFifoInventoryReview} or ${hasUnresolvedNonFifoReviewLayer}
                      then true
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      then ${schema.transactionReviews.needsReview}
                    else false
                  end`,
                    userNotes: schema.transactionReviews.userNotes,
                    reviewedAt: sql`case
                    when ${hasFifoInventoryReview} or ${hasUnresolvedNonFifoReviewLayer}
                      or ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
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
              assetRepresentationId,
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
              readonly assetRepresentationId: string | null
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
                    assetRepresentationId,
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
                      assetRepresentationId: sql.raw("excluded.asset_representation_id"),
                      amount: sql.raw("excluded.amount"),
                      kind: sql.raw("excluded.kind"),
                      provenance: sql.raw("excluded.provenance"),
                      derivationRule: sql.raw("excluded.derivation_rule"),
                      metadata: sql`coalesce(${schema.transactionLegs.metadata}, '{}'::jsonb) || excluded.metadata`,
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
              assetRepresentationId,
              destinationSourceId,
              destinationLegId,
              disposition,
            }: {
              readonly originLegId: string
              readonly assetId: string
              readonly assetRepresentationId: string | null
              readonly destinationSourceId: string
              readonly destinationLegId: string
              readonly disposition: {
                readonly matches: ReadonlyArray<{
                  readonly fifoLotId: string
                  readonly matchedAmount: unknown
                  readonly acquiredAt: Date
                  readonly costBasisPerToken: unknown
                  readonly costBasisCurrency: string
                  readonly costBasisStatus: "known" | "pending_review"
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
                  .select({
                    id: schema.fifoLots.id,
                    sourceLegSequence: schema.fifoLots.sourceLegSequence,
                  })
                  .from(schema.fifoLots)
                  .where(eq(schema.fifoLots.sourceLegId, destinationLegId))
                  .orderBy(asc(schema.fifoLots.sourceLegSequence))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.findExistingLots"
                    )
                  )

                if (existingLots.length > 0) {
                  yield* Effect.forEach(
                    existingLots,
                    (existingLot) => {
                      const match = disposition.matches[existingLot.sourceLegSequence]
                      if (match === undefined) {
                        return Effect.fail(
                          new SyncEngineStorageError({
                            operation:
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.matchExistingLot",
                            cause: {
                              destinationLegId,
                              sourceLegSequence: existingLot.sourceLegSequence,
                              message: "Existing carried lot has no matching source disposition.",
                            },
                          })
                        )
                      }

                      return tx
                        .update(schema.fifoLots)
                        .set({
                          assetId,
                          assetRepresentationId,
                          costBasisStatus: match.costBasisStatus,
                          updatedAt: nowDate(),
                        })
                        .where(eq(schema.fifoLots.id, existingLot.id))
                        .pipe(
                          wrapSyncEngineSqlError(
                            "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.moveLotsForInternalTransfer.updateExistingLot"
                          )
                        )
                    },
                    { concurrency: 1, discard: true }
                  )
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
                      assetRepresentationId,
                      acquiredAt: match.acquiredAt,
                      originalAmount: matchedAmount,
                      remainingAmount: matchedAmount,
                      costBasisPerToken,
                      costBasisCurrency: match.costBasisCurrency,
                      costBasisStatus: match.costBasisStatus,
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
                    providerTransferId: schema.inventoryMovements.providerTransferId,
                    purpose: schema.inventoryMovements.purpose,
                    reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
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
                  if (
                    movement.reconciliationStatus === "matched" ||
                    allocatedMovementIds.has(movement.id)
                  ) {
                    continue
                  }

                  if (movement.purpose === "principal" && movement.providerTransferId !== null) {
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
                        (leg) =>
                          leg.assetId === movement.assetId && matchedDisposalLegIds.has(leg.id)
                      ),
                      (leg) =>
                        Effect.gen(function* () {
                          const disposalAmount = yield* decodeBigDecimal({
                            value: yield* formatDecimal({
                              value: leg.amount,
                              operation:
                                "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.disposalAmount",
                            }),
                            operation:
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.hasUnmatchedFifoEffects.disposalAmount",
                          })
                          return BigDecimal.equals(disposalAmount, movementAmount)
                        })
                    )

                    if (matchingDisposalResults.some(Boolean)) {
                      continue
                    }
                  }

                  return true
                }

                return false
              })

            const clearResolvedFifoReview = ({
              transactionId,
            }: {
              readonly transactionId: string
            }) =>
              Effect.gen(function* () {
                if (
                  yield* hasUnmatchedFifoEffects({
                    transactionId,
                  })
                ) {
                  return
                }

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
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.clearResolvedFifoReview.loadReview"
                    )
                  )

                if (review === undefined) {
                  return
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
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.clearResolvedFifoReview.deleteFifoOnlyReview"
                      )
                    )
                  return
                }

                yield* tx
                  .update(schema.transactionReviews)
                  .set({
                    categorizationReason:
                      remainingReasons.length === 0 ? null : remainingReasons.join("\n"),
                    matchedLayer: remainingLayers.length === 0 ? null : remainingLayers.join(","),
                    needsReview: review.reviewStatus === "needs_review",
                    updatedAt: nowDate(),
                  })
                  .where(eq(schema.transactionReviews.transactionId, transactionId))
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.clearResolvedFifoReview.clearFifoSegment"
                    )
                  )
              })

            type ReconciliationRow = (typeof connectedReconciliations)[number]

            const resolveReconciliationTransactions = ({
              canonicalTransactionId,
              row,
            }: {
              readonly canonicalTransactionId: string
              readonly row: ReconciliationRow
            }) => {
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

              return { destinationTransaction, originTransaction }
            }

            const loadCustodyProviderTransferId = ({
              originTransactionId,
              row,
            }: {
              readonly originTransactionId: string
              readonly row: ReconciliationRow
            }) =>
              row.providerDirection === "outbound"
                ? Effect.succeed(row.providerTransferId)
                : tx
                    .select({
                      providerTransferId: schema.inventoryMovements.providerTransferId,
                    })
                    .from(schema.inventoryMovements)
                    .innerJoin(
                      schema.providerTransfers,
                      eq(schema.providerTransfers.id, schema.inventoryMovements.providerTransferId)
                    )
                    .where(
                      and(
                        eq(schema.inventoryMovements.transactionId, originTransactionId),
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

            const FIFO_REBUILD_REASON =
              "fifo_inventory: Review required because a later internal transfer must be rebuilt after earlier FIFO effects changed."

            const markInternalTransferForFifoRebuild = ({
              transactionId,
            }: {
              readonly transactionId: string
            }) =>
              tx
                .update(schema.transactionReviews)
                .set({
                  reviewStatus: sql`case
                    when ${schema.transactionReviews.reviewStatus} in ('approved', 'changed')
                      then ${schema.transactionReviews.reviewStatus}
                    else 'needs_review'
                  end`,
                  categorizationReason: sql`case
                    when strpos(
                      coalesce(${schema.transactionReviews.categorizationReason}, ''),
                      cast(${FIFO_REBUILD_REASON} as text)
                    ) > 0
                      then ${schema.transactionReviews.categorizationReason}
                    when coalesce(${schema.transactionReviews.categorizationReason}, '') = ''
                      then cast(${FIFO_REBUILD_REASON} as text)
                    else ${schema.transactionReviews.categorizationReason}
                      || E'\n'
                      || cast(${FIFO_REBUILD_REASON} as text)
                  end`,
                  matchedLayer: sql`case
                    when cast(${FIFO_INVENTORY_REVIEW_LAYER} as text) = any(
                      string_to_array(coalesce(${schema.transactionReviews.matchedLayer}, ''), ',')
                    )
                      then ${schema.transactionReviews.matchedLayer}
                    else concat_ws(
                      ',',
                      nullif(${schema.transactionReviews.matchedLayer}, ''),
                      cast(${FIFO_INVENTORY_REVIEW_LAYER} as text)
                    )
                  end`,
                  needsReview: true,
                  updatedAt: nowDate(),
                })
                .where(eq(schema.transactionReviews.transactionId, transactionId))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.markInternalTransferForFifoRebuild"
                  ),
                  Effect.asVoid
                )

            const rebuildDestinationFifoEffects = ({
              affectedAssetId,
              affectedPrincipalId,
              destinationSourceId,
              fromTimestamp,
            }: {
              readonly affectedAssetId: string
              readonly affectedPrincipalId: string
              readonly destinationSourceId: string
              readonly fromTimestamp: Date
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
                      sql`${schema.transactionLegs.derivationRule} is distinct from 'internal_transfer_out'`,
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
                    providerTransferId: schema.inventoryMovements.providerTransferId,
                    purpose: schema.inventoryMovements.purpose,
                  })
                  .from(schema.inventoryMovements)
                  .where(
                    and(
                      eq(schema.inventoryMovements.sourceId, destinationSourceId),
                      eq(schema.inventoryMovements.direction, "outbound"),
                      ne(schema.inventoryMovements.reconciliationStatus, "matched")
                    )
                  )
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadMovements"
                    )
                  )

                const earliestAffectedTimestampByInventory = new Map<string, Date>([
                  [`${affectedPrincipalId}:${affectedAssetId}`, fromTimestamp],
                ])

                // A later canonical transfer may reserve inventory needed by an earlier reviewed
                // effect. Build each dependent transfer chain, verify that every destination lot
                // is used only by another planned transfer, then invalidate from the far end.
                type InvalidationPlan = {
                  readonly custodyProviderTransferId: string | null
                  readonly depth: number
                  readonly destinationLegs: Effect.Success<ReturnType<typeof loadPrincipalLegs>>
                  readonly destinationSourceId: string
                  readonly destinationTimestamp: Date
                  readonly inventoryKey: string
                  readonly originLegs: Effect.Success<ReturnType<typeof loadPrincipalLegs>>
                  readonly originTimestamp: Date
                  readonly originTransactionId: string
                  readonly row: ReconciliationRow
                }
                const loadInvalidationPlan = ({
                  depth,
                  inventoryKey,
                  row,
                }: {
                  readonly depth: number
                  readonly inventoryKey: string
                  readonly row: ReconciliationRow
                }) =>
                  Effect.gen(function* () {
                    if (row.canonicalTransactionId === null || row.canonicalTransferId === null) {
                      return null
                    }

                    const { destinationTransaction, originTransaction } =
                      resolveReconciliationTransactions({
                        canonicalTransactionId: row.canonicalTransactionId,
                        row,
                      })
                    const amount = yield* formatDecimal({
                      value: row.amount,
                      operation:
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.downstreamAmount",
                    })
                    const originExternalId = `${originTransaction.externalId ?? originTransaction.id}:internal_transfer_out`
                    const destinationExternalId = `${destinationTransaction.externalId ?? destinationTransaction.id}:internal_transfer_in`
                    const originSourceTransferId =
                      originTransaction.id === row.canonicalTransactionId
                        ? row.canonicalTransferId
                        : null
                    const destinationSourceTransferId =
                      destinationTransaction.id === row.canonicalTransactionId
                        ? row.canonicalTransferId
                        : null
                    const originLegs = yield* loadPrincipalLegs({
                      transactionId: originTransaction.id,
                      assetId: row.assetId,
                      amount,
                      kind: "disposal",
                      sourceTransferId: originSourceTransferId,
                    })
                    const destinationLegs = yield* loadPrincipalLegs({
                      transactionId: destinationTransaction.id,
                      assetId: row.assetId,
                      amount,
                      kind: "acquisition",
                      sourceTransferId: destinationSourceTransferId,
                    })
                    const [originLeg] = originLegs
                    const [destinationLeg] = destinationLegs
                    const originIsCanonical =
                      originLeg !== undefined &&
                      originLegs.length === 1 &&
                      (yield* isExpectedPrincipalLeg({
                        leg: originLeg,
                        externalId: originExternalId,
                        kind: "disposal",
                        derivationRule: "internal_transfer_out",
                        assetId: row.assetId,
                        amount,
                        sourceTransferId: originSourceTransferId,
                      }))
                    const destinationIsCanonical =
                      destinationLeg !== undefined &&
                      destinationLegs.length === 1 &&
                      (yield* isExpectedPrincipalLeg({
                        leg: destinationLeg,
                        externalId: destinationExternalId,
                        kind: "acquisition",
                        derivationRule: "internal_transfer_in",
                        assetId: row.assetId,
                        amount,
                        sourceTransferId: destinationSourceTransferId,
                      }))

                    if (!originIsCanonical || !destinationIsCanonical) {
                      return null
                    }

                    return {
                      custodyProviderTransferId: yield* loadCustodyProviderTransferId({
                        originTransactionId: originTransaction.id,
                        row,
                      }),
                      depth,
                      destinationLegs,
                      destinationSourceId: destinationTransaction.sourceId,
                      destinationTimestamp: destinationTransaction.timestamp,
                      inventoryKey,
                      originLegs,
                      originTimestamp: originTransaction.timestamp,
                      originTransactionId: originTransaction.id,
                      row,
                    } satisfies InvalidationPlan
                  })

                const rootRowsByInventoryKey = new Map<string, ReconciliationRow[]>()
                for (const row of connectedReconciliations) {
                  if (row.canonicalTransactionId === null) {
                    continue
                  }
                  const { originTransaction } = resolveReconciliationTransactions({
                    canonicalTransactionId: row.canonicalTransactionId,
                    row,
                  })
                  if (originTransaction.sourceId !== destinationSourceId) {
                    continue
                  }

                  const inventoryKey = `${originTransaction.principalId}:${row.assetId}`
                  const cutoff = earliestAffectedTimestampByInventory.get(inventoryKey)
                  if (cutoff === undefined || originTransaction.timestamp < cutoff) {
                    continue
                  }

                  const roots = rootRowsByInventoryKey.get(inventoryKey) ?? []
                  roots.push(row)
                  rootRowsByInventoryKey.set(inventoryKey, roots)
                }

                const rebuildableReconciliations: InvalidationPlan[] = []
                const unrebuildableInventoryKeys = new Set<string>()

                for (const [inventoryKey, rootRows] of rootRowsByInventoryKey) {
                  const plans: InvalidationPlan[] = []
                  const plannedReconciliationIds = new Set<string>()
                  const pendingRows = rootRows.map((row) => ({ depth: 0, row }))

                  for (let index = 0; index < pendingRows.length; index += 1) {
                    const pending = pendingRows[index]
                    if (
                      pending === undefined ||
                      plannedReconciliationIds.has(pending.row.reconciliationId)
                    ) {
                      continue
                    }

                    const plan = yield* loadInvalidationPlan({
                      depth: pending.depth,
                      inventoryKey,
                      row: pending.row,
                    })
                    if (plan === null) {
                      continue
                    }

                    plannedReconciliationIds.add(plan.row.reconciliationId)
                    plans.push(plan)
                    for (const candidate of connectedReconciliations) {
                      if (
                        plannedReconciliationIds.has(candidate.reconciliationId) ||
                        candidate.assetId !== plan.row.assetId ||
                        originSourceIdForReconciliation(candidate) !== plan.destinationSourceId
                      ) {
                        continue
                      }

                      const candidateOriginTimestamp =
                        candidate.providerDirection === "outbound"
                          ? candidate.providerTransactionTimestamp
                          : candidate.canonicalTransactionTimestamp
                      if (candidateOriginTimestamp < plan.destinationTimestamp) {
                        continue
                      }

                      pendingRows.push({ depth: plan.depth + 1, row: candidate })
                    }
                  }

                  const plannedOriginLegIds = new Set(
                    plans.flatMap(({ originLegs }) => originLegs.map(({ id }) => id))
                  )
                  const destinationLegIds = plans.flatMap(({ destinationLegs }) =>
                    destinationLegs.map(({ id }) => id)
                  )
                  const dependentDisposals =
                    destinationLegIds.length === 0
                      ? []
                      : yield* tx
                          .select({ disposalLegId: schema.disposalMatches.disposalLegId })
                          .from(schema.disposalMatches)
                          .innerJoin(
                            schema.fifoLots,
                            eq(schema.fifoLots.id, schema.disposalMatches.fifoLotId)
                          )
                          .where(inArray(schema.fifoLots.sourceLegId, destinationLegIds))
                          .pipe(
                            wrapSyncEngineSqlError(
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadDependentTransferDisposals"
                            )
                          )
                  const dependentAllocations =
                    destinationLegIds.length === 0
                      ? []
                      : yield* tx
                          .select({ id: schema.inventoryMovementAllocations.id })
                          .from(schema.inventoryMovementAllocations)
                          .innerJoin(
                            schema.fifoLots,
                            eq(schema.fifoLots.id, schema.inventoryMovementAllocations.fifoLotId)
                          )
                          .where(inArray(schema.fifoLots.sourceLegId, destinationLegIds))
                          .limit(1)
                          .pipe(
                            wrapSyncEngineSqlError(
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.loadDependentTransferAllocations"
                            )
                          )
                  const hasUnplannedUsage =
                    dependentAllocations.length > 0 ||
                    dependentDisposals.some(
                      ({ disposalLegId }) => !plannedOriginLegIds.has(disposalLegId)
                    )

                  if (hasUnplannedUsage) {
                    unrebuildableInventoryKeys.add(inventoryKey)
                    continue
                  }

                  rebuildableReconciliations.push(...plans)
                }

                if (unrebuildableInventoryKeys.size > 0) {
                  return yield* new SyncEngineStorageError({
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildDestinationFifoEffects.unrebuildableDownstreamUsage",
                    cause: {
                      inventoryKeys: [...unrebuildableInventoryKeys].sort(),
                    },
                  })
                }

                const invalidationsInReverseDependencyOrder = [...rebuildableReconciliations].sort(
                  (left, right) =>
                    right.depth - left.depth ||
                    right.originTimestamp.getTime() - left.originTimestamp.getTime() ||
                    right.row.reconciliationId.localeCompare(left.row.reconciliationId)
                )

                for (const invalidated of invalidationsInReverseDependencyOrder) {
                  yield* clearPrincipalLegs({ legs: invalidated.originLegs })
                  yield* clearPrincipalLegs({ legs: invalidated.destinationLegs })
                  yield* markInternalTransferForFifoRebuild({
                    transactionId: invalidated.originTransactionId,
                  })
                }

                const disposalsToRebuild = allDisposals.filter((disposal) => {
                  const cutoff = earliestAffectedTimestampByInventory.get(
                    `${disposal.principalId}:${disposal.assetId}`
                  )
                  return cutoff !== undefined && disposal.timestamp >= cutoff
                })
                const movementsToRebuild = []
                for (const movement of allMovements) {
                  const cutoff = earliestAffectedTimestampByInventory.get(
                    `${movement.principalId}:${movement.assetId}`
                  )
                  if (cutoff === undefined || movement.timestamp < cutoff) {
                    continue
                  }

                  if (
                    movement.transactionLegId === null &&
                    movement.providerTransferId !== null &&
                    movement.purpose === "principal"
                  ) {
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

                const effects: ReadonlyArray<RebuildableFifoEffect> = [
                  ...disposalsToRebuild.map((disposal) => ({
                    kind: "disposal" as const,
                    sourceId: destinationSourceId,
                    ...disposal,
                  })),
                  ...movementsToRebuild.map((movement) => ({
                    kind: "movement" as const,
                    sourceId: destinationSourceId,
                    fiatAmount: null,
                    ...movement,
                  })),
                ]
                const { rebuildFifoEffects } = makeReconciliationEffectMutations(tx)
                const { blockedInventoryKeys } = yield* rebuildFifoEffects({
                  effects,
                  shortageMode: "preserve",
                })

                for (const { transactionId } of reviewedTransactions) {
                  const reviewedInventoryKeys = [
                    ...allDisposals.filter((disposal) => disposal.transactionId === transactionId),
                    ...allMovements.filter((movement) => movement.transactionId === transactionId),
                  ].map(({ principalId: effectPrincipalId, assetId }) => {
                    return `${destinationSourceId}:${effectPrincipalId}:${assetId}`
                  })

                  if (reviewedInventoryKeys.some((key) => blockedInventoryKeys.has(key))) {
                    continue
                  }

                  yield* clearResolvedFifoReview({ transactionId })
                }

                const invalidatedProviderTransferIds = [
                  ...new Set(
                    rebuildableReconciliations.flatMap(({ custodyProviderTransferId, row }) =>
                      custodyProviderTransferId === null ||
                      custodyProviderTransferId === row.providerTransferId
                        ? [row.providerTransferId]
                        : [row.providerTransferId, custodyProviderTransferId]
                    )
                  ),
                ]

                if (invalidatedProviderTransferIds.length > 0) {
                  yield* tx
                    .update(schema.inventoryMovements)
                    .set({
                      taxTreatment: "pending_review",
                      reconciliationStatus: "unmatched",
                      updatedAt: nowDate(),
                    })
                    .where(
                      inArray(
                        schema.inventoryMovements.providerTransferId,
                        invalidatedProviderTransferIds
                      )
                    )
                    .pipe(
                      wrapSyncEngineSqlError(
                        "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildReviewedDestinationFifoEffects.resetInvalidatedCustodyMovements"
                      )
                    )
                }

                return [...rebuildableReconciliations]
                  .sort(
                    (left, right) =>
                      left.depth - right.depth ||
                      left.originTimestamp.getTime() - right.originTimestamp.getTime() ||
                      left.row.reconciliationId.localeCompare(right.row.reconciliationId)
                  )
                  .map(({ row }) => row)
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
                  return { applied: false, invalidatedReconciliations: [] }
                }

                const { destinationTransaction, originTransaction } =
                  resolveReconciliationTransactions({ canonicalTransactionId, row })

                const manuallyReviewedTransactions = yield* tx
                  .select({
                    transactionId: schema.transactionReviews.transactionId,
                    reviewStatus: schema.transactionReviews.reviewStatus,
                  })
                  .from(schema.transactionReviews)
                  .where(
                    and(
                      inArray(schema.transactionReviews.transactionId, [
                        originTransaction.id,
                        destinationTransaction.id,
                      ]),
                      inArray(schema.transactionReviews.reviewStatus, ["approved", "changed"])
                    )
                  )
                  .for("update")
                  .pipe(
                    wrapSyncEngineSqlError(
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.applyPair.loadManualReviews"
                    )
                  )

                if (manuallyReviewedTransactions.length > 0) {
                  return yield* new SyncEngineStorageError({
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.applyPair.manualTransactionReview",
                    cause: {
                      providerTransferId: row.providerTransferId,
                      canonicalTransferId,
                      reviewedTransactions: manuallyReviewedTransactions,
                      message:
                        "Automatic canonicalization cannot replace manually reviewed accounting.",
                    },
                  })
                }

                const originExternalId = `${originTransaction.externalId ?? originTransaction.id}:internal_transfer_out`
                const destinationExternalId = `${destinationTransaction.externalId ?? destinationTransaction.id}:internal_transfer_in`
                const originSourceTransferId =
                  originTransaction.id === canonicalTransactionId ? canonicalTransferId : null
                const destinationSourceTransferId =
                  destinationTransaction.id === canonicalTransactionId ? canonicalTransferId : null
                const originAssetRepresentationId =
                  originTransaction.id === canonicalTransactionId ? row.assetRepresentationId : null
                const destinationAssetRepresentationId =
                  destinationTransaction.id === canonicalTransactionId
                    ? row.assetRepresentationId
                    : null

                const custodyProviderTransferId = yield* loadCustodyProviderTransferId({
                  originTransactionId: originTransaction.id,
                  row,
                })

                const originPrincipalLegs = yield* loadPrincipalLegs({
                  transactionId: originTransaction.id,
                  assetId: row.assetId,
                  amount,
                  kind: "disposal",
                  sourceTransferId: originSourceTransferId,
                })
                const destinationPrincipalLegs = yield* loadPrincipalLegs({
                  transactionId: destinationTransaction.id,
                  assetId: row.assetId,
                  amount,
                  kind: "acquisition",
                  sourceTransferId: destinationSourceTransferId,
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
                  return yield* new SyncEngineStorageError({
                    operation:
                      "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rebuildDestinationFifoEffects.unrebuildableDownstreamUsage",
                    cause: {
                      providerTransferId: row.providerTransferId,
                      canonicalTransferId,
                      canonicalTransactionId,
                      originAlreadyCanonical,
                      destinationAlreadyCanonical,
                      message:
                        "Dependent downstream usage prevents replacing the existing principal legs.",
                    },
                  })
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
                    when exists (
                      select 1
                      from ${schema.transactionReviews}
                      where ${schema.transactionReviews.transactionId} = ${schema.transactions.id}
                        and ${schema.transactionReviews.needsReview} = true
                        and exists (
                          select 1
                          from unnest(
                            string_to_array(
                              coalesce(${schema.transactionReviews.matchedLayer}, ''),
                              ','
                            )
                          ) as review_layer(layer)
                          where trim(review_layer.layer) not in (
                            '',
                            'fifo_inventory',
                            'transfer_reconciliation'
                          )
                        )
                    )
                      then ${schema.transactions.transactionType}
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
                  assetRepresentationId: originAssetRepresentationId,
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
                  assetRepresentationId: destinationAssetRepresentationId,
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
                  return { applied: false, invalidatedReconciliations: [] }
                }

                const disposition = yield* ensureInternalTransferDisposition({
                  originLegId,
                  custodyProviderTransferId,
                  principalId: originTransaction.principalId,
                  sourceId: originTransaction.sourceId,
                  assetId: row.assetId,
                  amount,
                  maxAcquiredAt: originTransaction.timestamp,
                })

                yield* tx
                  .update(schema.transactionLegs)
                  .set({
                    metadata:
                      custodyProviderTransferId === null
                        ? sql`jsonb_set(
                            coalesce(${schema.transactionLegs.metadata}, '{}'::jsonb),
                            '{reconciliation,dispositionSource}',
                            to_jsonb(${disposition.dispositionSource}::text),
                            true
                          )`
                        : sql`jsonb_set(
                            jsonb_set(
                              coalesce(${schema.transactionLegs.metadata}, '{}'::jsonb),
                              '{reconciliation,dispositionSource}',
                              to_jsonb(${disposition.dispositionSource}::text),
                              true
                            ),
                            '{reconciliation,custodyProviderTransferId}',
                            to_jsonb(${custodyProviderTransferId}::text),
                            true
                          )`,
                    updatedAt: nowDate(),
                  })
                  .where(eq(schema.transactionLegs.id, originLegId))

                yield* moveLotsForInternalTransfer({
                  originLegId,
                  assetId: row.assetId,
                  assetRepresentationId: destinationAssetRepresentationId,
                  destinationSourceId: destinationTransaction.sourceId,
                  destinationLegId,
                  disposition,
                })
                const invalidatedReconciliations = yield* rebuildDestinationFifoEffects({
                  affectedAssetId: row.assetId,
                  affectedPrincipalId: destinationTransaction.principalId,
                  destinationSourceId: destinationTransaction.sourceId,
                  fromTimestamp: destinationTransaction.timestamp,
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

                yield* clearResolvedFifoReview({
                  transactionId: originTransaction.id,
                })

                return { applied: true, invalidatedReconciliations }
              })

            // Invalidated downstream transfers are replayed after the current destination FIFO
            // suffix, and can in turn enqueue the next transfer in a longer chain.
            const requestedReconciliationIds = new Set(
              reconciliations.map((row) => row.reconciliationId)
            )
            const queuedReconciliationIds = new Set(
              connectedReconciliations.map((row) => row.reconciliationId)
            )
            const reconciliationQueue = connectedReconciliations.map((row) => ({
              countTowardSummary: requestedReconciliationIds.has(row.reconciliationId),
              row,
            }))
            let canonicalizedPairs = 0

            for (let index = 0; index < reconciliationQueue.length; index += 1) {
              const queued = reconciliationQueue[index]
              if (queued === undefined) {
                continue
              }

              if (!(yield* stillHasOneExactMovementCandidate(queued.row))) {
                const metadata = yield* Schema.decodeUnknownEffect(
                  Schema.Record(Schema.String, Schema.Unknown)
                )(queued.row.reviewMetadata).pipe(
                  Effect.orElseSucceed(() => ({ evidence: queued.row.reviewMetadata }))
                )
                yield* upsertTransferReconciliation({
                  principalId,
                  providerTransferId: queued.row.providerTransferId,
                  canonicalTransferId: null,
                  canonicalTransactionId: null,
                  status: "needs_review",
                  matchReason: "movement_facts_changed_before_canonicalization",
                  confidence: "0.0000",
                  deterministic: false,
                  reviewMetadata: {
                    ...metadata,
                    canonicalization: {
                      status: "blocked",
                      reason: "movement_facts_changed_before_canonicalization",
                    },
                  },
                })
                continue
              }

              yield* tx
                .execute(sql.raw("savepoint transfer_reconciliation_pair"))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.createPairSavepoint"
                  )
                )
              const result = yield* applyPair(queued.row).pipe(
                Effect.catchTag("SyncEngineStorageError", (error) => {
                  const unrebuildableDownstreamUsage = error.operation.endsWith(
                    ".rebuildDestinationFifoEffects.unrebuildableDownstreamUsage"
                  )
                  const dependentInboundProviderLotUsage = error.operation.endsWith(
                    ".removeUnusedInboundProviderLot.dependentUsage"
                  )
                  const manualTransactionReview = error.operation.endsWith(
                    ".applyPair.manualTransactionReview"
                  )
                  return error.operation.startsWith(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.ensureInternalTransferDisposition."
                  ) ||
                    unrebuildableDownstreamUsage ||
                    dependentInboundProviderLotUsage ||
                    manualTransactionReview
                    ? Effect.gen(function* () {
                        const reason = manualTransactionReview
                          ? "manual_transaction_review_preserved"
                          : unrebuildableDownstreamUsage || dependentInboundProviderLotUsage
                            ? "dependent_fifo_rebuild_blocked"
                            : error.operation.endsWith(".remainingAmount")
                              ? "insufficient_fifo_inventory"
                              : error.operation.endsWith(".custodyAmountMismatch")
                                ? "custody_allocation_amount_mismatch"
                                : error.operation.endsWith("Currency")
                                  ? "mixed_cost_basis_currency"
                                  : "fifo_canonicalization_failed"
                        yield* tx
                          .execute(sql.raw("rollback to savepoint transfer_reconciliation_pair"))
                          .pipe(
                            wrapSyncEngineSqlError(
                              "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.rollbackPairSavepoint"
                            )
                          )
                        const metadata = yield* Schema.decodeUnknownEffect(
                          Schema.Record(Schema.String, Schema.Unknown)
                        )(queued.row.reviewMetadata).pipe(
                          Effect.orElseSucceed(() => ({ evidence: queued.row.reviewMetadata }))
                        )
                        yield* tx
                          .update(schema.transferReconciliations)
                          .set({
                            status: "needs_review",
                            matchReason: reason,
                            confidence: "0.0000",
                            deterministic: false,
                            reviewMetadata: {
                              ...metadata,
                              canonicalization: {
                                status: "blocked",
                                reason,
                                details: String(error.cause),
                              },
                            },
                            updatedAt: nowDate(),
                          })
                          .where(eq(schema.transferReconciliations.id, queued.row.reconciliationId))
                        yield* Effect.logWarning(
                          {
                            providerTransferId: queued.row.providerTransferId,
                            reconciliationId: queued.row.reconciliationId,
                            reason,
                            details: String(error.cause),
                          },
                          "Rolled back one internal transfer canonicalization pair"
                        )
                        return { applied: false, invalidatedReconciliations: [] }
                      })
                    : Effect.fail(error)
                })
              )
              yield* tx
                .execute(sql.raw("release savepoint transfer_reconciliation_pair"))
                .pipe(
                  wrapSyncEngineSqlError(
                    "transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization.releasePairSavepoint"
                  )
                )
              if (queued.countTowardSummary && result.applied) {
                canonicalizedPairs += 1
              }

              for (const invalidated of result.invalidatedReconciliations) {
                if (queuedReconciliationIds.has(invalidated.reconciliationId)) {
                  continue
                }

                queuedReconciliationIds.add(invalidated.reconciliationId)
                reconciliationQueue.push({
                  countTowardSummary: false,
                  row: invalidated,
                })
              }
            }

            return {
              canonicalizedPairs,
            } satisfies DeterministicTransferCanonicalizationSummary
          })
        )
        .pipe(
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
