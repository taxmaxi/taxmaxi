/**
 * CalculationRunRepositoryLive - Drizzle-backed write-once calculation runs.
 *
 * @module CalculationRunRepositoryLive
 */

import type { TaxAccountingResult } from "@my/accounting"
import { format as formatQuantity } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  notExists,
  or,
  sql,
  lte,
} from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  CalculationRunResumeMismatchError,
  CalculationRunRepository,
  CalculationRunTriggerRepository,
  type BeginCalculationRunParams,
  type FailCalculationRunParams,
  type FailSupersededCalculationRunsParams,
  type CalculationRunRepositoryShape,
  type PersistCalculationRunParams,
  type RecoverableTerminalCalculationPrincipal,
} from "../services/CalculationRunRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const INSERT_BATCH_ROW_COUNT = 500
const ACTIVE_PROCESSING_JOB_STATUSES = ["pending", "processing"] as const
const TERMINAL_PROCESSING_JOB_STATUSES = ["completed", "failed", "credit_required"] as const

const writeBatches = <Row, Error, Requirements>(
  rows: ReadonlyArray<Row>,
  writeBatch: (batch: [Row, ...Array<Row>]) => Effect.Effect<unknown, Error, Requirements>
): Effect.Effect<void, Error, Requirements> =>
  Effect.gen(function* () {
    for (let start = 0; start < rows.length; start += INSERT_BATCH_ROW_COUNT) {
      const first = rows[start]

      if (first !== undefined) {
        yield* writeBatch([first, ...rows.slice(start + 1, start + INSERT_BATCH_ROW_COUNT)])
      }
    }
  })

const resultCurrencies = (result: TaxAccountingResult): ReadonlyArray<CurrencyCode> => [
  ...result.allocations.flatMap(({ costBasis }) =>
    costBasis === null ? [] : [costBasis.currency]
  ),
  ...result.realizedResults.flatMap(({ costBasis, proceeds, gainLoss }) => [
    costBasis.currency,
    proceeds.currency,
    gainLoss.currency,
  ]),
  ...result.incomeResults.map(({ value }) => value.currency),
  ...result.derivedLots.flatMap(({ costBasisPerUnit }) =>
    costBasisPerUnit === null ? [] : [costBasisPerUnit.currency]
  ),
]

const validateReportingCurrency = ({
  id,
  reportingCurrency,
  result,
}: Pick<PersistCalculationRunParams, "id" | "reportingCurrency" | "result">) => {
  const mismatchedCurrency = resultCurrencies(result).find(
    (currency) => currency !== reportingCurrency
  )

  return mismatchedCurrency === undefined
    ? Effect.void
    : Effect.fail(
        new CalculationRunCurrencyMismatchError({
          runId: id,
          expected: reportingCurrency,
          actual: mismatchedCurrency,
        })
      )
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type CalculationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
  interface WriteContext {
    readonly tx: CalculationTransaction
    readonly params: PersistCalculationRunParams
    readonly result: TaxAccountingResult
    readonly startedAt: Date
  }

  const runResumeMismatchReason = ({
    row,
    params,
  }: {
    readonly row: {
      readonly principalId: string
      readonly jurisdiction: string
      readonly taxYear: number
      readonly reportingCurrency: string
      readonly engineVersion: string
      readonly ruleSetVersion: string
      readonly inputLedgerRevision: string
      readonly valuationRevision: string
    }
    readonly params: BeginCalculationRunParams
  }): CalculationRunResumeMismatchError["reason"] | null => {
    const metadataMatches =
      row.principalId === params.principalId &&
      row.jurisdiction === params.jurisdiction &&
      row.taxYear === params.taxYear &&
      row.reportingCurrency === params.reportingCurrency &&
      row.engineVersion === params.engineVersion &&
      row.ruleSetVersion === params.ruleSetVersion
    const inputRevisionsMatch =
      row.inputLedgerRevision === params.inputLedgerRevision &&
      row.valuationRevision === params.valuationRevision

    if (metadataMatches && inputRevisionsMatch) return null
    if (!metadataMatches && !inputRevisionsMatch) return "input_revision_and_run_metadata"
    return metadataMatches ? "input_revision" : "run_metadata"
  }

  const begin = (params: BeginCalculationRunParams) =>
    Effect.gen(function* () {
      const startedAt = yield* DateTime.nowAsDate
      const inserted = yield* db
        .insert(schema.calculationRuns)
        .values({
          id: params.id,
          principalId: params.principalId,
          jurisdiction: params.jurisdiction,
          taxYear: params.taxYear,
          reportingCurrency: params.reportingCurrency,
          engineVersion: params.engineVersion,
          ruleSetVersion: params.ruleSetVersion,
          inputLedgerRevision: params.inputLedgerRevision,
          valuationRevision: params.valuationRevision,
          status: "running",
          accountingMethod: null,
          inventoryScope: null,
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [],
          startedAt,
          completedAt: null,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .onConflictDoNothing({ target: schema.calculationRuns.id })
        .returning({ id: schema.calculationRuns.id })

      if (inserted.length === 0) {
        const [existingRun] = yield* db
          .select({
            principalId: schema.calculationRuns.principalId,
            jurisdiction: schema.calculationRuns.jurisdiction,
            taxYear: schema.calculationRuns.taxYear,
            reportingCurrency: schema.calculationRuns.reportingCurrency,
            engineVersion: schema.calculationRuns.engineVersion,
            ruleSetVersion: schema.calculationRuns.ruleSetVersion,
            inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
            valuationRevision: schema.calculationRuns.valuationRevision,
            status: schema.calculationRuns.status,
          })
          .from(schema.calculationRuns)
          .where(eq(schema.calculationRuns.id, params.id))
          .limit(1)

        if (existingRun === undefined || existingRun.status !== "running") {
          return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
        }

        const mismatchReason = runResumeMismatchReason({ row: existingRun, params })
        if (mismatchReason !== null) {
          return yield* new CalculationRunResumeMismatchError({
            runId: params.id,
            reason: mismatchReason,
          })
        }
      }
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(CalculationRunAlreadyStoredError)(error) ||
        Schema.is(CalculationRunResumeMismatchError)(error)
          ? error
          : new PersistenceError({ operation: "calculationRunRepository.begin", cause: error })
      )
    )

  const claimRun = ({ tx, params, result, startedAt }: WriteContext) =>
    Effect.gen(function* () {
      const claimedRuns = yield* tx
        .insert(schema.calculationRuns)
        .values({
          id: params.id,
          principalId: params.principalId,
          jurisdiction: result.jurisdiction,
          taxYear: result.taxYear,
          reportingCurrency: params.reportingCurrency,
          engineVersion: result.engineVersion,
          ruleSetVersion: result.ruleSetVersion,
          inputLedgerRevision: params.inputLedgerRevision,
          valuationRevision: params.valuationRevision,
          status: "pending",
          accountingMethod: null,
          inventoryScope: null,
          appliedChoiceIds: [],
          appliedRules: [],
          processedEventIds: [],
          startedAt,
          completedAt: null,
          createdAt: startedAt,
          updatedAt: startedAt,
        })
        .onConflictDoNothing({ target: schema.calculationRuns.id })
        .returning({ id: schema.calculationRuns.id })

      if (claimedRuns.length === 0) {
        const [startedRun] = yield* tx
          .select({
            principalId: schema.calculationRuns.principalId,
            jurisdiction: schema.calculationRuns.jurisdiction,
            taxYear: schema.calculationRuns.taxYear,
            reportingCurrency: schema.calculationRuns.reportingCurrency,
            engineVersion: schema.calculationRuns.engineVersion,
            ruleSetVersion: schema.calculationRuns.ruleSetVersion,
            inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
            valuationRevision: schema.calculationRuns.valuationRevision,
            status: schema.calculationRuns.status,
          })
          .from(schema.calculationRuns)
          .where(eq(schema.calculationRuns.id, params.id))
          .limit(1)
          .for("update")

        if (
          startedRun === undefined ||
          startedRun.status !== "running" ||
          runResumeMismatchReason({
            row: startedRun,
            params: {
              id: params.id,
              principalId: params.principalId,
              jurisdiction: result.jurisdiction,
              taxYear: result.taxYear,
              reportingCurrency: params.reportingCurrency,
              engineVersion: result.engineVersion,
              ruleSetVersion: result.ruleSetVersion,
              inputLedgerRevision: params.inputLedgerRevision,
              valuationRevision: params.valuationRevision,
            },
          }) !== null
        ) {
          return yield* new CalculationRunAlreadyStoredError({ runId: params.id })
        }
      }

      yield* validateReportingCurrency(params)
    })

  const snapshotCustodyMembership = ({ tx, params }: WriteContext) =>
    Effect.gen(function* () {
      const custodyUnits = [
        ...new Map(
          params.custodyUnitMemberships.map(({ custodyUnitId }) => [
            custodyUnitId,
            { runId: params.id, principalId: params.principalId, custodyUnitId },
          ])
        ).values(),
      ]
      const custodyUnitSources = params.custodyUnitMemberships.map(
        ({ custodyUnitId, sourceId }) => ({
          runId: params.id,
          principalId: params.principalId,
          custodyUnitId,
          sourceId,
        })
      )

      yield* writeBatches(custodyUnits, (batch) =>
        tx.insert(schema.calculationRunCustodyUnits).values(batch)
      )
      yield* writeBatches(custodyUnitSources, (batch) =>
        tx.insert(schema.calculationRunCustodyUnitSources).values(batch)
      )
    })

  const writeAllocations = ({ tx, params, result }: WriteContext) => {
    const rows = result.allocations.map((allocation, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      acquisitionEventId: allocation.acquisitionEventId,
      dispositionEventId: allocation.dispositionEventId,
      assetId: allocation.assetId,
      custodyUnitId: allocation.custodyUnitId,
      acquiredAt: allocation.acquiredAt.toDate(),
      disposedAt: allocation.disposedAt.toDate(),
      quantity: formatQuantity(allocation.quantity),
      costBasis: allocation.costBasis?.format() ?? null,
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunAllocations).values(batch))
  }

  const writeRealizedResults = ({ tx, params, result }: WriteContext) => {
    const rows = result.realizedResults.map((realized, sequence) => ({
      runId: params.id,
      sequence,
      acquisitionEventId: realized.acquisitionEventId,
      dispositionEventId: realized.dispositionEventId,
      assetId: realized.assetId,
      acquiredAt: realized.acquiredAt.toDate(),
      disposedAt: realized.disposedAt.toDate(),
      quantity: formatQuantity(realized.quantity),
      costBasis: realized.costBasis.format(),
      proceeds: realized.proceeds.format(),
      gainLoss: realized.gainLoss.format(),
      treatmentCodes: realized.treatmentCodes,
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunRealizedResults).values(batch)
    )
  }

  const writeIncomeResults = ({ tx, params, result }: WriteContext) => {
    const rows = result.incomeResults.map((income, sequence) => ({
      runId: params.id,
      sequence,
      eventId: income.eventId,
      assetId: income.assetId,
      occurredAt: income.occurredAt.toDate(),
      quantity: formatQuantity(income.quantity),
      value: income.value.format(),
      treatmentCodes: income.treatmentCodes,
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunIncomeResults).values(batch)
    )
  }

  const writeDerivedLots = ({ tx, params, result }: WriteContext) => {
    const rows = result.derivedLots.map((lot, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      acquisitionEventId: lot.acquisitionEventId,
      assetId: lot.assetId,
      custodyUnitId: lot.custodyUnitId,
      acquiredAt: lot.acquiredAt.toDate(),
      remainingQuantity: formatQuantity(lot.remainingQuantity),
      costBasisPerUnit: lot.costBasisPerUnit?.format() ?? null,
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunDerivedLots).values(batch))
  }

  const writeBlockers = ({ tx, params, result }: WriteContext) => {
    const rows = result.blockers.map((blocker, sequence) => ({
      runId: params.id,
      principalId: params.principalId,
      sequence,
      code: blocker.code,
      eventId: blocker.eventId,
      assetId: blocker.assetId,
      custodyUnitId: blocker.custodyUnitId,
      missingQuantity:
        blocker.missingQuantity === null ? null : formatQuantity(blocker.missingQuantity),
    }))

    return writeBatches(rows, (batch) => tx.insert(schema.calculationRunBlockers).values(batch))
  }

  const writeExplanations = ({ tx, params, result }: WriteContext) => {
    const rows = result.explanationTrace.map((entry) => ({
      runId: params.id,
      sequence: entry.sequence,
      eventId: entry.eventId,
      code: entry.code,
      valuationKind: entry.valuationKind,
      matches: entry.matches.map((match) => ({
        acquisitionEventId: match.acquisitionEventId,
        quantity: formatQuantity(match.quantity),
      })),
    }))

    return writeBatches(rows, (batch) =>
      tx.insert(schema.calculationRunExplanationEntries).values(batch)
    )
  }

  const finalizeRun = ({ tx, params, result }: WriteContext) =>
    Effect.gen(function* () {
      const completedAt = yield* DateTime.nowAsDate

      yield* tx
        .update(schema.calculationRuns)
        .set({
          status: result.status,
          accountingMethod: result.accountingMethod,
          inventoryScope: result.inventoryScope,
          appliedChoiceIds: result.appliedChoiceIds,
          appliedRules: result.appliedRules,
          processedEventIds: result.processedEventIds,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(schema.calculationRuns.id, params.id))

      return completedAt
    })

  const activateRun = ({
    tx,
    params,
    result,
    completedAt,
  }: WriteContext & { readonly completedAt: Date }) =>
    tx
      .insert(schema.activeCalculationRuns)
      .values({
        principalId: params.principalId,
        jurisdiction: result.jurisdiction,
        taxYear: result.taxYear,
        reportingCurrency: params.reportingCurrency,
        runId: params.id,
        updatedAt: completedAt,
      })
      .onConflictDoUpdate({
        target: [
          schema.activeCalculationRuns.principalId,
          schema.activeCalculationRuns.jurisdiction,
          schema.activeCalculationRuns.taxYear,
          schema.activeCalculationRuns.reportingCurrency,
        ],
        set: { runId: params.id, updatedAt: completedAt },
      })

  const persist: CalculationRunRepositoryShape["persist"] = (params) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const startedAt = yield* DateTime.nowAsDate
          const { result } = params
          const context = { tx, params, result, startedAt }

          yield* claimRun(context)
          yield* snapshotCustodyMembership(context)
          yield* writeAllocations(context)
          yield* writeRealizedResults(context)
          yield* writeIncomeResults(context)
          yield* writeDerivedLots(context)
          yield* writeBlockers(context)
          yield* writeExplanations(context)
          const completedAt = yield* finalizeRun(context)
          yield* activateRun({ ...context, completedAt })
        })
      )
      .pipe(
        Effect.mapError((error) =>
          Schema.is(CalculationRunAlreadyStoredError)(error) ||
          Schema.is(CalculationRunCurrencyMismatchError)(error)
            ? error
            : new PersistenceError({
                operation: "calculationRunRepository.persist",
                cause: error,
              })
        )
      )

  const fail = ({ id, failureCode, failureMessage }: FailCalculationRunParams) =>
    Effect.gen(function* () {
      const completedAt = yield* DateTime.nowAsDate
      const failed = yield* db
        .update(schema.calculationRuns)
        .set({
          status: "failed",
          failureCode,
          failureMessage,
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(eq(schema.calculationRuns.id, id), eq(schema.calculationRuns.status, "running")))
        .returning({ id: schema.calculationRuns.id })

      if (failed.length === 0) {
        return yield* new CalculationRunAlreadyStoredError({ runId: id })
      }
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(CalculationRunAlreadyStoredError)(error)
          ? error
          : new PersistenceError({ operation: "calculationRunRepository.fail", cause: error })
      )
    )

  const failSuperseded = ({
    principalId,
    latestRunId,
    failureCode,
    failureMessage,
  }: FailSupersededCalculationRunsParams) =>
    Effect.gen(function* () {
      const completedAt = yield* DateTime.nowAsDate
      const supersededCompletedJobs = db
        .select({ id: schema.processingJobs.id })
        .from(schema.processingJobs)
        .where(
          and(
            eq(schema.processingJobs.principalId, principalId),
            eq(schema.processingJobs.status, "completed"),
            ne(schema.processingJobs.id, latestRunId)
          )
        )
      const failed = yield* db
        .update(schema.calculationRuns)
        .set({
          status: "failed",
          failureCode,
          failureMessage,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(schema.calculationRuns.principalId, principalId),
            eq(schema.calculationRuns.status, "running"),
            inArray(schema.calculationRuns.id, supersededCompletedJobs)
          )
        )
        .returning({ id: schema.calculationRuns.id })

      return failed.length
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceError({
            operation: "calculationRunRepository.failSuperseded",
            cause,
          })
      )
    )

  return CalculationRunRepository.of({ begin, persist, fail, failSuperseded })
})

const CalculationRunWriterLive = Layer.effect(CalculationRunRepository, make)

const makeTriggerRepository = Effect.gen(function* () {
  const db = yield* drizzle
  const recoveryCursor = yield* SynchronizedRef.make<string | null>(null)

  const hasActivePrincipalJobs = ({ principalId }: { readonly principalId: string }) =>
    db
      .select({ count: sql<number>`count(*)::integer` })
      .from(schema.processingJobs)
      .where(
        and(
          eq(schema.processingJobs.principalId, principalId),
          inArray(schema.processingJobs.status, ACTIVE_PROCESSING_JOB_STATUSES)
        )
      )
      .pipe(
        Effect.map(([row]) => (row?.count ?? 0) > 0),
        Effect.mapError(
          (cause) =>
            new PersistenceError({
              operation: "calculationRunTriggerRepository.hasActivePrincipalJobs",
              cause,
            })
        )
      )

  const findLatestCompletedJob = ({ principalId }: { readonly principalId: string }) =>
    db
      .select({ id: schema.processingJobs.id })
      .from(schema.processingJobs)
      .where(
        and(
          eq(schema.processingJobs.principalId, principalId),
          eq(schema.processingJobs.status, "completed")
        )
      )
      .orderBy(desc(schema.processingJobs.completedAt), desc(schema.processingJobs.id))
      .limit(1)
      .pipe(
        Effect.map(([job]) => job ?? null),
        Effect.mapError(
          (cause) =>
            new PersistenceError({
              operation: "calculationRunTriggerRepository.findLatestCompletedJob",
              cause,
            })
        )
      )

  const findTerminalJob = ({ jobId }: { readonly jobId: string }) =>
    db
      .select({
        sourceId: schema.processingJobs.sourceId,
        principalId: schema.processingJobs.principalId,
        status: schema.processingJobs.status,
      })
      .from(schema.processingJobs)
      .where(
        and(
          eq(schema.processingJobs.id, jobId),
          inArray(schema.processingJobs.status, TERMINAL_PROCESSING_JOB_STATUSES)
        )
      )
      .limit(1)
      .pipe(
        Effect.map(([job]) => {
          if (
            job?.status !== "completed" &&
            job?.status !== "failed" &&
            job?.status !== "credit_required"
          ) {
            return null
          }

          return {
            sourceId: job.sourceId,
            principalId: job.principalId,
            status: job.status,
          }
        }),
        Effect.mapError(
          (cause) =>
            new PersistenceError({
              operation: "calculationRunTriggerRepository.findTerminalJob",
              cause,
            })
        )
      )

  const listRecoverableTerminalPrincipals = ({ limit }: { readonly limit: number }) => {
    const activeLatestJobs = aliasedTable(schema.processingJobs, "active_latest_jobs")
    const activeRunningJobs = aliasedTable(schema.processingJobs, "active_running_jobs")
    const latestCompletedJobs = db
      .selectDistinctOn([schema.processingJobs.principalId], {
        id: schema.processingJobs.id,
        principalId: schema.processingJobs.principalId,
        completedAt: schema.processingJobs.completedAt,
      })
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.status, "completed"))
      .orderBy(
        schema.processingJobs.principalId,
        desc(schema.processingJobs.completedAt),
        desc(schema.processingJobs.id)
      )
      .as("latest_completed_calculation_jobs")

    const listLatestCandidates = ({
      afterPrincipalId,
      throughPrincipalId,
    }: {
      readonly afterPrincipalId: string | null
      readonly throughPrincipalId: string | null
    }) =>
      db
        .select({ principalId: latestCompletedJobs.principalId })
        .from(latestCompletedJobs)
        .leftJoin(schema.calculationRuns, eq(schema.calculationRuns.id, latestCompletedJobs.id))
        .where(
          and(
            or(isNull(schema.calculationRuns.id), eq(schema.calculationRuns.status, "running")),
            notExists(
              db
                .select({ id: activeLatestJobs.id })
                .from(activeLatestJobs)
                .where(
                  and(
                    eq(activeLatestJobs.principalId, latestCompletedJobs.principalId),
                    inArray(activeLatestJobs.status, ACTIVE_PROCESSING_JOB_STATUSES)
                  )
                )
            ),
            afterPrincipalId === null
              ? undefined
              : gt(latestCompletedJobs.principalId, afterPrincipalId),
            throughPrincipalId === null
              ? undefined
              : lte(latestCompletedJobs.principalId, throughPrincipalId)
          )
        )
        .orderBy(asc(latestCompletedJobs.principalId))
        .limit(limit)

    const listRunningCandidates = ({
      afterPrincipalId,
      throughPrincipalId,
    }: {
      readonly afterPrincipalId: string | null
      readonly throughPrincipalId: string | null
    }) =>
      db
        .selectDistinctOn([schema.calculationRuns.principalId], {
          principalId: schema.calculationRuns.principalId,
        })
        .from(schema.calculationRuns)
        .innerJoin(schema.processingJobs, eq(schema.processingJobs.id, schema.calculationRuns.id))
        .where(
          and(
            eq(schema.calculationRuns.status, "running"),
            eq(schema.processingJobs.status, "completed"),
            notExists(
              db
                .select({ id: activeRunningJobs.id })
                .from(activeRunningJobs)
                .where(
                  and(
                    eq(activeRunningJobs.principalId, schema.calculationRuns.principalId),
                    inArray(activeRunningJobs.status, ACTIVE_PROCESSING_JOB_STATUSES)
                  )
                )
            ),
            afterPrincipalId === null
              ? undefined
              : gt(schema.calculationRuns.principalId, afterPrincipalId),
            throughPrincipalId === null
              ? undefined
              : lte(schema.calculationRuns.principalId, throughPrincipalId)
          )
        )
        .orderBy(schema.calculationRuns.principalId, asc(schema.calculationRuns.updatedAt))
        .limit(limit)

    const mergeCandidates = (
      ...pages: ReadonlyArray<ReadonlyArray<RecoverableTerminalCalculationPrincipal>>
    ) =>
      [
        ...new Map(pages.flat().map(({ principalId }) => [principalId, { principalId }])).values(),
      ].sort((left, right) => left.principalId.localeCompare(right.principalId))

    const scanRange = ({
      afterPrincipalId,
      throughPrincipalId,
    }: {
      readonly afterPrincipalId: string | null
      readonly throughPrincipalId: string | null
    }) =>
      Effect.all([
        listLatestCandidates({ afterPrincipalId, throughPrincipalId }),
        listRunningCandidates({ afterPrincipalId, throughPrincipalId }),
      ]).pipe(Effect.map(([latest, running]) => mergeCandidates(latest, running)))

    return SynchronizedRef.modifyEffect(recoveryCursor, (afterPrincipalId) =>
      Effect.gen(function* () {
        const forward = yield* scanRange({ afterPrincipalId, throughPrincipalId: null })
        const wrapped =
          forward.length >= limit || afterPrincipalId === null
            ? []
            : yield* scanRange({ afterPrincipalId: null, throughPrincipalId: afterPrincipalId })
        const forwardPage = forward.slice(0, limit)
        const forwardPrincipalIds = new Set(forwardPage.map(({ principalId }) => principalId))
        const selected = [
          ...forwardPage,
          ...wrapped
            .filter(({ principalId }) => !forwardPrincipalIds.has(principalId))
            .slice(0, limit - forwardPage.length),
        ]

        return [selected, selected.at(-1)?.principalId ?? null] as const
      })
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceError({
            operation: "calculationRunTriggerRepository.listRecoverableTerminalPrincipals",
            cause,
          })
      )
    )
  }

  return CalculationRunTriggerRepository.of({
    hasActivePrincipalJobs,
    findLatestCompletedJob,
    findTerminalJob,
    listRecoverableTerminalPrincipals,
  })
})

/** Live durable source-job reads for calculation orchestration. */
const CalculationRunTriggerRepositoryLive = Layer.effect(
  CalculationRunTriggerRepository,
  makeTriggerRepository
)

/** Live calculation-run write and trigger repositories backed by PostgreSQL. */
export const CalculationRunRepositoryLive = Layer.merge(
  CalculationRunWriterLive,
  CalculationRunTriggerRepositoryLive
)
