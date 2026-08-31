/**
 * CalculationRunRepositoryLive - Drizzle-backed write-once calculation runs.
 *
 * @module CalculationRunRepositoryLive
 */

import type { TaxAccountingResult } from "@my/accounting"
import { format as formatQuantity } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import { and, asc, eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  CalculationRunRepository,
  type CalculationRunRepositoryShape,
  type PersistCalculationRunParams,
} from "../services/CalculationRunRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const INSERT_BATCH_ROW_COUNT = 500

const writeBatches = <Row, Error, Requirements>(
  rows: ReadonlyArray<Row>,
  writeBatch: (batch: [Row, ...Array<Row>]) => Effect.Effect<unknown, Error, Requirements>
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += INSERT_BATCH_ROW_COUNT) {
      const first = rows[start]

      if (first !== undefined) {
        yield* writeBatch([first, ...rows.slice(start + 1, start + INSERT_BATCH_ROW_COUNT)])
      }
    }
  })

const resultCurrencies = (result: TaxAccountingResult): ReadonlyArray<CurrencyCode> => [
  ...result.allocations.flatMap(({ costBasis }) =>
    costBasis === null ? [] : [costBasis.currency]
  ),
  ...result.realizedResults.flatMap(({ costBasis, proceeds, gainLoss }) => [
    costBasis.currency,
    proceeds.currency,
    gainLoss.currency,
  ]),
  ...result.incomeResults.map(({ value }) => value.currency),
  ...result.derivedLots.flatMap(({ costBasisPerUnit }) =>
    costBasisPerUnit === null ? [] : [costBasisPerUnit.currency]
  ),
]

const validateReportingCurrency = ({
  id,
  reportingCurrency,
  result,
}: Pick<PersistCalculationRunParams, "id" | "reportingCurrency" | "result">) => {
  const mismatchedCurrency = resultCurrencies(result).find(
    (currency) => currency !== reportingCurrency
  )

  return mismatchedCurrency === undefined
    ? Effect.void
    : Effect.fail(
        new CalculationRunCurrencyMismatchError({
          runId: id,
          expected: reportingCurrency,
          actual: mismatchedCurrency,
        })
      )
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type CalculationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
  interface WriteContext {
    readonly tx: CalculationTransaction
    readonly params: PersistCalculationRunParams
    readonly result: TaxAccountingResult
    readonly startedAt: Date
  }

  const claimRun = ({ tx, params, result, startedAt }: WriteContext) =>
    Effect.gen(function* () {
      const claimedRuns = yield* tx
        .insert(schema.calculationRuns)
        .values({
          id: params.id,
          principalId: params.principalId,
          jurisdiction: result.jurisdiction,
          taxYear: result.taxYear,
          reportingCurrency: params.reportingCurrency,
          engineVersion: result.engineVersion,
          ruleSetVersion: result.ruleSetVersion,
          inputLedgerRevision: params.inputLedgerRevision,
          valuationRevision: params.valuationRevision,
          status: "pending",
          accountingMethod: null,
          inventoryScope: null,
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [],
          startedAt,
          completedAt: null,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .onConflictDoNothing({ target: schema.calculationRuns.id })
        .returning({ id: schema.calculationRuns.id })

      if (claimedRuns.length === 0) {
        return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
      }

      yield* validateReportingCurrency(params)
    })

  const snapshotCustodyMembership = ({ tx, params }: WriteContext) =>
    Effect.gen(function* () {
      const liveMembership = yield* tx
        .select({
          custodyUnitId: schema.custodyUnits.id,
          principalId: schema.custodyUnits.principalId,
          sourceId: schema.custodyUnitSources.sourceId,
        })
        .from(schema.custodyUnits)
        .leftJoin(
          schema.custodyUnitSources,
          and(
            eq(schema.custodyUnitSources.custodyUnitId, schema.custodyUnits.id),
            eq(schema.custodyUnitSources.principalId, schema.custodyUnits.principalId)
          )
        )
        .where(eq(schema.custodyUnits.principalId, params.principalId))
        .orderBy(asc(schema.custodyUnits.id), asc(schema.custodyUnitSources.sourceId))

      const custodyUnits = [
        ...new Map(
          liveMembership.map(({ custodyUnitId, principalId }) => [
            custodyUnitId,
            { runId: params.id, principalId, custodyUnitId },
          ])
        ).values(),
      ]
      const custodyUnitSources = liveMembership.flatMap(
        ({ custodyUnitId, principalId, sourceId }) =>
          sourceId === null ? [] : [{ runId: params.id, principalId, custodyUnitId, sourceId }]
      )

      yield* writeBatches(custodyUnits, (batch) =>
        tx.insert(schema.calculationRunCustodyUnits).values(batch)
      )
      yield* writeBatches(custodyUnitSources, (batch) =>
        tx.insert(schema.calculationRunCustodyUnitSources).values(batch)
      )
    })

  const writeAllocations = ({ tx, params, result }: WriteContext) => {
    const rows = result.allocations.map((allocation, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      acquisitionEventId: allocation.acquisitionEventId,
      dispositionEventId: allocation.dispositionEventId,
      assetId: allocation.assetId,
      custodyUnitId: allocation.custodyUnitId,
      acquiredAt: allocation.acquiredAt.toDate(),
      disposedAt: allocation.disposedAt.toDate(),
      quantity: formatQuantity(allocation.quantity),
      costBasis: allocation.costBasis?.format() ?? null,
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunAllocations).values(batch))
  }

  const writeRealizedResults = ({ tx, params, result }: WriteContext) => {
    const rows = result.realizedResults.map((realized, sequence) => ({
      runId: params.id,
      sequence,
      acquisitionEventId: realized.acquisitionEventId,
      dispositionEventId: realized.dispositionEventId,
      assetId: realized.assetId,
      acquiredAt: realized.acquiredAt.toDate(),
      disposedAt: realized.disposedAt.toDate(),
      quantity: formatQuantity(realized.quantity),
      costBasis: realized.costBasis.format(),
      proceeds: realized.proceeds.format(),
      gainLoss: realized.gainLoss.format(),
      treatmentCodes: realized.treatmentCodes,
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunRealizedResults).values(batch)
    )
  }

  const writeIncomeResults = ({ tx, params, result }: WriteContext) => {
    const rows = result.incomeResults.map((income, sequence) => ({
      runId: params.id,
      sequence,
      eventId: income.eventId,
      assetId: income.assetId,
      occurredAt: income.occurredAt.toDate(),
      quantity: formatQuantity(income.quantity),
      value: income.value.format(),
      treatmentCodes: income.treatmentCodes,
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunIncomeResults).values(batch)
    )
  }

  const writeDerivedLots = ({ tx, params, result }: WriteContext) => {
    const rows = result.derivedLots.map((lot, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      acquisitionEventId: lot.acquisitionEventId,
      assetId: lot.assetId,
      custodyUnitId: lot.custodyUnitId,
      acquiredAt: lot.acquiredAt.toDate(),
      remainingQuantity: formatQuantity(lot.remainingQuantity),
      costBasisPerUnit: lot.costBasisPerUnit?.format() ?? null,
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunDerivedLots).values(batch))
  }

  const writeBlockers = ({ tx, params, result }: WriteContext) => {
    const rows = result.blockers.map((blocker, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      code: blocker.code,
      eventId: blocker.eventId,
      assetId: blocker.assetId,
      custodyUnitId: blocker.custodyUnitId,
      missingQuantity:
        blocker.missingQuantity === null ? null : formatQuantity(blocker.missingQuantity),
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunBlockers).values(batch))
  }

  const writeExplanations = ({ tx, params, result }: WriteContext) => {
    const rows = result.explanationTrace.map((entry) => ({
      runId: params.id,
      sequence: entry.sequence,
      eventId: entry.eventId,
      code: entry.code,
      valuationKind: entry.valuationKind,
      matches: entry.matches.map((match) => ({
        acquisitionEventId: match.acquisitionEventId,
        quantity: formatQuantity(match.quantity),
      })),
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunExplanationEntries).values(batch)
    )
  }

  const finalizeRun = ({ tx, params, result }: WriteContext) =>
    Effect.gen(function* () {
      const completedAt = yield* DateTime.nowAsDate

      yield* tx
        .update(schema.calculationRuns)
        .set({
          status: result.status,
          accountingMethod: result.accountingMethod,
          inventoryScope: result.inventoryScope,
          appliedChoiceIds: result.appliedChoiceIds,
          appliedRules: result.appliedRules,
          processedEventIds: result.processedEventIds,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.calculationRuns.id, params.id))

      return completedAt
    })

  const activateRun = ({
    tx,
    params,
    result,
    completedAt,
  }: WriteContext & { readonly completedAt: Date }) =>
    tx
      .insert(schema.activeCalculationRuns)
      .values({
        principalId: params.principalId,
        jurisdiction: result.jurisdiction,
        taxYear: result.taxYear,
        reportingCurrency: params.reportingCurrency,
        runId: params.id,
        updatedAt: completedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.activeCalculationRuns.principalId,
          schema.activeCalculationRuns.jurisdiction,
          schema.activeCalculationRuns.taxYear,
          schema.activeCalculationRuns.reportingCurrency,
        ],
        set: { runId: params.id, updatedAt: completedAt },
      })

  const persist: CalculationRunRepositoryShape["persist"] = (params) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const startedAt = yield* DateTime.nowAsDate
          const { result } = params
          const context = { tx, params, result, startedAt }

          yield* claimRun(context)
          yield* snapshotCustodyMembership(context)
          yield* writeAllocations(context)
          yield* writeRealizedResults(context)
          yield* writeIncomeResults(context)
          yield* writeDerivedLots(context)
          yield* writeBlockers(context)
          yield* writeExplanations(context)
          const completedAt = yield* finalizeRun(context)
          yield* activateRun({ ...context, completedAt })
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error) ||
          Schema.is(CalculationRunCurrencyMismatchError)(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunRepository.persist",
                cause: error,
              })
        )
      )

  return CalculationRunRepository.of({ persist })
})

/** Live calculation-run repository backed by PostgreSQL. */
export const CalculationRunRepositoryLive = Layer.effect(CalculationRunRepository, make)
