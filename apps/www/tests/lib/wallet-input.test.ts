import { describe, expect, it } from "vitest"

import { parseResolveErrorCode, parseWalletInput } from "#/lib/wallet-input"

const EVM_ADDRESS = "0x24a9db9c9c6bcbba1a1ea88d9769cd48eb0efb1a"
const SOLANA_ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
const BITCOIN_ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"

describe("parseWalletInput", () => {
  it("returns empty for blank input", () => {
    expect(parseWalletInput("")).toEqual({ kind: "empty" })
    expect(parseWalletInput("   ")).toEqual({ kind: "empty" })
  })

  it("detects a full EVM address", () => {
    expect(parseWalletInput(EVM_ADDRESS)).toEqual({
      kind: "address",
      chain: "evm",
      address: EVM_ADDRESS,
    })
  })

  it("trims surrounding whitespace before detection", () => {
    expect(parseWalletInput(`  ${EVM_ADDRESS}  `)).toEqual({
      kind: "address",
      chain: "evm",
      address: EVM_ADDRESS,
    })
  })

  it("hints EVM for a 0x prefix while typing", () => {
    expect(parseWalletInput("0x")).toEqual({ kind: "partial", hint: "evm" })
    expect(parseWalletInput("0x24a9db")).toEqual({ kind: "partial", hint: "evm" })
  })

  it("detects a full Solana address", () => {
    expect(parseWalletInput(SOLANA_ADDRESS)).toEqual({
      kind: "address",
      chain: "solana",
      address: SOLANA_ADDRESS,
    })
  })

  it("treats a short base58 string as partial without a hint", () => {
    expect(parseWalletInput("9xQeWvG816bU")).toEqual({ kind: "partial" })
  })

  it("marks Bitcoin addresses as unsupported instead of misreading them as Solana", () => {
    expect(parseWalletInput(BITCOIN_ADDRESS)).toEqual({ kind: "unsupported", reason: "bitcoin" })
    expect(parseWalletInput("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")).toEqual({
      kind: "unsupported",
      reason: "bitcoin",
    })
  })

  it("detects ENS names as EVM wallet names", () => {
    expect(parseWalletInput("vitalik.eth")).toEqual({
      kind: "name",
      chain: "evm",
      name: "vitalik.eth",
    })
    expect(parseWalletInput("Max.cb.id")).toEqual({ kind: "name", chain: "evm", name: "max.cb.id" })
  })

  it("detects SNS names as Solana wallet names", () => {
    expect(parseWalletInput("toly.sol")).toEqual({
      kind: "name",
      chain: "solana",
      name: "toly.sol",
    })
  })

  it("treats an unfinished name as partial", () => {
    expect(parseWalletInput("vitalik.et")).toEqual({ kind: "partial" })
    expect(parseWalletInput("vitalik.")).toEqual({ kind: "partial" })
  })

  it("rejects input that cannot become an address or name", () => {
    expect(parseWalletInput("not a wallet")).toEqual({ kind: "invalid" })
    expect(parseWalletInput("0xZZZZ")).toEqual({ kind: "invalid" })
  })
})

describe("parseResolveErrorCode", () => {
  it("reads a code from the error itself", () => {
    expect(parseResolveErrorCode({ code: "name_unresolved" })).toBe("name_unresolved")
  })

  it("reads a code one cause level down", () => {
    expect(parseResolveErrorCode({ cause: { code: "rate_limited" } })).toBe("rate_limited")
  })

  it("returns undefined for unknown shapes and codes", () => {
    expect(parseResolveErrorCode(new Error("boom"))).toBeUndefined()
    expect(parseResolveErrorCode({ code: "something_else" })).toBeUndefined()
    expect(parseResolveErrorCode(undefined)).toBeUndefined()
  })
})
