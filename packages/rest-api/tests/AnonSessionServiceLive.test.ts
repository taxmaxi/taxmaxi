import { ConfigProvider, Effect } from "effect"
import * as ConfigError from "effect/ConfigError"
import { describe, expect, it } from "vitest"
import { AnonSessionServiceLive } from "../src/layers/AnonSessionServiceLive.ts"
import { AnonSessionService } from "../src/services/AnonSessionService.ts"

const VALID_ANON_SESSION_SECRET = "test-anon-session-secret-32-bytes-long"

const makeConfigProvider = (secret: string) =>
  ConfigProvider.fromMap(new Map([["ANON_SESSION_SECRET", secret]]))

const loadAnonSessionService = (secret: string) =>
  Effect.runPromise(
    AnonSessionService.pipe(
      Effect.provide(AnonSessionServiceLive),
      Effect.withConfigProvider(makeConfigProvider(secret)),
      Effect.either
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

      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(ConfigError.isConfigError(result.left)).toBe(true)
        expect(ConfigError.isInvalidData(result.left)).toBe(true)
      }
    }
  })

  it("creates and verifies session tokens when the anon session secret is valid", async () => {
    const result = await loadAnonSessionService(VALID_ANON_SESSION_SECRET)

    expect(result._tag).toBe("Right")
    if (result._tag === "Right") {
      const token = await Effect.runPromise(
        result.right.createSessionToken({
          payerChainType: "solana",
          payerWalletAddress: "test-payer-wallet",
        })
      )
      const subject = await Effect.runPromise(result.right.verifySessionToken(token))

      expect(subject).toStrictEqual({
        payerChainType: "solana",
        payerWalletAddress: "test-payer-wallet",
      })
    }
  })
})
