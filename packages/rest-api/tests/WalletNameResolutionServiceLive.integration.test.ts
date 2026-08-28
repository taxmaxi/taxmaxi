import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { beforeEach, describe, expect, it } from "@effect/vitest"

import { drizzle } from "../../persistence/src/layers/PgClientLive.ts"
import { WalletNameCacheRepositoryLive } from "../../persistence/src/layers/WalletNameCacheRepositoryLive.ts"
import { schema } from "../../persistence/src/schema/index.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { WalletNameResolutionServiceLive } from "../src/layers/WalletNameResolutionServiceLive.ts"
import { WalletNameResolutionService } from "../src/services/WalletNameResolutionService.ts"

const ENS_NAME = "vitalik.eth"
const ENS_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
const SNS_NAME = "bonfida.sol"
const SNS_ADDRESS = "HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_wallet_name_resolution",
})

await Effect.runPromise(context.recreateTestDatabase())

const ResolutionTestLayer = WalletNameResolutionServiceLive.pipe(
  Layer.provide(WalletNameCacheRepositoryLive)
)

const runService = <A, E>(effect: Effect.Effect<A, E, WalletNameResolutionService>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: ResolutionTestLayer }))

const seedCacheEntry = ({
  name,
  namespace,
  resolvedAddress,
}: {
  readonly namespace: "ens" | "sns"
  readonly name: string
  readonly resolvedAddress: string
}) =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle

      yield* db.insert(schema.walletNameCache).values({
        namespace,
        name,
        resolvedAddress,
        resolvedAt: yield* DateTime.nowAsDate,
        expiresAt: DateTime.toDateUtc(DateTime.addDuration(yield* DateTime.now, "1 hour")),
      })
    })
  )

const clearCache = () =>
  context.runPg(
    Effect.gen(function* () {
      const db = yield* drizzle
      yield* db.delete(schema.walletNameCache)
    })
  )

const resolveFlipped = (name: string) =>
  runService(
    Effect.gen(function* () {
      const service = yield* WalletNameResolutionService
      return yield* service.resolve(name).pipe(Effect.flip)
    })
  )

describe("WalletNameResolutionService integration", () => {
  beforeEach(() => Effect.runPromise(Effect.asVoid(Effect.promise(() => clearCache()))))

  it.effect("returns a cached ENS resolution without an on-chain lookup", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        seedCacheEntry({ namespace: "ens", name: ENS_NAME, resolvedAddress: ENS_ADDRESS })
      )

      const result = yield* Effect.promise(() =>
        runService(
          Effect.gen(function* () {
            const service = yield* WalletNameResolutionService
            return yield* service.resolve(ENS_NAME)
          })
        )
      )

      expect(result).toEqual({
        namespace: "ens",
        name: ENS_NAME,
        resolvedAddress: ENS_ADDRESS,
        chainType: "evm",
        fromCache: true,
      })
    })
  )

  it.effect("returns a cached SNS resolution without an on-chain lookup", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        seedCacheEntry({ namespace: "sns", name: SNS_NAME, resolvedAddress: SNS_ADDRESS })
      )

      const result = yield* Effect.promise(() =>
        runService(
          Effect.gen(function* () {
            const service = yield* WalletNameResolutionService
            return yield* service.resolve(SNS_NAME)
          })
        )
      )

      expect(result).toEqual({
        namespace: "sns",
        name: SNS_NAME,
        resolvedAddress: SNS_ADDRESS,
        chainType: "solana",
        fromCache: true,
      })
    })
  )

  it.effect("lowercases and trims names before the cache lookup", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        seedCacheEntry({ namespace: "sns", name: SNS_NAME, resolvedAddress: SNS_ADDRESS })
      )

      const result = yield* Effect.promise(() =>
        runService(
          Effect.gen(function* () {
            const service = yield* WalletNameResolutionService
            return yield* service.resolve("  BONFIDA.SOL  ")
          })
        )
      )

      expect(result.name).toBe(SNS_NAME)
      expect(result.fromCache).toBe(true)
    })
  )

  it.effect("fails with invalid_name for input that is not a wallet name", () =>
    Effect.gen(function* () {
      const error = yield* Effect.promise(() => resolveFlipped("not-a-name"))

      expect(error._tag).toBe("WalletNameResolutionError")

      if (error._tag === "WalletNameResolutionError") {
        expect(error.code).toBe("invalid_name")
        expect(error.namespace).toBeNull()
      }
    })
  )

  it.effect("fails with invalid_name for a plain address", () =>
    Effect.gen(function* () {
      const error = yield* Effect.promise(() => resolveFlipped(ENS_ADDRESS))

      expect(error._tag).toBe("WalletNameResolutionError")

      if (error._tag === "WalletNameResolutionError") {
        expect(error.code).toBe("invalid_name")
      }
    })
  )
})
