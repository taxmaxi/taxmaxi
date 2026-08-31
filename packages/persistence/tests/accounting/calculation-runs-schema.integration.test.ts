import { NodeServices } from "@effect/platform-node"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { and, eq, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const CALCULATION_RUN_ID = "00000000-0000-4000-8000-000000000701"
const OTHER_CALCULATION_RUN_ID = "00000000-0000-4000-8000-000000000702"
const ACQUISITION_EVENT_ID = "00000000-0000-4000-8000-000000000703"
const DISPOSITION_EVENT_ID = "00000000-0000-4000-8000-000000000704"
const CLAIMING_USER_ID = "00000000-0000-4000-8000-000000000705"
const CLAIMING_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000706"
const GROUPED_CUSTODY_UNIT_ID = "00000000-0000-4000-8000-000000000707"
const MISSING_SOURCE_ID = "00000000-0000-4000-8000-000000000708"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_calculation_runs_schema",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const insertRun = ({ id, taxYear = 2025 }: { readonly id: string; readonly taxYear?: number }) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.calculationRuns).values({
      id,
      principalId: TEST_PRINCIPAL_ID,
      jurisdiction: "DE",
      taxYear,
      reportingCurrency: "EUR",
      engineVersion: "1",
      ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
      inputLedgerRevision: "ledger-17",
      valuationRevision: "prices-9",
      status: "complete",
      accountingMethod: "fifo",
      inventoryScope: "per_custody_unit",
      appliedChoiceIds: [],
      appliedRules: ["de.private.section23.wallet-fifo-method"],
      processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
      completedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T08:00:00.000Z")),
    })
  })

describe("calculation-runs schema", () => {
  it.effect("stores a complete run result under one immutable run key", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)

          const db = yield* drizzle
          yield* insertRun({ id: CALCULATION_RUN_ID })
          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunCustodyUnitSources).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })

          const acquiredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T10:00:00.000Z"))
          const disposedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z"))

          yield* db.insert(schema.calculationRunAllocations).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
          })
          yield* db.insert(schema.calculationRunRealizedResults).values({
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            sourceId: TEST_SOURCE_ID,
            allocationSequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
            proceeds: "15000",
            gainLoss: "5000",
            treatmentCodes: ["de.tax_free_holding_period"],
          })
          yield* db.insert(schema.calculationRunIncomeResults).values({
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            sourceId: TEST_SOURCE_ID,
            eventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            occurredAt: acquiredAt,
            quantity: "0.01",
            value: "250",
            treatmentCodes: ["de.taxable_income_section22_3_staking"],
          })
          yield* db.insert(schema.calculationRunDerivedLots).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            acquiredAt,
            remainingQuantity: "0.75",
            costBasisPerUnit: "40000",
          })
          yield* db.insert(schema.calculationRunBlockers).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            code: "missing_valuation",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            missingQuantity: null,
          })
          yield* db.insert(schema.calculationRunExplanationEntries).values({
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            eventId: DISPOSITION_EVENT_ID,
            code: "fifo_matched",
            valuationKind: "observed_consideration",
            matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: "0.25" }],
          })
          yield* db.insert(schema.activeCalculationRuns).values({
            principalId: TEST_PRINCIPAL_ID,
            jurisdiction: "DE",
            taxYear: 2025,
            reportingCurrency: "EUR",
            runId: CALCULATION_RUN_ID,
          })

          const [storedRun] = yield* db
            .select({ status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, CALCULATION_RUN_ID))
          const [storedLot] = yield* db
            .select({ custodyUnitId: schema.calculationRunDerivedLots.custodyUnitId })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, CALCULATION_RUN_ID))
          const [activeRun] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(
              and(
                eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID),
                eq(schema.activeCalculationRuns.taxYear, 2025)
              )
            )

          expect(storedRun?.status).toBe("complete")
          expect(storedLot?.custodyUnitId).toBe(TEST_SOURCE_ID)
          expect(activeRun?.runId).toBe(CALCULATION_RUN_ID)
        })
      )
    )
  )

  it.effect("rejects an active pointer whose scope differs from its run", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          yield* insertRun({ id: OTHER_CALCULATION_RUN_ID, taxYear: 2024 })
          const db = yield* drizzle

          const failure = yield* Effect.result(
            db.insert(schema.activeCalculationRuns).values({
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: "DE",
              taxYear: 2025,
              reportingCurrency: "EUR",
              runId: OTHER_CALCULATION_RUN_ID,
            })
          )

          expect(failure._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("requires result attribution to reference the frozen source and exact allocation", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          yield* insertRun({ id: CALCULATION_RUN_ID })
          const db = yield* drizzle
          const acquiredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T10:00:00.000Z"))
          const disposedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-02T10:00:00.000Z"))

          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunCustodyUnitSources).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunAllocations).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            sequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_SOURCE_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
          })

          const realizedBase = {
            runId: CALCULATION_RUN_ID,
            sequence: 0,
            sourceId: TEST_SOURCE_ID,
            allocationSequence: 0,
            acquisitionEventId: ACQUISITION_EVENT_ID,
            dispositionEventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            acquiredAt,
            disposedAt,
            quantity: "0.25",
            costBasis: "10000",
            proceeds: "15000",
            gainLoss: "5000",
            treatmentCodes: ["de.tax_free_holding_period"],
          }
          const missingAllocation = yield* Effect.result(
            db
              .insert(schema.calculationRunRealizedResults)
              .values({ ...realizedBase, allocationSequence: 7 })
          )
          const missingRealizedSource = yield* Effect.result(
            db
              .insert(schema.calculationRunRealizedResults)
              .values({ ...realizedBase, sourceId: MISSING_SOURCE_ID })
          )
          const missingIncomeSource = yield* Effect.result(
            db.insert(schema.calculationRunIncomeResults).values({
              runId: CALCULATION_RUN_ID,
              sequence: 0,
              sourceId: MISSING_SOURCE_ID,
              eventId: ACQUISITION_EVENT_ID,
              assetId: TEST_BTC_ASSET_ID,
              occurredAt: acquiredAt,
              quantity: "0.01",
              value: "250",
              treatmentCodes: ["de.taxable_income_section22_3_staking"],
            })
          )

          expect(missingAllocation._tag).toBe("Failure")
          expect(missingRealizedSource._tag).toBe("Failure")
          expect(missingIncomeSource._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("moves live custody ownership without rewriting a historical run snapshot", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          yield* insertRun({ id: CALCULATION_RUN_ID })
          const db = yield* drizzle

          yield* db.insert(schema.calculationRunCustodyUnits).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.calculationRunCustodyUnitSources).values({
            runId: CALCULATION_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })
          yield* db.insert(schema.custodyUnits).values({
            id: GROUPED_CUSTODY_UNIT_ID,
            principalId: TEST_PRINCIPAL_ID,
          })
          yield* db
            .update(schema.custodyUnitSources)
            .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
          yield* db.insert(schema.users).values({
            id: CLAIMING_USER_ID,
            email: "calculation-run-claim@taxmaxi.test",
            name: "Calculation Run Claim User",
          })
          yield* db.insert(schema.principals).values({
            id: CLAIMING_PRINCIPAL_ID,
            kind: "user",
            userId: CLAIMING_USER_ID,
          })
          yield* db
            .update(schema.sources)
            .set({ principalId: CLAIMING_PRINCIPAL_ID })
            .where(eq(schema.sources.id, TEST_SOURCE_ID))

          const [unit] = yield* db
            .select({ principalId: schema.custodyUnits.principalId })
            .from(schema.custodyUnits)
            .where(eq(schema.custodyUnits.id, GROUPED_CUSTODY_UNIT_ID))
          const [membership] = yield* db
            .select({ principalId: schema.custodyUnitSources.principalId })
            .from(schema.custodyUnitSources)
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
          const [snapshot] = yield* db
            .select({
              principalId: schema.calculationRunCustodyUnitSources.principalId,
              custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
              sourceId: schema.calculationRunCustodyUnitSources.sourceId,
            })
            .from(schema.calculationRunCustodyUnitSources)
            .where(eq(schema.calculationRunCustodyUnitSources.runId, CALCULATION_RUN_ID))

          expect(unit?.principalId).toBe(CLAIMING_PRINCIPAL_ID)
          expect(membership?.principalId).toBe(CLAIMING_PRINCIPAL_ID)
          expect(snapshot).toEqual({
            principalId: TEST_PRINCIPAL_ID,
            custodyUnitId: TEST_SOURCE_ID,
            sourceId: TEST_SOURCE_ID,
          })
        })
      )
    )
  )

  it.effect("hard-deletes unattributed runs before adding required result attribution", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const migrationPath = yield* path.fromFileUrl(
        new URL("../../drizzle/20260831221014_fuzzy_korg/migration.sql", import.meta.url)
      )
      const migrationSql = yield* fileSystem.readFileString(migrationPath)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const fixture = yield* seedSyncEngineRepositoryFixture()
            yield* seedSyncEngineAssets(fixture)
            const db = yield* drizzle

            yield* db.execute(
              sql`alter table calculation_run_income_results drop constraint calculation_run_income_results_run_source_fk`
            )
            yield* db.execute(
              sql`alter table calculation_run_realized_results drop constraint calculation_run_realized_results_run_source_fk`
            )
            yield* db.execute(
              sql`alter table calculation_run_realized_results drop constraint calculation_run_realized_results_run_allocation_fk`
            )
            yield* db.execute(sql`alter table calculation_run_income_results drop column source_id`)
            yield* db.execute(
              sql`alter table calculation_run_realized_results drop column source_id`
            )
            yield* db.execute(
              sql`alter table calculation_run_realized_results drop column allocation_sequence`
            )

            yield* insertRun({ id: CALCULATION_RUN_ID })
            yield* db.insert(schema.calculationRunCustodyUnits).values({
              runId: CALCULATION_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              custodyUnitId: TEST_SOURCE_ID,
            })
            yield* db.insert(schema.calculationRunCustodyUnitSources).values({
              runId: CALCULATION_RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              custodyUnitId: TEST_SOURCE_ID,
              sourceId: TEST_SOURCE_ID,
            })
            yield* db.insert(schema.activeCalculationRuns).values({
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: "DE",
              taxYear: 2025,
              reportingCurrency: "EUR",
              runId: CALCULATION_RUN_ID,
            })
            yield* db.execute(sql`
              insert into calculation_run_allocations (
                run_id, principal_id, sequence, acquisition_event_id, disposition_event_id,
                asset_id, custody_unit_id, acquired_at, disposed_at, quantity, cost_basis
              ) values (
                ${CALCULATION_RUN_ID}, ${TEST_PRINCIPAL_ID}, 0, ${ACQUISITION_EVENT_ID},
                ${DISPOSITION_EVENT_ID}, ${TEST_BTC_ASSET_ID}, ${TEST_SOURCE_ID},
                '2024-01-01T10:00:00.000Z', '2025-01-02T10:00:00.000Z', 0.25, 10000
              )
            `)
            yield* db.execute(sql`
              insert into calculation_run_realized_results (
                run_id, sequence, acquisition_event_id, disposition_event_id, asset_id,
                acquired_at, disposed_at, quantity, cost_basis, proceeds, gain_loss,
                treatment_codes
              ) values (
                ${CALCULATION_RUN_ID}, 0, ${ACQUISITION_EVENT_ID}, ${DISPOSITION_EVENT_ID},
                ${TEST_BTC_ASSET_ID}, '2024-01-01T10:00:00.000Z',
                '2025-01-02T10:00:00.000Z', 0.25, 10000, 15000, 5000,
                '["de.tax_free_holding_period"]'::jsonb
              )
            `)
            yield* db.execute(sql`
              insert into calculation_run_income_results (
                run_id, sequence, event_id, asset_id, occurred_at, quantity, value,
                treatment_codes
              ) values (
                ${CALCULATION_RUN_ID}, 0, ${ACQUISITION_EVENT_ID}, ${TEST_BTC_ASSET_ID},
                '2024-01-01T10:00:00.000Z', 0.01, 250,
                '["de.taxable_income_section22_3_staking"]'::jsonb
              )
            `)

            for (const statement of migrationSql
              .split("--> statement-breakpoint")
              .map((part) => part.trim())
              .filter((part) => part.length > 0)) {
              yield* db.execute(sql.raw(statement))
            }

            const [remaining] = yield* db
              .select({
                runs: sql<number>`count(distinct ${schema.calculationRuns.id})::int`,
                realized: sql<number>`count(distinct ${schema.calculationRunRealizedResults.runId})::int`,
                income: sql<number>`count(distinct ${schema.calculationRunIncomeResults.runId})::int`,
              })
              .from(schema.calculationRuns)
              .fullJoin(
                schema.calculationRunRealizedResults,
                eq(schema.calculationRunRealizedResults.runId, schema.calculationRuns.id)
              )
              .fullJoin(
                schema.calculationRunIncomeResults,
                eq(schema.calculationRunIncomeResults.runId, schema.calculationRuns.id)
              )
            const [pointer] = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
              .where(eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID))

            expect(remaining).toEqual({ runs: 0, realized: 0, income: 0 })
            expect(pointer).toEqual({ runId: null })
          })
        )
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )

  it.effect("backfills one custody unit per existing source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const migrationPath = yield* path.fromFileUrl(
        new URL("../../drizzle/20260830232618_tidy_mystique/migration.sql", import.meta.url)
      )
      const migrationSql = yield* fileSystem.readFileString(migrationPath)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.execute(sql`drop trigger sources_create_default_custody_unit on sources`)
            yield* db.execute(sql`drop function create_default_custody_unit_for_source`)
            yield* db.execute(sql`drop trigger sources_move_custody_unit_principal on sources`)
            yield* db.execute(sql`drop function move_custody_unit_with_source_principal`)
            yield* db.execute(sql`drop table active_calculation_runs`)
            yield* db.execute(sql`drop table calculation_run_explanation_entries`)
            yield* db.execute(sql`drop table calculation_run_blockers`)
            yield* db.execute(sql`drop table calculation_run_derived_lots`)
            yield* db.execute(sql`drop table calculation_run_income_results`)
            yield* db.execute(sql`drop table calculation_run_realized_results`)
            yield* db.execute(sql`drop table calculation_run_allocations`)
            yield* db.execute(sql`drop table calculation_run_custody_unit_sources`)
            yield* db.execute(sql`drop table calculation_run_custody_units`)
            yield* db.execute(sql`drop table calculation_runs`)
            yield* db.execute(sql`drop table custody_unit_sources`)
            yield* db.execute(sql`drop table custody_units`)
            yield* db.execute(sql`alter table sources drop constraint sources_id_principal_unique`)
            yield* db.execute(sql`drop type calculation_run_inventory_scope`)
            yield* db.execute(sql`drop type calculation_run_status`)
            yield* seedSyncEngineRepositoryFixture()

            for (const statement of migrationSql
              .split("--> statement-breakpoint")
              .map((part) => part.trim())
              .filter((part) => part.length > 0)) {
              yield* db.execute(sql.raw(statement))
            }

            const associations = yield* db
              .select({
                sourceId: schema.custodyUnitSources.sourceId,
                custodyUnitId: schema.custodyUnitSources.custodyUnitId,
              })
              .from(schema.custodyUnitSources)

            expect(associations).toEqual([
              { sourceId: TEST_SOURCE_ID, custodyUnitId: TEST_SOURCE_ID },
            ])
          })
        )
      )
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
