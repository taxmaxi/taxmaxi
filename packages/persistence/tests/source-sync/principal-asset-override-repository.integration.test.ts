import { beforeEach, describe, expect, it } from "@effect/vitest"
import type { PrincipalAssetOverrideTarget } from "@my/core/assets"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { PrincipalAssetOverrideRepositoryLive } from "../../src/layers/PrincipalAssetOverrideRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideProjection,
} from "../../src/services/PrincipalAssetOverrideRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const CURRENT_ASSET_ID = "00000000-0000-4000-8000-000000000701"
const CURRENT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000000702"
const OVERRIDE_TARGET_ID = "00000000-0000-4000-8000-000000000703"
const OVERRIDE_ID = "00000000-0000-4000-8000-000000000704"
const NFT_ASSET_ID = "00000000-0000-4000-8000-000000000705"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000706"
const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000707"
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000708"
const PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000709"
const NFT_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000710"
const PRIMARY_USER_ID = "00000000-0000-4000-8000-000000000711"
const PRIMARY_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000712"
const PRIMARY_SOURCE_ID = "00000000-0000-4000-8000-000000000713"
const EXACT_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000714"
const EXACT_TRANSACTION_ID = "00000000-0000-4000-8000-000000000715"
const INCLUSION_OVERRIDE_ID = "00000000-0000-4000-8000-000000000716"
const INCLUSION_WITHDRAWAL_ID = "00000000-0000-4000-8000-000000000717"
const FIRST_CONCLUSION_ID = "00000000-0000-4000-8000-000000000718"
const SECOND_CONCLUSION_ID = "00000000-0000-4000-8000-000000000719"
const POLICY_EVALUATION_ID = "00000000-0000-4000-8000-000000000720"
const EXCLUDED_CONCLUSION_ID = "00000000-0000-4000-8000-000000000721"
const CHAINLESS_CONCLUSION_ID = "00000000-0000-4000-8000-000000000722"
const FIAT_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000723"
const MATCHING_TRANSFER_ID = "00000000-0000-4000-8000-000000000724"
const MISMATCH_TRANSFER_ID = "00000000-0000-4000-8000-000000000725"
const EVM_CONTRACT_CHECKSUM = "0xAbCd000000000000000000000000000000000096"
const EVM_CONTRACT_CANONICAL = EVM_CONTRACT_CHECKSUM.toLowerCase()
const SOLANA_MINT = "CaseSensitiveMint1111111111111111111111111111"
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value))

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_asset_override_repository",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const runRepository = <A, E>(effect: Effect.Effect<A, E, PrincipalAssetOverrideRepository>) =>
  context.runWithLayer({ effect, layer: PrincipalAssetOverrideRepositoryLive })

const findProjection = (params: {
  readonly principalId?: string
  readonly target: PrincipalAssetOverrideTarget
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.findProjection({
        principalId: PrincipalId.make(params.principalId ?? PRIMARY_PRINCIPAL_ID),
        target: params.target,
      })
    )
  )

const validateIdentityReplacement = (params: {
  readonly assetId: string
  readonly principalId?: string
  readonly target: PrincipalAssetOverrideTarget
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.validateIdentityReplacement({
        assetId: params.assetId,
        principalId: PrincipalId.make(params.principalId ?? PRIMARY_PRINCIPAL_ID),
        target: params.target,
      })
    )
  )

const representationTarget = ({
  blockchain = "base",
  contractAddress = EVM_CONTRACT_CANONICAL,
  mintAddress = null,
}: {
  readonly blockchain?: string
  readonly contractAddress?: string | null
  readonly mintAddress?: string | null
} = {}): PrincipalAssetOverrideTarget => ({
  _tag: "representation",
  blockchain,
  type: "token",
  contractAddress,
  mintAddress,
})

const expectProjection = (
  projection: Option.Option<PrincipalAssetOverrideProjection>
): PrincipalAssetOverrideProjection => {
  expect(Option.isSome(projection)).toBe(true)
  return Option.getOrThrow(projection)
}

describe("PrincipalAssetOverrideRepository", () => {
  it.effect("collapses EVM aliases and keeps an active override visible when TaxMaxi changes", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const seeded = yield* seedSyncEngineRepositoryFixture({
              userId: PRIMARY_USER_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              sourceId: PRIMARY_SOURCE_ID,
            })
            yield* seedSyncEngineAssets(seeded)
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: CURRENT_ASSET_ID,
              name: "USD Coin",
              symbol: "USDC",
              coingeckoCoinId: "usd-coin",
              type: "fungible",
            })
            yield* db.insert(schema.assetRepresentations).values({
              id: CURRENT_REPRESENTATION_ID,
              assetId: CURRENT_ASSET_ID,
              blockchainId: seeded.baseBlockchainId,
              type: "token",
              contractAddress: EVM_CONTRACT_CANONICAL,
              mintAddress: null,
              decimals: 6,
              isSpam: false,
              updatedAt: date("2026-08-31T10:00:00.000Z"),
            })
            yield* db.insert(schema.sourceRepresentationUses).values({
              sourceId: PRIMARY_SOURCE_ID,
              blockchainId: seeded.baseBlockchainId,
              representationType: "token",
              contractAddress: EVM_CONTRACT_CHECKSUM,
              mintAddress: null,
            })
            return seeded
          })
        )
      )

      const initial = expectProjection(
        yield* findProjection({
          target: representationTarget({ contractAddress: EVM_CONTRACT_CHECKSUM }),
        })
      )
      expect(initial.target).toEqual(representationTarget())
      expect(initial.system.identity).toEqual({ _tag: "resolved", assetId: CURRENT_ASSET_ID })
      expect(initial.checkedTechnicalBlockerKinds).toEqual([
        "malformed_movement",
        "missing_decimals",
        "unsupported_asset_type",
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrideTargets).values({
              id: OVERRIDE_TARGET_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              targetKind: "representation",
              blockchainId: fixture.baseBlockchainId,
              representationType: "token",
              contractAddress: EVM_CONTRACT_CANONICAL,
              mintAddress: null,
              providerAssetRowId: null,
            })
            yield* db.insert(schema.principalAssetOverrides).values([
              {
                id: OVERRIDE_ID,
                principalId: PRIMARY_PRINCIPAL_ID,
                targetId: OVERRIDE_TARGET_ID,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: initial.system.identityRevision,
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: CURRENT_ASSET_ID,
                inspectedSystemInclusion: null,
                replacementAssetId: TEST_BTC_ASSET_ID,
                replacementInclusion: null,
                actorUserId: PRIMARY_USER_ID,
                reason: "Treat this contract as the existing BTC economic asset.",
                supersedesOverrideId: null,
                recordedAt: date("2026-08-31T10:01:00.000Z"),
              },
              {
                id: INCLUSION_OVERRIDE_ID,
                principalId: PRIMARY_PRINCIPAL_ID,
                targetId: OVERRIDE_TARGET_ID,
                kind: "inclusion",
                operation: "create",
                inspectedSystemRevision: initial.system.inclusionRevision,
                inspectedSystemIdentity: null,
                inspectedSystemAssetId: null,
                inspectedSystemInclusion: "included",
                replacementAssetId: null,
                replacementInclusion: "excluded",
                actorUserId: PRIMARY_USER_ID,
                reason: "Exclude this asset from my calculation.",
                supersedesOverrideId: null,
                recordedAt: date("2026-08-31T10:02:00.000Z"),
              },
              {
                id: INCLUSION_WITHDRAWAL_ID,
                principalId: PRIMARY_PRINCIPAL_ID,
                targetId: OVERRIDE_TARGET_ID,
                kind: "inclusion",
                operation: "withdraw",
                inspectedSystemRevision: initial.system.inclusionRevision,
                inspectedSystemIdentity: null,
                inspectedSystemAssetId: null,
                inspectedSystemInclusion: "included",
                replacementAssetId: null,
                replacementInclusion: null,
                actorUserId: PRIMARY_USER_ID,
                reason: "Return to TaxMaxi's inclusion decision.",
                supersedesOverrideId: INCLUSION_OVERRIDE_ID,
                recordedAt: date("2026-08-31T10:03:00.000Z"),
              },
            ])
            yield* db
              .delete(schema.sourceRepresentationUses)
              .where(eq(schema.sourceRepresentationUses.sourceId, PRIMARY_SOURCE_ID))
          })
        )
      )

      const withOverride = expectProjection(
        yield* findProjection({ target: representationTarget() })
      )
      expect(withOverride.activeIdentityOverride?.id).toBe(OVERRIDE_ID)
      expect(withOverride.effectiveDecision).toEqual({
        _tag: "included",
        assetId: TEST_BTC_ASSET_ID,
      })
      expect(withOverride.identityOverrideUsesStaleSystemRevision).toBe(false)
      expect(withOverride.activeInclusionOverride).toBeNull()
      expect(withOverride.history.map(({ id }) => id)).toEqual([
        OVERRIDE_ID,
        INCLUSION_OVERRIDE_ID,
        INCLUSION_WITHDRAWAL_ID,
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetRepresentations)
              .set({ updatedAt: date("2026-08-31T10:30:00.000Z") })
              .where(eq(schema.assetRepresentations.id, CURRENT_REPRESENTATION_ID))
          })
        )
      )

      const afterNoopRefresh = expectProjection(
        yield* findProjection({ target: representationTarget() })
      )
      expect(afterNoopRefresh.system.identityRevision).toBe(initial.system.identityRevision)
      expect(afterNoopRefresh.system.inclusionRevision).toBe(initial.system.inclusionRevision)
      expect(afterNoopRefresh.identityOverrideUsesStaleSystemRevision).toBe(false)

      const validation = yield* validateIdentityReplacement({
        assetId: TEST_BTC_ASSET_ID,
        target: representationTarget({ contractAddress: EVM_CONTRACT_CHECKSUM }),
      })
      expect(Option.isSome(validation) && validation.value._tag === "ready").toBe(true)
      if (Option.isSome(validation) && validation.value._tag === "ready") {
        expect(validation.value.checkedTechnicalBlockerKinds).toEqual([
          "malformed_movement",
          "missing_decimals",
          "unsupported_asset_type",
        ])
        expect(validation.value.warnings.map(({ code }) => code)).toEqual([
          "symbol_mismatch",
          "name_mismatch",
          "market_data_identity_mismatch",
          "system_identity_mismatch",
        ])
      }

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetRepresentations)
              .set({
                assetId: TEST_BTC_ASSET_ID,
                updatedAt: date("2026-08-31T11:00:00.000Z"),
              })
              .where(eq(schema.assetRepresentations.id, CURRENT_REPRESENTATION_ID))
          })
        )
      )

      const afterSystemChange = expectProjection(
        yield* findProjection({ target: representationTarget() })
      )
      expect(afterSystemChange.activeIdentityOverride?.id).toBe(OVERRIDE_ID)
      expect(afterSystemChange.identityOverrideUsesStaleSystemRevision).toBe(true)
      expect(afterSystemChange.system.identity).toEqual({
        _tag: "resolved",
        assetId: TEST_BTC_ASSET_ID,
      })
      expect(afterSystemChange.effectiveDecision).toEqual({
        _tag: "included",
        assetId: TEST_BTC_ASSET_ID,
      })
    })
  )

  it.effect("aggregates owned conclusions across providers without a global representation", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const seeded = yield* seedSyncEngineRepositoryFixture({
              userId: PRIMARY_USER_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              sourceId: PRIMARY_SOURCE_ID,
            })
            yield* seedSyncEngineAssets(seeded)
            const db = yield* drizzle
            const occurredAt = date("2026-08-31T12:00:00.000Z")
            yield* db.insert(schema.assets).values({
              id: CURRENT_ASSET_ID,
              name: "USD Coin",
              symbol: "USDC",
              coingeckoCoinId: "usd-coin",
              type: "fungible",
            })
            yield* db.insert(schema.providerAssets).values([
              {
                id: EXACT_PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "exact-provider-conclusion",
                currencyCode: "USDC",
                name: "USD Coin",
                exponent: 6,
                providerType: "crypto",
                retrievedAt: occurredAt,
              },
              {
                id: NFT_PROVIDER_ASSET_ID,
                provider: "second-provider",
                providerAssetId: "same-exact-representation",
                currencyCode: "USDC.e",
                name: "Bridged USD Coin",
                exponent: 6,
                providerType: "crypto",
                retrievedAt: occurredAt,
              },
            ])
            yield* db.insert(schema.providerAssetMappings).values([
              {
                providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
                mappingKind: "asset",
                mappingStatus: "excluded",
                canonicalAssetId: CURRENT_ASSET_ID,
                canonicalFiatCurrency: null,
                updatedAt: occurredAt,
              },
              {
                providerAssetRowId: NFT_PROVIDER_ASSET_ID,
                mappingKind: "asset",
                mappingStatus: "pending_review",
                canonicalAssetId: null,
                canonicalFiatCurrency: null,
                updatedAt: occurredAt,
              },
            ])
            yield* db.insert(schema.assetResolutionDecisions).values([
              {
                id: FIRST_CONCLUSION_ID,
                providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
                evidenceRevision: 1,
                policyRevision: "test-v1",
                outcome: "identity",
                assetId: CURRENT_ASSET_ID,
                actor: "test:first-conclusion",
              },
              {
                id: SECOND_CONCLUSION_ID,
                providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
                evidenceRevision: 1,
                policyRevision: "test-v2",
                outcome: "identity",
                supersedesDecisionId: FIRST_CONCLUSION_ID,
                assetId: TEST_BTC_ASSET_ID,
                actor: "test:second-conclusion",
              },
              {
                id: POLICY_EVALUATION_ID,
                providerAssetRowId: NFT_PROVIDER_ASSET_ID,
                evidenceRevision: 1,
                policyRevision: "test-policy-v1",
                outcome: "pending",
                reason: "possible_duplicate",
                actor: "system:asset-resolution-policy",
              },
            ])
            yield* db.insert(schema.assetResolutionCurrentState).values([
              {
                providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
                currentConclusionId: FIRST_CONCLUSION_ID,
                currentPolicyEvaluationId: null,
                updatedAt: occurredAt,
              },
              {
                providerAssetRowId: NFT_PROVIDER_ASSET_ID,
                currentConclusionId: null,
                currentPolicyEvaluationId: POLICY_EVALUATION_ID,
                updatedAt: occurredAt,
              },
            ])
            yield* db.insert(schema.sourceRepresentationUses).values({
              sourceId: PRIMARY_SOURCE_ID,
              blockchainId: seeded.baseBlockchainId,
              representationType: "token",
              contractAddress: EVM_CONTRACT_CANONICAL,
              mintAddress: null,
            })
            yield* db.insert(schema.transactions).values({
              id: EXACT_TRANSACTION_ID,
              sourceId: PRIMARY_SOURCE_ID,
              externalId: "provider-conclusion-transaction",
              timestamp: occurredAt,
              principalId: PRIMARY_PRINCIPAL_ID,
            })
            yield* db.insert(schema.providerTransfers).values([
              {
                id: MATCHING_TRANSFER_ID,
                sourceId: PRIMARY_SOURCE_ID,
                transactionId: EXACT_TRANSACTION_ID,
                externalId: "provider-conclusion-transfer",
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAddress: "external-address",
                toAddress: "owned-address",
                providerAssetId: EXACT_PROVIDER_ASSET_ID,
                observedBlockchainId: seeded.baseBlockchainId,
                observedRepresentationType: "token",
                observedContractAddress: EVM_CONTRACT_CANONICAL,
                observedMintAddress: null,
                observedDecimals: 6,
                amount: "1",
              },
              {
                id: MISMATCH_TRANSFER_ID,
                sourceId: PRIMARY_SOURCE_ID,
                transactionId: EXACT_TRANSACTION_ID,
                externalId: "second-provider-transfer",
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAddress: "external-address",
                toAddress: "owned-address",
                providerAssetId: NFT_PROVIDER_ASSET_ID,
                observedBlockchainId: seeded.baseBlockchainId,
                observedRepresentationType: "token",
                observedContractAddress: EVM_CONTRACT_CANONICAL,
                observedMintAddress: null,
                observedDecimals: 6,
                amount: "1",
              },
            ])
            return seeded
          })
        )
      )

      const initial = expectProjection(yield* findProjection({ target: representationTarget() }))
      expect(initial.system.identity).toEqual({ _tag: "resolved", assetId: CURRENT_ASSET_ID })
      expect(initial.system.inclusion).toBe("included")
      expect(initial.technicalBlockers).toEqual([])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.providerTransfers).values(
              Array.from({ length: 40 }, (_, index) => ({
                id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
                sourceId: PRIMARY_SOURCE_ID,
                transactionId: EXACT_TRANSACTION_ID,
                externalId: `duplicate-exact-transfer-${index}`,
                timestamp: date("2026-08-31T12:00:00.000Z"),
                direction: "inbound" as const,
                processingMode: "accounting_and_evidence" as const,
                fromAddress: "external-address",
                toAddress: "owned-address",
                providerAssetId: EXACT_PROVIDER_ASSET_ID,
                observedBlockchainId: fixture.baseBlockchainId,
                observedRepresentationType: "token" as const,
                observedContractAddress: EVM_CONTRACT_CANONICAL,
                observedMintAddress: null,
                observedDecimals: 6,
                amount: "1",
              }))
            )
            yield* db
              .update(schema.providerAssetMappings)
              .set({ updatedAt: date("2026-08-31T12:30:00.000Z") })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, EXACT_PROVIDER_ASSET_ID))
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ updatedAt: date("2026-08-31T12:30:00.000Z") })
              .where(
                eq(schema.assetResolutionCurrentState.providerAssetRowId, EXACT_PROVIDER_ASSET_ID)
              )
          })
        )
      )

      const afterNoopRefresh = expectProjection(
        yield* findProjection({ target: representationTarget() })
      )
      expect(afterNoopRefresh.system.identityRevision).toBe(initial.system.identityRevision)
      expect(afterNoopRefresh.system.inclusionRevision).toBe(initial.system.inclusionRevision)
      const metadataValidation = yield* validateIdentityReplacement({
        assetId: CURRENT_ASSET_ID,
        target: representationTarget(),
      })
      expect(Option.getOrNull(metadataValidation)).toMatchObject({
        _tag: "ready",
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "name_mismatch", current: "Bridged USD Coin" }),
          expect.objectContaining({ code: "symbol_mismatch", current: "USDC.e" }),
        ]),
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrideTargets).values({
              id: OVERRIDE_TARGET_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              targetKind: "representation",
              blockchainId: fixture.baseBlockchainId,
              representationType: "token",
              contractAddress: EVM_CONTRACT_CANONICAL,
              mintAddress: null,
              providerAssetRowId: null,
            })
            yield* db.insert(schema.principalAssetOverrides).values({
              id: OVERRIDE_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              targetId: OVERRIDE_TARGET_ID,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: initial.system.identityRevision,
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: CURRENT_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: PRIMARY_USER_ID,
              reason: "Use the existing BTC asset for this exact representation.",
              supersedesOverrideId: null,
            })
            yield* db
              .update(schema.providerAssetMappings)
              .set({
                canonicalAssetId: TEST_BTC_ASSET_ID,
                updatedAt: date("2026-08-31T13:00:00.000Z"),
              })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, EXACT_PROVIDER_ASSET_ID))
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({
                currentConclusionId: SECOND_CONCLUSION_ID,
                updatedAt: date("2026-08-31T13:00:00.000Z"),
              })
              .where(
                eq(schema.assetResolutionCurrentState.providerAssetRowId, EXACT_PROVIDER_ASSET_ID)
              )
          })
        )
      )

      const changed = expectProjection(yield* findProjection({ target: representationTarget() }))
      expect(changed.system.identity).toEqual({ _tag: "resolved", assetId: TEST_BTC_ASSET_ID })
      expect(changed.system.identityRevision).not.toBe(initial.system.identityRevision)
      expect(changed.activeIdentityOverride?.id).toBe(OVERRIDE_ID)
      expect(changed.identityOverrideUsesStaleSystemRevision).toBe(true)
      expect(changed.effectiveDecision).toEqual({ _tag: "included", assetId: TEST_BTC_ASSET_ID })
      const validation = yield* validateIdentityReplacement({
        assetId: TEST_BTC_ASSET_ID,
        target: representationTarget(),
      })
      expect(Option.getOrNull(validation)).toMatchObject({
        _tag: "ready",
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "system_confidence_pending", current: "pending" }),
        ]),
      })

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.assetResolutionDecisions).values({
              id: EXCLUDED_CONCLUSION_ID,
              providerAssetRowId: NFT_PROVIDER_ASSET_ID,
              evidenceRevision: 2,
              policyRevision: "test-v3",
              outcome: "excluded",
              actor: "test:excluded-conclusion",
            })
            yield* db
              .update(schema.assetResolutionCurrentState)
              .set({ currentConclusionId: EXCLUDED_CONCLUSION_ID })
              .where(
                eq(schema.assetResolutionCurrentState.providerAssetRowId, NFT_PROVIDER_ASSET_ID)
              )
          })
        )
      )

      const conflict = expectProjection(yield* findProjection({ target: representationTarget() }))
      expect(conflict.system.identity).toEqual({ _tag: "resolved", assetId: TEST_BTC_ASSET_ID })
      expect(conflict.system.inclusion).toBe("excluded")
      const conflictValidation = yield* validateIdentityReplacement({
        assetId: TEST_BTC_ASSET_ID,
        target: representationTarget(),
      })
      expect(Option.getOrNull(conflictValidation)).toMatchObject({
        _tag: "ready",
        warnings: expect.arrayContaining([
          expect.objectContaining({
            code: "system_confidence_conflict",
            current: "conflicting",
          }),
        ]),
      })
    })
  )

  it.effect("keeps case-sensitive representation keys distinct and hides unowned targets", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const fixture = yield* seedSyncEngineRepositoryFixture({
              userId: PRIMARY_USER_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              sourceId: PRIMARY_SOURCE_ID,
            })
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            const db = yield* drizzle
            const [solana] = yield* db
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(eq(schema.blockchains.name, "solana"))
              .limit(1)
            if (solana === undefined) return yield* Effect.die("Missing Solana fixture")

            yield* db.insert(schema.sourceRepresentationUses).values({
              sourceId: fixture.sourceId,
              blockchainId: solana.id,
              representationType: "token",
              contractAddress: null,
              mintAddress: SOLANA_MINT,
            })
          })
        )
      )

      const exactTarget = representationTarget({
        blockchain: "Solana",
        contractAddress: null,
        mintAddress: SOLANA_MINT,
      })
      const exact = expectProjection(yield* findProjection({ target: exactTarget }))
      expect(exact.target).toEqual({ ...exactTarget, blockchain: "solana" })
      expect(exact.technicalBlockers).toEqual(["missing_decimals"])

      const absent = yield* findProjection({
        target: representationTarget({
          blockchain: "solana",
          contractAddress: null,
          mintAddress: SOLANA_MINT.toLowerCase(),
        }),
      })
      const unowned = yield* findProjection({
        principalId: OTHER_PRINCIPAL_ID,
        target: exactTarget,
      })
      expect(Option.isNone(absent)).toBe(true)
      expect(unowned).toEqual(absent)
    })
  )

  it.effect(
    "uses current chainless conclusions, authoritative asset types, and rejects fiat targets",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const fixture = yield* seedSyncEngineRepositoryFixture({
                userId: PRIMARY_USER_ID,
                principalId: PRIMARY_PRINCIPAL_ID,
                sourceId: PRIMARY_SOURCE_ID,
              })
              yield* seedSyncEngineAssets(fixture)
              const db = yield* drizzle
              const observedAt = date("2026-08-31T14:00:00.000Z")
              yield* db.insert(schema.assets).values([
                {
                  id: CURRENT_ASSET_ID,
                  name: "Mapped Fungible",
                  symbol: "MAP",
                  type: "fungible",
                },
                {
                  id: NFT_ASSET_ID,
                  name: "Current NFT",
                  symbol: "CNFT",
                  type: "nft",
                },
              ])
              yield* db.insert(schema.providerAssets).values([
                {
                  id: PROVIDER_ASSET_ID,
                  provider: "coinbase",
                  providerAssetId: "chainless-current-conclusion",
                  currencyCode: "CNFT",
                  name: "Current NFT",
                  exponent: 0,
                  providerType: "crypto",
                  retrievedAt: observedAt,
                },
                {
                  id: FIAT_PROVIDER_ASSET_ID,
                  provider: "coinbase",
                  providerAssetId: "eur-fiat-observation",
                  currencyCode: "EUR",
                  name: "Euro",
                  exponent: 2,
                  providerType: "fiat",
                  retrievedAt: observedAt,
                },
              ])
              yield* db.insert(schema.providerAssetMappings).values([
                {
                  providerAssetRowId: PROVIDER_ASSET_ID,
                  mappingKind: "asset",
                  mappingStatus: "excluded",
                  canonicalAssetId: CURRENT_ASSET_ID,
                  canonicalFiatCurrency: null,
                  updatedAt: observedAt,
                },
                {
                  providerAssetRowId: FIAT_PROVIDER_ASSET_ID,
                  mappingKind: "fiat",
                  mappingStatus: "approved",
                  canonicalAssetId: null,
                  canonicalFiatCurrency: "EUR",
                  updatedAt: observedAt,
                },
              ])
              yield* db.insert(schema.assetResolutionDecisions).values({
                id: CHAINLESS_CONCLUSION_ID,
                providerAssetRowId: PROVIDER_ASSET_ID,
                evidenceRevision: 1,
                policyRevision: "test-chainless-v1",
                outcome: "identity",
                assetId: NFT_ASSET_ID,
                actor: "test:chainless-conclusion",
              })
              yield* db.insert(schema.assetResolutionCurrentState).values({
                providerAssetRowId: PROVIDER_ASSET_ID,
                currentConclusionId: CHAINLESS_CONCLUSION_ID,
                currentPolicyEvaluationId: null,
                updatedAt: observedAt,
              })
              yield* db.insert(schema.providerAssetSourceUses).values([
                { providerAssetRowId: PROVIDER_ASSET_ID, sourceId: fixture.sourceId },
                { providerAssetRowId: FIAT_PROVIDER_ASSET_ID, sourceId: fixture.sourceId },
              ])
            })
          )
        )

        const target: PrincipalAssetOverrideTarget = {
          _tag: "provider_asset",
          providerAssetRowId: PROVIDER_ASSET_ID,
        }
        const initial = expectProjection(yield* findProjection({ target }))
        expect(initial.system.identity).toEqual({ _tag: "resolved", assetId: NFT_ASSET_ID })
        expect(initial.system.inclusion).toBe("included")
        expect(initial.technicalBlockers).toEqual([])

        const nft = yield* validateIdentityReplacement({ assetId: NFT_ASSET_ID, target })
        expect(Option.getOrNull(nft)).toMatchObject({
          _tag: "ready",
          asset: { id: NFT_ASSET_ID, type: "nft" },
          technicalBlockers: [],
        })
        const fungible = yield* validateIdentityReplacement({ assetId: TEST_BTC_ASSET_ID, target })
        expect(Option.getOrNull(fungible)).toMatchObject({
          _tag: "incompatible_asset_type",
          targetAssetType: "nft",
        })

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerAssetMappings)
                .set({ updatedAt: date("2026-08-31T14:30:00.000Z") })
                .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
              yield* db
                .update(schema.assetResolutionCurrentState)
                .set({ updatedAt: date("2026-08-31T14:30:00.000Z") })
                .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, PROVIDER_ASSET_ID))
            })
          )
        )

        const afterNoopRefresh = expectProjection(yield* findProjection({ target }))
        expect(afterNoopRefresh.system.identityRevision).toBe(initial.system.identityRevision)
        expect(afterNoopRefresh.system.inclusionRevision).toBe(initial.system.inclusionRevision)

        const fiatTarget: PrincipalAssetOverrideTarget = {
          _tag: "provider_asset",
          providerAssetRowId: FIAT_PROVIDER_ASSET_ID,
        }
        const fiatProjection = yield* findProjection({ target: fiatTarget })
        const fiatValidation = yield* validateIdentityReplacement({
          assetId: TEST_BTC_ASSET_ID,
          target: fiatTarget,
        })
        expect(Option.isNone(fiatProjection)).toBe(true)
        expect(Option.isNone(fiatValidation)).toBe(true)
      })
  )

  it.effect("returns typed provider blockers without vetoing an existing identity choice", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const fixture = yield* seedSyncEngineRepositoryFixture({
              userId: PRIMARY_USER_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              sourceId: PRIMARY_SOURCE_ID,
            })
            yield* seedSyncEngineAssets(fixture)
            const db = yield* drizzle
            yield* db.insert(schema.providerAssets).values({
              id: PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "unsupported-observation",
              currencyCode: "MYSTERY",
              name: "Mystery Asset",
              exponent: null,
              providerType: "unknown",
              retrievedAt: date("2026-08-31T10:00:00.000Z"),
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: PROVIDER_ASSET_ID,
              mappingKind: "asset",
              mappingStatus: "excluded",
              canonicalAssetId: null,
              canonicalFiatCurrency: null,
            })
            yield* db.insert(schema.assetResolutionDecisions).values({
              id: POLICY_EVALUATION_ID,
              providerAssetRowId: PROVIDER_ASSET_ID,
              evidenceRevision: 1,
              policyRevision: "test-policy-v1",
              outcome: "fail_closed",
              reason: "conflicting_authority",
              actor: "system:asset-resolution-policy",
            })
            yield* db.insert(schema.assetResolutionCurrentState).values({
              providerAssetRowId: PROVIDER_ASSET_ID,
              currentConclusionId: null,
              currentPolicyEvaluationId: POLICY_EVALUATION_ID,
            })
            yield* db.insert(schema.providerAssetSourceUses).values({
              providerAssetRowId: PROVIDER_ASSET_ID,
              sourceId: fixture.sourceId,
            })
          })
        )
      )

      const target: PrincipalAssetOverrideTarget = {
        _tag: "provider_asset",
        providerAssetRowId: PROVIDER_ASSET_ID,
      }
      const projection = expectProjection(yield* findProjection({ target }))
      expect(projection.system.identity).toEqual({ _tag: "unresolved" })
      expect(projection.system.inclusion).toBe("excluded")
      expect(projection.technicalBlockers).toEqual(["missing_decimals", "unsupported_asset_type"])
      expect(projection.effectiveDecision).toEqual({
        _tag: "excluded",
        identity: { _tag: "unresolved" },
      })

      const missingAsset = yield* validateIdentityReplacement({
        assetId: "00000000-0000-4000-8000-000000000799",
        target,
      })
      expect(Option.getOrNull(missingAsset)).toMatchObject({
        _tag: "asset_not_found",
        assetId: "00000000-0000-4000-8000-000000000799",
        checkedTechnicalBlockerKinds: [
          "malformed_movement",
          "missing_decimals",
          "unsupported_asset_type",
        ],
        technicalBlockers: ["missing_decimals", "unsupported_asset_type"],
      })

      const existingAsset = yield* validateIdentityReplacement({
        assetId: TEST_BTC_ASSET_ID,
        target,
      })
      expect(Option.getOrNull(existingAsset)).toMatchObject({
        _tag: "ready",
        technicalBlockers: ["missing_decimals", "unsupported_asset_type"],
        warnings: expect.arrayContaining([
          expect.objectContaining({
            code: "system_confidence_fail_closed",
            current: "fail_closed",
          }),
        ]),
      })
    })
  )

  it.effect("rejects known fungible and NFT mismatches", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const fixture = yield* seedSyncEngineRepositoryFixture({
              userId: PRIMARY_USER_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              sourceId: PRIMARY_SOURCE_ID,
            })
            yield* seedSyncEngineAssets(fixture)
            const db = yield* drizzle
            yield* db.insert(schema.assets).values({
              id: NFT_ASSET_ID,
              name: "Fixture NFT",
              symbol: "NFT",
              type: "nft",
            })
            yield* db.insert(schema.providerAssets).values({
              id: NFT_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "nft-observation",
              currencyCode: "NFT",
              name: "Fixture NFT",
              exponent: 0,
              providerType: "nft",
              retrievedAt: date("2026-08-31T10:00:00.000Z"),
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: NFT_PROVIDER_ASSET_ID,
              mappingKind: "asset",
              mappingStatus: "pending_review",
              canonicalAssetId: null,
              canonicalFiatCurrency: null,
            })
            yield* db.insert(schema.providerAssetSourceUses).values({
              providerAssetRowId: NFT_PROVIDER_ASSET_ID,
              sourceId: fixture.sourceId,
            })
          })
        )
      )

      const target: PrincipalAssetOverrideTarget = {
        _tag: "provider_asset",
        providerAssetRowId: NFT_PROVIDER_ASSET_ID,
      }
      const fungible = yield* validateIdentityReplacement({ assetId: TEST_BTC_ASSET_ID, target })
      expect(Option.getOrNull(fungible)).toMatchObject({
        _tag: "incompatible_asset_type",
        targetAssetType: "nft",
        asset: { id: TEST_BTC_ASSET_ID, type: "fungible" },
      })

      const nft = yield* validateIdentityReplacement({ assetId: NFT_ASSET_ID, target })
      expect(Option.getOrNull(nft)).toMatchObject({
        _tag: "ready",
        asset: { id: NFT_ASSET_ID, type: "nft" },
      })
    })
  )

  it.effect("does not treat an exact provider observation as a chainless fallback", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const fixture = yield* seedSyncEngineRepositoryFixture({
              userId: PRIMARY_USER_ID,
              principalId: PRIMARY_PRINCIPAL_ID,
              sourceId: PRIMARY_SOURCE_ID,
            })
            const db = yield* drizzle
            const occurredAt = date("2026-08-31T10:00:00.000Z")
            yield* db.insert(schema.providerAssets).values({
              id: EXACT_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "exact-observation",
              currencyCode: "USDC",
              name: "USD Coin",
              exponent: 6,
              providerType: "crypto",
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
              mappingKind: "asset",
              mappingStatus: "pending_review",
              canonicalAssetId: null,
              canonicalFiatCurrency: null,
            })
            yield* db.insert(schema.providerAssetSourceUses).values({
              providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
              sourceId: fixture.sourceId,
            })
            yield* db.insert(schema.transactions).values({
              id: EXACT_TRANSACTION_ID,
              sourceId: fixture.sourceId,
              externalId: "exact-observation-transaction",
              timestamp: occurredAt,
              principalId: PRIMARY_PRINCIPAL_ID,
            })
            yield* db.insert(schema.providerTransfers).values({
              sourceId: fixture.sourceId,
              transactionId: EXACT_TRANSACTION_ID,
              externalId: "exact-observation-transfer",
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "accounting_and_evidence",
              fromAddress: "external-address",
              toAddress: "owned-address",
              providerAssetId: EXACT_PROVIDER_ASSET_ID,
              observedBlockchainId: fixture.baseBlockchainId,
              observedRepresentationType: "token",
              observedContractAddress: EVM_CONTRACT_CANONICAL,
              observedMintAddress: null,
              observedDecimals: 6,
              amount: "1",
            })
          })
        )
      )

      const projection = yield* findProjection({
        target: {
          _tag: "provider_asset",
          providerAssetRowId: EXACT_PROVIDER_ASSET_ID,
        },
      })
      expect(Option.isNone(projection)).toBe(true)
    })
  )

  it.effect("returns typed canonical-target errors", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: PRIMARY_USER_ID,
            principalId: PRIMARY_PRINCIPAL_ID,
            sourceId: PRIMARY_SOURCE_ID,
          })
        )
      )

      const unknownBlockchain = yield* findProjection({
        target: representationTarget({ blockchain: "missing-chain" }),
      }).pipe(Effect.flip)
      expect(unknownBlockchain).toMatchObject({
        _tag: "PrincipalAssetOverrideInvalidTargetError",
        reason: "unknown_blockchain",
      })

      const invalidEvmAddress = yield* findProjection({
        target: representationTarget({ contractAddress: "not-an-evm-address" }),
      }).pipe(Effect.flip)
      expect(invalidEvmAddress).toMatchObject({
        _tag: "PrincipalAssetOverrideInvalidTargetError",
        reason: "invalid_evm_address",
      })
    })
  )
})
