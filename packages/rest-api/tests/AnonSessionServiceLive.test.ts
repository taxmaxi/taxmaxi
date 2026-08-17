import { Config, ConfigProvider, Effect } from "effect"
import { describe, expect, it } from "vitest"
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
  it("rejects blank and low-entropy anon session secrets", async () => {
    const invalidSecrets = [
      "",
      "   ",
      "<generated-secret>",
      "short-secret",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]

    for (const secret of invalidSecrets) {
      const result = await loadAnonSessionService(secret)

      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(Config.ConfigError)
      }
    }
  })

  it("creates and verifies session tokens when the anon session secret is valid", async () => {
    const result = await loadAnonSessionService(VALID_ANON_SESSION_SECRET)

    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      const token = await Effect.runPromise(
        result.success.createSessionToken({
          payerChainType: "solana",
          payerWalletAddress: "test-payer-wallet",
        })
      )
      const subject = await Effect.runPromise(result.success.verifySessionToken(token))

      expect(subject).toStrictEqual({
        payerChainType: "solana",
        payerWalletAddress: "test-payer-wallet",
      })
    }
  })
})
