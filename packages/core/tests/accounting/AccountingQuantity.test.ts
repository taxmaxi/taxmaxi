import { describe, expect, it } from "@effect/vitest"
import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AccountingQuantity, add, format, min, subtract } from "../../src/accounting/index.ts"

const decodeQuantity = Schema.decodeUnknownSync(AccountingQuantity)

describe("AccountingQuantity", () => {
  it("keeps exact asset precision when quantities are added", () => {
    const quantity = add(
      decodeQuantity("1.000000000000000001"),
      decodeQuantity("0.000000000000000009")
    )

    expect(format(quantity)).toBe("1.000000000000000010")
  })

  it("rejects negative quantities", () => {
    expect(() => decodeQuantity("-0.00000001")).toThrow()
  })

  it("subtracts without allowing a negative quantity", () => {
    const available = decodeQuantity("1.5")
    const used = decodeQuantity("1.25")

    expect(Option.map(subtract(available, used), format)).toEqual(Option.some("0.25"))
    expect(subtract(used, available)).toEqual(Option.none())
  })

  it("selects the smaller quantity across different decimal scales", () => {
    const selected = min(decodeQuantity("2.000"), decodeQuantity("1.999999999999999999"))

    expect(BigDecimal.equals(selected, BigDecimal.fromStringUnsafe("1.999999999999999999"))).toBe(
      true
    )
  })
})
