import { asc, eq, inArray } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import { SourceId } from "@my/core/source"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "vitest"
import { PrincipalClaimRepositoryLive } from "../../src/layers/PrincipalClaimRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { PrincipalClaimRepository } from "../../src/services/PrincipalClaimRepository.ts"
import { makeIntegrationTestDatabaseContext } from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_claim_repo",
})

const runPg = context.runPg

const runPrincipalClaim = <A, E>(effect: Effect.Effect<A, E, PrincipalClaimRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: PrincipalClaimRepositoryLive }))

const ANONYMOUS_PRINCIPAL_ID = PrincipalId.make("00000000-0000-0000-0000-000000001101")
const USER_ID = "00000000-0000-0000-0000-000000001102"
const USER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-0000-0000-000000001103")
const ADDRESS_ID = "00000000-0000-0000-0000-000000001104"
const SOURCE_ID = SourceId.make("00000000-0000-0000-0000-000000001105")
const REQUEST_ID = "00000000-0000-0000-0000-000000001106"
const WALLET_ADDRESS = "bc1qprincipalclaimlockorder000000000000000000"
const CLAIM_VALUE_HASH = "claim-lock-order-hash"

await Effect.runPromise(context.recreateTestDatabase())

describe("PrincipalClaimRepositoryLive", () => {
  beforeEach(async () => {
    await Effect.runPromise(context.recreateTestDatabase())
    await runPg(
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
            year: 2025,
            jurisdiction: "germany",
          },
        ])
      })
    )
  })

  it("locks the source before either ownership principal", async () => {
    // Given another transaction owns the source row lock.
    const sourceLockAcquired = await Effect.runPromise(Deferred.make<void>())
    const releaseSourceLock = await Effect.runPromise(Deferred.make<void>())
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

    await Effect.runPromise(Deferred.await(sourceLockAcquired))

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

    await context.waitForQueryBlockedOnLock({ queryIncludes: "sources" })

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
    const principalLockProbeOutcome = await principalLockProbe

    // Then the principal rows remain lockable while the claim waits.
    expect(principalLockProbeOutcome).toBe("completed")

    // And the claim finishes successfully after the source lock is released.
    await Effect.runPromise(Deferred.succeed(releaseSourceLock, undefined))
    const [, claimedSourceId] = await Promise.all([heldSourceLock, claimWaitingForSource])

    expect(claimedSourceId).toBe(SOURCE_ID)
  })
})
