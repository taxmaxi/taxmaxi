import { describe, expect, it } from "@effect/vitest"
import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  AccountingQuantity,
  add,
  format,
  fromAtomicUnits,
  min,
  subtract,
  toAtomicUnits,
} from "../../src/accounting/index.ts"

const decodeQuantity = Schema.decodeUnknownSync(AccountingQuantity)

describe("AccountingQuantity", () => {
  it("keeps exact asset precision when quantities are added", () => {
    const quantity = add(
      decodeQuantity("1.000000000000000001"),
      decodeQuantity("0.000000000000000009")
    )

    expect(format(quantity)).toBe("1.000000000000000010")
  })

  it("encodes high-precision quantities as plain decimals", () => {
    const quantity = decodeQuantity("0.000000000000000001")

    expect(Schema.encodeSync(AccountingQuantity)(quantity)).toBe("0.000000000000000001")
  })

  it("rejects negative quantities", () => {
    expect(() => decodeQuantity("-0.00000001")).toThrow()
  })

  it.each(["", "1e3"])("rejects malformed plain-decimal quantity %j", (value) => {
    expect(() => decodeQuantity(value)).toThrow()
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

  it("converts between decimal quantities and atomic units", () => {
    const decoded = fromAtomicUnits({ atomicUnits: 123_456_789n, decimals: 8 })

    expect(Option.map(decoded, format)).toEqual(Option.some("1.23456789"))
    expect(Option.flatMap(decoded, (quantity) => toAtomicUnits({ quantity, decimals: 8 }))).toEqual(
      Option.some(123_456_789n)
    )
  })

  it("accepts removable decimal zeroes but rejects precision loss", () => {
    expect(toAtomicUnits({ quantity: decodeQuantity("1.230"), decimals: 2 })).toEqual(
      Option.some(123n)
    )
    expect(toAtomicUnits({ quantity: decodeQuantity("1.234"), decimals: 2 })).toEqual(Option.none())
  })

  it("rejects invalid atomic quantities and decimal counts", () => {
    expect(fromAtomicUnits({ atomicUnits: -1n, decimals: 8 })).toEqual(Option.none())
    expect(fromAtomicUnits({ atomicUnits: 1n, decimals: -1 })).toEqual(Option.none())
    expect(toAtomicUnits({ quantity: decodeQuantity("1"), decimals: 1.5 })).toEqual(Option.none())
  })

  it("accepts the supported decimal limit and rejects larger counts", () => {
    expect(Option.isSome(fromAtomicUnits({ atomicUnits: 1n, decimals: 255 }))).toBe(true)
    expect(fromAtomicUnits({ atomicUnits: 1n, decimals: 256 })).toEqual(Option.none())
    expect(fromAtomicUnits({ atomicUnits: 1n, decimals: Number.MAX_SAFE_INTEGER + 1 })).toEqual(
      Option.none()
    )
    expect(toAtomicUnits({ quantity: decodeQuantity("1"), decimals: 256 })).toEqual(Option.none())
    expect(
      toAtomicUnits({ quantity: decodeQuantity("1"), decimals: Number.MAX_SAFE_INTEGER + 1 })
    ).toEqual(Option.none())
  })
})
