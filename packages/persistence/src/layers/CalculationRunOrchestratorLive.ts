/**
 * CalculationRunOrchestratorLive - Persistence adapters for post-sync accounting.
 *
 * @module CalculationRunOrchestratorLive
 */

import { calculate, GERMAN_RULE_SET_VERSION, TAX_ACCOUNTING_ENGINE_VERSION } from "@my/accounting"
import { PrincipalId } from "@my/core/ownership"
import {
  CalculationRunOrchestrationError,
  CalculationRunOrchestrator,
  makeCalculationRunOrchestrator,
} from "@my/sync-engine/services"
import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  CalculationRunId,
  CalculationRunRepository,
  CalculationRunTriggerRepository,
  InputLedgerRevision,
  ValuationRevision,
} from "../services/CalculationRunRepository.ts"
import { FactualLedgerRepository } from "../services/FactualLedgerRepository.ts"

const toOrchestrationError = ({
  operation,
  cause,
}: {
  readonly operation: string
  readonly cause: unknown
}) => new CalculationRunOrchestrationError({ operation, cause, retrySourceJob: false })

const RESERVED_CONNECTION_TRANSACTION_DEPTH = -1
const PRINCIPAL_LOCK_RETRY_INTERVAL_MS = 100

type PrincipalLockAttempt<A> =
  | { readonly _tag: "Acquired"; readonly value: A }
  | { readonly _tag: "Busy" }

const make = Effect.gen(function* () {
  const sqlClient = yield* PgClient.PgClient
  const factualLedgerRepository = yield* FactualLedgerRepository
  const calculationRunRepository = yield* CalculationRunRepository
  const calculationRunTriggerRepository = yield* CalculationRunTriggerRepository

  const withPrincipalLock = <A, E, R>({
    principalId,
    shared,
    effect,
  }: {
    readonly principalId: string
    readonly shared: boolean
    readonly effect: Effect.Effect<A, E, R>
  }): Effect.Effect<A, E | CalculationRunOrchestrationError, R> =>
    Effect.serviceOption(sqlClient.transactionService).pipe(
      Effect.flatMap((existingTransaction) => {
        if (existingTransaction._tag === "Some") {
          const [connection] = existingTransaction.value
          return connection
            .executeRaw(
              shared
                ? "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))"
                : "select pg_advisory_xact_lock(hashtextextended($1, 0))",
              [principalId]
            )
            .pipe(
              Effect.mapError((cause) =>
                toOrchestrationError({
                  operation: "calculationRunOrchestrator.acquirePrincipalLock",
                  cause,
                })
              ),
              Effect.andThen(effect)
            )
        }

        const tryLock: Effect.Effect<
          PrincipalLockAttempt<A>,
          E | CalculationRunOrchestrationError,
          R
        > = Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* sqlClient.reserve.pipe(
              Effect.mapError((cause) =>
                toOrchestrationError({
                  operation: "calculationRunOrchestrator.reservePrincipalLock",
                  cause,
                })
              )
            )
            const unlock = connection
              .executeRaw(
                shared
                  ? "select pg_advisory_unlock_shared(hashtextextended($1, 0))"
                  : "select pg_advisory_unlock(hashtextextended($1, 0))",
                [principalId]
              )
              .pipe(
                Effect.mapError((cause) =>
                  toOrchestrationError({
                    operation: "calculationRunOrchestrator.releasePrincipalLock",
                    cause,
                  })
                )
              )
            return yield* Effect.acquireUseRelease(
              connection
                .executeValues(
                  shared
                    ? "select pg_try_advisory_lock_shared(hashtextextended($1, 0))"
                    : "select pg_try_advisory_lock(hashtextextended($1, 0))",
                  [principalId]
                )
                .pipe(
                  Effect.flatMap((rows: unknown) =>
                    Schema.decodeUnknownEffect(Schema.Array(Schema.Tuple([Schema.Boolean])))(rows)
                  ),
                  Effect.map((rows) => rows[0]?.[0] === true),
                  Effect.mapError((cause) =>
                    toOrchestrationError({
                      operation: "calculationRunOrchestrator.tryPrincipalLock",
                      cause,
                    })
                  )
                ),
              (acquired): Effect.Effect<PrincipalLockAttempt<A>, E, R> =>
                acquired
                  ? effect.pipe(
                      // Bind every protected query to the lock-owning connection. A depth of -1
                      // lets each repository's first withTransaction call stay top-level.
                      Effect.provideService(sqlClient.transactionService, [
                        connection,
                        RESERVED_CONNECTION_TRANSACTION_DEPTH,
                      ]),
                      Effect.map((value) => ({ _tag: "Acquired" as const, value }))
                    )
                  : Effect.succeed({ _tag: "Busy" as const }),
              (acquired) => (acquired ? unlock : Effect.void)
            )
          })
        )

        const waitForLock: Effect.Effect<A, E | CalculationRunOrchestrationError, R> =
          Effect.suspend(() =>
            tryLock.pipe(
              Effect.flatMap((attempt) =>
                attempt._tag === "Acquired"
                  ? Effect.succeed(attempt.value)
                  : Effect.sleep(PRINCIPAL_LOCK_RETRY_INTERVAL_MS).pipe(Effect.andThen(waitForLock))
              )
            )
          )

        return waitForLock
      })
    )

  const orchestrator = makeCalculationRunOrchestrator({
    engineVersion: TAX_ACCOUNTING_ENGINE_VERSION,
    ruleSetVersion: GERMAN_RULE_SET_VERSION,
    withPrincipalLock,
    hasActivePrincipalJobs: calculationRunTriggerRepository.hasActivePrincipalJobs,
    findLatestCompletedJob: calculationRunTriggerRepository.findLatestCompletedJob,
    findTerminalJob: calculationRunTriggerRepository.findTerminalJob,
    listRecoverableTerminalPrincipals:
      calculationRunTriggerRepository.listRecoverableTerminalPrincipals,
    loadFactualLedger: ({ principalId, reportingCurrency }) =>
      Schema.decodeEffect(PrincipalId)(principalId).pipe(
        Effect.flatMap((ownerId) =>
          factualLedgerRepository.load({ principalId: ownerId, reportingCurrency })
        )
      ),
    begin: (params) =>
      Effect.gen(function* () {
        const id = yield* Schema.decodeEffect(CalculationRunId)(params.id)
        const principalId = yield* Schema.decodeEffect(PrincipalId)(params.principalId)
        const inputLedgerRevision = yield* Schema.decodeEffect(InputLedgerRevision)(
          params.inputLedgerRevision
        )
        const valuationRevision = yield* Schema.decodeEffect(ValuationRevision)(
          params.valuationRevision
        )

        return yield* calculationRunRepository
          .begin({ ...params, id, principalId, inputLedgerRevision, valuationRevision })
          .pipe(
            Effect.as("ready" as const),
            Effect.catchTags({
              CalculationRunAlreadyStoredError: () => Effect.succeed("terminal" as const),
              CalculationRunResumeMismatchError: ({ reason }) =>
                Effect.succeed(
                  reason === "input_revision"
                    ? ("input_revision_mismatch" as const)
                    : reason === "run_metadata"
                      ? ("run_metadata_mismatch" as const)
                      : ("input_revision_and_run_metadata_mismatch" as const)
                ),
            })
          )
      }),
    calculate,
    persist: (params) =>
      Effect.gen(function* () {
        const id = yield* Schema.decodeEffect(CalculationRunId)(params.id)
        const principalId = yield* Schema.decodeEffect(PrincipalId)(params.principalId)
        const inputLedgerRevision = yield* Schema.decodeEffect(InputLedgerRevision)(
          params.inputLedgerRevision
        )
        const valuationRevision = yield* Schema.decodeEffect(ValuationRevision)(
          params.valuationRevision
        )

        yield* calculationRunRepository.persist({
          ...params,
          id,
          principalId,
          inputLedgerRevision,
          valuationRevision,
        })
      }),
    fail: ({ id: rawId, failureCode, failureMessage }) =>
      Schema.decodeEffect(CalculationRunId)(rawId).pipe(
        Effect.flatMap((id) => calculationRunRepository.fail({ id, failureCode, failureMessage }))
      ),
    failSuperseded: ({ principalId: rawPrincipalId, latestRunId: rawLatestRunId, ...failure }) =>
      Effect.gen(function* () {
        const principalId = yield* Schema.decodeEffect(PrincipalId)(rawPrincipalId)
        const latestRunId = yield* Schema.decodeEffect(CalculationRunId)(rawLatestRunId)
        return yield* calculationRunRepository.failSuperseded({
          principalId,
          latestRunId,
          ...failure,
        })
      }),
  })

  return CalculationRunOrchestrator.of(orchestrator)
})

/** Live post-sync calculation adapter backed by PostgreSQL. */
export const CalculationRunOrchestratorLive = Layer.effect(CalculationRunOrchestrator, make)
