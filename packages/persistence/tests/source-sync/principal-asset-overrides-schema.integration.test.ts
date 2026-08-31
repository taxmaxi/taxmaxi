import { beforeEach, describe, expect, it } from "@effect/vitest"
import { asc, eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_PRINCIPAL_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const OVERRIDE_ID = "00000000-0000-4000-8000-000000000901"
const REPLACEMENT_OVERRIDE_ID = "00000000-0000-4000-8000-000000000902"
const WITHDRAWAL_OVERRIDE_ID = "00000000-0000-4000-8000-000000000903"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000904"
const OTHER_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000905"
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000906"
const REACTIVATION_OVERRIDE_ID = "00000000-0000-4000-8000-000000000907"
const SECOND_REPLACEMENT_OVERRIDE_ID = "00000000-0000-4000-8000-000000000908"
const SECOND_WITHDRAWAL_OVERRIDE_ID = "00000000-0000-4000-8000-000000000909"
const SECOND_REACTIVATION_OVERRIDE_ID = "00000000-0000-4000-8000-000000000910"
const ANONYMOUS_PRINCIPAL_ID = "00000000-0000-4000-8000-000000000911"

const WHITESPACE_ONLY_VALUES = [
  "   ",
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  "\u0085",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
] as const

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_asset_overrides_schema",
})

const runPg = context.runPg

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() => Effect.runPromise(context.recreateTestDatabase()))

const insertRepresentationTarget = ({
  blockchainId,
  contractAddress,
  principalId = TEST_PRINCIPAL_ID,
}: {
  readonly blockchainId: string
  readonly contractAddress: string
  readonly principalId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId,
        targetKind: "representation",
        blockchainId,
        representationType: "token",
        contractAddress,
        mintAddress: null,
        providerAssetRowId: null,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })

    return target === undefined ? yield* Effect.die("Failed to create override target") : target.id
  })

const insertIdentityRoot = ({
  targetId,
  reason = "Use the existing BTC economic asset.",
}: {
  readonly targetId: string
  readonly reason?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.principalAssetOverrides).values({
      id: OVERRIDE_ID,
      principalId: TEST_PRINCIPAL_ID,
      targetId,
      kind: "identity",
      operation: "create",
      inspectedSystemRevision: "asset-resolution:17",
      inspectedSystemIdentity: "unresolved",
      inspectedSystemAssetId: null,
      inspectedSystemInclusion: null,
      replacementAssetId: TEST_BTC_ASSET_ID,
      replacementInclusion: null,
      actorUserId: TEST_USER_ID,
      reason,
      supersedesOverrideId: null,
    })
  })

const insertIdentityOverride = ({
  id,
  inspectedSystemRevision,
  operation,
  reason,
  supersedesOverrideId,
  targetId,
}: {
  readonly id: string
  readonly inspectedSystemRevision: string
  readonly operation: "create" | "replace" | "withdraw"
  readonly reason: string
  readonly supersedesOverrideId: string
  readonly targetId: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle

    yield* db.insert(schema.principalAssetOverrides).values({
      id,
      principalId: TEST_PRINCIPAL_ID,
      targetId,
      kind: "identity",
      operation,
      inspectedSystemRevision,
      inspectedSystemIdentity: "resolved",
      inspectedSystemAssetId: TEST_BTC_ASSET_ID,
      inspectedSystemInclusion: null,
      replacementAssetId: operation === "withdraw" ? null : TEST_BTC_ASSET_ID,
      replacementInclusion: null,
      actorUserId: TEST_USER_ID,
      reason,
      supersedesOverrideId,
    })
  })

describe("principal asset override history schema", () => {
  it.effect("stores one attributed identity override for an exact representation target", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle

          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          yield* insertIdentityRoot({
            targetId,
            reason: "This contract is the same economic asset as BTC.",
          })

          const [stored] = yield* db
            .select({
              id: schema.principalAssetOverrides.id,
              principalId: schema.principalAssetOverrides.principalId,
              targetId: schema.principalAssetOverrides.targetId,
              kind: schema.principalAssetOverrides.kind,
              operation: schema.principalAssetOverrides.operation,
              inspectedSystemRevision: schema.principalAssetOverrides.inspectedSystemRevision,
              inspectedSystemIdentity: schema.principalAssetOverrides.inspectedSystemIdentity,
              inspectedSystemAssetId: schema.principalAssetOverrides.inspectedSystemAssetId,
              inspectedSystemInclusion: schema.principalAssetOverrides.inspectedSystemInclusion,
              replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
              replacementInclusion: schema.principalAssetOverrides.replacementInclusion,
              actorUserId: schema.principalAssetOverrides.actorUserId,
              reason: schema.principalAssetOverrides.reason,
              supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
              recordedAt: schema.principalAssetOverrides.recordedAt,
            })
            .from(schema.principalAssetOverrides)

          expect(stored).toMatchObject({
            id: OVERRIDE_ID,
            principalId: TEST_PRINCIPAL_ID,
            targetId,
            kind: "identity",
            operation: "create",
            inspectedSystemRevision: "asset-resolution:17",
            inspectedSystemIdentity: "unresolved",
            inspectedSystemAssetId: null,
            inspectedSystemInclusion: null,
            replacementAssetId: TEST_BTC_ASSET_ID,
            replacementInclusion: null,
            actorUserId: TEST_USER_ID,
            reason: "This contract is the same economic asset as BTC.",
            supersedesOverrideId: null,
          })
          expect(stored?.recordedAt).toBeInstanceOf(Date)
        })
      )
    )
  )

  it.effect("keeps replacement and withdrawal records without changing earlier history", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle

          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          yield* db.insert(schema.principalAssetOverrides).values([
            {
              id: OVERRIDE_ID,
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "inclusion",
              operation: "create",
              inspectedSystemRevision: "asset-resolution:17",
              inspectedSystemIdentity: null,
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: "excluded",
              replacementAssetId: null,
              replacementInclusion: "included",
              actorUserId: TEST_USER_ID,
              reason: "Include the supported asset in my calculation.",
              supersedesOverrideId: null,
              recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T10:00:00.000Z")),
            },
            {
              id: REPLACEMENT_OVERRIDE_ID,
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "inclusion",
              operation: "replace",
              inspectedSystemRevision: "asset-resolution:18",
              inspectedSystemIdentity: null,
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: "included",
              replacementAssetId: null,
              replacementInclusion: "excluded",
              actorUserId: TEST_USER_ID,
              reason: "Exclude this asset from my calculation instead.",
              supersedesOverrideId: OVERRIDE_ID,
              recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T10:01:00.000Z")),
            },
            {
              id: WITHDRAWAL_OVERRIDE_ID,
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "inclusion",
              operation: "withdraw",
              inspectedSystemRevision: "asset-resolution:19",
              inspectedSystemIdentity: null,
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: "included",
              replacementAssetId: null,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "Return to TaxMaxi's current inclusion decision.",
              supersedesOverrideId: REPLACEMENT_OVERRIDE_ID,
              recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T10:02:00.000Z")),
            },
          ])

          const history = yield* db
            .select({
              id: schema.principalAssetOverrides.id,
              operation: schema.principalAssetOverrides.operation,
              replacementInclusion: schema.principalAssetOverrides.replacementInclusion,
              supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
            })
            .from(schema.principalAssetOverrides)
            .orderBy(asc(schema.principalAssetOverrides.recordedAt))

          expect(history).toEqual([
            {
              id: OVERRIDE_ID,
              operation: "create",
              replacementInclusion: "included",
              supersedesOverrideId: null,
            },
            {
              id: REPLACEMENT_OVERRIDE_ID,
              operation: "replace",
              replacementInclusion: "excluded",
              supersedesOverrideId: OVERRIDE_ID,
            },
            {
              id: WITHDRAWAL_OVERRIDE_ID,
              operation: "withdraw",
              replacementInclusion: null,
              supersedesOverrideId: REPLACEMENT_OVERRIDE_ID,
            },
          ])
        })
      )
    )
  )

  it.effect("stores the chainless provider-asset fallback as a separate target shape", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          yield* seedSyncEngineRepositoryFixture()
          const db = yield* drizzle
          const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T10:00:00.000Z"))
          const [providerAsset] = yield* db
            .insert(schema.providerAssets)
            .values({
              provider: "coinbase",
              providerAssetId: "override-usdc",
              currencyCode: "USDC",
              name: "USD Coin",
              exponent: 6,
              providerType: "crypto",
              retrievedAt: now,
            })
            .returning({ id: schema.providerAssets.id })

          if (providerAsset === undefined) {
            return yield* Effect.die("Failed to create provider asset")
          }

          const [target] = yield* db
            .insert(schema.principalAssetOverrideTargets)
            .values({
              principalId: TEST_PRINCIPAL_ID,
              targetKind: "provider_asset",
              blockchainId: null,
              representationType: null,
              contractAddress: null,
              mintAddress: null,
              providerAssetRowId: providerAsset.id,
            })
            .returning({
              principalId: schema.principalAssetOverrideTargets.principalId,
              targetKind: schema.principalAssetOverrideTargets.targetKind,
              blockchainId: schema.principalAssetOverrideTargets.blockchainId,
              representationType: schema.principalAssetOverrideTargets.representationType,
              contractAddress: schema.principalAssetOverrideTargets.contractAddress,
              mintAddress: schema.principalAssetOverrideTargets.mintAddress,
              providerAssetRowId: schema.principalAssetOverrideTargets.providerAssetRowId,
            })

          expect(target).toMatchObject({
            principalId: TEST_PRINCIPAL_ID,
            targetKind: "provider_asset",
            blockchainId: null,
            representationType: null,
            contractAddress: null,
            mintAddress: null,
            providerAssetRowId: providerAsset.id,
          })
        })
      )
    )
  )

  it.effect("rejects mixed or incomplete target shapes", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          const db = yield* drizzle
          const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-31T10:00:00.000Z"))
          const [providerAsset] = yield* db
            .insert(schema.providerAssets)
            .values({
              provider: "coinbase",
              providerAssetId: "override-invalid-shape",
              currencyCode: "USDC",
              name: "USD Coin",
              exponent: 6,
              providerType: "crypto",
              retrievedAt: now,
            })
            .returning({ id: schema.providerAssets.id })

          if (providerAsset === undefined) {
            return yield* Effect.die("Failed to create provider asset")
          }

          const incompleteRepresentation = yield* Effect.result(
            db.insert(schema.principalAssetOverrideTargets).values({
              principalId: TEST_PRINCIPAL_ID,
              targetKind: "representation",
              blockchainId: fixture.baseBlockchainId,
              representationType: "token",
              contractAddress: null,
              mintAddress: null,
              providerAssetRowId: null,
            })
          )
          const mixedProviderTarget = yield* Effect.result(
            db.insert(schema.principalAssetOverrideTargets).values({
              principalId: TEST_PRINCIPAL_ID,
              targetKind: "provider_asset",
              blockchainId: fixture.baseBlockchainId,
              representationType: null,
              contractAddress: null,
              mintAddress: null,
              providerAssetRowId: providerAsset.id,
            })
          )
          const blankContractAddresses = yield* Effect.forEach(
            WHITESPACE_ONLY_VALUES,
            (contractAddress) =>
              Effect.result(
                db.insert(schema.principalAssetOverrideTargets).values({
                  principalId: TEST_PRINCIPAL_ID,
                  targetKind: "representation",
                  blockchainId: fixture.baseBlockchainId,
                  representationType: "token",
                  contractAddress,
                  mintAddress: null,
                  providerAssetRowId: null,
                })
              )
          )
          const blankMintAddresses = yield* Effect.forEach(WHITESPACE_ONLY_VALUES, (mintAddress) =>
            Effect.result(
              db.insert(schema.principalAssetOverrideTargets).values({
                principalId: TEST_PRINCIPAL_ID,
                targetKind: "representation",
                blockchainId: fixture.baseBlockchainId,
                representationType: "token",
                contractAddress: null,
                mintAddress,
                providerAssetRowId: null,
              })
            )
          )

          expect(incompleteRepresentation._tag).toBe("Failure")
          expect(mixedProviderTarget._tag).toBe("Failure")
          expect(
            [...blankContractAddresses, ...blankMintAddresses].every(
              (result) => result._tag === "Failure"
            )
          ).toBe(true)
        })
      )
    )
  )

  it.effect("rejects incomplete audit data and cross-target supersession", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const firstTargetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })
          const secondTargetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0xfedcba0987654321",
          })
          yield* insertIdentityRoot({ targetId: firstTargetId })

          const emptyReasons = yield* Effect.forEach(WHITESPACE_ONLY_VALUES, (reason) =>
            Effect.result(
              db.insert(schema.principalAssetOverrides).values({
                principalId: TEST_PRINCIPAL_ID,
                targetId: secondTargetId,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "asset-resolution:17",
                inspectedSystemIdentity: "unresolved",
                inspectedSystemAssetId: null,
                inspectedSystemInclusion: null,
                replacementAssetId: TEST_BTC_ASSET_ID,
                replacementInclusion: null,
                actorUserId: TEST_USER_ID,
                reason,
                supersedesOverrideId: null,
              })
            )
          )
          const emptyRevisions = yield* Effect.forEach(
            WHITESPACE_ONLY_VALUES,
            (inspectedSystemRevision) =>
              Effect.result(
                db.insert(schema.principalAssetOverrides).values({
                  principalId: TEST_PRINCIPAL_ID,
                  targetId: secondTargetId,
                  kind: "identity",
                  operation: "create",
                  inspectedSystemRevision,
                  inspectedSystemIdentity: "unresolved",
                  inspectedSystemAssetId: null,
                  inspectedSystemInclusion: null,
                  replacementAssetId: TEST_BTC_ASSET_ID,
                  replacementInclusion: null,
                  actorUserId: TEST_USER_ID,
                  reason: "Use the existing BTC economic asset.",
                  supersedesOverrideId: null,
                })
              )
          )
          const crossTargetSupersession = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId: secondTargetId,
              kind: "identity",
              operation: "replace",
              inspectedSystemRevision: "asset-resolution:18",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "Keep the target's history separate.",
              supersedesOverrideId: OVERRIDE_ID,
            })
          )

          expect(
            [...emptyReasons, ...emptyRevisions].every((result) => result._tag === "Failure")
          ).toBe(true)
          expect(crossTargetSupersession._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects history written under a principal that does not own the target", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineRepositoryFixture({
            userId: OTHER_USER_ID,
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
          })
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          const wrongPrincipal = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: OTHER_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "asset-resolution:17",
              inspectedSystemIdentity: "unresolved",
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: OTHER_USER_ID,
              reason: "This principal must not use another principal's target.",
              supersedesOverrideId: null,
            })
          )

          expect(wrongPrincipal._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects an actor who does not own the user-backed principal", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineRepositoryFixture({
            userId: OTHER_USER_ID,
            principalId: OTHER_PRINCIPAL_ID,
            sourceId: OTHER_SOURCE_ID,
          })
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          const unrelatedActor = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "asset-resolution:17",
              inspectedSystemIdentity: "unresolved",
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: OTHER_USER_ID,
              reason: "Only the principal's user may create override history.",
              supersedesOverrideId: null,
            })
          )

          expect(unrelatedActor._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects authenticated override history for an anonymous principal", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle

          yield* db.insert(schema.principals).values({
            id: ANONYMOUS_PRINCIPAL_ID,
            kind: "anonymous_wallet",
            userId: null,
          })
          const targetId = yield* insertRepresentationTarget({
            principalId: ANONYMOUS_PRINCIPAL_ID,
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          const anonymousPrincipalActor = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: ANONYMOUS_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "asset-resolution:17",
              inspectedSystemIdentity: "unresolved",
              inspectedSystemAssetId: null,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "Anonymous principals cannot have authenticated override history.",
              supersedesOverrideId: null,
            })
          )

          expect(anonymousPrincipalActor._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("rejects two successors for the same history record", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })
          yield* insertIdentityRoot({ targetId })

          yield* db.insert(schema.principalAssetOverrides).values({
            id: REPLACEMENT_OVERRIDE_ID,
            principalId: TEST_PRINCIPAL_ID,
            targetId,
            kind: "identity",
            operation: "replace",
            inspectedSystemRevision: "asset-resolution:18",
            inspectedSystemIdentity: "resolved",
            inspectedSystemAssetId: TEST_BTC_ASSET_ID,
            inspectedSystemInclusion: null,
            replacementAssetId: TEST_BTC_ASSET_ID,
            replacementInclusion: null,
            actorUserId: TEST_USER_ID,
            reason: "Keep using the existing BTC economic asset.",
            supersedesOverrideId: OVERRIDE_ID,
          })

          const secondSuccessor = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "withdraw",
              inspectedSystemRevision: "asset-resolution:19",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: null,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "Do not fork the append-only history.",
              supersedesOverrideId: OVERRIDE_ID,
            })
          )

          expect(secondSuccessor._tag).toBe("Failure")
        })
      )
    )
  )

  it.effect("keeps targets and override records immutable", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          yield* insertIdentityRoot({ targetId })

          const updateTarget = yield* Effect.result(
            db
              .update(schema.principalAssetOverrideTargets)
              .set({ contractAddress: "0xfedcba0987654321" })
              .where(eq(schema.principalAssetOverrideTargets.id, targetId))
          )
          const updateHistory = yield* Effect.result(
            db
              .update(schema.principalAssetOverrides)
              .set({ reason: "Changed reason" })
              .where(eq(schema.principalAssetOverrides.id, OVERRIDE_ID))
          )
          const deleteHistory = yield* Effect.result(
            db
              .delete(schema.principalAssetOverrides)
              .where(eq(schema.principalAssetOverrides.id, OVERRIDE_ID))
          )
          const deleteTarget = yield* Effect.result(
            db
              .delete(schema.principalAssetOverrideTargets)
              .where(eq(schema.principalAssetOverrideTargets.id, targetId))
          )

          expect(updateTarget._tag).toBe("Failure")
          expect(updateHistory._tag).toBe("Failure")
          expect(deleteHistory._tag).toBe("Failure")
          expect(deleteTarget._tag).toBe("Failure")

          const deletePrincipal = yield* Effect.result(
            db.delete(schema.principals).where(eq(schema.principals.id, TEST_PRINCIPAL_ID))
          )
          const remainingHistory = yield* db
            .select({ id: schema.principalAssetOverrides.id })
            .from(schema.principalAssetOverrides)
            .where(eq(schema.principalAssetOverrides.id, OVERRIDE_ID))

          expect(deletePrincipal._tag).toBe("Failure")
          expect(remainingHistory).toEqual([{ id: OVERRIDE_ID }])
        })
      )
    )
  )

  it.effect("allows create after withdrawal while rejecting other inactive transitions", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          yield* insertIdentityRoot({ targetId })
          yield* insertIdentityOverride({
            id: WITHDRAWAL_OVERRIDE_ID,
            targetId,
            operation: "withdraw",
            inspectedSystemRevision: "asset-resolution:18",
            reason: "Return to TaxMaxi's current identity decision.",
            supersedesOverrideId: OVERRIDE_ID,
          })

          const replaceAfterWithdrawal = yield* Effect.result(
            insertIdentityOverride({
              id: REPLACEMENT_OVERRIDE_ID,
              targetId,
              operation: "replace",
              inspectedSystemRevision: "asset-resolution:19",
              reason: "An inactive stream cannot be replaced.",
              supersedesOverrideId: WITHDRAWAL_OVERRIDE_ID,
            })
          )
          const withdrawAfterWithdrawal = yield* Effect.result(
            insertIdentityOverride({
              id: SECOND_WITHDRAWAL_OVERRIDE_ID,
              targetId,
              operation: "withdraw",
              inspectedSystemRevision: "asset-resolution:19",
              reason: "An inactive stream cannot be withdrawn again.",
              supersedesOverrideId: WITHDRAWAL_OVERRIDE_ID,
            })
          )

          yield* insertIdentityOverride({
            id: REACTIVATION_OVERRIDE_ID,
            targetId,
            operation: "create",
            inspectedSystemRevision: "asset-resolution:19",
            reason: "Create a new active override after withdrawal.",
            supersedesOverrideId: WITHDRAWAL_OVERRIDE_ID,
          })

          const createAfterActiveOverride = yield* Effect.result(
            insertIdentityOverride({
              id: REPLACEMENT_OVERRIDE_ID,
              targetId,
              operation: "create",
              inspectedSystemRevision: "asset-resolution:20",
              reason: "An active stream cannot be created again.",
              supersedesOverrideId: REACTIVATION_OVERRIDE_ID,
            })
          )

          yield* insertIdentityOverride({
            id: SECOND_REPLACEMENT_OVERRIDE_ID,
            targetId,
            operation: "replace",
            inspectedSystemRevision: "asset-resolution:20",
            reason: "Replace the reactivated override.",
            supersedesOverrideId: REACTIVATION_OVERRIDE_ID,
          })
          yield* insertIdentityOverride({
            id: SECOND_WITHDRAWAL_OVERRIDE_ID,
            targetId,
            operation: "withdraw",
            inspectedSystemRevision: "asset-resolution:21",
            reason: "Withdraw the replacement.",
            supersedesOverrideId: SECOND_REPLACEMENT_OVERRIDE_ID,
          })
          yield* insertIdentityOverride({
            id: SECOND_REACTIVATION_OVERRIDE_ID,
            targetId,
            operation: "create",
            inspectedSystemRevision: "asset-resolution:22",
            reason: "Create after the second withdrawal.",
            supersedesOverrideId: SECOND_WITHDRAWAL_OVERRIDE_ID,
          })

          const history = yield* db
            .select({
              id: schema.principalAssetOverrides.id,
              operation: schema.principalAssetOverrides.operation,
              supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
            })
            .from(schema.principalAssetOverrides)
            .orderBy(asc(schema.principalAssetOverrides.id))

          expect(replaceAfterWithdrawal._tag).toBe("Failure")
          expect(withdrawAfterWithdrawal._tag).toBe("Failure")
          expect(createAfterActiveOverride._tag).toBe("Failure")
          expect(history).toEqual([
            { id: OVERRIDE_ID, operation: "create", supersedesOverrideId: null },
            {
              id: WITHDRAWAL_OVERRIDE_ID,
              operation: "withdraw",
              supersedesOverrideId: OVERRIDE_ID,
            },
            {
              id: REACTIVATION_OVERRIDE_ID,
              operation: "create",
              supersedesOverrideId: WITHDRAWAL_OVERRIDE_ID,
            },
            {
              id: SECOND_REPLACEMENT_OVERRIDE_ID,
              operation: "replace",
              supersedesOverrideId: REACTIVATION_OVERRIDE_ID,
            },
            {
              id: SECOND_WITHDRAWAL_OVERRIDE_ID,
              operation: "withdraw",
              supersedesOverrideId: SECOND_REPLACEMENT_OVERRIDE_ID,
            },
            {
              id: SECOND_REACTIVATION_OVERRIDE_ID,
              operation: "create",
              supersedesOverrideId: SECOND_WITHDRAWAL_OVERRIDE_ID,
            },
          ])
        })
      )
    )
  )

  it.effect("rejects a second history root and a self-superseding record", () =>
    Effect.promise(() =>
      runPg(
        Effect.gen(function* () {
          const fixture = yield* seedSyncEngineRepositoryFixture()
          yield* seedSyncEngineAssets(fixture)
          const db = yield* drizzle
          const targetId = yield* insertRepresentationTarget({
            blockchainId: fixture.baseBlockchainId,
            contractAddress: "0x1234567890abcdef",
          })

          yield* insertIdentityRoot({ targetId })

          const secondRoot = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "asset-resolution:18",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "Do not create a second history root.",
              supersedesOverrideId: null,
            })
          )
          const selfSupersession = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              id: REPLACEMENT_OVERRIDE_ID,
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "replace",
              inspectedSystemRevision: "asset-resolution:18",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "Do not allow a self-cycle.",
              supersedesOverrideId: REPLACEMENT_OVERRIDE_ID,
            })
          )
          const createWithParent = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values({
              principalId: TEST_PRINCIPAL_ID,
              targetId,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "asset-resolution:18",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              inspectedSystemInclusion: null,
              replacementAssetId: TEST_BTC_ASSET_ID,
              replacementInclusion: null,
              actorUserId: TEST_USER_ID,
              reason: "A create record with a parent must follow a withdrawal.",
              supersedesOverrideId: OVERRIDE_ID,
            })
          )
          const rootlessCycle = yield* Effect.result(
            db.insert(schema.principalAssetOverrides).values([
              {
                id: REPLACEMENT_OVERRIDE_ID,
                principalId: TEST_PRINCIPAL_ID,
                targetId,
                kind: "identity",
                operation: "replace",
                inspectedSystemRevision: "asset-resolution:18",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                inspectedSystemInclusion: null,
                replacementAssetId: TEST_BTC_ASSET_ID,
                replacementInclusion: null,
                actorUserId: TEST_USER_ID,
                reason: "Do not allow a rootless cycle.",
                supersedesOverrideId: WITHDRAWAL_OVERRIDE_ID,
              },
              {
                id: WITHDRAWAL_OVERRIDE_ID,
                principalId: TEST_PRINCIPAL_ID,
                targetId,
                kind: "identity",
                operation: "replace",
                inspectedSystemRevision: "asset-resolution:18",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                inspectedSystemInclusion: null,
                replacementAssetId: TEST_BTC_ASSET_ID,
                replacementInclusion: null,
                actorUserId: TEST_USER_ID,
                reason: "Do not allow a rootless cycle.",
                supersedesOverrideId: REPLACEMENT_OVERRIDE_ID,
              },
            ])
          )

          expect(secondRoot._tag).toBe("Failure")
          expect(selfSupersession._tag).toBe("Failure")
          expect(createWithParent._tag).toBe("Failure")
          expect(rootlessCycle._tag).toBe("Failure")
        })
      )
    )
  )
})
