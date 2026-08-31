/**
 * CalculationRunRepository - Write-once calculation-run persistence contract.
 *
 * @module CalculationRunRepository
 */

import type { TaxAccountingResult } from "@my/accounting"
import { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** Stable, caller-assigned identity of one immutable calculation run. */
export const CalculationRunId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("CalculationRunId")
)

/** Stable, caller-assigned identity of one immutable calculation run. */
export type CalculationRunId = typeof CalculationRunId.Type

/** Revision of the factual ledger used as calculation input. */
export const InputLedgerRevision = Schema.Trimmed.pipe(
  Schema.check(Schema.isPattern(/^v1:\d+:[0-9a-f]{64}$/)),
  Schema.brand("InputLedgerRevision")
)

/** Revision of the factual ledger used as calculation input. */
export type InputLedgerRevision = typeof InputLedgerRevision.Type

/** Revision of the valuation facts used as calculation input. */
export const ValuationRevision = Schema.Trimmed.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  Schema.brand("ValuationRevision")
)

/** Revision of the valuation facts used as calculation input. */
export type ValuationRevision = typeof ValuationRevision.Type

/** A terminal calculation run cannot be written again under the same ID. */
export class CalculationRunAlreadyStoredError extends Schema.TaggedError<CalculationRunAlreadyStoredError>()(
  "CalculationRunAlreadyStoredError",
  { runId: CalculationRunId }
) {}

/** A monetary result does not match the run's declared reporting currency. */
export class CalculationRunCurrencyMismatchError extends Schema.TaggedError<CalculationRunCurrencyMismatchError>()(
  "CalculationRunCurrencyMismatchError",
  {
    runId: CalculationRunId,
    expected: CurrencyCode,
    actual: CurrencyCode,
  }
) {}

/** Input required to write one terminal calculation run and compare it for activation. */
export interface PersistCalculationRunParams {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly reportingCurrency: CurrencyCode
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly result: TaxAccountingResult
}

/** Outcome of a durable run write and monotonic active-pointer comparison. */
export interface CalculationRunWriteResult {
  readonly activated: boolean
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly status: "complete" | "partial"
}

/** Expected failures while writing a calculation run. */
export type CalculationRunWriteError =
  | CalculationRunAlreadyStoredError
  | CalculationRunCurrencyMismatchError
  | PersistenceError

/** Persistence contract for atomic, write-once calculation results. */
export interface CalculationRunRepositoryShape {
  /**
   * Persist every row of a complete or partial engine result, then activate it
   * only when its factual snapshot is newer than the current active run.
   *
   * Custody membership is snapshotted from live data at persistence time. A run
   * ID is single-use, including for an otherwise identical retry.
   */
  readonly persist: (
    params: PersistCalculationRunParams
  ) => Effect.Effect<CalculationRunWriteResult, CalculationRunWriteError>
}

/** Context tag for calculation-run writes. */
export class CalculationRunRepository extends Context.Service<
  CalculationRunRepository,
  CalculationRunRepositoryShape
>()("@my/persistence/CalculationRunRepository") {}
