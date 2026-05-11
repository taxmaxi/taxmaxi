/**
 * TaxCalculationServiceLive - Drizzle-backed tax summary aggregation.
 *
 * Validates that source-scoped tax inputs are complete and consistently valued
 * in the reporting currency before producing a deterministic yearly summary.
 *
 * @module TaxCalculationServiceLive
 */

import { and, eq, gte, lt } from "drizzle-orm"
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
  TaxCalculationUnsupportedCurrencyError,
  UnsupportedJurisdictionError,
  type TaxCalculationServiceError,
  type TaxCalculationServiceShape,
} from "../services/TaxCalculationService.ts"
import { drizzle } from "./PgClientLive.ts"

const HOLDING_PERIOD_YEARS = 1
const SUPPORTED_JURISDICTION = "germany"
const REPORTING_CURRENCY = EUR
const taxCalculationOutcomeMetric = Metric.frequency("taxmaxi_tax_calculation_outcomes", {
  description: "Outcome frequencies for source-scoped tax calculations.",
})
const taxCalculationDurationMetric = Metric.timer(
  "taxmaxi_tax_calculation_duration",
  "Duration of successful source-scoped tax calculations."
)

interface DisposalMatchRow {
  readonly disposalLegId: string
  readonly fifoLotId: string
  readonly gainLoss: unknown
  readonly acquiredAt: Date
  readonly disposedAt: Date
  readonly disposalCurrency: string | null
  readonly costBasisCurrency: string
}

interface IncomeLegRow {
  readonly legId: string
  readonly fiatAmount: unknown
  readonly fiatCurrency: string | null
}

interface TaxSummaryTotals {
  readonly taxableGains: BigDecimal.BigDecimal
  readonly taxableLosses: BigDecimal.BigDecimal
  readonly taxFreeGains: BigDecimal.BigDecimal
}

const zeroAmount = (): BigDecimal.BigDecimal => BigDecimal.fromBigInt(0n)

const emptyTotals = (): TaxSummaryTotals => ({
  taxableGains: zeroAmount(),
  taxableLosses: zeroAmount(),
  taxFreeGains: zeroAmount(),
})

const startOfYearUtc = (year: number): Date => new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0))

const endOfYearUtc = (year: number): Date => new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0))

const holdingPeriodEnd = (acquiredAt: Date): Date => {
  const end = new Date(acquiredAt.getTime())
  end.setUTCFullYear(end.getUTCFullYear() + HOLDING_PERIOD_YEARS)
  return end
}

const isTaxFreeDisposal = ({
  acquiredAt,
  disposedAt,
}: Pick<DisposalMatchRow, "acquiredAt" | "disposedAt">): boolean =>
  disposedAt.getTime() >= holdingPeriodEnd(acquiredAt).getTime()

const wrapTaxCalculationError =
  () =>
  <A, R>(
    effect: Effect.Effect<A, TaxCalculationServiceError, R>
  ): Effect.Effect<A, TaxCalculationServiceError, R> =>
    effect

const recordTaxCalculationOutcome = ({
  jurisdiction,
  outcome,
}: {
  readonly jurisdiction: string
  readonly outcome: string
}) =>
  Metric.update(
    taxCalculationOutcomeMetric.pipe(Metric.tagged("jurisdiction", jurisdiction)),
    outcome
  )

const trackTaxCalculationDuration = ({ jurisdiction }: { readonly jurisdiction: string }) =>
  Metric.trackDuration(
    taxCalculationDurationMetric.pipe(Metric.tagged("jurisdiction", jurisdiction))
  )

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectSourceFields = {
    id: schema.sources.id,
  } as const

  const selectDisposalMatchFields = {
    disposalLegId: schema.disposalMatches.disposalLegId,
    fifoLotId: schema.disposalMatches.fifoLotId,
    gainLoss: schema.disposalMatches.gainLoss,
    acquiredAt: schema.fifoLots.acquiredAt,
    disposedAt: schema.transactionLegs.timestamp,
    disposalCurrency: schema.transactionLegs.fiatCurrency,
    costBasisCurrency: schema.fifoLots.costBasisCurrency,
  } as const

  const selectIncomeLegFields = {
    legId: schema.transactionLegs.id,
    fiatAmount: schema.transactionLegs.fiatAmount,
    fiatCurrency: schema.transactionLegs.fiatCurrency,
  } as const

  /**
   * Decode a database numeric value into a BigDecimal.
   *
   * @param value - Raw database value
   * @param operation - Error context for persistence failures
   * @returns Parsed decimal value
   */
  const decodeDecimal = ({
    value,
    operation,
  }: {
    readonly value: unknown
    readonly operation: string
  }): Effect.Effect<BigDecimal.BigDecimal, PersistenceError> =>
    Schema.decodeUnknown(Schema.BigDecimal)(value).pipe(
      Effect.mapError(
        () =>
          new PersistenceError({
            operation,
            cause: `Invalid decimal value: ${String(value)}`,
          })
      )
    )

  /**
   * Convert an exact decimal total into the public numeric API shape.
   *
   * @param amount - Exact decimal total
   * @returns Numeric response value
   */
  const toResponseNumber = (amount: BigDecimal.BigDecimal): number =>
    Number(BigDecimal.format(amount))

  /**
   * Validate that a tax-visible amount is valued in the reporting currency.
   *
   * @param sourceId - Owning source identifier
   * @param field - Field description for actionable error messages
   * @param currency - Currency to validate
   * @returns The validated reporting currency
   */
  const ensureReportingCurrency = ({
    sourceId,
    field,
    currency,
  }: {
    readonly sourceId: string
    readonly field: string
    readonly currency: string | null
  }) =>
    Effect.gen(function* () {
      if (currency === null) {
        return yield* Effect.fail(
          new TaxCalculationIncompleteDataError({
            sourceId,
            field,
            reason: "missing fiat currency",
          })
        )
      }

      if (currency !== REPORTING_CURRENCY) {
        return yield* Effect.fail(
          new TaxCalculationUnsupportedCurrencyError({
            sourceId,
            field,
            expectedCurrency: REPORTING_CURRENCY,
            actualCurrency: currency,
          })
        )
      }

      return REPORTING_CURRENCY
    })

  /**
   * Load the source row to enforce the source-scoped contract.
   *
   * @param sourceId - Source identifier from the API path
   * @returns The matched source row
   */
  const loadSource = (sourceId: string) =>
    Effect.gen(function* () {
      const [source] = yield* db
        .select(selectSourceFields)
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .limit(1)
        .pipe(wrapSqlError("taxCalculationService.loadSource.select"))

      if (source === undefined) {
        return yield* Effect.fail(new SourceNotFoundError({ sourceId }))
      }

      return source
    }).pipe(
      withObservedOperation({
        name: "persistence.tax-calculation.load-source",
        attributes: { sourceId },
        kind: "client",
      })
    )

  /**
   * Load disposal matches that fall within the selected tax year.
   *
   * @param sourceId - Source identifier
   * @param yearStart - Inclusive UTC year start
   * @param yearEnd - Exclusive UTC year end
   * @returns Disposal matches with valuation metadata
   */
  const loadDisposalMatches = ({
    sourceId,
    yearStart,
    yearEnd,
  }: {
    readonly sourceId: string
    readonly yearStart: Date
    readonly yearEnd: Date
  }) =>
    db
      .select(selectDisposalMatchFields)
      .from(schema.disposalMatches)
      .innerJoin(
        schema.transactionLegs,
        eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
      )
      .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
      .where(
        and(
          eq(schema.transactionLegs.sourceId, sourceId),
          gte(schema.transactionLegs.timestamp, yearStart),
          lt(schema.transactionLegs.timestamp, yearEnd)
        )
      )
      .pipe(
        wrapSqlError("taxCalculationService.loadDisposalMatches"),
        withObservedOperation({
          name: "persistence.tax-calculation.load-disposal-matches",
          attributes: {
            sourceId,
            yearStart: yearStart.toISOString(),
            yearEnd: yearEnd.toISOString(),
          },
          kind: "client",
        })
      )

  /**
   * Load income legs that contribute to the selected tax year.
   *
   * @param sourceId - Source identifier
   * @param yearStart - Inclusive UTC year start
   * @param yearEnd - Exclusive UTC year end
   * @returns Income legs with fiat valuation fields
   */
  const loadIncomeLegs = ({
    sourceId,
    yearStart,
    yearEnd,
  }: {
    readonly sourceId: string
    readonly yearStart: Date
    readonly yearEnd: Date
  }) =>
    db
      .select(selectIncomeLegFields)
      .from(schema.transactionLegs)
      .where(
        and(
          eq(schema.transactionLegs.sourceId, sourceId),
          eq(schema.transactionLegs.kind, "income"),
          gte(schema.transactionLegs.timestamp, yearStart),
          lt(schema.transactionLegs.timestamp, yearEnd)
        )
      )
      .pipe(
        wrapSqlError("taxCalculationService.loadIncomeLegs"),
        withObservedOperation({
          name: "persistence.tax-calculation.load-income-legs",
          attributes: {
            sourceId,
            yearStart: yearStart.toISOString(),
            yearEnd: yearEnd.toISOString(),
          },
          kind: "client",
        })
      )

  /**
   * Aggregate disposal gain/loss rows into taxable and tax-free totals.
   *
   * @param sourceId - Source identifier for error reporting
   * @param rows - Disposal match rows for the selected year
   * @returns Running tax summary totals
   */
  const summarizeDisposals = ({
    sourceId,
    rows,
  }: {
    readonly sourceId: string
    readonly rows: ReadonlyArray<DisposalMatchRow>
  }) =>
    Effect.reduce(rows, emptyTotals(), (totals, row) =>
      Effect.gen(function* () {
        yield* ensureReportingCurrency({
          sourceId,
          field: `disposal leg ${row.disposalLegId} fiat currency`,
          currency: row.disposalCurrency,
        })
        yield* ensureReportingCurrency({
          sourceId,
          field: `FIFO lot ${row.fifoLotId} cost basis currency`,
          currency: row.costBasisCurrency,
        })

        const gainLoss = yield* decodeDecimal({
          value: row.gainLoss,
          operation: "taxCalculationService.summarizeDisposals.gainLoss",
        })

        if (!BigDecimal.isNegative(gainLoss)) {
          return isTaxFreeDisposal(row)
            ? {
                ...totals,
                taxFreeGains: BigDecimal.sum(totals.taxFreeGains, gainLoss),
              }
            : {
                ...totals,
                taxableGains: BigDecimal.sum(totals.taxableGains, gainLoss),
              }
        }

        if (isTaxFreeDisposal(row)) {
          return totals
        }

        return {
          ...totals,
          taxableLosses: BigDecimal.sum(totals.taxableLosses, BigDecimal.abs(gainLoss)),
        }
      })
    )

  /**
   * Aggregate income legs after validating complete fiat valuation metadata.
   *
   * @param sourceId - Source identifier for error reporting
   * @param rows - Income rows for the selected year
   * @returns Exact income total in the reporting currency
   */
  const summarizeIncome = ({
    sourceId,
    rows,
  }: {
    readonly sourceId: string
    readonly rows: ReadonlyArray<IncomeLegRow>
  }) =>
    Effect.reduce(rows, zeroAmount(), (incomeTotal, row) =>
      Effect.gen(function* () {
        yield* ensureReportingCurrency({
          sourceId,
          field: `income leg ${row.legId} fiat currency`,
          currency: row.fiatCurrency,
        })

        if (row.fiatAmount === null) {
          return yield* Effect.fail(
            new TaxCalculationIncompleteDataError({
              sourceId,
              field: `income leg ${row.legId} fiat amount`,
              reason: "missing fiat valuation",
            })
          )
        }

        const fiatAmount = yield* decodeDecimal({
          value: row.fiatAmount,
          operation: "taxCalculationService.summarizeIncome.fiatAmount",
        })

        return BigDecimal.sum(incomeTotal, fiatAmount)
      })
    )

  const calculateTax: TaxCalculationServiceShape["calculateTax"] = ({
    sourceId,
    jurisdiction,
    year,
  }) =>
    Effect.gen(function* () {
      if (jurisdiction !== SUPPORTED_JURISDICTION) {
        return yield* Effect.fail(new UnsupportedJurisdictionError({ jurisdiction }))
      }

      yield* loadSource(sourceId)

      const yearStart = startOfYearUtc(year)
      const yearEnd = endOfYearUtc(year)

      const disposalRows = yield* loadDisposalMatches({
        sourceId,
        yearStart,
        yearEnd,
      })
      const incomeRows = yield* loadIncomeLegs({
        sourceId,
        yearStart,
        yearEnd,
      })

      yield* Effect.annotateCurrentSpan({
        sourceId,
        jurisdiction,
        year,
        disposalRowCount: disposalRows.length,
        incomeRowCount: incomeRows.length,
      })

      const disposalTotals = yield* summarizeDisposals({
        sourceId,
        rows: disposalRows,
      })
      const incomeTotal = yield* summarizeIncome({
        sourceId,
        rows: incomeRows,
      })

      const summary = {
        year,
        currency: REPORTING_CURRENCY,
        taxableGains: toResponseNumber(disposalTotals.taxableGains),
        taxableLosses: toResponseNumber(disposalTotals.taxableLosses),
        taxFreeGains: toResponseNumber(disposalTotals.taxFreeGains),
        incomeTotal: toResponseNumber(incomeTotal),
      } as const

      yield* recordTaxCalculationOutcome({
        jurisdiction,
        outcome: "completed",
      })

      yield* Effect.logInfo(
        {
          sourceId,
          jurisdiction,
          year,
          disposalRowCount: disposalRows.length,
          incomeRowCount: incomeRows.length,
        },
        "tax-calculation:completed"
      )

      return summary
    }).pipe(
      withObservedOperation({
        name: "persistence.tax-calculation.calculate-tax",
        attributes: { sourceId, jurisdiction, year },
      }),
      trackTaxCalculationDuration({ jurisdiction }),
      Effect.tapError((error) =>
        Effect.all(
          [
            recordTaxCalculationOutcome({
              jurisdiction,
              outcome: error._tag,
            }),
            Effect.logError(
              {
                sourceId,
                jurisdiction,
                year,
                error,
              },
              "tax-calculation:failed"
            ),
          ],
          { discard: true }
        )
      ),
      wrapTaxCalculationError()
    )

  return {
    calculateTax,
  } satisfies TaxCalculationServiceShape
})

/**
 * TaxCalculationServiceLive - Live layer for source tax calculation.
 */
export const TaxCalculationServiceLive = Layer.effect(TaxCalculationService, make)
