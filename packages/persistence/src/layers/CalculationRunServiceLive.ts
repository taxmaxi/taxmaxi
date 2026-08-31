/**
 * CalculationRunServiceLive - Repeatable-read full calculation runs.
 *
 * @module CalculationRunServiceLive
 */

import {
  AccountingChoiceResolutionError,
  calculate,
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
  events,
  custodyUnitMembership,
}: {
  readonly snapshotTransactionId: string
  readonly events: ReadonlyArray<AccountingEvent>
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
}): InputLedgerRevision =>
  InputLedgerRevision.make(
    `v1:${snapshotTransactionId}:${sha256("taxmaxi:factual-ledger:v1", {
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

  const recompute: CalculationRunServiceShape["recompute"] = (params) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.execute(sql`set transaction isolation level repeatable read`)
          const snapshotTransactionRows = yield* tx
            .select({ transactionId: sql<string>`pg_current_xact_id()::text` })
            .from(schema.principals)
            .where(eq(schema.principals.id, params.principalId))
            .limit(1)
          const snapshotTransactionId = snapshotTransactionRows[0]?.transactionId

          if (snapshotTransactionId === undefined) {
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
            events: factualLedger.events,
            custodyUnitMembership: factualLedger.custodyUnitMembership,
          })
          const valuationRevision = makeValuationRevision(factualLedger.valuationFacts)
          const result = yield* calculate({
            ledger: factualLedger.events,
            jurisdiction: params.jurisdiction,
            taxYear: params.taxYear,
            accountingChoices: params.accountingChoices,
            valuationFacts: factualLedger.valuationFacts,
          })

          return yield* calculationRunRepository.persist({
            id: params.id,
            principalId: params.principalId,
            reportingCurrency: params.reportingCurrency,
            inputLedgerRevision,
            valuationRevision,
            result,
          })
        })
      )
      .pipe(
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
