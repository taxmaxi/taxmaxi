import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { SyncEngineSourceRepositoryLive } from "../../src/layers/SyncEngineSourceRepositoryLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_SOURCE_ID,
  TEST_PRINCIPAL_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { SourceRepository } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_sync_engine_source_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, SourceRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: SyncEngineSourceRepositoryLive }))

describe("SyncEngineSourceRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("loads only sources owned by the requesting user", async () => {
    const ownedSource = await runRepository(
      Effect.flatMap(SourceRepository, (repository) =>
        repository.findOwnedSourceSyncContext({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    const missingSource = await runRepository(
      Effect.flatMap(SourceRepository, (repository) =>
        repository.findOwnedSourceSyncContext({
          principalId: "00000000-0000-0000-0000-000000009001",
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    expect(Option.isSome(ownedSource)).toBe(true)
    expect(Option.getOrNull(ownedSource)).toMatchObject({
      id: TEST_SOURCE_ID,
      principalId: TEST_PRINCIPAL_ID,
      providerKey: "coinbase",
      walletAddress: null,
    })
    expect(Option.isNone(missingSource)).toBe(true)
  })

  it("loads wallet address context for onchain sources", async () => {
    const onchainSourceId = "00000000-0000-0000-0000-000000000282"
    const onchainAddressId = "00000000-0000-0000-0000-000000000382"
    const walletAddress = "So11111111111111111111111111111111111111112"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.addresses).values({
          id: onchainAddressId,
          address: walletAddress,
          type: "solana",
          name: "Solana wallet",
          principalId: TEST_PRINCIPAL_ID,
        })
        yield* db.insert(schema.sources).values({
          id: onchainSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Solana wallet",
          providerKey: "helius-solana",
          sourceableType: "onchain",
          addressId: onchainAddressId,
          cexAccountId: null,
        })
      })
    )

    const source = await runRepository(
      Effect.flatMap(SourceRepository, (repository) =>
        repository.findOwnedSourceSyncContext({
          principalId: TEST_PRINCIPAL_ID,
          sourceId: onchainSourceId,
        })
      )
    )

    expect(Option.getOrNull(source)).toMatchObject({
      id: onchainSourceId,
      providerKey: "helius-solana",
      addressId: onchainAddressId,
      walletAddress,
    })
  })

  it("does not hydrate wallet addresses owned by another principal", async () => {
    const foreignUserId = "00000000-0000-0000-0000-000000000184"
    const foreignPrincipalId = "00000000-0000-0000-0000-000000000185"
    const foreignAddressId = "00000000-0000-0000-0000-000000000383"
    const inconsistentSourceId = "00000000-0000-0000-0000-000000000283"
    const foreignWalletAddress = "Foreign1111111111111111111111111111111111111"

    await runPg(
      Effect.gen(function* () {
        const db = yield* drizzle

        yield* db.insert(schema.users).values({
          id: foreignUserId,
          email: "foreign-sync-source-owner@taxmaxi.test",
          name: "Foreign Sync Source Owner",
        })
        yield* db.insert(schema.principals).values({
          id: foreignPrincipalId,
          kind: "user",
          userId: foreignUserId,
        })
        yield* db.insert(schema.addresses).values({
          id: foreignAddressId,
          address: foreignWalletAddress,
          type: "solana",
          name: "Foreign Solana wallet",
          principalId: foreignPrincipalId,
        })
        yield* db.insert(schema.sources).values({
          id: inconsistentSourceId,
          principalId: TEST_PRINCIPAL_ID,
          name: "Inconsistent Solana wallet",
          providerKey: "helius-solana",
          sourceableType: "onchain",
          addressId: foreignAddressId,
          cexAccountId: null,
        })
      })
    )

    const result = await runRepository(
      Effect.flatMap(SourceRepository, (repository) =>
        Effect.all({
          found: repository.findOwnedSourceSyncContext({
            principalId: TEST_PRINCIPAL_ID,
            sourceId: inconsistentSourceId,
          }),
          listed: repository.listPrincipalSourceSyncContexts({ principalId: TEST_PRINCIPAL_ID }),
        })
      )
    )
    const listedSource = result.listed.find((source) => source.id === inconsistentSourceId)

    expect(Option.getOrNull(result.found)).toMatchObject({
      id: inconsistentSourceId,
      principalId: TEST_PRINCIPAL_ID,
      addressId: foreignAddressId,
      walletAddress: null,
    })
    expect(listedSource).toMatchObject({
      id: inconsistentSourceId,
      walletAddress: null,
    })
  })
})
