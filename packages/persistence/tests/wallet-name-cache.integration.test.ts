import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { beforeEach, describe, expect, it } from "@effect/vitest"

import { WalletNameCacheRepositoryLive } from "../src/layers/WalletNameCacheRepositoryLive.ts"
import { drizzle } from "../src/layers/PgClientLive.ts"
import { schema } from "../src/schema/index.ts"
import { WalletNameCacheRepository } from "../src/services/WalletNameCacheRepository.ts"
import { makeIntegrationTestDatabaseContext } from "./support/integration-test-kit.ts"

const ENS_NAME = "vitalik.eth"
const ENS_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const SNS_NAME = "bonfida.sol"
const SNS_ADDRESS = "HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_wallet_name_cache",
})

await Effect.runPromise(context.recreateTestDatabase())

const runRepository = <A, E>(effect: Effect.Effect<A, E, WalletNameCacheRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: WalletNameCacheRepositoryLive }))

const clearCache = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.delete(schema.walletNameCache)
    })
  )

const inOneHour = () => DateTime.toDateUtc(DateTime.addDuration(DateTime.nowUnsafe(), "1 hour"))
const oneHourAgo = () =>
  DateTime.toDateUtc(DateTime.subtractDuration(DateTime.nowUnsafe(), "1 hour"))

describe("WalletNameCacheRepository integration", () => {
  beforeEach(() => Effect.runPromise(Effect.asVoid(Effect.promise(() => clearCache()))))

  it.effect("returns null for a missing entry", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* WalletNameCacheRepository
            return yield* repository.get({ namespace: "ens", name: ENS_NAME })
          })
        )
      )

      expect(result).toBeNull()
    })
  )

  it.effect("stores and reads back a resolution", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* WalletNameCacheRepository
            yield* repository.upsert({
              namespace: "ens",
              name: ENS_NAME,
              resolvedAddress: ENS_ADDRESS,
              expiresAt: inOneHour(),
            })
            return yield* repository.get({ namespace: "ens", name: ENS_NAME })
          })
        )
      )

      expect(result).toBe(ENS_ADDRESS)
    })
  )

  it.effect("returns null for an expired entry", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* WalletNameCacheRepository
            yield* repository.upsert({
              namespace: "sns",
              name: SNS_NAME,
              resolvedAddress: SNS_ADDRESS,
              expiresAt: oneHourAgo(),
            })
            return yield* repository.get({ namespace: "sns", name: SNS_NAME })
          })
        )
      )

      expect(result).toBeNull()
    })
  )

  it.effect("refreshes an existing entry on conflict", () =>
    Effect.gen(function* () {
      const updatedAddress = "0x0000000000000000000000000000000000000001"

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* WalletNameCacheRepository
            yield* repository.upsert({
              namespace: "ens",
              name: ENS_NAME,
              resolvedAddress: ENS_ADDRESS,
              expiresAt: oneHourAgo(),
            })
            yield* repository.upsert({
              namespace: "ens",
              name: ENS_NAME,
              resolvedAddress: updatedAddress,
              expiresAt: inOneHour(),
            })
            return yield* repository.get({ namespace: "ens", name: ENS_NAME })
          })
        )
      )

      expect(result).toBe(updatedAddress)
    })
  )

  it.effect("keeps the same name independent across namespaces", () =>
    Effect.gen(function* () {
      const sharedName = "same-name.example"

      const result = yield* Effect.promise(() =>
        runRepository(
          Effect.gen(function* () {
            const repository = yield* WalletNameCacheRepository
            yield* repository.upsert({
              namespace: "ens",
              name: sharedName,
              resolvedAddress: ENS_ADDRESS,
              expiresAt: inOneHour(),
            })
            yield* repository.upsert({
              namespace: "sns",
              name: sharedName,
              resolvedAddress: SNS_ADDRESS,
              expiresAt: inOneHour(),
            })

            const ens = yield* repository.get({ namespace: "ens", name: sharedName })
            const sns = yield* repository.get({ namespace: "sns", name: sharedName })
            return { ens, sns }
          })
        )
      )

      expect(result).toEqual({ ens: ENS_ADDRESS, sns: SNS_ADDRESS })
    })
  )
})
