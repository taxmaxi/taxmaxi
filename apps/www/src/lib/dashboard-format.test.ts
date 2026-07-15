import { describe, expect, it } from "vitest"
import { formatTokenAmount, formatTokenPrice } from "./dashboard-format"

describe("dashboard decimal formatting", () => {
  it("formats token amounts without losing integer precision", () => {
    expect(formatTokenAmount("9007199254740993.125")).toBe("9.007.199.254.740.993,13")
  })

  it("keeps useful significant digits for low token prices", () => {
    expect(formatTokenPrice("0.004321", "eur")).toBe("0,004321 EUR")
    expect(formatTokenPrice("0.000000012345", "usd")).toBe("0,00000001235 USD")
  })
})
