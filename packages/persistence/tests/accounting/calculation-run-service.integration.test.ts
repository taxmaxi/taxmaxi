import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { CalculationRunId } from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const FIRST_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000901")
const SECOND_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000902")
const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const PROVIDER_ASSET_ROW_ID = "00000000-0000-4000-8000-000000000701"
const EUR = CurrencyCode.make("EUR")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_calculation_run_service",
})
const runPg = context.runPg

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const runCalculationService = <A, E>(effect: Effect.Effect<A, E, CalculationRunService>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: CalculationRunServiceTestLive }))

const runFactualLedger = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const loadLedger = () =>
  runFactualLedger(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({ principalId: PRINCIPAL_ID, reportingCurrency: EUR })
    )
  )

const recompute = (id: CalculationRunId) =>
  runCalculationService(
    Effect.flatMap(CalculationRunService, (service) =>
      service.recompute({
        id,
        principalId: PRINCIPAL_ID,
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(2025),
        reportingCurrency: EUR,
        accountingChoices: [],
      })
    )
  )

const factualContentHash = (inputLedgerRevision: string): string | undefined =>
  inputLedgerRevision.split(":").at(-1)

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() =>
        runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
      )
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
    })
  )
)

describe("CalculationRunServiceLive", () => {
  it.effect("commits the exact override history position to the factual content hash", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))
      const { firstOverrideId, targetId } = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [principal] = yield* db
              .select({ userId: schema.principals.userId })
              .from(schema.principals)
              .where(eq(schema.principals.id, PRINCIPAL_ID))
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (principal?.userId === null || principal?.userId === undefined) {
              return yield* Effect.die("Missing principal actor")
            }
            if (representation === undefined) {
              return yield* Effect.die("Missing representation fixture")
            }

            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "override-revision-input",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create fact")

            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "override-revision-input-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
            })

            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                blockchainId: representation.blockchainId,
                representationType: representation.type,
                contractAddress: representation.contractAddress,
                mintAddress: representation.mintAddress,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to create override target")

            const [firstOverride] = yield* db
              .insert(schema.principalAssetOverrides)
              .values({
                principalId: PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "run-input-system-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: TEST_BTC_ASSET_ID,
                actorUserId: principal.userId,
                reason: "Record the first history position",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (firstOverride === undefined) {
              return yield* Effect.die("Failed to create first override")
            }

            return { targetId: target.id, firstOverrideId: firstOverride.id }
          })
        )
      )

      const firstRead = yield* Effect.promise(loadLedger)
      const repeatedFirstRead = yield* Effect.promise(loadLedger)
      expect(repeatedFirstRead.events).toEqual(firstRead.events)
      expect(repeatedFirstRead.principalAssetOverrideRevision).toEqual(
        firstRead.principalAssetOverrideRevision
      )

      yield* Effect.promise(() => recompute(FIRST_RUN_ID))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [principal] = yield* db
              .select({ userId: schema.principals.userId })
              .from(schema.principals)
              .where(eq(schema.principals.id, PRINCIPAL_ID))
            if (principal?.userId === null || principal?.userId === undefined) {
              return yield* Effect.die("Missing principal actor")
            }
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "replace",
              inspectedSystemRevision: "run-input-system-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              replacementAssetId: TEST_BTC_ASSET_ID,
              actorUserId: principal.userId,
              reason: "Record a different history position with the same decision",
              supersedesOverrideId: firstOverrideId,
            })
          })
        )
      )

      const secondRead = yield* Effect.promise(loadLedger)
      const repeatedSecondRead = yield* Effect.promise(loadLedger)
      expect(secondRead.events).toEqual(firstRead.events)
      expect(secondRead.principalAssetOverrideRevision).not.toEqual(
        firstRead.principalAssetOverrideRevision
      )
      expect(repeatedSecondRead.principalAssetOverrideRevision).toEqual(
        secondRead.principalAssetOverrideRevision
      )

      yield* Effect.promise(() => recompute(SECOND_RUN_ID))

      const revisions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                id: schema.calculationRuns.id,
                inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
              })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.principalId, PRINCIPAL_ID))
          })
        )
      )
      const firstRevision = revisions.find(({ id }) => id === FIRST_RUN_ID)?.inputLedgerRevision
      const secondRevision = revisions.find(({ id }) => id === SECOND_RUN_ID)?.inputLedgerRevision

      expect(firstRevision).toBeDefined()
      expect(secondRevision).toBeDefined()
      expect(factualContentHash(firstRevision ?? "")).not.toBe(
        factualContentHash(secondRevision ?? "")
      )
    })
  )

  it.effect(
    "commits the provider-asset override history position to the factual content hash",
    () =>
      Effect.gen(function* () {
        const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T10:00:00.000Z"))
        const { firstOverrideId, targetId } = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [principal] = yield* db
                .select({ userId: schema.principals.userId })
                .from(schema.principals)
                .where(eq(schema.principals.id, PRINCIPAL_ID))
              if (principal?.userId === null || principal?.userId === undefined) {
                return yield* Effect.die("Missing principal actor")
              }

              yield* db.insert(schema.providerAssets).values({
                id: PROVIDER_ASSET_ROW_ID,
                provider: "coinbase",
                providerAssetId: "provider-revision-btc",
                currencyCode: "BTC",
                name: "Bitcoin",
                providerType: "crypto",
                rawProviderPayload: { asset_id: "provider-revision-btc" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              })
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "approved",
              })

              const [transaction] = yield* db
                .insert(schema.transactions)
                .values({
                  sourceId: SOURCE_ID,
                  externalId: "provider-override-revision-input",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: PRINCIPAL_ID,
                })
                .returning({ id: schema.transactions.id })
              if (transaction === undefined) return yield* Effect.die("Failed to create fact")

              yield* db.insert(schema.transactionLegs).values({
                sourceId: SOURCE_ID,
                externalId: "provider-override-revision-input-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                metadata: { providerAssetRowId: PROVIDER_ASSET_ROW_ID },
                transactionId: transaction.id,
              })

              const [target] = yield* db
                .insert(schema.principalAssetOverrideTargets)
                .values({
                  principalId: PRINCIPAL_ID,
                  targetKind: "provider_asset",
                  providerAssetRowId: PROVIDER_ASSET_ROW_ID,
                })
                .returning({ id: schema.principalAssetOverrideTargets.id })
              if (target === undefined) return yield* Effect.die("Failed to create override target")

              const [firstOverride] = yield* db
                .insert(schema.principalAssetOverrides)
                .values({
                  principalId: PRINCIPAL_ID,
                  targetId: target.id,
                  kind: "identity",
                  operation: "create",
                  inspectedSystemRevision: "provider-run-input-system-v1",
                  inspectedSystemIdentity: "resolved",
                  inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                  replacementAssetId: TEST_BTC_ASSET_ID,
                  actorUserId: principal.userId,
                  reason: "Record the first provider-asset history position",
                })
                .returning({ id: schema.principalAssetOverrides.id })
              if (firstOverride === undefined) {
                return yield* Effect.die("Failed to create first provider-asset override")
              }

              return { targetId: target.id, firstOverrideId: firstOverride.id }
            })
          )
        )

        const firstRead = yield* Effect.promise(loadLedger)
        const repeatedFirstRead = yield* Effect.promise(loadLedger)
        expect(repeatedFirstRead.events).toEqual(firstRead.events)
        expect(repeatedFirstRead.principalAssetOverrideRevision).toEqual(
          firstRead.principalAssetOverrideRevision
        )

        yield* Effect.promise(() => recompute(FIRST_RUN_ID))

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [principal] = yield* db
                .select({ userId: schema.principals.userId })
                .from(schema.principals)
                .where(eq(schema.principals.id, PRINCIPAL_ID))
              if (principal?.userId === null || principal?.userId === undefined) {
                return yield* Effect.die("Missing principal actor")
              }
              yield* db.insert(schema.principalAssetOverrides).values({
                principalId: PRINCIPAL_ID,
                targetId,
                kind: "identity",
                operation: "replace",
                inspectedSystemRevision: "provider-run-input-system-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: TEST_BTC_ASSET_ID,
                actorUserId: principal.userId,
                reason: "Record another provider-asset history position with the same decision",
                supersedesOverrideId: firstOverrideId,
              })
            })
          )
        )

        const secondRead = yield* Effect.promise(loadLedger)
        const repeatedSecondRead = yield* Effect.promise(loadLedger)
        expect(secondRead.events).toEqual(firstRead.events)
        expect(secondRead.principalAssetOverrideRevision).not.toEqual(
          firstRead.principalAssetOverrideRevision
        )
        expect(repeatedSecondRead.principalAssetOverrideRevision).toEqual(
          secondRead.principalAssetOverrideRevision
        )

        yield* Effect.promise(() => recompute(SECOND_RUN_ID))

        const revisions = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({
                  id: schema.calculationRuns.id,
                  inputLedgerRevision: schema.calculationRuns.inputLedgerRevision,
                })
                .from(schema.calculationRuns)
                .where(eq(schema.calculationRuns.principalId, PRINCIPAL_ID))
            })
          )
        )
        const firstRevision = revisions.find(({ id }) => id === FIRST_RUN_ID)?.inputLedgerRevision
        const secondRevision = revisions.find(({ id }) => id === SECOND_RUN_ID)?.inputLedgerRevision

        expect(firstRevision).toBeDefined()
        expect(secondRevision).toBeDefined()
        expect(factualContentHash(firstRevision ?? "")).not.toBe(
          factualContentHash(secondRevision ?? "")
        )
      })
  )
})
