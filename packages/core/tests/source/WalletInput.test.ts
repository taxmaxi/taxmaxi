import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  detectAddressChainType,
  parseAddressOrName,
  parseCryptoAddress,
  ValidatedAddressOrName,
  ValidatedCryptoAddress,
} from "../../src/source/index.ts"

describe("WalletInput", () => {
  it("detects EVM, Bitcoin, and Solana address families", () => {
    expect(detectAddressChainType("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toBe("evm")
    expect(detectAddressChainType("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toBe("bitcoin")
    expect(detectAddressChainType("So11111111111111111111111111111111111111112")).toBe("solana")
    expect(detectAddressChainType("not-an-address")).toBeNull()
  })

  it.effect("parses a crypto address with inferred chain type", () =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeEffect(ValidatedCryptoAddress)(
        "0x742d35Cc6634C0532925a3b844Bc454e4438f44e"
      )

      expect(parsed).toEqual({
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        chainType: "evm",
      })
      expect(parseCryptoAddress("not-an-address")).toBeNull()
      const error = yield* Schema.decodeEffect(ValidatedCryptoAddress)("not-an-address").pipe(
        Effect.flip
      )
      expect(String(error)).toContain("Invalid crypto address.")
    })
  )

  it.effect("parses wallet names separately from direct addresses", () =>
    Effect.gen(function* () {
      const parsed = yield* Schema.decodeEffect(ValidatedAddressOrName)("Vitalik.eth")

      expect(parsed).toEqual({
        type: "name",
        namespace: "ens",
        name: "vitalik.eth",
      })
      expect(parseAddressOrName("Bonfida.sol")).toEqual({
        type: "name",
        namespace: "sns",
        name: "bonfida.sol",
      })
      expect(parseAddressOrName("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toEqual({
        type: "address",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        chainType: "evm",
      })
      expect(parseAddressOrName(".sol")).toBeNull()
      const error = yield* Schema.decodeEffect(ValidatedAddressOrName)("not-an-address").pipe(
        Effect.flip
      )
      expect(String(error)).toContain(
        "Invalid input. Must be a valid crypto address or wallet name."
      )
    })
  )
})
