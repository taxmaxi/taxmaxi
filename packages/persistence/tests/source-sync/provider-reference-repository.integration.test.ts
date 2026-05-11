import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { ProviderReferenceRepositoryLive } from "../../src/layers/ProviderReferenceRepositoryLive.ts"
import {
  makeIntegrationTestDatabaseContext,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"
import { ProviderReferenceRepository } from "@my/sync-engine/services"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_provider_reference_repo",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, ProviderReferenceRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ProviderReferenceRepositoryLive }))

describe("ProviderReferenceRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(seedSyncEngineRepositoryFixture())
  })

  afterAll(async () => {
    await Effect.runPromise(context.destroyTestDatabase())
  })

  it("persists transaction-type catalogs, approved mappings, and pending-review discoveries", async () => {
    const transactionCatalogCount = await runRepository(
      Effect.flatMap(ProviderReferenceRepository, (repository) =>
        repository.upsertTransactionTypeCatalog({
          providerKey: "coinbase",
          entries: [
            {
              providerKey: "coinbase",
              providerTransactionType: "buy",
              displayName: "Buy",
              payload: { type: "buy" },
            },
            {
              providerKey: "coinbase",
              providerTransactionType: "send",
              displayName: "Send",
              payload: { type: "send" },
            },
          ],
        })
      )
    )

    const ensuredTransactionMappings = await runRepository(
      Effect.flatMap(ProviderReferenceRepository, (repository) =>
        repository.ensureTransactionTypeMappings({
          providerKey: "coinbase",
          mappings: [
            {
              providerKey: "coinbase",
              providerTransactionType: "buy",
              transactionType: "buy_fiat",
              inventoryEffect: "acquisition",
              taxTreatment: "non_taxable_by_default",
              resolutionStrategy: "static",
              pairedRecordRequired: false,
              mappingStatus: "approved",
              reviewerNotes: "Reviewed",
              sourceNotes: null,
            },
          ],
        })
      )
    )

    await runRepository(
      Effect.flatMap(ProviderReferenceRepository, (repository) =>
        repository.recordPendingTransactionTypeMapping({
          providerKey: "coinbase",
          providerTransactionType: "mystery_type",
          transactionType: null,
          inventoryEffect: "unknown",
          taxTreatment: "requires_additional_rule_logic",
          resolutionStrategy: "no_leg",
          pairedRecordRequired: false,
          mappingStatus: "pending_review",
          reviewerNotes: null,
          sourceNotes: "Observed in fixture payload",
        })
      )
    )

    const approvedTransactionMapping = await runRepository(
      Effect.flatMap(ProviderReferenceRepository, (repository) =>
        repository.findTransactionTypeMapping({
          providerKey: "coinbase",
          providerTransactionType: "buy",
        })
      )
    )

    const pendingTransactionMapping = await runRepository(
      Effect.flatMap(ProviderReferenceRepository, (repository) =>
        repository.findTransactionTypeMapping({
          providerKey: "coinbase",
          providerTransactionType: "mystery_type",
        })
      )
    )

    expect(transactionCatalogCount).toBe(2)
    expect(ensuredTransactionMappings).toBe(1)
    expect(Option.getOrNull(approvedTransactionMapping)).toMatchObject({
      providerTransactionType: "buy",
      transactionType: "buy_fiat",
      mappingStatus: "approved",
    })
    expect(Option.getOrNull(pendingTransactionMapping)).toMatchObject({
      providerTransactionType: "mystery_type",
      transactionType: null,
      mappingStatus: "pending_review",
    })
  })
})
