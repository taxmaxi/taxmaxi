import { describe, expect, it } from "@effect/vitest"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  AccountingQuantity,
  DivisionByZeroError,
  MonetaryAmount,
  multiplyByQuantity,
  prorate,
} from "../../src/accounting/index.ts"

const decodeQuantity = Schema.decodeUnknownSync(AccountingQuantity)

describe("MonetaryAmount accounting arithmetic", () => {
  it("multiplies a unit amount by an exact asset quantity", () => {
    const unitAmount = MonetaryAmount.unsafeFromString("2.50", "EUR")

    const total = multiplyByQuantity(unitAmount, decodeQuantity("1.2"))

    expect(total.format()).toBe("3")
    expect(total.currency).toBe("EUR")
  })

  it.effect("prorates and rounds money at an explicit accounting scale", () =>
    Effect.gen(function* () {
      const allocated = yield* prorate({
        total: MonetaryAmount.unsafeFromString("10", "EUR"),
        part: decodeQuantity("1"),
        whole: decodeQuantity("3"),
        scale: 8,
      })

      expect(allocated.format()).toBe("3.33333333")
      expect(allocated.currency).toBe("EUR")
    })
  )

  it.effect("multiplies before division to avoid double rounding", () =>
    Effect.gen(function* () {
      const allocated = yield* prorate({
        total: MonetaryAmount.unsafeFromString("2", "EUR"),
        part: decodeQuantity("1"),
        whole: decodeQuantity("3"),
        scale: 100,
      })
      const expected = BigDecimal.fromStringUnsafe(
        "0.6666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666666667"
      )

      expect(BigDecimal.equals(allocated.amount, expected)).toBe(true)
    })
  )

  it.effect("reports zero-total proration as a typed error", () =>
    Effect.gen(function* () {
      const error = yield* prorate({
        total: MonetaryAmount.unsafeFromString("10", "EUR"),
        part: decodeQuantity("1"),
        whole: decodeQuantity("0"),
        scale: 8,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(DivisionByZeroError)
    })
  )
})
