import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  detectAddressChainType,
  parseAddressOrEns,
  parseCryptoAddress,
  ValidatedAddressOrEns,
  ValidatedCryptoAddress,
} from "../../src/source/index.ts"

describe("WalletInput", () => {
  it("detects EVM, Bitcoin, and Solana address families", () => {
    expect(detectAddressChainType("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toBe("evm")
    expect(detectAddressChainType("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")).toBe("bitcoin")
    expect(detectAddressChainType("So11111111111111111111111111111111111111112")).toBe("solana")
    expect(detectAddressChainType("not-an-address")).toBeNull()
  })

  it("parses a crypto address with inferred chain type", async () => {
    const parsed = await Effect.runPromise(
      Schema.decodeUnknown(ValidatedCryptoAddress)("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")
    )

    expect(parsed).toEqual({
      address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      chainType: "evm",
    })
    expect(parseCryptoAddress("not-an-address")).toBeNull()
    await expect(
      Effect.runPromise(Schema.decodeUnknown(ValidatedCryptoAddress)("not-an-address"))
    ).rejects.toThrow("Invalid crypto address.")
  })

  it("parses ENS separately from direct addresses", async () => {
    const parsed = await Effect.runPromise(
      Schema.decodeUnknown(ValidatedAddressOrEns)("Vitalik.eth")
    )

    expect(parsed).toEqual({
      type: "ens",
      ensName: "vitalik.eth",
    })
    expect(parseAddressOrEns("0x742d35Cc6634C0532925a3b844Bc454e4438f44e")).toEqual({
      type: "address",
      address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      chainType: "evm",
    })
    await expect(
      Effect.runPromise(Schema.decodeUnknown(ValidatedAddressOrEns)("not-an-address"))
    ).rejects.toThrow("Invalid input. Must be a valid crypto address or ENS name.")
  })
})
