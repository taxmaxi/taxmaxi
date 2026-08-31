import { beforeEach, describe, expect, it } from "@effect/vitest"
import type { TaxAccountingResult } from "@my/accounting"
import {
  AccountingChoiceId,
  AccountingEventId,
  AccountingMethodId,
  AccountingQuantity,
  CustodyUnitId,
  JurisdictionCode,
  TaxYear,
} from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { SourceId } from "@my/core/source"
import { MonetaryAmount } from "@my/core/shared/values/MonetaryAmount"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import { asc, eq, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Deferred from "effect/Deferred"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { PersistenceError } from "../../src/errors/RepositoryError.ts"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema, type ProcessingJobInsert } from "../../src/schema/index.ts"
import {
  CalculationRunAlreadyStoredError,
  CalculationRunCurrencyMismatchError,
  CalculationRunId,
  CalculationRunRepository,
  CalculationRunTriggerRepository,
  InputLedgerRevision,
  ValuationRevision,
} from "../../src/services/CalculationRunRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000801")
const SECOND_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000805")
const THIRD_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000806")
const FOURTH_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000811")
const FIFTH_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000813")
const SIXTH_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000814")
const ACQUISITION_EVENT_ID = AccountingEventId.make("00000000-0000-4000-8000-000000000802")
const DISPOSITION_EVENT_ID = AccountingEventId.make("00000000-0000-4000-8000-000000000803")
const TEST_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const TEST_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const TEST_SOURCE = SourceId.make(TEST_SOURCE_ID)
const TEST_CUSTODY_UNIT_ID = CustodyUnitId.make(TEST_SOURCE_ID)
const MISSING_CUSTODY_UNIT_ID = CustodyUnitId.make("00000000-0000-4000-8000-000000000807")
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000808"
const OTHER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000809")
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000810"
const OTHER_CUSTODY_UNIT_ID = CustodyUnitId.make(OTHER_SOURCE_ID)
const GROUPED_CUSTODY_UNIT_ID = "00000000-0000-4000-8000-000000000812"
const ACTIONABLE_USER_ID = "00000000-0000-4000-8000-000000000815"
const ACTIONABLE_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000816")
const ACTIONABLE_SOURCE_ID = "00000000-0000-4000-8000-000000000817"
const EUR = CurrencyCode.make("EUR")
const USD = CurrencyCode.make("USD")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_calculation_run_repo",
})

const runPg = context.runPg

const runPgEffect = <A, E>(effect: Parameters<typeof runPg<A, E>>[0]) =>
  Effect.promise(() => runPg(effect))

const runRepository = <A, E>(effect: Effect.Effect<A, E, CalculationRunRepository>) =>
  context.runWithLayer({ effect, layer: CalculationRunRepositoryLive })

const runTriggerRepository = <A, E>(effect: Effect.Effect<A, E, CalculationRunTriggerRepository>) =>
  context.runWithLayer({ effect, layer: CalculationRunRepositoryLive })

const quantity = (value: string) => AccountingQuantity.make(BigDecimal.fromStringUnsafe(value))

const acquiredAt = Timestamp.make({ epochMillis: Date.parse("2024-01-01T10:00:00.000Z") })
const disposedAt = Timestamp.make({ epochMillis: Date.parse("2025-01-02T10:00:00.000Z") })

const completeResult = ({
  custodyUnitId = TEST_CUSTODY_UNIT_ID,
  currency = "EUR",
  jurisdiction = "DE",
  taxYear = 2025,
}: {
  readonly custodyUnitId?: CustodyUnitId
  readonly currency?: string
  readonly jurisdiction?: string
  readonly taxYear?: number
} = {}): TaxAccountingResult => ({
  status: "complete",
  jurisdiction: JurisdictionCode.make(jurisdiction),
  taxYear: TaxYear.make(taxYear),
  engineVersion: "1",
  ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
  accountingMethod: AccountingMethodId.make("fifo"),
  inventoryScope: "per_custody_unit",
  appliedChoiceIds: [AccountingChoiceId.make("00000000-0000-4000-8000-000000000804")],
  appliedRules: ["de.private.section23.wallet-fifo-method"],
  processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
  allocations: [
    {
      acquisitionEventId: ACQUISITION_EVENT_ID,
      dispositionEventId: DISPOSITION_EVENT_ID,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId,
      acquiredAt,
      disposedAt,
      quantity: quantity("0.25"),
      costBasis: MonetaryAmount.unsafeFromString("10000", currency),
    },
  ],
  realizedResults: [
    {
      acquisitionEventId: ACQUISITION_EVENT_ID,
      dispositionEventId: DISPOSITION_EVENT_ID,
      assetId: TEST_BTC_ASSET_ID,
      acquiredAt,
      disposedAt,
      quantity: quantity("0.25"),
      costBasis: MonetaryAmount.unsafeFromString("10000", currency),
      proceeds: MonetaryAmount.unsafeFromString("15000", currency),
      gainLoss: MonetaryAmount.unsafeFromString("5000", currency),
      treatmentCodes: ["de.tax_free_holding_period"],
    },
  ],
  incomeResults: [
    {
      eventId: ACQUISITION_EVENT_ID,
      assetId: TEST_BTC_ASSET_ID,
      occurredAt: acquiredAt,
      quantity: quantity("0.01"),
      value: MonetaryAmount.unsafeFromString("250", currency),
      treatmentCodes: ["de.taxable_income_section22_3_staking"],
    },
  ],
  derivedLots: [
    {
      acquisitionEventId: ACQUISITION_EVENT_ID,
      assetId: TEST_BTC_ASSET_ID,
      custodyUnitId,
      acquiredAt,
      remainingQuantity: quantity("0.75"),
      costBasisPerUnit: MonetaryAmount.unsafeFromString("40000", currency),
    },
  ],
  blockers: [],
  explanationTrace: [
    {
      sequence: 17,
      eventId: DISPOSITION_EVENT_ID,
      code: "fifo_matched",
      valuationKind: "observed_consideration",
      matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: quantity("0.25") }],
    },
  ],
})

const persistResult = ({
  id = RUN_ID,
  principalId = TEST_PRINCIPAL_ID,
  reportingCurrency = EUR,
  custodyUnitMemberships = [{ sourceId: TEST_SOURCE, custodyUnitId: TEST_CUSTODY_UNIT_ID }],
  result = completeResult(),
}: {
  readonly id?: CalculationRunId
  readonly principalId?: PrincipalId
  readonly reportingCurrency?: CurrencyCode
  readonly custodyUnitMemberships?: ReadonlyArray<{
    readonly sourceId: SourceId
    readonly custodyUnitId: CustodyUnitId
  }>
  readonly result?: TaxAccountingResult
} = {}) =>
  Effect.flatMap(CalculationRunRepository, (repository) =>
    repository.persist({
      id,
      principalId,
      reportingCurrency,
      inputLedgerRevision: InputLedgerRevision.make("ledger-17"),
      valuationRevision: ValuationRevision.make("prices-9"),
      custodyUnitMemberships,
      result,
    })
  )

const seedCalculationRunFixture = ({
  includeOtherPrincipal = false,
}: {
  readonly includeOtherPrincipal?: boolean
} = {}) =>
  Effect.gen(function* () {
    const fixture = yield* seedSyncEngineRepositoryFixture({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: TEST_SOURCE_ID,
    })
    yield* seedSyncEngineAssets(fixture)

    if (includeOtherPrincipal) {
      yield* seedSyncEngineRepositoryFixture({
        userId: OTHER_USER_ID,
        principalId: OTHER_PRINCIPAL_ID,
        sourceId: OTHER_SOURCE_ID,
      })
    }
  })

const readLiveAndStoredMembership = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [live] = yield* db
      .select({ custodyUnitId: schema.custodyUnitSources.custodyUnitId })
      .from(schema.custodyUnitSources)
      .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
    const [snapshot] = yield* db
      .select({
        custodyUnitId: schema.calculationRunCustodyUnitSources.custodyUnitId,
        sourceId: schema.calculationRunCustodyUnitSources.sourceId,
      })
      .from(schema.calculationRunCustodyUnitSources)
      .where(eq(schema.calculationRunCustodyUnitSources.runId, RUN_ID))

    return { live, snapshot }
  })

const currencyMismatchCases = (): ReadonlyArray<{
  readonly field: string
  readonly result: TaxAccountingResult
}> => {
  const base = completeResult()
  const usd = (value: string) => MonetaryAmount.unsafeFromString(value, "USD")

  return [
    {
      field: "allocation cost basis",
      result: {
        ...base,
        allocations: base.allocations.map((allocation) => ({
          ...allocation,
          costBasis: usd("10000"),
        })),
      },
    },
    {
      field: "realized cost basis",
      result: {
        ...base,
        realizedResults: base.realizedResults.map((realized) => ({
          ...realized,
          costBasis: usd("10000"),
        })),
      },
    },
    {
      field: "realized proceeds",
      result: {
        ...base,
        realizedResults: base.realizedResults.map((realized) => ({
          ...realized,
          proceeds: usd("15000"),
        })),
      },
    },
    {
      field: "realized gain or loss",
      result: {
        ...base,
        realizedResults: base.realizedResults.map((realized) => ({
          ...realized,
          gainLoss: usd("5000"),
        })),
      },
    },
    {
      field: "income value",
      result: {
        ...base,
        incomeResults: base.incomeResults.map((income) => ({
          ...income,
          value: usd("250"),
        })),
      },
    },
    {
      field: "derived-lot cost basis per unit",
      result: {
        ...base,
        derivedLots: base.derivedLots.map((lot) => ({
          ...lot,
          costBasisPerUnit: usd("40000"),
        })),
      },
    },
  ]
}

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

describe("CalculationRunRepositoryLive", () => {
  it.effect("writes one complete run and activates its complete result atomically", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      yield* runRepository(persistResult())

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [run] = yield* db
            .select({
              id: schema.calculationRuns.id,
              principalId: schema.calculationRuns.principalId,
              jurisdiction: schema.calculationRuns.jurisdiction,
              taxYear: schema.calculationRuns.taxYear,
              reportingCurrency: schema.calculationRuns.reportingCurrency,
              status: schema.calculationRuns.status,
              accountingMethod: schema.calculationRuns.accountingMethod,
              inventoryScope: schema.calculationRuns.inventoryScope,
              appliedRules: schema.calculationRuns.appliedRules,
              processedEventIds: schema.calculationRuns.processedEventIds,
              startedAt: schema.calculationRuns.startedAt,
              completedAt: schema.calculationRuns.completedAt,
            })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID))
          const custodyUnits = yield* db
            .select({ custodyUnitId: schema.calculationRunCustodyUnits.custodyUnitId })
            .from(schema.calculationRunCustodyUnits)
            .where(eq(schema.calculationRunCustodyUnits.runId, RUN_ID))
          const custodySources = yield* db
            .select({ sourceId: schema.calculationRunCustodyUnitSources.sourceId })
            .from(schema.calculationRunCustodyUnitSources)
            .where(eq(schema.calculationRunCustodyUnitSources.runId, RUN_ID))
          const allocations = yield* db
            .select({
              sequence: schema.calculationRunAllocations.sequence,
              quantity: schema.calculationRunAllocations.quantity,
            })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunAllocations.sequence))
          const realizedResults = yield* db
            .select({
              sequence: schema.calculationRunRealizedResults.sequence,
              gainLoss: schema.calculationRunRealizedResults.gainLoss,
            })
            .from(schema.calculationRunRealizedResults)
            .where(eq(schema.calculationRunRealizedResults.runId, RUN_ID))
          const incomeResults = yield* db
            .select({
              sequence: schema.calculationRunIncomeResults.sequence,
              value: schema.calculationRunIncomeResults.value,
            })
            .from(schema.calculationRunIncomeResults)
            .where(eq(schema.calculationRunIncomeResults.runId, RUN_ID))
          const derivedLots = yield* db
            .select({
              sequence: schema.calculationRunDerivedLots.sequence,
              remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity,
            })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, RUN_ID))
          const explanations = yield* db
            .select({
              sequence: schema.calculationRunExplanationEntries.sequence,
              matches: schema.calculationRunExplanationEntries.matches,
            })
            .from(schema.calculationRunExplanationEntries)
            .where(eq(schema.calculationRunExplanationEntries.runId, RUN_ID))

          return {
            run,
            active,
            custodyUnits,
            custodySources,
            allocations,
            realizedResults,
            incomeResults,
            derivedLots,
            explanations,
          }
        })
      )

      expect(stored.run).toMatchObject({
        id: RUN_ID,
        principalId: TEST_PRINCIPAL_ID,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        status: "complete",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
        appliedRules: ["de.private.section23.wallet-fifo-method"],
        processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
      })
      expect(stored.run?.startedAt).toBeInstanceOf(Date)
      expect(stored.run?.completedAt).toBeInstanceOf(Date)
      expect(stored.active).toEqual({ runId: RUN_ID })
      expect(stored.custodyUnits).toHaveLength(1)
      expect(stored.custodySources).toHaveLength(1)
      const [allocation] = stored.allocations
      const [realized] = stored.realizedResults
      const [income] = stored.incomeResults
      const [derivedLot] = stored.derivedLots

      expect(allocation?.sequence).toBe(0)
      expect(
        allocation === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(allocation.quantity), quantity("0.25"))
      ).toBe(true)
      expect(realized?.sequence).toBe(0)
      expect(
        realized === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(realized.gainLoss), quantity("5000"))
      ).toBe(true)
      expect(income?.sequence).toBe(0)
      expect(
        income === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(income.value), quantity("250"))
      ).toBe(true)
      expect(derivedLot?.sequence).toBe(0)
      expect(
        derivedLot === undefined
          ? false
          : BigDecimal.equals(
              BigDecimal.fromStringUnsafe(derivedLot.remainingQuantity),
              quantity("0.75")
            )
      ).toBe(true)
      expect(stored.explanations).toEqual([
        expect.objectContaining({
          sequence: 17,
          matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: "0.25" }],
        }),
      ])
    })
  )

  it.effect("batches results beyond PostgreSQL's single-statement parameter limit", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const base = completeResult()
      const allocation = base.allocations[0]

      if (allocation === undefined) {
        return yield* Effect.die("completeResult must contain one allocation")
      }

      const allocationCount = 6_000
      yield* runRepository(
        persistResult({
          result: {
            ...base,
            allocations: Array.from({ length: allocationCount }, () => allocation),
          },
        })
      )

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [allocationSummary] = yield* db
            .select({
              count: sql<number>`count(*)::integer`,
              firstSequence: sql<number>`min(${schema.calculationRunAllocations.sequence})::integer`,
              lastSequence: sql<number>`max(${schema.calculationRunAllocations.sequence})::integer`,
            })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(eq(schema.activeCalculationRuns.runId, RUN_ID))

          return { allocationSummary, active }
        })
      )

      expect(stored).toEqual({
        allocationSummary: {
          count: allocationCount,
          firstSequence: 0,
          lastSequence: allocationCount - 1,
        },
        active: { runId: RUN_ID },
      })
    })
  )

  it.effect("keeps the claimed run pending until child rows are stored", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(`
              create function assert_test_run_pending() returns trigger as $$
              declare parent_status text;
              declare parent_completed_at timestamptz;
              begin
                select status::text, completed_at
                  into parent_status, parent_completed_at
                  from calculation_runs
                  where id = new.run_id;
                if parent_status <> 'pending' or parent_completed_at is not null then
                  raise exception 'run was finalized before child persistence';
                end if;
                return new;
              end;
              $$ language plpgsql
            `)
          )
          yield* db.execute(
            sql.raw(`
              create trigger assert_test_run_pending
              before insert on calculation_run_allocations
              for each row execute function assert_test_run_pending()
            `)
          )
          yield* db.execute(
            sql.raw(`
              create function assert_test_run_finalized() returns trigger as $$
              declare parent_status text;
              declare parent_started_at timestamptz;
              declare parent_completed_at timestamptz;
              begin
                select status::text, started_at, completed_at
                  into parent_status, parent_started_at, parent_completed_at
                  from calculation_runs
                  where id = new.run_id;
                if parent_status <> 'complete'
                  or parent_completed_at is null
                  or parent_completed_at < parent_started_at then
                  raise exception 'run was activated before finalization';
                end if;
                return new;
              end;
              $$ language plpgsql
            `)
          )
          yield* db.execute(
            sql.raw(`
              create trigger assert_test_run_finalized
              before insert on active_calculation_runs
              for each row execute function assert_test_run_finalized()
            `)
          )
        })
      )

      const removeLifecycleAssertions = runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw("drop trigger if exists assert_test_run_pending on calculation_run_allocations")
          )
          yield* db.execute(
            sql.raw("drop trigger if exists assert_test_run_finalized on active_calculation_runs")
          )
          yield* db.execute(sql.raw("drop function if exists assert_test_run_pending()"))
          yield* db.execute(sql.raw("drop function if exists assert_test_run_finalized()"))
        })
      )

      yield* runRepository(persistResult()).pipe(Effect.ensuring(removeLifecycleAssertions))

      const [stored] = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              status: schema.calculationRuns.status,
              accountingMethod: schema.calculationRuns.accountingMethod,
              inventoryScope: schema.calculationRuns.inventoryScope,
              startedAt: schema.calculationRuns.startedAt,
              completedAt: schema.calculationRuns.completedAt,
            })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
        })
      )

      expect(stored).toMatchObject({
        status: "complete",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
      })
      expect(stored?.startedAt).toBeInstanceOf(Date)
      expect(stored?.completedAt).toBeInstanceOf(Date)
      expect((stored?.completedAt?.getTime() ?? 0) >= (stored?.startedAt?.getTime() ?? 1)).toBe(
        true
      )
    })
  )

  it.effect("writes and activates a partial run with ordered blockers", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      const partialResult: TaxAccountingResult = {
        ...completeResult(),
        status: "partial",
        allocations: completeResult().allocations.map((allocation) => ({
          ...allocation,
          costBasis: null,
        })),
        realizedResults: [],
        incomeResults: [],
        derivedLots: completeResult().derivedLots.map((lot) => ({
          ...lot,
          costBasisPerUnit: null,
        })),
        blockers: [
          {
            code: "missing_valuation",
            eventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: null,
          },
          {
            code: "inventory_shortage",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: quantity("0.5"),
          },
        ],
      }

      yield* runRepository(persistResult({ result: partialResult }))

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [run] = yield* db
            .select({ status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
            .where(eq(schema.activeCalculationRuns.principalId, TEST_PRINCIPAL_ID))
          const blockers = yield* db
            .select({
              sequence: schema.calculationRunBlockers.sequence,
              code: schema.calculationRunBlockers.code,
              missingQuantity: schema.calculationRunBlockers.missingQuantity,
            })
            .from(schema.calculationRunBlockers)
            .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunBlockers.sequence))

          const [allocation] = yield* db
            .select({ costBasis: schema.calculationRunAllocations.costBasis })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
          const [derivedLot] = yield* db
            .select({ costBasisPerUnit: schema.calculationRunDerivedLots.costBasisPerUnit })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, RUN_ID))

          return { run, active, blockers, allocation, derivedLot }
        })
      )

      expect(stored.run).toEqual({ status: "partial" })
      expect(stored.active).toEqual({ runId: RUN_ID })
      expect(stored.allocation).toEqual({ costBasis: null })
      expect(stored.derivedLot).toEqual({ costBasisPerUnit: null })
      expect(stored.blockers.map(({ sequence, code }) => ({ sequence, code }))).toEqual([
        { sequence: 0, code: "missing_valuation" },
        { sequence: 1, code: "inventory_shortage" },
      ])
      const missingQuantity = stored.blockers[1]?.missingQuantity
      expect(
        missingQuantity === null || missingQuantity === undefined
          ? false
          : BigDecimal.equals(BigDecimal.fromStringUnsafe(missingQuantity), quantity("0.5"))
      ).toBe(true)
    })
  )

  it.effect("stores each result collection in its engine-provided order", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      const base = completeResult()
      const orderedResult: TaxAccountingResult = {
        ...base,
        allocations: base.allocations.flatMap((item) => [
          item,
          { ...item, quantity: quantity("0.5") },
        ]),
        realizedResults: base.realizedResults.flatMap((item) => [
          item,
          { ...item, treatmentCodes: ["second.realized"] },
        ]),
        incomeResults: base.incomeResults.flatMap((item) => [
          item,
          { ...item, treatmentCodes: ["second.income"] },
        ]),
        derivedLots: base.derivedLots.flatMap((item) => [
          item,
          { ...item, remainingQuantity: quantity("0.5") },
        ]),
        blockers: [
          {
            code: "missing_valuation",
            eventId: ACQUISITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: null,
          },
          {
            code: "inventory_shortage",
            eventId: DISPOSITION_EVENT_ID,
            assetId: TEST_BTC_ASSET_ID,
            custodyUnitId: TEST_CUSTODY_UNIT_ID,
            missingQuantity: quantity("0.5"),
          },
        ],
        explanationTrace: base.explanationTrace.flatMap((entry) => [
          entry,
          { ...entry, sequence: 23, code: "second.explanation" },
        ]),
      }

      yield* runRepository(persistResult({ result: orderedResult }))

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const allocations = yield* db
            .select({
              sequence: schema.calculationRunAllocations.sequence,
              quantity: schema.calculationRunAllocations.quantity,
            })
            .from(schema.calculationRunAllocations)
            .where(eq(schema.calculationRunAllocations.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunAllocations.sequence))
          const realized = yield* db
            .select({
              sequence: schema.calculationRunRealizedResults.sequence,
              treatmentCodes: schema.calculationRunRealizedResults.treatmentCodes,
            })
            .from(schema.calculationRunRealizedResults)
            .where(eq(schema.calculationRunRealizedResults.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunRealizedResults.sequence))
          const income = yield* db
            .select({
              sequence: schema.calculationRunIncomeResults.sequence,
              treatmentCodes: schema.calculationRunIncomeResults.treatmentCodes,
            })
            .from(schema.calculationRunIncomeResults)
            .where(eq(schema.calculationRunIncomeResults.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunIncomeResults.sequence))
          const derivedLots = yield* db
            .select({
              sequence: schema.calculationRunDerivedLots.sequence,
              remainingQuantity: schema.calculationRunDerivedLots.remainingQuantity,
            })
            .from(schema.calculationRunDerivedLots)
            .where(eq(schema.calculationRunDerivedLots.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunDerivedLots.sequence))
          const blockers = yield* db
            .select({
              sequence: schema.calculationRunBlockers.sequence,
              code: schema.calculationRunBlockers.code,
            })
            .from(schema.calculationRunBlockers)
            .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunBlockers.sequence))
          const explanations = yield* db
            .select({
              sequence: schema.calculationRunExplanationEntries.sequence,
              code: schema.calculationRunExplanationEntries.code,
            })
            .from(schema.calculationRunExplanationEntries)
            .where(eq(schema.calculationRunExplanationEntries.runId, RUN_ID))
            .orderBy(asc(schema.calculationRunExplanationEntries.sequence))

          return { allocations, realized, income, derivedLots, blockers, explanations }
        })
      )

      expect(stored.allocations.map(({ sequence }) => sequence)).toEqual([0, 1])
      expect(
        stored.allocations.map(({ quantity: value }) =>
          BigDecimal.format(BigDecimal.normalize(BigDecimal.fromStringUnsafe(value)))
        )
      ).toEqual(["0.25", "0.5"])
      expect(stored.realized).toEqual([
        { sequence: 0, treatmentCodes: ["de.tax_free_holding_period"] },
        { sequence: 1, treatmentCodes: ["second.realized"] },
      ])
      expect(stored.income).toEqual([
        { sequence: 0, treatmentCodes: ["de.taxable_income_section22_3_staking"] },
        { sequence: 1, treatmentCodes: ["second.income"] },
      ])
      expect(stored.derivedLots.map(({ sequence }) => sequence)).toEqual([0, 1])
      expect(stored.blockers).toEqual([
        { sequence: 0, code: "missing_valuation" },
        { sequence: 1, code: "inventory_shortage" },
      ])
      expect(stored.explanations).toEqual([
        { sequence: 17, code: "fifo_matched" },
        { sequence: 23, code: "second.explanation" },
      ])
    })
  )

  it.effect("rejects reuse of a run ID for identical and different payloads", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())

      const identicalError = yield* runRepository(Effect.flip(persistResult()))
      const differentError = yield* runRepository(
        Effect.flip(
          persistResult({
            result: { ...completeResult(), status: "partial", taxYear: TaxYear.make(2024) },
          })
        )
      )

      expect(identicalError).toBeInstanceOf(CalculationRunAlreadyStoredError)
      expect(differentError).toBeInstanceOf(CalculationRunAlreadyStoredError)
    })
  )

  it.effect("classifies concurrent claims of the same run ID as single-use", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      const outcomes = yield* runRepository(
        Effect.gen(function* () {
          const repository = yield* CalculationRunRepository
          const write = () =>
            Effect.match(
              repository.persist({
                id: RUN_ID,
                principalId: TEST_PRINCIPAL_ID,
                reportingCurrency: EUR,
                inputLedgerRevision: InputLedgerRevision.make("ledger-17"),
                valuationRevision: ValuationRevision.make("prices-9"),
                custodyUnitMemberships: [
                  { sourceId: TEST_SOURCE, custodyUnitId: TEST_CUSTODY_UNIT_ID },
                ],
                result: completeResult(),
              }),
              {
                onFailure: (error) => error._tag,
                onSuccess: () => "success" as const,
              }
            )

          return yield* Effect.all([write(), write()], { concurrency: 2 })
        })
      )

      expect([...outcomes].sort()).toEqual(["CalculationRunAlreadyStoredError", "success"])
    })
  )

  it.effect("rolls back every monetary field that differs from the reporting currency", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())

      for (const { field, result } of currencyMismatchCases()) {
        const error = yield* runRepository(Effect.flip(persistResult({ result })))
        expect(error, field).toBeInstanceOf(CalculationRunCurrencyMismatchError)
      }

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id })
            .from(schema.calculationRuns)
            .where(eq(schema.calculationRuns.id, RUN_ID))
          const active = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)

          return { runs, active }
        })
      )

      expect(stored).toEqual({ runs: [], active: [] })
    })
  )

  it.effect(
    "rolls back missing and cross-principal custody snapshots without moving the pointer",
    () =>
      Effect.gen(function* () {
        yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))
        yield* runRepository(persistResult())

        const missingError = yield* runRepository(
          Effect.flip(
            persistResult({
              id: SECOND_RUN_ID,
              result: completeResult({ custodyUnitId: MISSING_CUSTODY_UNIT_ID }),
            })
          )
        )
        const crossPrincipalError = yield* runRepository(
          Effect.flip(
            persistResult({
              id: THIRD_RUN_ID,
              result: completeResult({ custodyUnitId: OTHER_CUSTODY_UNIT_ID }),
            })
          )
        )

        expect(missingError).toBeInstanceOf(PersistenceError)
        expect(crossPrincipalError).toBeInstanceOf(PersistenceError)

        const stored = yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            const runs = yield* db
              .select({ id: schema.calculationRuns.id })
              .from(schema.calculationRuns)
              .orderBy(asc(schema.calculationRuns.id))
            const active = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
            const realized = yield* db
              .select({ runId: schema.calculationRunRealizedResults.runId })
              .from(schema.calculationRunRealizedResults)

            return { runs, active, realized }
          })
        )

        expect(stored).toEqual({
          runs: [{ id: RUN_ID }],
          active: [{ runId: RUN_ID }],
          realized: [{ runId: RUN_ID }],
        })
      })
  )

  it.effect("moves the active pointer to a later run without changing historical rows", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())
      yield* runRepository(
        persistResult({
          id: SECOND_RUN_ID,
          result: {
            ...completeResult(),
            status: "partial",
            blockers: [
              {
                code: "missing_valuation",
                eventId: DISPOSITION_EVENT_ID,
                assetId: TEST_BTC_ASSET_ID,
                custodyUnitId: TEST_CUSTODY_UNIT_ID,
                missingQuantity: null,
              },
            ],
          },
        })
      )

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id, status: schema.calculationRuns.status })
            .from(schema.calculationRuns)
            .orderBy(asc(schema.calculationRuns.id))
          const [active] = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
          const realized = yield* db
            .select({ runId: schema.calculationRunRealizedResults.runId })
            .from(schema.calculationRunRealizedResults)
            .orderBy(asc(schema.calculationRunRealizedResults.runId))
          const blockers = yield* db
            .select({ runId: schema.calculationRunBlockers.runId })
            .from(schema.calculationRunBlockers)

          return { runs, active, realized, blockers }
        })
      )

      expect(stored).toEqual({
        runs: [
          { id: RUN_ID, status: "complete" },
          { id: SECOND_RUN_ID, status: "partial" },
        ],
        active: { runId: SECOND_RUN_ID },
        realized: [{ runId: RUN_ID }, { runId: SECOND_RUN_ID }],
        blockers: [{ runId: SECOND_RUN_ID }],
      })
    })
  )

  it.effect("keeps active pointers isolated across tax-year and principal scopes", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture({ includeOtherPrincipal: true }))

      yield* runRepository(persistResult())
      yield* runRepository(
        persistResult({ id: SECOND_RUN_ID, result: completeResult({ taxYear: 2024 }) })
      )
      yield* runRepository(
        persistResult({
          id: THIRD_RUN_ID,
          principalId: OTHER_PRINCIPAL_ID,
          custodyUnitMemberships: [
            { sourceId: SourceId.make(OTHER_SOURCE_ID), custodyUnitId: OTHER_CUSTODY_UNIT_ID },
          ],
          result: completeResult({ custodyUnitId: OTHER_CUSTODY_UNIT_ID }),
        })
      )
      yield* runRepository(
        persistResult({
          id: FIFTH_RUN_ID,
          result: completeResult({ jurisdiction: "US" }),
        })
      )
      yield* runRepository(
        persistResult({
          id: SIXTH_RUN_ID,
          reportingCurrency: USD,
          result: completeResult({ currency: "USD" }),
        })
      )

      const active = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              principalId: schema.activeCalculationRuns.principalId,
              jurisdiction: schema.activeCalculationRuns.jurisdiction,
              taxYear: schema.activeCalculationRuns.taxYear,
              reportingCurrency: schema.activeCalculationRuns.reportingCurrency,
              runId: schema.activeCalculationRuns.runId,
            })
            .from(schema.activeCalculationRuns)
            .orderBy(
              asc(schema.activeCalculationRuns.principalId),
              asc(schema.activeCalculationRuns.jurisdiction),
              asc(schema.activeCalculationRuns.taxYear),
              asc(schema.activeCalculationRuns.reportingCurrency)
            )
        })
      )

      expect(active).toEqual([
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2024,
          reportingCurrency: "EUR",
          runId: SECOND_RUN_ID,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: RUN_ID,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "USD",
          runId: SIXTH_RUN_ID,
        },
        {
          principalId: TEST_PRINCIPAL_ID,
          jurisdiction: "US",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: FIFTH_RUN_ID,
        },
        {
          principalId: OTHER_PRINCIPAL_ID,
          jurisdiction: "DE",
          taxYear: 2025,
          reportingCurrency: "EUR",
          runId: THIRD_RUN_ID,
        },
      ])
    })
  )

  it.effect("keeps a run's custody membership unchanged after live source regrouping", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())

      const snapshots = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.insert(schema.custodyUnits).values({
            id: GROUPED_CUSTODY_UNIT_ID,
            principalId: TEST_PRINCIPAL_ID,
          })
          yield* db
            .update(schema.custodyUnitSources)
            .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
            .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))

          return yield* readLiveAndStoredMembership()
        })
      )

      expect(snapshots).toEqual({
        live: { custodyUnitId: GROUPED_CUSTODY_UNIT_ID },
        snapshot: { custodyUnitId: TEST_SOURCE_ID, sourceId: TEST_SOURCE_ID },
      })
    })
  )

  it.effect("stores committed membership while a concurrent regroup is uncommitted", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      const regroupReady = yield* Deferred.make<void>()
      const releaseRegroup = yield* Deferred.make<void>()
      const heldRegroup = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(schema.custodyUnits).values({
                id: GROUPED_CUSTODY_UNIT_ID,
                principalId: TEST_PRINCIPAL_ID,
              })
              yield* tx
                .update(schema.custodyUnitSources)
                .set({ custodyUnitId: GROUPED_CUSTODY_UNIT_ID })
                .where(eq(schema.custodyUnitSources.sourceId, TEST_SOURCE_ID))
              yield* Deferred.succeed(regroupReady, undefined)
              yield* Deferred.await(releaseRegroup)
            })
          )
        })
      )

      yield* Deferred.await(regroupReady)
      yield* runRepository(persistResult()).pipe(
        Effect.ensuring(Deferred.succeed(releaseRegroup, undefined))
      )
      yield* Effect.promise(() => heldRegroup)

      const snapshots = yield* runPgEffect(readLiveAndStoredMembership())

      expect(snapshots).toEqual({
        live: { custodyUnitId: GROUPED_CUSTODY_UNIT_ID },
        snapshot: { custodyUnitId: TEST_SOURCE_ID, sourceId: TEST_SOURCE_ID },
      })
    })
  )

  it.effect("rolls back result rows when the final pointer write fails", () =>
    Effect.gen(function* () {
      yield* runPgEffect(seedCalculationRunFixture())
      yield* runRepository(persistResult())

      yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(
            sql.raw(`
            create function reject_test_calculation_pointer() returns trigger as $$
            begin
              if new.run_id = '${FOURTH_RUN_ID}' then
                raise exception 'forced active pointer failure';
              end if;
              return new;
            end;
            $$ language plpgsql
          `)
          )
          yield* db.execute(
            sql.raw(`
            create trigger reject_test_calculation_pointer
            before insert or update on active_calculation_runs
            for each row execute function reject_test_calculation_pointer()
          `)
          )
        })
      )

      const error = yield* runRepository(Effect.flip(persistResult({ id: FOURTH_RUN_ID })))
      expect(error).toBeInstanceOf(PersistenceError)

      const stored = yield* runPgEffect(
        Effect.gen(function* () {
          const db = yield* drizzle
          const runs = yield* db
            .select({ id: schema.calculationRuns.id })
            .from(schema.calculationRuns)
          const active = yield* db
            .select({ runId: schema.activeCalculationRuns.runId })
            .from(schema.activeCalculationRuns)
          const realized = yield* db
            .select({ runId: schema.calculationRunRealizedResults.runId })
            .from(schema.calculationRunRealizedResults)

          return { runs, active, realized }
        })
      )

      expect(stored).toEqual({
        runs: [{ id: RUN_ID }],
        active: [{ runId: RUN_ID }],
        realized: [{ runId: RUN_ID }],
      })
    })
  )

  it.effect("applies the recovery limit after excluding principals with active source jobs", () =>
    Effect.gen(function* () {
      yield* runPgEffect(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })
          yield* seedSyncEngineRepositoryFixture({
            userId: OTHER_USER_ID,
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
          })
          yield* seedSyncEngineRepositoryFixture({
            userId: ACTIONABLE_USER_ID,
            principalId: ACTIONABLE_PRINCIPAL_ID,
            sourceId: ACTIONABLE_SOURCE_ID,
          })

          const db = yield* drizzle
          const firstBlockedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
          const secondBlockedAt = DateTime.toDateUtc(
            DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")
          )
          const actionableAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-03T00:00:00.000Z"))
          yield* db.insert(schema.processingJobs).values([
            {
              id: RUN_ID,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "completed",
              completedAt: firstBlockedAt,
              createdAt: firstBlockedAt,
              updatedAt: firstBlockedAt,
            },
            {
              id: SECOND_RUN_ID,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "processing",
              startedAt: firstBlockedAt,
              heartbeatAt: firstBlockedAt,
              createdAt: firstBlockedAt,
              updatedAt: firstBlockedAt,
            },
            {
              id: THIRD_RUN_ID,
              sourceId: OTHER_SOURCE_ID,
              principalId: OTHER_PRINCIPAL_ID,
              status: "completed",
              completedAt: secondBlockedAt,
              createdAt: secondBlockedAt,
              updatedAt: secondBlockedAt,
            },
            {
              id: FOURTH_RUN_ID,
              sourceId: OTHER_SOURCE_ID,
              principalId: OTHER_PRINCIPAL_ID,
              status: "processing",
              startedAt: secondBlockedAt,
              heartbeatAt: secondBlockedAt,
              createdAt: secondBlockedAt,
              updatedAt: secondBlockedAt,
            },
            {
              id: FIFTH_RUN_ID,
              sourceId: ACTIONABLE_SOURCE_ID,
              principalId: ACTIONABLE_PRINCIPAL_ID,
              status: "completed",
              completedAt: actionableAt,
              createdAt: actionableAt,
              updatedAt: actionableAt,
            },
          ])
        })
      )

      const candidates = yield* runTriggerRepository(
        Effect.flatMap(CalculationRunTriggerRepository, (repository) =>
          repository.listRecoverableTerminalPrincipals({ limit: 1 })
        )
      )

      expect(candidates).toEqual([{ principalId: ACTIONABLE_PRINCIPAL_ID }])
    })
  )

  it.effect("orders completed jobs by immutable completion time after ownership updates", () =>
    Effect.gen(function* () {
      yield* runPgEffect(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: TEST_SOURCE_ID,
          })

          const db = yield* drizzle
          const olderCompletion = DateTime.toDateUtc(
            DateTime.makeUnsafe("2026-01-01T00:00:00.000Z")
          )
          const newerCompletion = DateTime.toDateUtc(
            DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")
          )
          const ownershipUpdate = DateTime.toDateUtc(
            DateTime.makeUnsafe("2026-01-03T00:00:00.000Z")
          )

          yield* db.insert(schema.processingJobs).values([
            {
              id: RUN_ID,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "completed",
              completedAt: olderCompletion,
              createdAt: olderCompletion,
              updatedAt: ownershipUpdate,
            },
            {
              id: SECOND_RUN_ID,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "completed",
              completedAt: newerCompletion,
              createdAt: newerCompletion,
              updatedAt: newerCompletion,
            },
          ])
          yield* db.insert(schema.calculationRuns).values({
            id: SECOND_RUN_ID,
            principalId: TEST_PRINCIPAL_ID,
            jurisdiction: "DE",
            taxYear: 2025,
            reportingCurrency: "EUR",
            engineVersion: "1",
            ruleSetVersion: "de-2025",
            inputLedgerRevision: "latest-ledger",
            valuationRevision: "latest-valuations",
            status: "complete",
            accountingMethod: "fifo",
            inventoryScope: "per_custody_unit",
            appliedChoiceIds: [],
            appliedRules: [],
            processedEventIds: [],
            startedAt: newerCompletion,
            completedAt: newerCompletion,
          })
        })
      )

      const result = yield* runTriggerRepository(
        Effect.gen(function* () {
          const repository = yield* CalculationRunTriggerRepository
          const latest = yield* repository.findLatestCompletedJob({
            principalId: TEST_PRINCIPAL_ID,
          })
          const candidates = yield* repository.listRecoverableTerminalPrincipals({ limit: 10 })
          return { latest, candidates }
        })
      )

      expect(result).toEqual({ latest: { id: SECOND_RUN_ID }, candidates: [] })
    })
  )

  it.effect("advances a bounded recovery cursor across both candidate classes", () =>
    Effect.gen(function* () {
      const fixtures = [
        {
          userId: "10000000-0000-4000-8000-000000000901",
          principalId: PrincipalId.make("10000000-0000-4000-8000-000000000911"),
          sourceId: "10000000-0000-4000-8000-000000000921",
          olderJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000931"),
          latestJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000941"),
          candidateClass: "latest",
        },
        {
          userId: "10000000-0000-4000-8000-000000000902",
          principalId: PrincipalId.make("10000000-0000-4000-8000-000000000912"),
          sourceId: "10000000-0000-4000-8000-000000000922",
          olderJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000932"),
          latestJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000942"),
          candidateClass: "latest",
        },
        {
          userId: "10000000-0000-4000-8000-000000000903",
          principalId: PrincipalId.make("10000000-0000-4000-8000-000000000913"),
          sourceId: "10000000-0000-4000-8000-000000000923",
          olderJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000933"),
          latestJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000943"),
          candidateClass: "running",
        },
        {
          userId: "10000000-0000-4000-8000-000000000904",
          principalId: PrincipalId.make("10000000-0000-4000-8000-000000000914"),
          sourceId: "10000000-0000-4000-8000-000000000924",
          olderJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000934"),
          latestJobId: CalculationRunId.make("10000000-0000-4000-8000-000000000944"),
          candidateClass: "running",
        },
      ] as const
      const completedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))

      yield* runPgEffect(
        Effect.gen(function* () {
          for (const fixture of fixtures) {
            yield* seedSyncEngineRepositoryFixture(fixture)
          }

          const db = yield* drizzle
          const jobs: Array<ProcessingJobInsert> = []
          for (const fixture of fixtures) {
            if (fixture.candidateClass === "running") {
              jobs.push({
                id: fixture.olderJobId,
                sourceId: fixture.sourceId,
                principalId: fixture.principalId,
                status: "completed",
                completedAt,
                createdAt: completedAt,
                updatedAt: completedAt,
              })
            }
            jobs.push({
              id: fixture.latestJobId,
              sourceId: fixture.sourceId,
              principalId: fixture.principalId,
              status: "completed",
              completedAt,
              createdAt: completedAt,
              updatedAt: completedAt,
            })
          }
          const [firstJob, ...remainingJobs] = jobs
          if (firstJob === undefined) return yield* Effect.die("Expected recovery jobs")
          yield* db.insert(schema.processingJobs).values([firstJob, ...remainingJobs])
        })
      )

      yield* runRepository(
        Effect.gen(function* () {
          const repository = yield* CalculationRunRepository
          for (const fixture of fixtures.filter(
            ({ candidateClass }) => candidateClass === "running"
          )) {
            const begin = (id: CalculationRunId) =>
              repository.begin({
                id,
                principalId: fixture.principalId,
                jurisdiction: JurisdictionCode.make("DE"),
                taxYear: TaxYear.make(2025),
                reportingCurrency: EUR,
                engineVersion: "1",
                ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
                inputLedgerRevision: InputLedgerRevision.make("ledger-fairness"),
                valuationRevision: ValuationRevision.make("prices-fairness"),
              })
            yield* begin(fixture.olderJobId)
            yield* begin(fixture.latestJobId)
            yield* repository.fail({
              id: fixture.latestJobId,
              failureCode: "test_terminal",
              failureMessage: "Latest run is already terminal.",
            })
          }
        })
      )

      const pages = yield* runTriggerRepository(
        Effect.gen(function* () {
          const repository = yield* CalculationRunTriggerRepository
          const selected: Array<string> = []
          for (let page = 0; page < fixtures.length + 1; page += 1) {
            const [candidate] = yield* repository.listRecoverableTerminalPrincipals({ limit: 1 })
            if (candidate !== undefined) selected.push(candidate.principalId)
          }
          return selected
        })
      )

      expect(pages).toEqual([
        ...fixtures.map(({ principalId }) => principalId),
        fixtures[0].principalId,
      ])
    })
  )

  it.effect(
    "discovers and settles running calculations superseded by the latest completed job",
    () =>
      Effect.gen(function* () {
        yield* runPgEffect(seedCalculationRunFixture())
        const olderCompletedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"))
        const newerCompletedAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"))
        const newestCompletedAt = DateTime.toDateUtc(
          DateTime.makeUnsafe("2026-01-03T00:00:00.000Z")
        )

        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values([
              {
                id: RUN_ID,
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                status: "completed",
                completedAt: olderCompletedAt,
                createdAt: olderCompletedAt,
                updatedAt: olderCompletedAt,
              },
              {
                id: SECOND_RUN_ID,
                sourceId: TEST_SOURCE_ID,
                principalId: TEST_PRINCIPAL_ID,
                status: "completed",
                completedAt: newerCompletedAt,
                createdAt: newerCompletedAt,
                updatedAt: newerCompletedAt,
              },
            ])
          })
        )
        yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.begin({
              id: RUN_ID,
              principalId: TEST_PRINCIPAL_ID,
              jurisdiction: JurisdictionCode.make("DE"),
              taxYear: TaxYear.make(2025),
              reportingCurrency: EUR,
              engineVersion: "1",
              ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
              inputLedgerRevision: InputLedgerRevision.make("ledger-old"),
              valuationRevision: ValuationRevision.make("prices-old"),
            })
          )
        )
        yield* runRepository(persistResult({ id: SECOND_RUN_ID }))

        const supersededCandidate = yield* runTriggerRepository(
          Effect.flatMap(CalculationRunTriggerRepository, (repository) =>
            repository.listRecoverableTerminalPrincipals({ limit: 10 })
          )
        )
        expect(supersededCandidate).toEqual([{ principalId: TEST_PRINCIPAL_ID }])

        const failedCount = yield* runRepository(
          Effect.flatMap(CalculationRunRepository, (repository) =>
            repository.failSuperseded({
              principalId: TEST_PRINCIPAL_ID,
              latestRunId: SECOND_RUN_ID,
              failureCode: "calculation_superseded",
              failureMessage:
                "A newer completed source job superseded this interrupted calculation.",
            })
          )
        )
        const settled = yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            const runs = yield* db
              .select({
                id: schema.calculationRuns.id,
                status: schema.calculationRuns.status,
                failureCode: schema.calculationRuns.failureCode,
              })
              .from(schema.calculationRuns)
              .orderBy(asc(schema.calculationRuns.id))
            const [active] = yield* db
              .select({ runId: schema.activeCalculationRuns.runId })
              .from(schema.activeCalculationRuns)
            const realized = yield* db
              .select({ runId: schema.calculationRunRealizedResults.runId })
              .from(schema.calculationRunRealizedResults)

            return { runs, active, realized }
          })
        )

        expect(failedCount).toBe(1)
        expect(settled).toEqual({
          runs: [
            { id: RUN_ID, status: "failed", failureCode: "calculation_superseded" },
            { id: SECOND_RUN_ID, status: "complete", failureCode: null },
          ],
          active: { runId: SECOND_RUN_ID },
          realized: [{ runId: SECOND_RUN_ID }],
        })

        yield* runPgEffect(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.processingJobs).values({
              id: THIRD_RUN_ID,
              sourceId: TEST_SOURCE_ID,
              principalId: TEST_PRINCIPAL_ID,
              status: "completed",
              completedAt: newestCompletedAt,
              createdAt: newestCompletedAt,
              updatedAt: newestCompletedAt,
            })
          })
        )

        const missingLatestRun = yield* runTriggerRepository(
          Effect.flatMap(CalculationRunTriggerRepository, (repository) =>
            repository.listRecoverableTerminalPrincipals({ limit: 10 })
          )
        )
        expect(missingLatestRun).toEqual([{ principalId: TEST_PRINCIPAL_ID }])
      })
  )
})
