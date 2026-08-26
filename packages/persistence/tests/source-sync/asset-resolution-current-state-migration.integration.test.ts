import { readFileSync } from "node:fs"
import { asc, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const MIGRATION_ASSET_ID = "00000000-0000-4000-8000-000000000881"
const MIGRATION_REPRESENTATION_ID = "00000000-0000-4000-8000-000000000882"
const SCOPED_ASSET_A_ID = "00000000-0000-4000-8000-000000000883"
const SCOPED_ASSET_B_ID = "00000000-0000-4000-8000-000000000884"
const SCOPED_REPRESENTATION_A_ID = "00000000-0000-4000-8000-000000000885"
const SCOPED_REPRESENTATION_B_ID = "00000000-0000-4000-8000-000000000886"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_resolution_state_migration",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const migrationStatements = readFileSync(
  new URL("../../drizzle/20260826135934_ambitious_morbius/migration.sql", import.meta.url),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((part) => part.trim())
  .filter(
    (statement) =>
      statement.startsWith('CREATE TABLE "asset_resolution_current_state"') ||
      statement.startsWith('INSERT INTO "asset_resolution_decisions"') ||
      statement.startsWith('INSERT INTO "asset_resolution_evidence"') ||
      statement.startsWith('INSERT INTO "asset_resolution_current_state"')
  )

describe("asset resolution current-state migration", () => {
  it("backfills trusted mappings and keeps later policy evaluations separate from conclusions", async () => {
    await runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values({
          id: MIGRATION_ASSET_ID,
          name: "Migration asset",
          symbol: "MIG",
          type: "fungible",
        })
        yield* db.insert(schema.assetRepresentations).values({
          id: MIGRATION_REPRESENTATION_ID,
          assetId: MIGRATION_ASSET_ID,
          blockchainId: fixture.bitcoinBlockchainId,
          type: "token",
          contractAddress: "migration-asset-contract",
          decimals: 8,
        })
        const observedAt = new Date("2026-08-25T12:00:00.000Z")
        const [trusted, automatic, human, legacyReversal] = yield* db
          .insert(schema.providerAssets)
          .values(
            ["trusted", "automatic", "human", "legacy-reversal"].map((suffix) => ({
              provider: "coinbase",
              providerAssetId: `migration-${suffix}`,
              currencyCode: "BTC",
              name: "Bitcoin",
              exponent: 8,
              providerType: "crypto",
              evidenceRevision: suffix === "trusted" ? 1 : 2,
              retrievedAt: observedAt,
            }))
          )
          .returning({ id: schema.providerAssets.id })
        if (
          trusted === undefined ||
          automatic === undefined ||
          human === undefined ||
          legacyReversal === undefined
        ) {
          return yield* Effect.die("Failed to seed migration observations")
        }

        yield* db.insert(schema.providerAssetMappings).values(
          [trusted.id, automatic.id, human.id, legacyReversal.id].map((providerAssetRowId) => ({
            providerAssetRowId,
            mappingKind: "asset" as const,
            canonicalAssetId: MIGRATION_ASSET_ID,
            assetRepresentationId: MIGRATION_REPRESENTATION_ID,
            canonicalFiatCurrency: null,
            mappingStatus: "approved" as const,
            sourceNotes: "Trusted migration fixture",
          }))
        )

        const [automaticConclusion] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: automatic.id,
            evidenceRevision: 1,
            policyRevision: "automatic.1",
            outcome: "attach",
            assetId: MIGRATION_ASSET_ID,
            assetRepresentationId: MIGRATION_REPRESENTATION_ID,
            actor: "system:asset-resolution-policy",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        const [humanConclusion] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: human.id,
            evidenceRevision: 1,
            policyRevision: "human.1",
            outcome: "excluded",
            reason: "confirmed_spam",
            humanClaim: { _tag: "exclusion", reason: "confirmed_spam" },
            actor: "admin:migration-test",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        const [supersededExclusion] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: legacyReversal.id,
            evidenceRevision: 2,
            policyRevision: "automatic.1",
            outcome: "excluded",
            reason: "provider_artifact",
            actor: "system:asset-resolution-policy",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (supersededExclusion === undefined) {
          return yield* Effect.die("Failed to seed legacy exclusion")
        }
        const [legacyReversalConclusion] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: legacyReversal.id,
            evidenceRevision: 2,
            policyRevision: "manual.legacy-reversal.1",
            outcome: "attach",
            assetId: MIGRATION_ASSET_ID,
            assetRepresentationId: MIGRATION_REPRESENTATION_ID,
            supersedesDecisionId: supersededExclusion.id,
            reason: "manual_exclusion_reversal",
            actor: "admin:migration-test",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        const laterEvaluations = yield* db
          .insert(schema.assetResolutionDecisions)
          .values(
            [automatic.id, human.id].map((providerAssetRowId) => ({
              providerAssetRowId,
              evidenceRevision: 2,
              policyRevision: "automatic.2",
              outcome: "pending" as const,
              reason: "display_collision",
              actor: "system:asset-resolution-policy",
            }))
          )
          .returning({
            id: schema.assetResolutionDecisions.id,
            providerAssetRowId: schema.assetResolutionDecisions.providerAssetRowId,
          })
        if (
          automaticConclusion === undefined ||
          humanConclusion === undefined ||
          legacyReversalConclusion === undefined
        ) {
          return yield* Effect.die("Failed to seed migration decisions")
        }

        yield* db.execute(sql`drop table asset_resolution_current_state`)
        for (const statement of migrationStatements) {
          yield* db.execute(sql.raw(statement))
        }

        const states = yield* db
          .select({
            providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId,
            currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
            currentPolicyEvaluationId: schema.assetResolutionCurrentState.currentPolicyEvaluationId,
          })
          .from(schema.assetResolutionCurrentState)
          .orderBy(asc(schema.assetResolutionCurrentState.providerAssetRowId))
        const trustedState = states.find(
          ({ providerAssetRowId }) => providerAssetRowId === trusted.id
        )
        const trustedEvidence = yield* db
          .select({
            authority: schema.assetResolutionEvidence.authority,
            evidenceRevision: schema.assetResolutionEvidence.evidenceRevision,
          })
          .from(schema.assetResolutionEvidence)
          .where(
            eq(
              schema.assetResolutionEvidence.decisionId,
              trustedState?.currentConclusionId ?? "00000000-0000-0000-0000-000000000000"
            )
          )

        expect(trustedState?.currentConclusionId).not.toBeNull()
        expect(trustedState?.currentPolicyEvaluationId).toBe(trustedState?.currentConclusionId)
        expect(trustedEvidence).toEqual([
          { authority: "trusted_provider_mapping", evidenceRevision: 1 },
        ])
        expect(
          states.find(({ providerAssetRowId }) => providerAssetRowId === automatic.id)
        ).toEqual({
          providerAssetRowId: automatic.id,
          currentConclusionId: automaticConclusion.id,
          currentPolicyEvaluationId: laterEvaluations.find(
            ({ providerAssetRowId }) => providerAssetRowId === automatic.id
          )?.id,
        })
        expect(states.find(({ providerAssetRowId }) => providerAssetRowId === human.id)).toEqual({
          providerAssetRowId: human.id,
          currentConclusionId: humanConclusion.id,
          currentPolicyEvaluationId: laterEvaluations.find(
            ({ providerAssetRowId }) => providerAssetRowId === human.id
          )?.id,
        })
        expect(
          states.find(({ providerAssetRowId }) => providerAssetRowId === legacyReversal.id)
        ).toEqual({
          providerAssetRowId: legacyReversal.id,
          currentConclusionId: legacyReversalConclusion.id,
          currentPolicyEvaluationId: supersededExclusion.id,
        })
      })
    )
  })

  it("rejects supersession links that cross observation or representation histories", async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture()
        const db = yield* drizzle
        yield* db.insert(schema.assets).values([
          {
            id: SCOPED_ASSET_A_ID,
            name: "Scoped asset A",
            symbol: "SCA",
            type: "fungible",
          },
          {
            id: SCOPED_ASSET_B_ID,
            name: "Scoped asset B",
            symbol: "SCB",
            type: "fungible",
          },
        ])
        yield* db.insert(schema.assetRepresentations).values([
          {
            id: SCOPED_REPRESENTATION_A_ID,
            assetId: SCOPED_ASSET_A_ID,
            blockchainId: fixture.bitcoinBlockchainId,
            type: "token",
            contractAddress: "scoped-representation-a",
            decimals: 8,
          },
          {
            id: SCOPED_REPRESENTATION_B_ID,
            assetId: SCOPED_ASSET_B_ID,
            blockchainId: fixture.baseBlockchainId,
            type: "token",
            contractAddress: "scoped-representation-b",
            decimals: 8,
          },
        ])
        const observations = yield* db
          .insert(schema.providerAssets)
          .values([
            {
              provider: "coinbase",
              providerAssetId: "scoped-history-a",
              currencyCode: "A",
              evidenceRevision: 1,
              retrievedAt: new Date("2026-08-26T12:00:00.000Z"),
            },
            {
              provider: "coinbase",
              providerAssetId: "scoped-history-b",
              currencyCode: "B",
              evidenceRevision: 1,
              retrievedAt: new Date("2026-08-26T12:00:00.000Z"),
            },
          ])
          .returning({ id: schema.providerAssets.id })
        const firstObservation = observations[0]
        const secondObservation = observations[1]
        if (firstObservation === undefined || secondObservation === undefined) {
          return yield* Effect.die("Failed to seed scoped decision histories")
        }

        const [secondDecision] = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: secondObservation.id,
            evidenceRevision: 1,
            policyRevision: "scoped-history.base",
            outcome: "excluded",
            actor: "system:scoped-history-test",
          })
          .returning({ id: schema.assetResolutionDecisions.id })
        if (secondDecision === undefined) {
          return yield* Effect.die("Failed to seed second observation decision")
        }

        const crossObservation = yield* db
          .insert(schema.assetResolutionDecisions)
          .values({
            providerAssetRowId: firstObservation.id,
            evidenceRevision: 1,
            policyRevision: "scoped-history.invalid",
            outcome: "excluded",
            supersedesDecisionId: secondDecision.id,
            actor: "admin:scoped-history-test",
          })
          .pipe(Effect.result)

        const [secondOwnership] = yield* db
          .insert(schema.assetRepresentationOwnershipDecisions)
          .values({
            assetRepresentationId: SCOPED_REPRESENTATION_B_ID,
            assetId: SCOPED_ASSET_B_ID,
            policyRevision: "scoped-history.base",
            actor: "system:scoped-history-test",
          })
          .returning({ id: schema.assetRepresentationOwnershipDecisions.id })
        if (secondOwnership === undefined) {
          return yield* Effect.die("Failed to seed second representation ownership")
        }
        const crossRepresentation = yield* db
          .insert(schema.assetRepresentationOwnershipDecisions)
          .values({
            assetRepresentationId: SCOPED_REPRESENTATION_A_ID,
            assetId: SCOPED_ASSET_A_ID,
            supersedesDecisionId: secondOwnership.id,
            policyRevision: "scoped-history.invalid",
            actor: "admin:scoped-history-test",
          })
          .pipe(Effect.result)

        expect(crossObservation._tag).toBe("Failure")
        expect(crossRepresentation._tag).toBe("Failure")
      })
    )
  })
})
