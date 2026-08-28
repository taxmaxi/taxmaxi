import { Config, ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { AnonSessionService } from "../src/services/AnonSessionService.ts"

const VALID_ANON_SESSION_SECRET = "test-anon-session-secret-32-bytes-long"

const makeConfigProvider = (secret: string) =>
  ConfigProvider.fromEnvRecord({ ANON_SESSION_SECRET: secret })

const loadAnonSessionService = (secret: string) =>
  Effect.runPromise(
    AnonSessionService.pipe(
      Effect.provide(AnonSessionServiceLive),
      Effect.provideService(ConfigProvider.ConfigProvider, makeConfigProvider(secret)),
      Effect.result
    )
  )

describe("AnonSessionServiceLive", () => {
  it.effect("rejects blank and low-entropy anon session secrets", () =>
    Effect.gen(function* () {
      const invalidSecrets = [
        "",
        "   ",
        "<generated-secret>",
        "short-secret",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]

      for (const secret of invalidSecrets) {
        const result = yield* Effect.promise(() => loadAnonSessionService(secret))

        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(Config.ConfigError)
        }
      }
    })
  )

  it.effect("creates and verifies session tokens when the anon session secret is valid", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => loadAnonSessionService(VALID_ANON_SESSION_SECRET))

      expect(result._tag).toBe("Success")
      if (result._tag === "Success") {
        const token = yield* result.success.createSessionToken({
          payerChainType: "solana",
          payerWalletAddress: "test-payer-wallet",
        })
        const subject = yield* result.success.verifySessionToken(token)

        expect(subject).toStrictEqual({
          payerChainType: "solana",
          payerWalletAddress: "test-payer-wallet",
        })
      }
    })
  )
})
