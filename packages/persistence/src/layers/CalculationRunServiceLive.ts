/**
 * CalculationRunServiceLive - Repeatable-read full calculation runs.
 *
 * @module CalculationRunServiceLive
 */

import {
  ACCOUNTING_ENGINE_VERSION,
  AccountingChoiceResolutionError,
  calculate,
  GERMAN_RULE_SET_VERSION,
  type TaxAccountingError,
  UnsupportedJurisdictionError,
} from "@my/accounting"
import {
  format as formatQuantity,
  type AccountingEvent,
  type ValuationFact,
} from "@my/core/accounting"
import { createHash } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  InputLedgerRevision,
  CalculationRunRepository,
  ValuationRevision,
} from "../services/CalculationRunRepository.ts"
import {
  CalculationRunService,
  type CalculationRunServiceShape,
} from "../services/CalculationRunService.ts"
import {
  FactualLedgerRepository,
  type CustodyUnitMembership,
} from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const CALCULATION_FAILED_CODE = "calculation_failed"

const IllegalAccountingChoiceErrorTag = Schema.TaggedStruct("IllegalAccountingChoiceError", {})

const isTaxAccountingError = (error: unknown): error is TaxAccountingError =>
  Schema.is(AccountingChoiceResolutionError)(error) ||
  Schema.is(UnsupportedJurisdictionError)(error) ||
  Schema.is(IllegalAccountingChoiceErrorTag)(error)

const canonicalEvent = (event: AccountingEvent): ReadonlyArray<string | number | null> => {
  const common = [
    event._tag,
    event.id,
    event.occurredAt.epochMillis,
    event.assetId,
    formatQuantity(event.quantity),
    event.transactionReference ?? null,
  ]

  return event._tag === "custody_movement"
    ? [...common, event.fromCustodySourceId, event.toCustodySourceId]
    : [...common, event.custodySourceId, event.cause]
}

const canonicalValuationFact = (fact: ValuationFact): ReadonlyArray<string | number | null> =>
  fact._tag === "observed_consideration"
    ? [fact._tag, fact.eventId, fact.amount.format(), fact.amount.currency, fact.evidenceReference]
    : [
        fact._tag,
        fact.eventId,
        fact.unitPrice.format(),
        fact.unitPrice.currency,
        fact.quotedAt.epochMillis,
        fact.source,
      ]

const sha256 = (domain: string, value: unknown): string =>
  createHash("sha256").update(domain).update("\0").update(JSON.stringify(value)).digest("hex")

const makeLedgerRevision = ({
  snapshotTransactionId,
  snapshotVisibility,
  events,
  custodyUnitMembership,
}: {
  readonly snapshotTransactionId: string
  readonly snapshotVisibility: string
  readonly events: ReadonlyArray<AccountingEvent>
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
}): InputLedgerRevision =>
  InputLedgerRevision.make(
    `v2:${snapshotTransactionId}:${snapshotVisibility}:${sha256("taxmaxi:factual-ledger:v1", {
      events: events.map(canonicalEvent),
      custodyUnitMembership: custodyUnitMembership.map(({ sourceId, custodyUnitId }) => [
        sourceId,
        custodyUnitId,
      ]),
    })}`
  )

const makeValuationRevision = (valuationFacts: ReadonlyArray<ValuationFact>): ValuationRevision =>
  ValuationRevision.make(
    `sha256:${sha256("taxmaxi:valuation-facts:v1", valuationFacts.map(canonicalValuationFact))}`
  )

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const calculationRunRepository = yield* CalculationRunRepository
  const factualLedgerRepository = yield* FactualLedgerRepository

  const loadSnapshot = (params: Parameters<CalculationRunServiceShape["recompute"]>[0]) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`set transaction isolation level repeatable read`)
          const snapshotTransactionRows = yield* tx
            .select({
              transactionId: sql<string>`pg_current_xact_id()::text`,
              visibility: sql<string>`replace(pg_current_snapshot()::text, ':', '.')`,
            })
            .from(schema.principals)
            .where(eq(schema.principals.id, params.principalId))
            .limit(1)
          const snapshotTransactionId = snapshotTransactionRows[0]?.transactionId
          const snapshotVisibility = snapshotTransactionRows[0]?.visibility

          if (snapshotTransactionId === undefined || snapshotVisibility === undefined) {
            return yield* new PersistenceError({
              operation: "calculationRunService.recompute.revision",
              cause: "PostgreSQL did not return a transaction sequence",
            })
          }

          const factualLedger = yield* factualLedgerRepository.load({
            principalId: params.principalId,
            reportingCurrency: params.reportingCurrency,
          })
          const inputLedgerRevision = makeLedgerRevision({
            snapshotTransactionId,
            snapshotVisibility,
            events: factualLedger.events,
            custodyUnitMembership: factualLedger.custodyUnitMembership,
          })
          const valuationRevision = makeValuationRevision(factualLedger.valuationFacts)
          return { factualLedger, inputLedgerRevision, valuationRevision }
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error) ||
          Schema.is(CalculationRunCurrencyMismatchError)(error) ||
          Schema.is(PersistenceError)(error) ||
          isTaxAccountingError(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunService.loadSnapshot",
                cause: error,
              })
        )
      )

  const recompute: CalculationRunServiceShape["recompute"] = (params) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot(params)

      yield* calculationRunRepository.start({
        id: params.id,
        principalId: params.principalId,
        jurisdiction: params.jurisdiction,
        taxYear: params.taxYear,
        reportingCurrency: params.reportingCurrency,
        engineVersion: ACCOUNTING_ENGINE_VERSION,
        ruleSetVersion: GERMAN_RULE_SET_VERSION,
        inputLedgerRevision: snapshot.inputLedgerRevision,
        valuationRevision: snapshot.valuationRevision,
        custodyUnitMembership: snapshot.factualLedger.custodyUnitMembership,
      })

      return yield* calculate({
        ledger: snapshot.factualLedger.events,
        jurisdiction: params.jurisdiction,
        taxYear: params.taxYear,
        accountingChoices: params.accountingChoices,
        valuationFacts: snapshot.factualLedger.valuationFacts,
      }).pipe(
        Effect.flatMap((result) =>
          calculationRunRepository.persist({
            id: params.id,
            principalId: params.principalId,
            reportingCurrency: params.reportingCurrency,
            inputLedgerRevision: snapshot.inputLedgerRevision,
            valuationRevision: snapshot.valuationRevision,
            result,
          })
        ),
        Effect.onError((originalCause) =>
          calculationRunRepository
            .fail({
              id: params.id,
              principalId: params.principalId,
              failureCode: CALCULATION_FAILED_CODE,
            })
            .pipe(
              Effect.catchCause((settlementCause) =>
                Effect.logError(
                  {
                    runId: params.id,
                    principalId: params.principalId,
                    originalCause,
                    settlementCause,
                  },
                  "calculation-run-service:failure-settlement-failed"
                )
              )
            )
        )
      )
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(CalculationRunAlreadyStoredError)(error) ||
        Schema.is(CalculationRunCurrencyMismatchError)(error) ||
        Schema.is(PersistenceError)(error) ||
        isTaxAccountingError(error)
          ? error
          : new PersistenceError({ operation: "calculationRunService.recompute", cause: error })
      )
    )

  return CalculationRunService.of({ recompute })
})

/** Live full-run orchestration over PostgreSQL and the pure accounting engine. */
export const CalculationRunServiceLive = Layer.effect(CalculationRunService, make)
