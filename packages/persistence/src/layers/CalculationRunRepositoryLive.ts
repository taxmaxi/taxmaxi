/**
 * CalculationRunRepositoryLive - Drizzle-backed write-once calculation runs.
 *
 * @module CalculationRunRepositoryLive
 */

import type { TaxAccountingResult } from "@my/accounting"
import { format as formatQuantity } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import { asc, eq } from "drizzle-orm"
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

  const persist: CalculationRunRepositoryShape["persist"] = (params) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const now = yield* DateTime.nowAsDate
          const { result } = params

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
              status: result.status,
              accountingMethod: result.accountingMethod,
              inventoryScope: result.inventoryScope,
              appliedChoiceIds: result.appliedChoiceIds,
              appliedRules: result.appliedRules,
              processedEventIds: result.processedEventIds,
              startedAt: now,
              completedAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: schema.calculationRuns.id })
            .returning({ id: schema.calculationRuns.id })

          if (claimedRuns.length === 0) {
            return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
          }

          yield* validateReportingCurrency(params)

          const custodyUnits = yield* tx
            .select({
              custodyUnitId: schema.custodyUnits.id,
              principalId: schema.custodyUnits.principalId,
            })
            .from(schema.custodyUnits)
            .where(eq(schema.custodyUnits.principalId, params.principalId))
            .orderBy(asc(schema.custodyUnits.id))

          const custodyUnitSources = yield* tx
            .select({
              custodyUnitId: schema.custodyUnitSources.custodyUnitId,
              principalId: schema.custodyUnitSources.principalId,
              sourceId: schema.custodyUnitSources.sourceId,
            })
            .from(schema.custodyUnitSources)
            .where(eq(schema.custodyUnitSources.principalId, params.principalId))
            .orderBy(
              asc(schema.custodyUnitSources.custodyUnitId),
              asc(schema.custodyUnitSources.sourceId)
            )

          if (custodyUnits.length > 0) {
            yield* tx.insert(schema.calculationRunCustodyUnits).values(
              custodyUnits.map(({ custodyUnitId, principalId }) => ({
                runId: params.id,
                principalId,
                custodyUnitId,
              }))
            )
          }

          if (custodyUnitSources.length > 0) {
            yield* tx.insert(schema.calculationRunCustodyUnitSources).values(
              custodyUnitSources.map(({ custodyUnitId, principalId, sourceId }) => ({
                runId: params.id,
                principalId,
                custodyUnitId,
                sourceId,
              }))
            )
          }

          if (result.allocations.length > 0) {
            yield* tx.insert(schema.calculationRunAllocations).values(
              result.allocations.map((allocation, sequence) => ({
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
            )
          }

          if (result.realizedResults.length > 0) {
            yield* tx.insert(schema.calculationRunRealizedResults).values(
              result.realizedResults.map((realized, sequence) => ({
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
            )
          }

          if (result.incomeResults.length > 0) {
            yield* tx.insert(schema.calculationRunIncomeResults).values(
              result.incomeResults.map((income, sequence) => ({
                runId: params.id,
                sequence,
                eventId: income.eventId,
                assetId: income.assetId,
                occurredAt: income.occurredAt.toDate(),
                quantity: formatQuantity(income.quantity),
                value: income.value.format(),
                treatmentCodes: income.treatmentCodes,
              }))
            )
          }

          if (result.derivedLots.length > 0) {
            yield* tx.insert(schema.calculationRunDerivedLots).values(
              result.derivedLots.map((lot, sequence) => ({
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
            )
          }

          if (result.blockers.length > 0) {
            yield* tx.insert(schema.calculationRunBlockers).values(
              result.blockers.map((blocker, sequence) => ({
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
            )
          }

          if (result.explanationTrace.length > 0) {
            yield* tx.insert(schema.calculationRunExplanationEntries).values(
              result.explanationTrace.map((entry) => ({
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
            )
          }

          yield* tx
            .insert(schema.activeCalculationRuns)
            .values({
              principalId: params.principalId,
              jurisdiction: result.jurisdiction,
              taxYear: result.taxYear,
              reportingCurrency: params.reportingCurrency,
              runId: params.id,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                schema.activeCalculationRuns.principalId,
                schema.activeCalculationRuns.jurisdiction,
                schema.activeCalculationRuns.taxYear,
                schema.activeCalculationRuns.reportingCurrency,
              ],
              set: { runId: params.id, updatedAt: now },
            })
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
