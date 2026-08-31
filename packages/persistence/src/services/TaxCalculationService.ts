/**
 * TaxCalculationService - Service interface for reading active-run tax summaries
 *
 * Uses Effect Context.Tag pattern for dependency injection.
 * All operations return Effect with typed errors.
 *
 * @module TaxCalculationService
 */

import { type CurrencyCode } from "@my/core/currency"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { SourceNotFoundError } from "@my/sync-engine/services"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * UnsupportedJurisdictionError - Tax jurisdiction is not supported.
 */
export class UnsupportedJurisdictionError extends Schema.TaggedError<UnsupportedJurisdictionError>()(
  "UnsupportedJurisdictionError",
  {
    jurisdiction: Schema.String,
  },
  { httpApiStatus: 400 }
) {
  override get message(): string {
    return `Unsupported jurisdiction: ${this.jurisdiction}`
  }
}

/**
 * TaxCalculationIncompleteDataError - Tax-visible records are missing required valuation data.
 */
export class TaxCalculationIncompleteDataError extends Schema.TaggedError<TaxCalculationIncompleteDataError>()(
  "TaxCalculationIncompleteDataError",
  {
    sourceId: Schema.String,
    field: Schema.String,
    reason: Schema.String,
  },
  { httpApiStatus: 422 }
) {
  override get message(): string {
    return `Tax calculation data is incomplete for source ${this.sourceId} (${this.field}): ${this.reason}`
  }
}

/**
 * TaxCalculationBlockingObservation - A provider asset observation blocking a
 * tax calculation, named by provider and currency code.
 */
export class TaxCalculationBlockingObservation extends Schema.Class<TaxCalculationBlockingObservation>(
  "TaxCalculationBlockingObservation"
)({
  provider: Schema.String,
  currencyCode: Schema.String,
}) {}

/**
 * TaxCalculationPendingObservationsError - Source activity depends on provider asset
 * observations that have no mapping decision yet, so the calculation is pending.
 */
export class TaxCalculationPendingObservationsError extends Schema.TaggedError<TaxCalculationPendingObservationsError>()(
  "TaxCalculationPendingObservationsError",
  {
    sourceId: Schema.String,
    pendingObservationCount: Schema.Int,
    blockingObservations: Schema.Array(TaxCalculationBlockingObservation),
  },
  { httpApiStatus: 422 }
) {
  override get message(): string {
    return `Tax calculation for source ${this.sourceId} is pending: ${this.pendingObservationCount} provider asset observation(s) await resolution`
  }
}

/**
 * TaxCalculationUnsupportedCurrencyError - Source contains non-reporting-currency values.
 */
export class TaxCalculationUnsupportedCurrencyError extends Schema.TaggedError<TaxCalculationUnsupportedCurrencyError>()(
  "TaxCalculationUnsupportedCurrencyError",
  {
    sourceId: Schema.String,
    field: Schema.String,
    expectedCurrency: Schema.String,
    actualCurrency: Schema.String,
  },
  { httpApiStatus: 422 }
) {
  override get message(): string {
    return `Tax calculation only supports ${this.expectedCurrency} values for ${this.field}; received ${this.actualCurrency}`
  }
}

/**
 * TaxCalculationServiceError - Union of all tax calculation service errors.
 */
export type TaxCalculationServiceError =
  | SourceNotFoundError
  | UnsupportedJurisdictionError
  | TaxCalculationIncompleteDataError
  | TaxCalculationPendingObservationsError
  | TaxCalculationUnsupportedCurrencyError
  | PersistenceError

/**
 * CalculateTaxParams - Active-run selection for a source, jurisdiction, and year.
 */
export interface CalculateTaxParams {
  readonly sourceId: string
  readonly jurisdiction: string
  readonly year: number
}

/**
 * CalculateTaxResult - Tax calculation aggregate values.
 */
export interface CalculateTaxResult {
  readonly calculationRunId: string
  readonly year: number
  readonly currency: CurrencyCode
  readonly taxableGains: number
  readonly taxableLosses: number
  readonly taxFreeGains: number
  readonly incomeTotal: number
}

/**
 * TaxCalculationServiceShape - Contract used by API handlers for tax calculation.
 */
export interface TaxCalculationServiceShape {
  /**
   * Read a supported jurisdiction and year from the source principal's active run.
   *
   * @param params - Source, jurisdiction, and tax year used to select the run
   * @returns The stored tax summary and identity of the selected active run
   */
  readonly calculateTax: (
    params: CalculateTaxParams
  ) => Effect.Effect<CalculateTaxResult, TaxCalculationServiceError>
}

/**
 * TaxCalculationService - Context tag for sources persistence operations.
 */
export class TaxCalculationService extends Context.Service<
  TaxCalculationService,
  TaxCalculationServiceShape
>()("TaxCalculationService") {}
