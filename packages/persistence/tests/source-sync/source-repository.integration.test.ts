import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { SyncEngineSourceRepositoryLive } from "../../src/layers/SyncEngineSourceRepositoryLive.ts"
import {
  TEST_SOURCE_ID,
  TEST_USER_ID,
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
          userId: TEST_USER_ID,
          sourceId: TEST_SOURCE_ID,
        })
      )
    )
    const missingSource = await runRepository(
      Effect.flatMap(SourceRepository, (repository) =>
        repository.findOwnedSourceSyncContext({
          userId: "00000000-0000-0000-0000-000000009001",
          sourceId: TEST_SOURCE_ID,
        })
      )
    )

    expect(Option.isSome(ownedSource)).toBe(true)
    expect(Option.getOrNull(ownedSource)).toMatchObject({
      id: TEST_SOURCE_ID,
      userId: TEST_USER_ID,
      providerKey: "coinbase",
    })
    expect(Option.isNone(missingSource)).toBe(true)
  })
})
