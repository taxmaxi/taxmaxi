import { eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { beforeEach, describe, expect, it } from "vitest"
import { ProviderAssetRepositoryLive } from "../../src/layers/ProviderAssetRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_EUR_REPRESENTATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_SOURCE_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { ProviderAssetRepository, SyncEngineStorageError } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_provider_asset_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, ProviderAssetRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderAssetRepositoryLive }))

const seedPendingApprovalAsset = async (suffix: string) => {
  const providerAsset = await runRepository(
    Effect.gen(function* () {
      const repository = yield* ProviderAssetRepository
      yield* repository.upsertProviderAssets({
        providerKey: "coinbase",
        entries: [
          {
            providerAssetId: `btc-approval-${suffix}`,
            naturalKey: null,
            currencyCode: "BTC",
            name: "Bitcoin",
            exponent: 8,
            providerType: "crypto",
            payload: { source: "test" },
          },
        ],
      })
      const result = yield* repository.findProviderAssetByProviderAssetId({
        providerKey: "coinbase",
        providerAssetId: `btc-approval-${suffix}`,
      })
      if (Option.isNone(result)) {
        return yield* Effect.dieMessage("Expected approval provider asset")
      }
      yield* repository.upsertProviderAssetMappings({
        mappings: [
          {
            providerAssetRowId: result.value.id,
            mappingKind: "asset",
            canonicalAssetId: null,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
            mappingStatus: "pending_review",
            reviewerNotes: null,
            sourceNotes: "Pending transfer evidence",
          },
        ],
      })
      return result.value
    })
  )

  await runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      const timestamp = new Date("2025-04-20T13:00:00.000Z")
      const [transaction] = yield* db
        .insert(schema.transactions)
        .values({
          sourceId: TEST_SOURCE_ID,
          externalId: `approval-${suffix}-transaction`,
          timestamp,
          providerTransactionType: "send",
          providerStatus: "completed",
          principalId: TEST_PRINCIPAL_ID,
        })
        .returning({ id: schema.transactions.id })
      if (transaction === undefined) {
        return yield* Effect.dieMessage("Expected approval replay transaction")
      }
      yield* db.insert(schema.providerTransfers).values({
        sourceId: TEST_SOURCE_ID,
        transactionId: transaction.id,
        externalId: `approval-${suffix}-transfer`,
        providerAssetId: providerAsset.id,
        timestamp,
        direction: "outbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "coinbase-account-1",
        toAddress: "bc1qapprovalreplay000000000000000000000000",
        amount: "0.25",
        metadata: { role: "principal" },
      })
    })
  )

  return providerAsset
}

describe("ProviderAssetRepositoryLive", () => {
  describe("current schema", () => {
    beforeEach(async () => {
      await Effect.runPromise(context.recreateTestDatabase())
      const fixture = await runPg(seedSyncEngineRepositoryFixture())
      await runPg(
        seedSyncEngineAssets({
          baseBlockchainId: fixture.baseBlockchainId,
          bitcoinBlockchainId: fixture.bitcoinBlockchainId,
        })
      )
    })

    it("upserts provider assets by stable provider asset id and resolves mappings", async () => {
      const firstUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-provider-asset",
                naturalKey: null,
                currencyCode: "btc",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "BTC", asset_id: "btc-provider-asset" },
              },
            ],
          })
        )
      )

      const secondUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-provider-asset",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin Updated",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "BTC", asset_id: "btc-provider-asset", revision: 2 },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "btc-provider-asset",
          })
        )
      )

      expect(Option.isSome(providerAsset)).toBe(true)

      if (Option.isNone(providerAsset)) {
        expect.fail("Expected provider asset fixture to exist")
      }

      const providerAssetRecord = providerAsset.value

      const mappingUpsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAssetRecord.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Reviewed",
                sourceNotes: "Seeded in integration test",
              },
            ],
          })
        )
      )

      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({
            providerAssetRowId: providerAssetRecord.id,
          })
        )
      )

      const providerAssetRows = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.providerAssets.id,
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.provider, "coinbase"))
        })
      )

      expect(firstUpsertCount).toBe(1)
      expect(secondUpsertCount).toBe(1)
      expect(mappingUpsertCount).toBe(1)
      expect(providerAssetRecord).toMatchObject({
        provider: "coinbase",
        providerAssetId: "btc-provider-asset",
        naturalKey: null,
        currencyCode: "BTC",
        name: "Bitcoin Updated",
        exponent: 8,
        providerType: "crypto",
      })
      expect(Option.getOrNull(mapping)).toMatchObject({
        providerAssetRowId: providerAssetRecord.id,
        mappingKind: "asset",
        canonicalAssetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        mappingStatus: "approved",
      })
      expect(providerAssetRows).toHaveLength(1)
    })

    it("approves only mappings that are still pending review", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "conditional-mint",
                naturalKey: "solana:mint:conditional-mint",
                currencyCode: "COND",
                name: "Conditional Token",
                exponent: 6,
                providerType: "spl-token",
                payload: { source: "test" },
              },
            ],
          })
          const result = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "conditional-mint",
          })

          if (Option.isNone(result)) {
            return yield* Effect.dieMessage("Expected conditional provider asset")
          }

          return result.value
        })
      )
      const approvedDraft = {
        providerAssetRowId: providerAsset.id,
        mappingKind: "asset" as const,
        canonicalAssetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
        mappingStatus: "approved" as const,
        reviewerNotes: null,
        sourceNotes: "Exact representation match",
      }

      const firstResult = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssetMappings({
            mappings: [
              {
                ...approvedDraft,
                canonicalAssetId: null,
                mappingStatus: "pending_review",
                sourceNotes: "Pending review",
              },
            ],
          })

          return yield* repository.approveProviderAssetMappingIfPending({
            mapping: approvedDraft,
          })
        })
      )

      expect(firstResult).toBe(true)

      const secondResult = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssetMappings({
            mappings: [
              {
                ...approvedDraft,
                canonicalAssetId: null,
                mappingStatus: "rejected",
                reviewerNotes: "Admin rejected",
                sourceNotes: "Admin decision",
              },
            ],
          })

          return yield* repository.approveProviderAssetMappingIfPending({
            mapping: approvedDraft,
          })
        })
      )
      const mapping = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetMapping({ providerAssetRowId: providerAsset.id })
        )
      )

      expect(secondResult).toBe(false)
      expect(Option.getOrNull(mapping)).toMatchObject({
        mappingStatus: "rejected",
        canonicalAssetId: null,
      })
    })

    it("approves once and attaches replay to an active job under concurrent retries", async () => {
      const providerAsset = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          yield* repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "btc-approval-replay",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "crypto",
                payload: { source: "test" },
              },
            ],
          })
          const result = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "btc-approval-replay",
          })
          if (Option.isNone(result)) {
            return yield* Effect.dieMessage("Expected approval provider asset")
          }

          yield* repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: result.value.id,
                mappingKind: "asset",
                canonicalAssetId: null,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "pending_review",
                reviewerNotes: null,
                sourceNotes: "Pending transfer evidence",
              },
            ],
          })

          return result.value
        })
      )

      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const timestamp = new Date("2025-04-20T12:00:00.000Z")
          const [transaction] = yield* db
            .insert(schema.transactions)
            .values({
              sourceId: TEST_SOURCE_ID,
              externalId: "approval-replay-transaction",
              timestamp,
              providerTransactionType: "send",
              providerStatus: "completed",
              principalId: TEST_PRINCIPAL_ID,
            })
            .returning({ id: schema.transactions.id })
          if (transaction === undefined) {
            return yield* Effect.dieMessage("Expected approval replay transaction")
          }

          yield* db.insert(schema.providerTransfers).values({
            sourceId: TEST_SOURCE_ID,
            transactionId: transaction.id,
            externalId: "approval-replay-transfer",
            providerAssetId: providerAsset.id,
            timestamp,
            direction: "outbound",
            processingMode: "accounting_and_evidence",
            fromAccountRef: "coinbase-account-1",
            toAddress: "bc1qapprovalreplay000000000000000000000000",
            amount: "0.25",
            metadata: { role: "principal" },
          })
          yield* db.insert(schema.processingJobs).values({
            sourceId: TEST_SOURCE_ID,
            principalId: TEST_PRINCIPAL_ID,
            mode: "sync",
            status: "pending",
            attemptCount: 0,
            maxAttempts: 3,
            progressDetails: { mode: "sync" },
          })
        })
      )

      const approve = () =>
        runRepository(
          Effect.flatMap(ProviderAssetRepository, (repository) =>
            repository.approveProviderAssetMappingAndRequestReplay({
              mapping: {
                providerAssetRowId: providerAsset.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Approved",
                sourceNotes: "Approved from transfer evidence",
              },
              expectedObservedRepresentations: [],
              expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
            })
          )
        )

      const results = await Promise.all([approve(), approve()])
      const state = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          const [mapping] = yield* db
            .select({
              status: schema.providerAssetMappings.mappingStatus,
              canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
            })
            .from(schema.providerAssetMappings)
            .where(eq(schema.providerAssetMappings.providerAssetRowId, providerAsset.id))
          const jobs = yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))

          return { jobs, mapping }
        })
      )

      expect(
        results
          .map(({ mappingChanged }) => mappingChanged)
          .sort((left, right) => Number(left) - Number(right))
      ).toEqual([false, true])
      expect(state.mapping).toEqual({
        status: "approved",
        canonicalAssetId: TEST_BTC_ASSET_ID,
      })
      expect(state.jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
    })

    it("creates a replay job when approval has no active owner", async () => {
      const providerAsset = await seedPendingApprovalAsset("no-active-owner")

      const result = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(result.mappingChanged).toBe(true)
      expect(jobs).toEqual([{ mode: "replay", status: "pending", followUpMode: null }])
    })

    it("reattaches replay when another active owner wins the insert race", async () => {
      const providerAsset = await seedPendingApprovalAsset("insert-race-owner")
      await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          yield* db.execute(sql`
            create function inject_active_replay_owner() returns trigger
            language plpgsql as $trigger$
            begin
              if new.mode = 'replay' then
                insert into processing_jobs (
                  source_id,
                  principal_id,
                  mode,
                  status,
                  attempt_count,
                  max_attempts,
                  progress_details
                ) values (
                  new.source_id,
                  new.principal_id,
                  'sync',
                  'pending',
                  0,
                  3,
                  '{"mode":"sync"}'::jsonb
                ) on conflict do nothing;
              end if;
              return new;
            end
            $trigger$
          `)
          yield* db.execute(sql`
            create trigger inject_active_replay_owner_before_insert
            before insert on processing_jobs
            for each row execute function inject_active_replay_owner()
          `)
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.approveProviderAssetMappingAndRequestReplay({
            mapping: {
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "approved",
              reviewerNotes: "Approved",
              sourceNotes: "Approved from transfer evidence",
            },
            expectedObservedRepresentations: [],
            expectedProviderAssetRetrievedAt: providerAsset.retrievedAt,
          })
        )
      )
      const jobs = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              mode: schema.processingJobs.mode,
              status: schema.processingJobs.status,
              followUpMode: schema.processingJobs.followUpMode,
            })
            .from(schema.processingJobs)
            .where(eq(schema.processingJobs.sourceId, TEST_SOURCE_ID))
        })
      )

      expect(jobs).toEqual([{ mode: "sync", status: "pending", followUpMode: "replay" }])
    })

    it("falls back to provider-scoped natural-key lookup when provider asset id is absent", async () => {
      const upsertCount = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:EUR",
                currencyCode: "eur",
                name: "Euro",
                exponent: 2,
                providerType: "fiat",
                payload: { id: "EUR" },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:EUR",
          })
        )
      )

      expect(upsertCount).toBe(1)
      expect(Option.getOrNull(providerAsset)).toMatchObject({
        provider: "coinbase",
        providerAssetId: null,
        naturalKey: "currency_code:EUR",
        currencyCode: "EUR",
        name: "Euro",
        exponent: 2,
        providerType: "fiat",
      })
    })

    it("rejects a network representation that belongs to another economic asset", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "helius-solana",
            entries: [
              {
                providerAssetId: "mismatched-representation-fixture",
                naturalKey: null,
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: 8,
                providerType: "spl-token",
                payload: { mint: "mismatched-representation-fixture" },
              },
            ],
          })
        )
      )

      const providerAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByProviderAssetId({
            providerKey: "helius-solana",
            providerAssetId: "mismatched-representation-fixture",
          })
        )
      )

      if (Option.isNone(providerAsset)) {
        expect.fail("Expected provider asset fixture to exist")
      }

      const error = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: providerAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: TEST_EUR_REPRESENTATION_ID,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: null,
                sourceNotes: "Invalid cross-asset representation fixture",
              },
            ],
          })
        ).pipe(Effect.flip)
      )

      expect(error).toBeInstanceOf(SyncEngineStorageError)
    })

    it("pages provider asset reviews with a stable provider asset cursor", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "ada-provider-asset",
                naturalKey: null,
                currencyCode: "ADA",
                name: "Cardano",
                exponent: 6,
                providerType: "crypto",
                payload: { code: "ADA" },
              },
              {
                providerAssetId: "eth-provider-asset",
                naturalKey: null,
                currencyCode: "ETH",
                name: "Ethereum",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "ETH" },
              },
              {
                providerAssetId: "sol-provider-asset",
                naturalKey: null,
                currencyCode: "SOL",
                name: "Solana",
                exponent: 9,
                providerType: "crypto",
                payload: { code: "SOL" },
              },
            ],
          })
        )
      )

      const providerAssets = await runRepository(
        Effect.gen(function* () {
          const repository = yield* ProviderAssetRepository
          const cardano = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "ada-provider-asset",
          })
          const ethereum = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "eth-provider-asset",
          })
          const solana = yield* repository.findProviderAssetByProviderAssetId({
            providerKey: "coinbase",
            providerAssetId: "sol-provider-asset",
          })

          if (Option.isNone(cardano) || Option.isNone(ethereum) || Option.isNone(solana)) {
            return yield* Effect.dieMessage("Expected provider assets to exist")
          }

          return [cardano.value, ethereum.value, solana.value] as const
        })
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: providerAssets.map((providerAsset) => ({
              providerAssetRowId: providerAsset.id,
              mappingKind: "asset",
              canonicalAssetId: null,
              assetRepresentationId: null,
              canonicalFiatCurrency: null,
              mappingStatus: "pending_review",
              reviewerNotes: null,
              sourceNotes: "Needs review",
            })),
          })
        )
      )

      const firstPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            cursor: null,
            limit: 2,
          })
        )
      )

      expect(firstPage).toHaveLength(2)
      const lastFirstPageRow = firstPage.at(-1)

      if (lastFirstPageRow === undefined) {
        throw new Error("Expected the first provider asset page to contain rows.")
      }

      const secondPage = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.listProviderAssetReviews({
            providerKey: "coinbase",
            mappingStatus: "pending_review",
            cursor: {
              providerAssetRowId: lastFirstPageRow.providerAsset.id,
            },
            limit: 2,
          })
        )
      )

      expect(secondPage).toHaveLength(1)
      expect(
        new Set([...firstPage, ...secondPage].map((review) => review.providerAsset.currencyCode))
      ).toEqual(new Set(["ADA", "ETH", "SOL"]))
    })

    it("keeps reviewed natural-key mappings preferred when a stable provider asset id arrives later", async () => {
      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: "currency_code:HYPE",
                currencyCode: "hype",
                name: "Hyperliquid",
                exponent: null,
                providerType: null,
                payload: { code: "HYPE" },
              },
            ],
          })
        )
      )

      const naturalKeyProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByNaturalKey({
            providerKey: "coinbase",
            naturalKey: "currency_code:HYPE",
          })
        )
      )

      if (Option.isNone(naturalKeyProviderAsset)) {
        expect.fail("Expected natural-key provider asset row to exist")
      }

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssetMappings({
            mappings: [
              {
                providerAssetRowId: naturalKeyProviderAsset.value.id,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                assetRepresentationId: null,
                canonicalFiatCurrency: null,
                mappingStatus: "approved",
                reviewerNotes: "Admin reviewed placeholder asset",
                sourceNotes: "Admin decision",
              },
            ],
          })
        )
      )

      await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: "hype-provider-asset",
                naturalKey: null,
                currencyCode: "HYPE",
                name: "Hyperliquid",
                exponent: 8,
                providerType: "crypto",
                payload: { code: "HYPE", asset_id: "hype-provider-asset" },
              },
            ],
          })
        )
      )

      const resolvedProviderAsset = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.findProviderAssetByCurrencyCode({
            providerKey: "coinbase",
            currencyCode: "HYPE",
          })
        )
      )

      expect(Option.getOrNull(resolvedProviderAsset)).toMatchObject({
        id: naturalKeyProviderAsset.value.id,
        naturalKey: "currency_code:HYPE",
        providerAssetId: null,
        currencyCode: "HYPE",
      })
    })

    it("fails when a provider asset entry has neither stable id nor natural key", async () => {
      const error = await runRepository(
        Effect.flatMap(ProviderAssetRepository, (repository) =>
          repository.upsertProviderAssets({
            providerKey: "coinbase",
            entries: [
              {
                providerAssetId: null,
                naturalKey: null,
                currencyCode: "mystery",
                name: "Mystery Asset",
                exponent: null,
                providerType: null,
                payload: { code: "MYSTERY" },
              },
            ],
          })
        ).pipe(Effect.flip)
      )

      const providerAssetRows = await runPg(
        Effect.gen(function* () {
          const db = yield* drizzle
          return yield* db
            .select({
              id: schema.providerAssets.id,
            })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.provider, "coinbase"))
        })
      )

      expect(error).toEqual(
        new SyncEngineStorageError({
          operation: "providerAssetRepository.upsertProviderAssets",
          cause: {
            providerKey: "coinbase",
            currencyCode: "mystery",
            message: "Provider asset entries require either providerAssetId or naturalKey.",
          },
        })
      )
      expect(providerAssetRows).toHaveLength(0)
    })
  })
})
