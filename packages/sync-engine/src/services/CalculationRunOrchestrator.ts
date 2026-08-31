/**
 * CalculationRunOrchestrator - Post-sync accounting orchestration policy.
 *
 * @module CalculationRunOrchestrator
 */

import {
  AccountingEvent,
  CustodyUnitId,
  CustodyUnitMembership,
  JurisdictionCode,
  TaxYear,
  ValuationFact,
} from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { SyncEngineTransactionShape } from "./SyncEngineTransaction.ts"

/** A calculation run could not be started or settled after factual sync completed. */
export class CalculationRunOrchestrationError extends Schema.TaggedError<CalculationRunOrchestrationError>()(
  "CalculationRunOrchestrationError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
    retrySourceJob: Schema.Boolean,
  }
) {}

/** Identifies the completed source job that owns one T13 calculation attempt. */
export interface RunCalculationAfterSourceSyncParams {
  readonly jobId: string
  readonly principalId: string
}

/** Result of checking whether a redelivered queue job already reached a terminal state. */
export interface ResumeCalculationAfterTerminalSyncResult {
  readonly sourceId: string
  readonly principalId: string
  readonly status: "completed" | "failed" | "credit_required"
}

/** Principal with unfinished durable calculation work after source jobs became terminal. */
export interface RecoverableTerminalCalculationPrincipal {
  readonly principalId: string
}

/** Summary of one durable calculation-recovery scan. */
export interface RecoverTerminalCalculationsSummary {
  readonly scannedPrincipals: number
  readonly recoveredPrincipals: number
  readonly failedPrincipals: number
}

/** Orchestration seam between sync completion and persistence-owned accounting work. */
export interface CalculationRunOrchestratorShape {
  /** Hold the principal's shared factual-write lock while one sync mutates facts. */
  readonly withPrincipalSyncLock: <A, E, R>(params: {
    readonly principalId: string
    readonly effect: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E | CalculationRunOrchestrationError, R>

  /** Hold the principal's exclusive lock while terminal state and accounting wake commit. */
  readonly withPrincipalCalculationLock: <A, E, R>(params: {
    readonly principalId: string
    readonly effect: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E | CalculationRunOrchestrationError, R>

  /** Calculate after one successful factual sync when no principal job remains active. */
  readonly runAfterSync: (
    params: RunCalculationAfterSourceSyncParams
  ) => Effect.Effect<void, CalculationRunOrchestrationError>

  /** Resume deferred accounting when BullMQ redelivers a terminal source job. */
  readonly resumeAfterTerminalSync: (params: {
    readonly jobId: string
  }) => Effect.Effect<
    ResumeCalculationAfterTerminalSyncResult | null,
    CalculationRunOrchestrationError
  >

  /** Wake a calculation deferred behind a principal job that did not complete successfully. */
  readonly runAfterPrincipalTerminal: (params: {
    readonly principalId: string
  }) => Effect.Effect<void, CalculationRunOrchestrationError>

  /** Retry durable calculation intent independently of source queue attempts. */
  readonly recoverTerminalCalculations: (params: {
    readonly limit: number
  }) => Effect.Effect<RecoverTerminalCalculationsSummary, CalculationRunOrchestrationError>
}

/** Context tag for principal-wide calculation after source sync. */
export class CalculationRunOrchestrator extends Context.Service<
  CalculationRunOrchestrator,
  CalculationRunOrchestratorShape
>()("CalculationRunOrchestrator") {}

/** Commit one source terminal state and its calculation wake as one recoverable operation. */
export const terminalizeSourceJobAndWakeCalculation = <ETerminal, EWake, RTerminal, RWake>({
  calculationRunOrchestrator,
  principalId,
  transaction,
  terminalize,
  wake,
}: {
  readonly calculationRunOrchestrator: Pick<
    CalculationRunOrchestratorShape,
    "withPrincipalCalculationLock"
  >
  readonly principalId: string
  readonly transaction: SyncEngineTransactionShape
  readonly terminalize: Effect.Effect<void, ETerminal, RTerminal>
  readonly wake: Effect.Effect<void, EWake, RWake>
}) =>
  calculationRunOrchestrator.withPrincipalCalculationLock({
    principalId,
    effect: transaction.run(terminalize.pipe(Effect.andThen(wake))),
  })

/** Outcome of claiming a caller-assigned calculation-run ID. */
export type BeginCalculationAttemptOutcome =
  | "ready"
  | "terminal"
  | "input_revision_mismatch"
  | "run_metadata_mismatch"
  | "input_revision_and_run_metadata_mismatch"

/** Canonical facts consumed by one calculation attempt. */
export interface CalculationOrchestratorFactualLedger {
  readonly events: ReadonlyArray<AccountingEvent>
  readonly valuationFacts: ReadonlyArray<ValuationFact>
  readonly custodyUnitMemberships: ReadonlyArray<CustodyUnitMembership>
}

/** Infrastructure adapters used by the sync-engine calculation policy. */
export interface CalculationRunOrchestratorDependencies<CalculationResult> {
  readonly engineVersion: string
  readonly ruleSetVersion: string
  readonly withPrincipalLock: <A, E, R>(params: {
    readonly principalId: string
    readonly shared: boolean
    readonly effect: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E | CalculationRunOrchestrationError, R>
  readonly hasActivePrincipalJobs: (params: {
    readonly principalId: string
  }) => Effect.Effect<boolean, unknown>
  readonly findLatestCompletedJob: (params: {
    readonly principalId: string
  }) => Effect.Effect<{ readonly id: string } | null, unknown>
  readonly findTerminalJob: (params: {
    readonly jobId: string
  }) => Effect.Effect<ResumeCalculationAfterTerminalSyncResult | null, unknown>
  readonly listRecoverableTerminalPrincipals: (params: {
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<RecoverableTerminalCalculationPrincipal>, unknown>
  readonly loadFactualLedger: (params: {
    readonly principalId: string
    readonly reportingCurrency: CurrencyCode
  }) => Effect.Effect<CalculationOrchestratorFactualLedger, unknown>
  readonly begin: (params: {
    readonly id: string
    readonly principalId: string
    readonly jurisdiction: JurisdictionCode
    readonly taxYear: TaxYear
    readonly reportingCurrency: CurrencyCode
    readonly engineVersion: string
    readonly ruleSetVersion: string
    readonly inputLedgerRevision: string
    readonly valuationRevision: string
  }) => Effect.Effect<BeginCalculationAttemptOutcome, unknown>
  readonly calculate: (params: {
    readonly ledger: ReadonlyArray<AccountingEvent>
    readonly jurisdiction: JurisdictionCode
    readonly taxYear: TaxYear
    readonly accountingChoices: ReadonlyArray<never>
    readonly valuationFacts: ReadonlyArray<ValuationFact>
    readonly custodyUnitMemberships: ReadonlyArray<CustodyUnitMembership>
  }) => Effect.Effect<CalculationResult, unknown>
  readonly persist: (params: {
    readonly id: string
    readonly principalId: string
    readonly reportingCurrency: CurrencyCode
    readonly inputLedgerRevision: string
    readonly valuationRevision: string
    readonly custodyUnitMemberships: ReadonlyArray<CustodyUnitMembership>
    readonly result: CalculationResult
  }) => Effect.Effect<void, unknown>
  readonly fail: (params: {
    readonly id: string
    readonly failureCode: string
    readonly failureMessage: string
  }) => Effect.Effect<void, unknown>
  readonly failSuperseded: (params: {
    readonly principalId: string
    readonly latestRunId: string
    readonly failureCode: string
    readonly failureMessage: string
  }) => Effect.Effect<number, unknown>
}

const GERMAN_TIME_ZONE = "Europe/Berlin"
const CALCULATION_JURISDICTION = JurisdictionCode.make("DE")
const CALCULATION_REPORTING_CURRENCY = CurrencyCode.make("EUR")
const LEDGER_REVISION_DOMAIN = "taxmaxi:factual-ledger:v2"
const VALUATION_REVISION_DOMAIN = "taxmaxi:valuation-facts:v1"

const encodeEvents = Schema.encodeSync(Schema.Array(AccountingEvent))
const encodeCustodyUnitMemberships = Schema.encodeSync(Schema.Array(CustodyUnitMembership))
const encodeValuationFacts = Schema.encodeSync(Schema.Array(ValuationFact))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const effectiveCustodyUnitMemberships = ({
  events,
  memberships,
}: {
  readonly events: ReadonlyArray<AccountingEvent>
  readonly memberships: ReadonlyArray<CustodyUnitMembership>
}): ReadonlyArray<CustodyUnitMembership> => {
  const bySourceId = new Map(memberships.map((membership) => [membership.sourceId, membership]))
  const eventSourceIds = events.flatMap((event) =>
    event._tag === "custody_movement"
      ? [event.fromCustodySourceId, event.toCustodySourceId]
      : [event.custodySourceId]
  )

  for (const sourceId of eventSourceIds) {
    if (!bySourceId.has(sourceId)) {
      bySourceId.set(sourceId, { sourceId, custodyUnitId: CustodyUnitId.make(sourceId) })
    }
  }

  return [...bySourceId.values()].sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.custodyUnitId.localeCompare(right.custodyUnitId)
  )
}

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")

const hashCalculationRevision = ({
  domain,
  value,
}: {
  readonly domain: string
  readonly value: unknown
}) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${domain}\n${encodeJson(value)}`)),
    catch: (cause) =>
      new CalculationRunOrchestrationError({
        operation: "calculationRunOrchestrator.hashRevision",
        cause,
        retrySourceJob: false,
      }),
  }).pipe(Effect.map((digest) => `sha256:${toHex(digest)}`))

const currentGermanTaxYear = DateTime.now.pipe(
  Effect.map((now) => DateTime.setZoneNamedUnsafe(now, GERMAN_TIME_ZONE)),
  Effect.map((now) => TaxYear.make(DateTime.toParts(now).year))
)

const mapOrchestrationError = ({
  operation,
  retrySourceJob = false,
}: {
  readonly operation: string
  readonly retrySourceJob?: boolean
}) =>
  Effect.mapError((cause: unknown) =>
    Schema.is(CalculationRunOrchestrationError)(cause)
      ? cause
      : new CalculationRunOrchestrationError({ operation, cause, retrySourceJob })
  )

/** Build the sync-engine policy around persistence and accounting adapters. */
export const makeCalculationRunOrchestrator = <CalculationResult>(
  dependencies: CalculationRunOrchestratorDependencies<CalculationResult>
): CalculationRunOrchestratorShape => {
  const recordFailure = ({
    id,
    failureCode,
    failureMessage,
  }: {
    readonly id: string
    readonly failureCode: string
    readonly failureMessage: string
  }) =>
    dependencies.fail({ id, failureCode, failureMessage }).pipe(
      mapOrchestrationError({
        operation: "calculationRunOrchestrator.recordFailure",
        retrySourceJob: true,
      })
    )

  const calculateAndStore = ({
    jobId,
    principalId,
  }: {
    readonly jobId: string
    readonly principalId: string
  }) =>
    Effect.gen(function* () {
      const taxYear = yield* currentGermanTaxYear
      const factualLedger = yield* dependencies
        .loadFactualLedger({
          principalId,
          reportingCurrency: CALCULATION_REPORTING_CURRENCY,
        })
        .pipe(mapOrchestrationError({ operation: "calculationRunOrchestrator.loadFactualLedger" }))
      const custodyUnitMemberships = effectiveCustodyUnitMemberships({
        events: factualLedger.events,
        memberships: factualLedger.custodyUnitMemberships,
      })
      const [inputLedgerRevision, valuationRevision] = yield* Effect.all([
        hashCalculationRevision({
          domain: LEDGER_REVISION_DOMAIN,
          value: {
            events: encodeEvents(factualLedger.events),
            custodyUnitMemberships: encodeCustodyUnitMemberships(custodyUnitMemberships),
          },
        }),
        hashCalculationRevision({
          domain: VALUATION_REVISION_DOMAIN,
          value: encodeValuationFacts(factualLedger.valuationFacts),
        }),
      ])

      const beginOutcome = yield* dependencies
        .begin({
          id: jobId,
          principalId,
          jurisdiction: CALCULATION_JURISDICTION,
          taxYear,
          reportingCurrency: CALCULATION_REPORTING_CURRENCY,
          engineVersion: dependencies.engineVersion,
          ruleSetVersion: dependencies.ruleSetVersion,
          inputLedgerRevision,
          valuationRevision,
        })
        .pipe(mapOrchestrationError({ operation: "calculationRunOrchestrator.begin" }))

      if (beginOutcome === "terminal") {
        return
      }

      if (beginOutcome === "input_revision_mismatch") {
        yield* recordFailure({
          id: jobId,
          failureCode: "calculation_input_revision_changed",
          failureMessage: "Calculation inputs changed before the interrupted run resumed.",
        })
        return
      }

      if (beginOutcome === "run_metadata_mismatch") {
        yield* recordFailure({
          id: jobId,
          failureCode: "calculation_run_metadata_changed",
          failureMessage:
            "Calculation scope or version changed before the interrupted run resumed.",
        })
        return
      }

      if (beginOutcome === "input_revision_and_run_metadata_mismatch") {
        yield* recordFailure({
          id: jobId,
          failureCode: "calculation_input_and_run_metadata_changed",
          failureMessage:
            "Calculation inputs and scope or version changed before the interrupted run resumed.",
        })
        return
      }

      const calculationResult = yield* dependencies
        .calculate({
          ledger: factualLedger.events,
          jurisdiction: CALCULATION_JURISDICTION,
          taxYear,
          accountingChoices: [],
          valuationFacts: factualLedger.valuationFacts,
          custodyUnitMemberships,
        })
        .pipe(Effect.result)

      if (Result.isFailure(calculationResult)) {
        yield* recordFailure({
          id: jobId,
          failureCode: "calculation_engine_failed",
          failureMessage: "The accounting engine rejected the calculation inputs.",
        })
        return
      }

      const stored = yield* dependencies
        .persist({
          id: jobId,
          principalId,
          reportingCurrency: CALCULATION_REPORTING_CURRENCY,
          inputLedgerRevision,
          valuationRevision,
          custodyUnitMemberships,
          result: calculationResult.success,
        })
        .pipe(Effect.result)

      if (Result.isFailure(stored)) {
        yield* recordFailure({
          id: jobId,
          failureCode: "calculation_result_storage_failed",
          failureMessage: "The completed accounting result could not be stored.",
        })
      }
    })

  const runLatestCompleted = ({ principalId }: { readonly principalId: string }) =>
    Effect.gen(function* () {
      if (yield* dependencies.hasActivePrincipalJobs({ principalId })) return
      const completedJob = yield* dependencies.findLatestCompletedJob({ principalId })
      if (completedJob === null) return
      yield* dependencies
        .failSuperseded({
          principalId,
          latestRunId: completedJob.id,
          failureCode: "calculation_superseded",
          failureMessage: "A newer completed source job superseded this interrupted calculation.",
        })
        .pipe(
          mapOrchestrationError({
            operation: "calculationRunOrchestrator.failSuperseded",
          })
        )
      yield* calculateAndStore({ jobId: completedJob.id, principalId })
    })

  const runAfterSync: CalculationRunOrchestratorShape["runAfterSync"] = ({ jobId, principalId }) =>
    dependencies
      .withPrincipalLock({
        principalId,
        shared: false,
        effect: Effect.gen(function* () {
          if (yield* dependencies.hasActivePrincipalJobs({ principalId })) return
          yield* calculateAndStore({ jobId, principalId })
        }),
      })
      .pipe(mapOrchestrationError({ operation: "calculationRunOrchestrator.runAfterSync" }))

  const runAfterPrincipalTerminal: CalculationRunOrchestratorShape["runAfterPrincipalTerminal"] = ({
    principalId,
  }) =>
    dependencies
      .withPrincipalLock({
        principalId,
        shared: false,
        effect: runLatestCompleted({ principalId }),
      })
      .pipe(
        mapOrchestrationError({
          operation: "calculationRunOrchestrator.runAfterPrincipalTerminal",
        })
      )

  const recoverTerminalCalculations: CalculationRunOrchestratorShape["recoverTerminalCalculations"] =
    ({ limit }) =>
      dependencies.listRecoverableTerminalPrincipals({ limit }).pipe(
        mapOrchestrationError({
          operation: "calculationRunOrchestrator.listRecoverableTerminalPrincipals",
        }),
        Effect.flatMap((principals) =>
          Effect.forEach(principals, ({ principalId }) =>
            runAfterPrincipalTerminal({ principalId }).pipe(
              Effect.tapError((error) =>
                Effect.logError(
                  { principalId, operation: error.operation, cause: error.cause },
                  "calculation-run:terminal-recovery-failed"
                )
              ),
              Effect.result
            )
          ).pipe(
            Effect.map((results) => ({
              scannedPrincipals: principals.length,
              recoveredPrincipals: results.filter(Result.isSuccess).length,
              failedPrincipals: results.filter(Result.isFailure).length,
            }))
          )
        )
      )

  return {
    withPrincipalSyncLock: ({ principalId, effect }) =>
      dependencies.withPrincipalLock({ principalId, shared: true, effect }),
    withPrincipalCalculationLock: ({ principalId, effect }) =>
      dependencies.withPrincipalLock({ principalId, shared: false, effect }),
    runAfterSync,
    runAfterPrincipalTerminal,
    recoverTerminalCalculations,
    resumeAfterTerminalSync: ({ jobId }) =>
      Effect.gen(function* () {
        const terminalJob = yield* dependencies
          .findTerminalJob({ jobId })
          .pipe(mapOrchestrationError({ operation: "calculationRunOrchestrator.loadTerminalSync" }))
        if (terminalJob === null) return null

        yield* runAfterPrincipalTerminal({ principalId: terminalJob.principalId })

        return terminalJob
      }),
  }
}
