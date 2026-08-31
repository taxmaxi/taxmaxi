/**
 * TaxCalculationServiceLive - Active-run-backed source tax summaries.
 *
 * @module TaxCalculationServiceLive
 */

import { and, eq } from "drizzle-orm"
import { EUR } from "@my/core/currency"
import { withObservedOperation } from "@my/core/shared/observability/ObservedOperation"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import { SourceNotFoundError } from "@my/sync-engine/services"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  TaxCalculationIncompleteDataError,
  TaxCalculationService,
  UnsupportedJurisdictionError,
  type TaxCalculationServiceError,
  type TaxCalculationServiceShape,
} from "../services/TaxCalculationService.ts"
import { drizzle } from "./PgClientLive.ts"

const SUPPORTED_JURISDICTION = "germany"
const RUN_JURISDICTION = "DE"
const REPORTING_CURRENCY = EUR
const TAXABLE_TREATMENT = "de.taxable_private_disposal"
const TAX_FREE_TREATMENT = "de.tax_free_holding_period"
const taxCalculationOutcomeMetric = Metric.frequency("taxmaxi_tax_calculation_outcomes", {
  description: "Outcome frequencies for source-scoped tax calculations.",
})
const taxCalculationDurationMetric = Metric.timer("taxmaxi_tax_calculation_duration", {
  description: "Duration of successful source-scoped tax calculations.",
})

interface TaxSummaryTotals {
  readonly taxableGains: BigDecimal.BigDecimal
  readonly taxableLosses: BigDecimal.BigDecimal
  readonly taxFreeGains: BigDecimal.BigDecimal
  readonly incomeTotal: BigDecimal.BigDecimal
}

const zeroAmount = (): BigDecimal.BigDecimal => BigDecimal.fromBigInt(0n)

const emptyTotals = (): TaxSummaryTotals => ({
  taxableGains: zeroAmount(),
  taxableLosses: zeroAmount(),
  taxFreeGains: zeroAmount(),
  incomeTotal: zeroAmount(),
})

const decodeDecimal = ({
  value,
  operation,
}: {
  readonly value: unknown
  readonly operation: string
}) =>
  Schema.decodeUnknownEffect(Schema.BigDecimalFromString)(value).pipe(
    Effect.mapError(
      () =>
        new PersistenceError({
          operation,
          cause: `Invalid decimal value: ${String(value)}`,
        })
    )
  )

const normalizeTaxCalculationError = (error: unknown): TaxCalculationServiceError =>
  Schema.is(SourceNotFoundError)(error) ||
  Schema.is(UnsupportedJurisdictionError)(error) ||
  Schema.is(TaxCalculationIncompleteDataError)(error) ||
  Schema.is(PersistenceError)(error)
    ? error
    : new PersistenceError({
        operation: "taxCalculationService.calculateTax",
        cause: error,
      })

const recordTaxCalculationOutcome = ({
  jurisdiction,
  outcome,
}: {
  readonly jurisdiction: string
  readonly outcome: string
}) =>
  Metric.update(taxCalculationOutcomeMetric.pipe(Metric.withAttributes({ jurisdiction })), outcome)

const trackTaxCalculationDuration = ({ jurisdiction }: { readonly jurisdiction: string }) =>
  Effect.trackDuration(taxCalculationDurationMetric.pipe(Metric.withAttributes({ jurisdiction })))

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const loadActiveRun = ({
    sourceId,
    year,
  }: {
    readonly sourceId: string
    readonly year: number
  }) =>
    Effect.gen(function* () {
      const [source] = yield* db
        .select({ principalId: schema.sources.principalId })
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .limit(1)
        .pipe(wrapSqlError("taxCalculationService.loadActiveRun.source"))

      if (source === undefined) {
        return yield* new SourceNotFoundError({ sourceId })
      }

      const principalId = source.principalId

      const [run] = yield* db
        .select({
          runId: schema.calculationRuns.id,
          status: schema.calculationRuns.status,
        })
        .from(schema.activeCalculationRuns)
        .innerJoin(
          schema.calculationRuns,
          eq(schema.activeCalculationRuns.runId, schema.calculationRuns.id)
        )
        .innerJoin(
          schema.calculationRunCustodyUnitSources,
          and(
            eq(schema.calculationRunCustodyUnitSources.runId, schema.calculationRuns.id),
            eq(schema.calculationRunCustodyUnitSources.principalId, principalId),
            eq(schema.calculationRunCustodyUnitSources.sourceId, sourceId)
          )
        )
        .where(
          and(
            eq(schema.activeCalculationRuns.principalId, principalId),
            eq(schema.activeCalculationRuns.jurisdiction, RUN_JURISDICTION),
            eq(schema.activeCalculationRuns.taxYear, year),
            eq(schema.activeCalculationRuns.reportingCurrency, REPORTING_CURRENCY)
          )
        )
        .limit(1)
        .pipe(wrapSqlError("taxCalculationService.loadActiveRun.run"))

      if (run === undefined || (run.status !== "complete" && run.status !== "partial")) {
        return yield* new TaxCalculationIncompleteDataError({
          sourceId,
          field: "calculation run",
          reason: "no readable active calculation run contains this source",
        })
      }

      return run
    })

  const calculateTax: TaxCalculationServiceShape["calculateTax"] = ({
    sourceId,
    jurisdiction,
    year,
  }) =>
    Effect.gen(function* () {
      if (jurisdiction !== SUPPORTED_JURISDICTION) {
        return yield* new UnsupportedJurisdictionError({ jurisdiction })
      }

      const run = yield* loadActiveRun({ sourceId, year })
      const realizedRows = yield* db
        .select({
          gainLoss: schema.calculationRunRealizedResults.gainLoss,
          treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
        })
        .from(schema.calculationRunRealizedResults)
        .where(
          and(
            eq(schema.calculationRunRealizedResults.runId, run.runId),
            eq(schema.calculationRunRealizedResults.sourceId, sourceId)
          )
        )
        .pipe(wrapSqlError("taxCalculationService.calculateTax.realized"))
      const incomeRows = yield* db
        .select({ value: schema.calculationRunIncomeResults.value })
        .from(schema.calculationRunIncomeResults)
        .where(
          and(
            eq(schema.calculationRunIncomeResults.runId, run.runId),
            eq(schema.calculationRunIncomeResults.sourceId, sourceId)
          )
        )
        .pipe(wrapSqlError("taxCalculationService.calculateTax.income"))

      let totals = emptyTotals()
      for (const row of realizedRows) {
        const gainLoss = yield* decodeDecimal({
          value: row.gainLoss,
          operation: "taxCalculationService.calculateTax.gainLoss",
        })
        if (row.treatmentCodes.includes(TAX_FREE_TREATMENT)) {
          if (!BigDecimal.isNegative(gainLoss)) {
            totals = {
              ...totals,
              taxFreeGains: BigDecimal.sum(totals.taxFreeGains, gainLoss),
            }
          }
          continue
        }
        if (!row.treatmentCodes.includes(TAXABLE_TREATMENT)) {
          continue
        }
        totals = BigDecimal.isNegative(gainLoss)
          ? {
              ...totals,
              taxableLosses: BigDecimal.sum(totals.taxableLosses, BigDecimal.abs(gainLoss)),
            }
          : {
              ...totals,
              taxableGains: BigDecimal.sum(totals.taxableGains, gainLoss),
            }
      }
      for (const row of incomeRows) {
        const value = yield* decodeDecimal({
          value: row.value,
          operation: "taxCalculationService.calculateTax.incomeValue",
        })
        totals = { ...totals, incomeTotal: BigDecimal.sum(totals.incomeTotal, value) }
      }

      yield* recordTaxCalculationOutcome({ jurisdiction, outcome: "completed" })

      return {
        calculationRunId: run.runId,
        year,
        currency: REPORTING_CURRENCY,
        taxableGains: Number(BigDecimal.format(totals.taxableGains)),
        taxableLosses: Number(BigDecimal.format(totals.taxableLosses)),
        taxFreeGains: Number(BigDecimal.format(totals.taxFreeGains)),
        incomeTotal: Number(BigDecimal.format(totals.incomeTotal)),
      }
    }).pipe(
      withObservedOperation({
        name: "persistence.tax-calculation.calculate-tax",
        attributes: { sourceId, jurisdiction, year },
      }),
      trackTaxCalculationDuration({ jurisdiction }),
      Effect.mapError(normalizeTaxCalculationError),
      Effect.tapError((error) =>
        Effect.all(
          [
            recordTaxCalculationOutcome({ jurisdiction, outcome: error._tag }),
            Effect.logError({ sourceId, jurisdiction, year, error }, "tax-calculation:failed"),
          ],
          { discard: true }
        )
      )
    )

  return TaxCalculationService.of({ calculateTax })
})

/** Live active-run tax-calculation reader. */
export const TaxCalculationServiceLive = Layer.effect(TaxCalculationService, make)
