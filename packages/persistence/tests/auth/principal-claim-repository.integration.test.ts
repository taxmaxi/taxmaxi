import { and, asc, eq, inArray } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import { SourceId } from "@my/core/source"
import * as Deferred from "effect/Deferred"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "@effect/vitest"
import { PrincipalClaimRepositoryLive } from "../../src/layers/PrincipalClaimRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SourceSyncRunRepositoryLive } from "../../src/layers/SourceSyncRunRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import { PrincipalClaimRepository } from "../../src/services/PrincipalClaimRepository.ts"
import { SourceSyncRunRepository } from "@my/sync-engine/services"
import { makeIntegrationTestDatabaseContext } from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_claim_repo",
})

const runPg = context.runPg

const runPrincipalClaim = <A, E>(effect: Effect.Effect<A, E, PrincipalClaimRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: PrincipalClaimRepositoryLive }))

const runSourceSyncRun = <A, E>(effect: Effect.Effect<A, E, SourceSyncRunRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SourceSyncRunRepositoryLive }))

const ANONYMOUS_PRINCIPAL_ID = PrincipalId.make("00000000-4000-4000-8000-000000001101")
const USER_ID = "00000000-0000-0000-0000-000000001102"
const USER_PRINCIPAL_ID = PrincipalId.make("00000000-4000-4000-8000-000000001103")
const ADDRESS_ID = "00000000-0000-0000-0000-000000001104"
const SOURCE_ID = SourceId.make("00000000-4000-4000-8000-000000001105")
const REQUEST_ID = "00000000-0000-0000-0000-000000001106"
const WALLET_ADDRESS = "bc1qprincipalclaimlockorder000000000000000000"
const CLAIM_VALUE_HASH = "claim-lock-order-hash"
const PAYER_WALLET_ADDRESS = "bc1qprincipalclaimpayer000000000000000000000"
const CALCULATION_RUN_ID = "00000000-4000-4000-8000-000000001107"
const TARGET_ACTIVE_RUN_ID = "00000000-4000-4000-8000-000000001108"
const ASSET_ID = "00000000-4000-4000-8000-000000001109"
const ACQUISITION_EVENT_ID = "00000000-4000-4000-8000-000000001110"
const DISPOSITION_EVENT_ID = "00000000-4000-4000-8000-000000001111"
const SYNC_RUN_ID = "00000000-4000-4000-8000-000000001112"
const SYNC_RUN_ITEM_ID = "00000000-4000-4000-8000-000000001113"
const COMPLETED_AT = DateTime.toDateUtc(DateTime.makeUnsafe("2025-12-31T23:59:59.000Z"))
const ACQUIRED_AT = DateTime.toDateUtc(DateTime.makeUnsafe("2024-01-01T00:00:00.000Z"))
const DISPOSED_AT = DateTime.toDateUtc(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z"))

const seedCalculationRunGraph = () =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.assets).values({
      id: ASSET_ID,
      name: "Principal claim test Bitcoin",
      symbol: "BTC",
      type: "fungible",
    })
    yield* db.insert(schema.processingJobs).values({
      id: CALCULATION_RUN_ID,
      sourceId: SOURCE_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      status: "completed",
      completedAt: COMPLETED_AT,
      updatedAt: COMPLETED_AT,
    })
    yield* db.insert(schema.syncRuns).values({
      id: SYNC_RUN_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      status: "completed",
      requestedSourceCount: 1,
      completedSourceCount: 1,
      startedAt: COMPLETED_AT,
      completedAt: COMPLETED_AT,
    })
    yield* db.insert(schema.syncRunItems).values({
      id: SYNC_RUN_ITEM_ID,
      runId: SYNC_RUN_ID,
      sourceId: SOURCE_ID,
      processingJobId: CALCULATION_RUN_ID,
      status: "completed",
    })
    yield* db.insert(schema.calculationRuns).values([
      {
        id: CALCULATION_RUN_ID,
        principalId: ANONYMOUS_PRINCIPAL_ID,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        engineVersion: "1",
        ruleSetVersion: "de-2025",
        inputLedgerRevision: "anonymous-ledger",
        valuationRevision: "anonymous-valuations",
        status: "partial",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
        appliedChoiceIds: [],
        appliedRules: ["de.private.section23"],
        processedEventIds: [ACQUISITION_EVENT_ID, DISPOSITION_EVENT_ID],
        startedAt: COMPLETED_AT,
        completedAt: COMPLETED_AT,
      },
      {
        id: TARGET_ACTIVE_RUN_ID,
        principalId: USER_PRINCIPAL_ID,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        engineVersion: "1",
        ruleSetVersion: "de-2025",
        inputLedgerRevision: "target-ledger",
        valuationRevision: "target-valuations",
        status: "complete",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
        appliedChoiceIds: [],
        appliedRules: [],
        processedEventIds: [],
        startedAt: COMPLETED_AT,
        completedAt: COMPLETED_AT,
      },
    ])
    yield* db.insert(schema.activeCalculationRuns).values([
      {
        principalId: ANONYMOUS_PRINCIPAL_ID,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        runId: CALCULATION_RUN_ID,
      },
      {
        principalId: USER_PRINCIPAL_ID,
        jurisdiction: "DE",
        taxYear: 2025,
        reportingCurrency: "EUR",
        runId: TARGET_ACTIVE_RUN_ID,
      },
    ])
    yield* db.insert(schema.calculationRunCustodyUnits).values({
      runId: CALCULATION_RUN_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      custodyUnitId: SOURCE_ID,
    })
    yield* db.insert(schema.calculationRunCustodyUnitSources).values({
      runId: CALCULATION_RUN_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      custodyUnitId: SOURCE_ID,
      sourceId: SOURCE_ID,
    })
    yield* db.insert(schema.calculationRunAllocations).values({
      runId: CALCULATION_RUN_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      sequence: 0,
      acquisitionEventId: ACQUISITION_EVENT_ID,
      dispositionEventId: DISPOSITION_EVENT_ID,
      assetId: ASSET_ID,
      custodyUnitId: SOURCE_ID,
      acquiredAt: ACQUIRED_AT,
      disposedAt: DISPOSED_AT,
      quantity: "1",
      costBasis: "100",
    })
    yield* db.insert(schema.calculationRunRealizedResults).values({
      runId: CALCULATION_RUN_ID,
      sequence: 0,
      acquisitionEventId: ACQUISITION_EVENT_ID,
      dispositionEventId: DISPOSITION_EVENT_ID,
      assetId: ASSET_ID,
      acquiredAt: ACQUIRED_AT,
      disposedAt: DISPOSED_AT,
      quantity: "1",
      costBasis: "100",
      proceeds: "150",
      gainLoss: "50",
      treatmentCodes: ["taxable"],
    })
    yield* db.insert(schema.calculationRunIncomeResults).values({
      runId: CALCULATION_RUN_ID,
      sequence: 0,
      eventId: ACQUISITION_EVENT_ID,
      assetId: ASSET_ID,
      occurredAt: DISPOSED_AT,
      quantity: "1",
      value: "100",
      treatmentCodes: ["income"],
    })
    yield* db.insert(schema.calculationRunDerivedLots).values({
      runId: CALCULATION_RUN_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      sequence: 0,
      acquisitionEventId: ACQUISITION_EVENT_ID,
      assetId: ASSET_ID,
      custodyUnitId: SOURCE_ID,
      acquiredAt: ACQUIRED_AT,
      remainingQuantity: "1",
      costBasisPerUnit: "100",
    })
    yield* db.insert(schema.calculationRunBlockers).values({
      runId: CALCULATION_RUN_ID,
      principalId: ANONYMOUS_PRINCIPAL_ID,
      sequence: 0,
      code: "missing_valuation",
      eventId: DISPOSITION_EVENT_ID,
      assetId: ASSET_ID,
      custodyUnitId: SOURCE_ID,
      missingQuantity: "1",
    })
    yield* db.insert(schema.calculationRunExplanationEntries).values({
      runId: CALCULATION_RUN_ID,
      sequence: 0,
      eventId: DISPOSITION_EVENT_ID,
      code: "fifo_matched",
      valuationKind: "observed_consideration",
      matches: [{ acquisitionEventId: ACQUISITION_EVENT_ID, quantity: "1" }],
    })
  })

const assertClaimedCalculationRunGraph = () =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const oldPrincipalRuns = yield* db
      .select({ id: schema.calculationRuns.id })
      .from(schema.calculationRuns)
      .where(
        and(
          eq(schema.calculationRuns.id, CALCULATION_RUN_ID),
          eq(schema.calculationRuns.principalId, ANONYMOUS_PRINCIPAL_ID)
        )
      )
    const newPrincipalRuns = yield* db
      .select({ id: schema.calculationRuns.id })
      .from(schema.calculationRuns)
      .where(
        and(
          eq(schema.calculationRuns.id, CALCULATION_RUN_ID),
          eq(schema.calculationRuns.principalId, USER_PRINCIPAL_ID)
        )
      )
    const [job] = yield* db
      .select({ id: schema.processingJobs.id, principalId: schema.processingJobs.principalId })
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, CALCULATION_RUN_ID))
    const activeRuns = yield* db
      .select({
        principalId: schema.activeCalculationRuns.principalId,
        runId: schema.activeCalculationRuns.runId,
      })
      .from(schema.activeCalculationRuns)
      .orderBy(asc(schema.activeCalculationRuns.principalId))
    const custodyUnits = yield* db
      .select({ principalId: schema.calculationRunCustodyUnits.principalId })
      .from(schema.calculationRunCustodyUnits)
      .where(eq(schema.calculationRunCustodyUnits.runId, CALCULATION_RUN_ID))
    const custodySources = yield* db
      .select({ principalId: schema.calculationRunCustodyUnitSources.principalId })
      .from(schema.calculationRunCustodyUnitSources)
      .where(eq(schema.calculationRunCustodyUnitSources.runId, CALCULATION_RUN_ID))
    const allocations = yield* db
      .select({ principalId: schema.calculationRunAllocations.principalId })
      .from(schema.calculationRunAllocations)
      .where(eq(schema.calculationRunAllocations.runId, CALCULATION_RUN_ID))
    const realized = yield* db
      .select({ runId: schema.calculationRunRealizedResults.runId })
      .from(schema.calculationRunRealizedResults)
      .where(eq(schema.calculationRunRealizedResults.runId, CALCULATION_RUN_ID))
    const income = yield* db
      .select({ runId: schema.calculationRunIncomeResults.runId })
      .from(schema.calculationRunIncomeResults)
      .where(eq(schema.calculationRunIncomeResults.runId, CALCULATION_RUN_ID))
    const derivedLots = yield* db
      .select({ principalId: schema.calculationRunDerivedLots.principalId })
      .from(schema.calculationRunDerivedLots)
      .where(eq(schema.calculationRunDerivedLots.runId, CALCULATION_RUN_ID))
    const blockers = yield* db
      .select({ principalId: schema.calculationRunBlockers.principalId })
      .from(schema.calculationRunBlockers)
      .where(eq(schema.calculationRunBlockers.runId, CALCULATION_RUN_ID))
    const explanations = yield* db
      .select({ runId: schema.calculationRunExplanationEntries.runId })
      .from(schema.calculationRunExplanationEntries)
      .where(eq(schema.calculationRunExplanationEntries.runId, CALCULATION_RUN_ID))

    expect(oldPrincipalRuns).toEqual([])
    expect(newPrincipalRuns).toEqual([{ id: CALCULATION_RUN_ID }])
    expect(job).toEqual({ id: CALCULATION_RUN_ID, principalId: USER_PRINCIPAL_ID })
    expect(activeRuns).toEqual([{ principalId: USER_PRINCIPAL_ID, runId: TARGET_ACTIVE_RUN_ID }])
    expect(custodyUnits).toEqual([{ principalId: USER_PRINCIPAL_ID }])
    expect(custodySources).toEqual([{ principalId: USER_PRINCIPAL_ID }])
    expect(allocations).toEqual([{ principalId: USER_PRINCIPAL_ID }])
    expect(realized).toEqual([{ runId: CALCULATION_RUN_ID }])
    expect(income).toEqual([{ runId: CALCULATION_RUN_ID }])
    expect(derivedLots).toEqual([{ principalId: USER_PRINCIPAL_ID }])
    expect(blockers).toEqual([{ principalId: USER_PRINCIPAL_ID }])
    expect(explanations).toEqual([{ runId: CALCULATION_RUN_ID }])
  })

const assertClaimedSyncRunAccess = () =>
  runSourceSyncRun(
    Effect.gen(function* () {
      const repository = yield* SourceSyncRunRepository
      const oldPrincipalRun = yield* repository.getVisibleRun({
        runId: SYNC_RUN_ID,
        principalId: ANONYMOUS_PRINCIPAL_ID,
      })
      const newPrincipalRun = yield* repository.getVisibleRun({
        runId: SYNC_RUN_ID,
        principalId: USER_PRINCIPAL_ID,
      })
      const items = yield* repository.listRunItems({ runId: SYNC_RUN_ID })

      expect(Option.isNone(oldPrincipalRun)).toBe(true)
      expect(Option.getOrNull(newPrincipalRun)).toMatchObject({
        id: SYNC_RUN_ID,
        principalId: USER_PRINCIPAL_ID,
      })
      expect(items).toEqual([
        expect.objectContaining({
          processingJobId: CALCULATION_RUN_ID,
          calculationRun: expect.objectContaining({
            runId: CALCULATION_RUN_ID,
            status: "partial",
          }),
        }),
      ])
    })
  )

await Effect.runPromise(context.recreateTestDatabase())

describe("PrincipalClaimRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle

              yield* db.insert(schema.users).values({
                id: USER_ID,
                email: "principal-claim-lock-order@taxmaxi.test",
                name: "Principal claim lock test",
              })
              yield* db.insert(schema.principals).values([
                {
                  id: ANONYMOUS_PRINCIPAL_ID,
                  kind: "anonymous_wallet",
                  userId: null,
                },
                {
                  id: USER_PRINCIPAL_ID,
                  kind: "user",
                  userId: USER_ID,
                },
              ])
              yield* db.insert(schema.addresses).values({
                id: ADDRESS_ID,
                address: WALLET_ADDRESS,
                type: "bitcoin",
                name: "Claimed wallet",
                principalId: ANONYMOUS_PRINCIPAL_ID,
              })
              yield* db.insert(schema.sources).values({
                id: SOURCE_ID,
                principalId: ANONYMOUS_PRINCIPAL_ID,
                name: "Claimed source",
                providerKey: "bitcoin",
                sourceableType: "onchain",
                addressId: ADDRESS_ID,
                cexAccountId: null,
              })
              yield* db.insert(schema.principalClaims).values([
                {
                  principalId: ANONYMOUS_PRINCIPAL_ID,
                  sourceId: SOURCE_ID,
                  requestId: REQUEST_ID,
                  claimType: "cli_claim_token",
                  claimValueHash: CLAIM_VALUE_HASH,
                  chainType: "bitcoin",
                  walletAddress: WALLET_ADDRESS,
                  year: 2025,
                  jurisdiction: "germany",
                },
                {
                  principalId: ANONYMOUS_PRINCIPAL_ID,
                  sourceId: SOURCE_ID,
                  requestId: REQUEST_ID,
                  claimType: "x402_receipt",
                  claimValueHash: "receipt-lock-order-hash",
                  chainType: "bitcoin",
                  walletAddress: WALLET_ADDRESS,
                  payerChainType: "bitcoin",
                  payerWalletAddress: PAYER_WALLET_ADDRESS,
                  year: 2025,
                  jurisdiction: "germany",
                },
              ])
            })
          )
        )
      })
    )
  )

  it.effect("locks the source before either ownership principal", () =>
    Effect.gen(function* () {
      // Given another transaction owns the source row lock.
      const sourceLockAcquired = yield* Deferred.make<void>()
      const releaseSourceLock = yield* Deferred.make<void>()
      const heldSourceLock = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .select({ id: schema.sources.id })
                .from(schema.sources)
                .where(eq(schema.sources.id, SOURCE_ID))
                .for("update")
              yield* Deferred.succeed(sourceLockAcquired, undefined)
              yield* Deferred.await(releaseSourceLock)
            })
          )
        })
      )

      yield* Deferred.await(sourceLockAcquired)

      // When a claim starts, it must wait for the source before locking either principal.
      const claimWaitingForSource = runPrincipalClaim(
        Effect.flatMap(PrincipalClaimRepository, (repository) =>
          repository.claimAnonymousSourceForUser({
            anonymousPrincipalId: ANONYMOUS_PRINCIPAL_ID,
            userPrincipalId: USER_PRINCIPAL_ID,
            sourceId: SOURCE_ID,
            requestId: REQUEST_ID,
            claimValueHash: CLAIM_VALUE_HASH,
          })
        )
      )

      yield* Effect.promise(() => context.waitForQueryBlockedOnLock({ queryIncludes: "sources" }))

      // The claim should be waiting on the source row without holding either
      // principal row, so this independent principal lock must complete.
      const principalLockProbe = runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.transaction((tx) =>
            tx
              .select({ id: schema.principals.id })
              .from(schema.principals)
              .where(inArray(schema.principals.id, [ANONYMOUS_PRINCIPAL_ID, USER_PRINCIPAL_ID]))
              .orderBy(asc(schema.principals.id))
              .for("update", { noWait: true })
          )
        })
      ).then(() => "completed" as const)
      const principalLockProbeOutcome = yield* Effect.promise(() => principalLockProbe)

      // Then the principal rows remain lockable while the claim waits.
      expect(principalLockProbeOutcome).toBe("completed")

      // And the claim finishes successfully after the source lock is released.
      yield* Deferred.succeed(releaseSourceLock, undefined)
      const [, claimedSourceId] = yield* Effect.promise(() =>
        Promise.all([heldSourceLock, claimWaitingForSource])
      )

      expect(claimedSourceId).toBe(SOURCE_ID)
    })
  )

  it.effect("transfers every calculation row through the claim-token path", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedCalculationRunGraph()))

      yield* Effect.promise(() =>
        runPrincipalClaim(
          Effect.flatMap(PrincipalClaimRepository, (repository) =>
            repository.claimAnonymousSourceForUser({
              anonymousPrincipalId: ANONYMOUS_PRINCIPAL_ID,
              userPrincipalId: USER_PRINCIPAL_ID,
              sourceId: SOURCE_ID,
              requestId: REQUEST_ID,
              claimValueHash: CLAIM_VALUE_HASH,
            })
          )
        )
      )

      yield* Effect.promise(() => runPg(assertClaimedCalculationRunGraph()))
      yield* Effect.promise(assertClaimedSyncRunAccess)
    })
  )

  it.effect("transfers every calculation row through the payer-wallet path", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedCalculationRunGraph()))

      yield* Effect.promise(() =>
        runPrincipalClaim(
          Effect.flatMap(PrincipalClaimRepository, (repository) =>
            repository.claimAnonymousSourceForUserByPayer({
              anonymousPrincipalId: ANONYMOUS_PRINCIPAL_ID,
              userPrincipalId: USER_PRINCIPAL_ID,
              sourceId: SOURCE_ID,
              requestId: REQUEST_ID,
              payerChainType: "bitcoin",
              payerWalletAddress: PAYER_WALLET_ADDRESS,
            })
          )
        )
      )

      yield* Effect.promise(() => runPg(assertClaimedCalculationRunGraph()))
      yield* Effect.promise(assertClaimedSyncRunAccess)
    })
  )
})
