/**
 * CalculationRunRepository - Write-once calculation-run persistence contract.
 *
 * @module CalculationRunRepository
 */

import type { TaxAccountingResult } from "@my/accounting"
import type { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"
import type { CustodyUnitMembership } from "./FactualLedgerRepository.ts"

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

/** Input metadata committed before the pure engine starts. */
export interface StartCalculationRunParams {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
  readonly engineVersion: string
  readonly ruleSetVersion: string
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
}

/** Input used to settle a visible running calculation after an error. */
export interface FailCalculationRunParams {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly failureCode: string
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

/** Calculation states exposed to API consumers. Pending writes are not externally visible. */
export const ExposedCalculationRunStatus = Schema.Literals([
  "running",
  "complete",
  "partial",
  "failed",
])

/** Calculation states exposed to API consumers. */
export type ExposedCalculationRunStatus = typeof ExposedCalculationRunStatus.Type

/** Principal-level status of the latest calculation for one reporting scope. */
export interface CalculationRunStatusSummary {
  readonly runId: CalculationRunId
  readonly status: ExposedCalculationRunStatus
  readonly failureCode: string | null
}

/** Scope used to select a principal's latest calculation run. */
export interface GetLatestCalculationRunStatusParams {
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
}

/** Persistence contract for atomic, write-once calculation results. */
export interface CalculationRunRepositoryShape {
  /** Read the newest factual revision for one principal and calculation scope. */
  readonly getLatestStatus: (
    params: GetLatestCalculationRunStatusParams
  ) => Effect.Effect<CalculationRunStatusSummary | null, PersistenceError>

  /** Commit one visible running run and its immutable factual-snapshot membership. */
  readonly start: (
    params: StartCalculationRunParams
  ) => Effect.Effect<void, CalculationRunAlreadyStoredError | PersistenceError>

  /** Settle a running run as failed without writing result rows or changing the active pointer. */
  readonly fail: (
    params: FailCalculationRunParams
  ) => Effect.Effect<void, CalculationRunAlreadyStoredError | PersistenceError>

  /**
   * Persist every row of a complete or partial engine result, then activate it
   * only when its factual snapshot is newer than the current active run.
   *
   * A run started through `start` keeps its committed custody snapshot. Direct
   * persistence snapshots live custody membership for the legacy atomic path.
   * A run ID is single-use after it reaches a terminal status.
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
