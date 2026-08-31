/**
 * CalculationRunRepository - Write-once calculation-run persistence contract.
 *
 * @module CalculationRunRepository
 */

import type { TaxAccountingResult } from "@my/accounting"
import type { CustodyUnitMembership, JurisdictionCode, TaxYear } from "@my/core/accounting"
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

const Revision = Schema.Trimmed.check(Schema.isNonEmpty())

/** Revision of the factual ledger used as calculation input. */
export const InputLedgerRevision = Revision.pipe(Schema.brand("InputLedgerRevision"))

/** Revision of the factual ledger used as calculation input. */
export type InputLedgerRevision = typeof InputLedgerRevision.Type

/** Revision of the valuation facts used as calculation input. */
export const ValuationRevision = Revision.pipe(Schema.brand("ValuationRevision"))

/** Revision of the valuation facts used as calculation input. */
export type ValuationRevision = typeof ValuationRevision.Type

/** A terminal calculation run cannot be written again under the same ID. */
export class CalculationRunAlreadyStoredError extends Schema.TaggedError<CalculationRunAlreadyStoredError>()(
  "CalculationRunAlreadyStoredError",
  { runId: CalculationRunId }
) {}

/** A crashed running attempt cannot resume because its inputs or run metadata changed. */
export class CalculationRunResumeMismatchError extends Schema.TaggedError<CalculationRunResumeMismatchError>()(
  "CalculationRunResumeMismatchError",
  {
    runId: CalculationRunId,
    reason: Schema.Literals(["input_revision", "run_metadata", "input_revision_and_run_metadata"]),
  }
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

/** Input required to write and activate one terminal calculation run. */
export interface PersistCalculationRunParams {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly reportingCurrency: CurrencyCode
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
  readonly custodyUnitMemberships: ReadonlyArray<CustodyUnitMembership>
  readonly result: TaxAccountingResult
}

/** Metadata known before one engine invocation starts. */
export interface BeginCalculationRunParams {
  readonly id: CalculationRunId
  readonly principalId: PrincipalId
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly reportingCurrency: CurrencyCode
  readonly engineVersion: string
  readonly ruleSetVersion: string
  readonly inputLedgerRevision: InputLedgerRevision
  readonly valuationRevision: ValuationRevision
}

/** Terminal failure recorded for a calculation that already started. */
export interface FailCalculationRunParams {
  readonly id: CalculationRunId
  readonly failureCode: string
  readonly failureMessage: string
}

/** Principal scope used to settle crashed runs older than the latest completed job. */
export interface FailSupersededCalculationRunsParams {
  readonly principalId: PrincipalId
  readonly latestRunId: CalculationRunId
  readonly failureCode: string
  readonly failureMessage: string
}

/** Terminal source-job metadata used to recover calculation orchestration. */
export interface TerminalCalculationTriggerJob {
  readonly sourceId: string
  readonly principalId: string
  readonly status: "completed" | "failed" | "credit_required"
}

/** Principal with unfinished calculation work tied to a completed source job. */
export interface RecoverableTerminalCalculationPrincipal {
  readonly principalId: string
}

/** Expected failures while writing a calculation run. */
export type CalculationRunWriteError =
  | CalculationRunAlreadyStoredError
  | CalculationRunResumeMismatchError
  | CalculationRunCurrencyMismatchError
  | PersistenceError

/** Persistence contract for atomic, write-once calculation results. */
export interface CalculationRunRepositoryShape {
  /** Create the externally visible running row for a caller-assigned run ID. */
  readonly begin: (
    params: BeginCalculationRunParams
  ) => Effect.Effect<
    void,
    CalculationRunAlreadyStoredError | CalculationRunResumeMismatchError | PersistenceError
  >

  /**
   * Persist every row of a complete or partial engine result, then activate it.
   *
   * Custody membership is the exact engine input and is snapshotted with the
   * result. A run ID is single-use, including for an otherwise identical retry.
   */
  readonly persist: (
    params: PersistCalculationRunParams
  ) => Effect.Effect<void, CalculationRunWriteError>

  /** Mark a started run failed without changing the active-run pointer. */
  readonly fail: (
    params: FailCalculationRunParams
  ) => Effect.Effect<void, CalculationRunAlreadyStoredError | PersistenceError>

  /** Fail every running completed-job calculation older than the latest run. */
  readonly failSuperseded: (
    params: FailSupersededCalculationRunsParams
  ) => Effect.Effect<number, PersistenceError>
}

/** Context tag for calculation-run writes. */
export class CalculationRunRepository extends Context.Service<
  CalculationRunRepository,
  CalculationRunRepositoryShape
>()("@my/persistence/CalculationRunRepository") {}

/** Durable source-job reads needed by the calculation orchestration adapter. */
export interface CalculationRunTriggerRepositoryShape {
  readonly hasActivePrincipalJobs: (params: {
    readonly principalId: string
  }) => Effect.Effect<boolean, PersistenceError>
  readonly findLatestCompletedJob: (params: {
    readonly principalId: string
  }) => Effect.Effect<{ readonly id: string } | null, PersistenceError>
  readonly findTerminalJob: (params: {
    readonly jobId: string
  }) => Effect.Effect<TerminalCalculationTriggerJob | null, PersistenceError>
  readonly listRecoverableTerminalPrincipals: (params: {
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<RecoverableTerminalCalculationPrincipal>, PersistenceError>
}

/** Context tag for durable source-job state read by calculation orchestration. */
export class CalculationRunTriggerRepository extends Context.Service<
  CalculationRunTriggerRepository,
  CalculationRunTriggerRepositoryShape
>()("@my/persistence/CalculationRunTriggerRepository") {}
