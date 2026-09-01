import { beforeEach, describe, expect, it } from "@effect/vitest"
import { AuthUserId } from "@my/core/authentication"
import type { PrincipalAssetOverrideTarget } from "@my/core/assets"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { PrincipalAssetOverrideRepositoryLive } from "../../src/layers/PrincipalAssetOverrideRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  PrincipalAssetOverrideConflictError,
  PrincipalAssetOverrideReplacementValidationError,
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideProjection,
} from "../../src/services/PrincipalAssetOverrideRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const USER_ID = "00000000-0000-4000-8000-000000000801"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000802"
const SOURCE_ID = "00000000-0000-4000-8000-000000000803"
const CURRENT_ASSET_ID = "00000000-0000-4000-8000-000000000804"
const CURRENT_REPRESENTATION_ID = "00000000-0000-4000-8000-000000000805"
const TARGET_ID = "00000000-0000-4000-8000-000000000806"
const IDENTITY_OVERRIDE_ID = "00000000-0000-4000-8000-000000000807"
const INCLUSION_OVERRIDE_ID = "00000000-0000-4000-8000-000000000808"
const NFT_ASSET_ID = "00000000-0000-4000-8000-000000000809"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000810"
const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000811"
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000812"
const CONTRACT_ADDRESS = "0xabcd000000000000000000000000000000000109"

const target: PrincipalAssetOverrideTarget = {
  _tag: "representation",
  blockchain: "base",
  type: "token",
  contractAddress: CONTRACT_ADDRESS,
  mintAddress: null,
}

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_asset_override_mutations",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const runRepository = <A, E>(effect: Effect.Effect<A, E, PrincipalAssetOverrideRepository>) =>
  context.runWithLayer({ effect, layer: PrincipalAssetOverrideRepositoryLive })

const expectProjection = (
  projection: Option.Option<PrincipalAssetOverrideProjection>
): PrincipalAssetOverrideProjection => {
  expect(Option.isSome(projection)).toBe(true)
  return Option.getOrThrow(projection)
}

const seedActiveOverrides = () =>
  Effect.promise(() =>
    runPg(
      Effect.gen(function* () {
        const fixture = yield* seedSyncEngineRepositoryFixture({
          userId: USER_ID,
          principalId: PRINCIPAL_ID,
          sourceId: SOURCE_ID,
        })
        yield* seedSyncEngineAssets(fixture)
        const db = yield* drizzle
        yield* db.insert(schema.assets).values([
          {
            id: CURRENT_ASSET_ID,
            name: "USD Coin",
            symbol: "USDC",
            type: "fungible",
          },
          {
            id: NFT_ASSET_ID,
            name: "Test NFT",
            symbol: "NFT",
            type: "nft",
          },
        ])
        yield* db.insert(schema.assetRepresentations).values({
          id: CURRENT_REPRESENTATION_ID,
          assetId: CURRENT_ASSET_ID,
          blockchainId: fixture.baseBlockchainId,
          type: "token",
          contractAddress: CONTRACT_ADDRESS,
          mintAddress: null,
          decimals: 6,
          isSpam: false,
        })
        yield* db.insert(schema.sourceRepresentationUses).values({
          sourceId: SOURCE_ID,
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress: CONTRACT_ADDRESS,
          mintAddress: null,
        })

        const initial = yield* Effect.provide(
          Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
            repository.findProjection({
              principalId: PrincipalId.make(PRINCIPAL_ID),
              target,
            })
          ),
          PrincipalAssetOverrideRepositoryLive
        )
        const projection = expectProjection(initial)

        yield* db.insert(schema.principalAssetOverrideTargets).values({
          id: TARGET_ID,
          principalId: PRINCIPAL_ID,
          targetKind: "representation",
          blockchainId: fixture.baseBlockchainId,
          representationType: "token",
          contractAddress: CONTRACT_ADDRESS,
          mintAddress: null,
          providerAssetRowId: null,
        })
        yield* db.insert(schema.principalAssetOverrides).values([
          {
            id: IDENTITY_OVERRIDE_ID,
            principalId: PRINCIPAL_ID,
            targetId: TARGET_ID,
            kind: "identity",
            operation: "create",
            inspectedSystemRevision: projection.system.identityRevision,
            inspectedSystemIdentity: "resolved",
            inspectedSystemAssetId: CURRENT_ASSET_ID,
            inspectedSystemInclusion: null,
            replacementAssetId: TEST_BTC_ASSET_ID,
            replacementInclusion: null,
            actorUserId: USER_ID,
            reason: "Use the existing BTC asset.",
            supersedesOverrideId: null,
          },
          {
            id: INCLUSION_OVERRIDE_ID,
            principalId: PRINCIPAL_ID,
            targetId: TARGET_ID,
            kind: "inclusion",
            operation: "create",
            inspectedSystemRevision: projection.system.inclusionRevision,
            inspectedSystemIdentity: null,
            inspectedSystemAssetId: null,
            inspectedSystemInclusion: "included",
            replacementAssetId: null,
            replacementInclusion: "excluded",
            actorUserId: USER_ID,
            reason: "Exclude this asset from my calculation.",
            supersedesOverrideId: null,
          },
        ])

        return projection
      })
    )
  )

const replace = (params: {
  readonly expectedActiveOverrideId: string
  readonly expectedSystemRevision: string
  readonly replacement:
    | { readonly _tag: "identity"; readonly assetId: string }
    | { readonly _tag: "inclusion"; readonly inclusion: "included" | "excluded" }
  readonly principalId?: string
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.replace({
        actorUserId: AuthUserId.make(USER_ID),
        expectedActiveOverrideId: params.expectedActiveOverrideId,
        expectedSystemRevision: params.expectedSystemRevision,
        principalId: PrincipalId.make(params.principalId ?? PRINCIPAL_ID),
        reason: "Update my active override.",
        replacement: params.replacement,
        target,
      })
    )
  )

const withdraw = (params: {
  readonly expectedActiveOverrideId: string
  readonly expectedSystemRevision: string
  readonly kind: "identity" | "inclusion"
}) =>
  runRepository(
    Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
      repository.withdraw({
        actorUserId: AuthUserId.make(USER_ID),
        expectedActiveOverrideId: params.expectedActiveOverrideId,
        expectedSystemRevision: params.expectedSystemRevision,
        kind: params.kind,
        principalId: PrincipalId.make(PRINCIPAL_ID),
        reason: "Return to TaxMaxi's current conclusion.",
        target,
      })
    )
  )

describe("PrincipalAssetOverrideRepository mutations", () => {
  it.effect("appends identity replacements and withdrawals without editing history", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()

      const replaced = expectProjection(
        yield* replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
        })
      )
      const replacement = replaced.activeIdentityOverride
      expect(replacement).toMatchObject({
        kind: "identity",
        operation: "replace",
        inspectedSystemRevision: initial.system.identityRevision,
        inspectedSystemIdentity: { _tag: "resolved", assetId: CURRENT_ASSET_ID },
        replacementIdentity: { _tag: "resolved", assetId: CURRENT_ASSET_ID },
        supersedesOverrideId: IDENTITY_OVERRIDE_ID,
      })
      expect(replaced.effectiveDecision).toEqual({
        _tag: "excluded",
        identity: replacement?.replacementIdentity,
      })

      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: replacement?.id ?? "missing",
          expectedSystemRevision: initial.system.identityRevision,
          kind: "identity",
        })
      )
      expect(withdrawn.activeIdentityOverride).toBeNull()
      expect(withdrawn.history.filter(({ kind }) => kind === "identity")).toHaveLength(3)
      expect(withdrawn.history.at(-1)).toMatchObject({
        kind: "identity",
        operation: "withdraw",
        replacementIdentity: null,
        supersedesOverrideId: replacement?.id,
      })

      const storedRoot = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [row] = yield* db
              .select({
                operation: schema.principalAssetOverrides.operation,
                replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
                supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
              })
              .from(schema.principalAssetOverrides)
              .where(eq(schema.principalAssetOverrides.id, IDENTITY_OVERRIDE_ID))
            return row
          })
        )
      )
      expect(storedRoot).toMatchObject({
        operation: "create",
        replacementAssetId: TEST_BTC_ASSET_ID,
        supersedesOverrideId: null,
      })
    })
  )

  it.effect("replaces and withdraws inclusion independently from identity", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const replaced = expectProjection(
        yield* replace({
          expectedActiveOverrideId: INCLUSION_OVERRIDE_ID,
          expectedSystemRevision: initial.system.inclusionRevision,
          replacement: { _tag: "inclusion", inclusion: "included" },
        })
      )
      const replacement = replaced.activeInclusionOverride
      expect(replacement).toMatchObject({
        kind: "inclusion",
        operation: "replace",
        inspectedSystemInclusion: "included",
        replacementInclusion: "included",
        supersedesOverrideId: INCLUSION_OVERRIDE_ID,
      })
      expect(replaced.activeIdentityOverride?.id).toBe(IDENTITY_OVERRIDE_ID)
      expect(replaced.effectiveDecision).toEqual({ _tag: "included", assetId: TEST_BTC_ASSET_ID })

      const withdrawn = expectProjection(
        yield* withdraw({
          expectedActiveOverrideId: replacement?.id ?? "missing",
          expectedSystemRevision: initial.system.inclusionRevision,
          kind: "inclusion",
        })
      )
      expect(withdrawn.activeInclusionOverride).toBeNull()
      expect(withdrawn.activeIdentityOverride?.id).toBe(IDENTITY_OVERRIDE_ID)
    })
  )

  it.effect(
    "returns the current projection and writes nothing for stale compare-and-set values",
    () =>
      Effect.gen(function* () {
        const initial = yield* seedActiveOverrides()
        const staleRevision = yield* Effect.result(
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: `${initial.system.identityRevision}:stale`,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          })
        )
        expect(Result.isFailure(staleRevision)).toBe(true)
        if (Result.isFailure(staleRevision)) {
          expect(staleRevision.failure).toBeInstanceOf(PrincipalAssetOverrideConflictError)
          if (staleRevision.failure instanceof PrincipalAssetOverrideConflictError) {
            expect(staleRevision.failure.conflictKinds).toEqual(["system_revision"])
            expect(staleRevision.failure.currentProjection.activeIdentityOverride?.id).toBe(
              IDENTITY_OVERRIDE_ID
            )
          }
        }

        const staleActive = yield* Effect.result(
          withdraw({
            expectedActiveOverrideId: "00000000-0000-4000-8000-000000000899",
            expectedSystemRevision: initial.system.identityRevision,
            kind: "identity",
          })
        )
        expect(Result.isFailure(staleActive)).toBe(true)
        if (
          Result.isFailure(staleActive) &&
          staleActive.failure instanceof PrincipalAssetOverrideConflictError
        ) {
          expect(staleActive.failure.conflictKinds).toEqual(["active_override"])
          expect(staleActive.failure.currentActiveOverrideId).toBe(IDENTITY_OVERRIDE_ID)
        }

        const rows = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              return yield* db
                .select({ id: schema.principalAssetOverrides.id })
                .from(schema.principalAssetOverrides)
            })
          )
        )
        expect(rows).toHaveLength(2)
      })
  )

  it.effect("rejects missing and incompatible identity replacements without writing", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const missing = yield* Effect.result(
        replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: {
            _tag: "identity",
            assetId: "00000000-0000-4000-8000-000000000898",
          },
        })
      )
      expect(Result.isFailure(missing)).toBe(true)
      if (
        Result.isFailure(missing) &&
        missing.failure instanceof PrincipalAssetOverrideReplacementValidationError
      ) {
        expect(missing.failure.validation._tag).toBe("asset_not_found")
      }

      const incompatible = yield* Effect.result(
        replace({
          expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
          expectedSystemRevision: initial.system.identityRevision,
          replacement: { _tag: "identity", assetId: NFT_ASSET_ID },
        })
      )
      expect(Result.isFailure(incompatible)).toBe(true)
      if (
        Result.isFailure(incompatible) &&
        incompatible.failure instanceof PrincipalAssetOverrideReplacementValidationError
      ) {
        expect(incompatible.failure.validation).toMatchObject({
          _tag: "incompatible_asset_type",
          targetAssetType: "fungible",
        })
      }
    })
  )

  it.effect("serializes racing replacements so only one appends", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      const attempts = yield* Effect.all(
        [
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: initial.system.identityRevision,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          }).pipe(Effect.result),
          replace({
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: initial.system.identityRevision,
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
          }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" }
      )

      expect(attempts.filter(Result.isSuccess)).toHaveLength(1)
      const [failed] = attempts.filter(Result.isFailure)
      expect(failed?.failure).toBeInstanceOf(PrincipalAssetOverrideConflictError)
      if (failed?.failure instanceof PrincipalAssetOverrideConflictError) {
        expect(failed.failure.conflictKinds).toEqual(["active_override"])
        expect(failed.failure.currentProjection.history).toHaveLength(3)
      }
    })
  )

  it.effect("keeps missing and other-principal targets indistinguishable", () =>
    Effect.gen(function* () {
      const initial = yield* seedActiveOverrides()
      yield* Effect.promise(() =>
        runPg(
          seedSyncEngineRepositoryFixture({
            userId: OTHER_USER_ID,
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
          })
        )
      )

      const unowned = yield* replace({
        principalId: OTHER_PRINCIPAL_ID,
        expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
        expectedSystemRevision: initial.system.identityRevision,
        replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
      })
      const missing = yield* runRepository(
        Effect.flatMap(PrincipalAssetOverrideRepository, (repository) =>
          repository.replace({
            actorUserId: AuthUserId.make(USER_ID),
            expectedActiveOverrideId: IDENTITY_OVERRIDE_ID,
            expectedSystemRevision: initial.system.identityRevision,
            principalId: PrincipalId.make(PRINCIPAL_ID),
            reason: "This target is absent.",
            replacement: { _tag: "identity", assetId: CURRENT_ASSET_ID },
            target: { ...target, contractAddress: "0xabcd000000000000000000000000000000000110" },
          })
        )
      )

      expect(unowned).toEqual(missing)
      expect(Option.isNone(unowned)).toBe(true)
    })
  )
})
