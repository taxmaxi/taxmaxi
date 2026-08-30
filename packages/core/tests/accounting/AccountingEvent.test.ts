import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { AccountingEvent } from "../../src/accounting/index.ts"

const decodeEvent = Schema.decodeUnknownSync(AccountingEvent)

describe("AccountingEvent", () => {
  it("decodes the three factual event shapes", () => {
    const acquisition = decodeEvent({
      _tag: "acquisition",
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: { epochMillis: 1_700_000_000_000 },
      assetId: "22222222-2222-4222-8222-222222222222",
      quantity: "1.25",
      custodySourceId: "33333333-3333-4333-8333-333333333333",
      transactionReference: "coinbase-order-42",
      cause: "purchase",
    })
    const disposition = decodeEvent({
      _tag: "disposition",
      id: "44444444-4444-4444-8444-444444444444",
      occurredAt: { epochMillis: 1_700_000_000_000 },
      assetId: "22222222-2222-4222-8222-222222222222",
      quantity: "0.01",
      custodySourceId: "33333333-3333-4333-8333-333333333333",
      transactionReference: "ethereum-0xabc",
      cause: "fee",
    })
    const movement = decodeEvent({
      _tag: "custody_movement",
      id: "55555555-5555-4555-8555-555555555555",
      occurredAt: { epochMillis: 1_700_000_000_000 },
      assetId: "22222222-2222-4222-8222-222222222222",
      quantity: "0.5",
      fromCustodySourceId: "33333333-3333-4333-8333-333333333333",
      toCustodySourceId: "66666666-6666-4666-8666-666666666666",
    })

    expect(acquisition.quantity.value).toBe(125n)
    expect(acquisition.transactionReference).toBe("coinbase-order-42")
    expect(disposition).toMatchObject({ cause: "fee", transactionReference: "ethereum-0xabc" })
    expect(movement).not.toHaveProperty("transactionReference")
  })

  it("rejects custody movements whose source does not change", () => {
    expect(() =>
      decodeEvent({
        _tag: "custody_movement",
        id: "55555555-5555-4555-8555-555555555555",
        occurredAt: { epochMillis: 1_700_000_000_000 },
        assetId: "22222222-2222-4222-8222-222222222222",
        quantity: "0.5",
        fromCustodySourceId: "33333333-3333-4333-8333-333333333333",
        toCustodySourceId: "33333333-3333-4333-8333-333333333333",
      })
    ).toThrow()
  })

  it.each(["0", "-0.01"])("rejects non-positive event quantity %s", (quantity) => {
    expect(() =>
      decodeEvent({
        _tag: "acquisition",
        id: "11111111-1111-4111-8111-111111111111",
        occurredAt: { epochMillis: 1_700_000_000_000 },
        assetId: "22222222-2222-4222-8222-222222222222",
        quantity,
        custodySourceId: "33333333-3333-4333-8333-333333333333",
        cause: "unknown",
      })
    ).toThrow()
  })

  it("rejects tax meaning presented as an acquisition cause", () => {
    expect(() =>
      decodeEvent({
        _tag: "acquisition",
        id: "11111111-1111-4111-8111-111111111111",
        occurredAt: { epochMillis: 1_700_000_000_000 },
        assetId: "22222222-2222-4222-8222-222222222222",
        quantity: "1",
        custodySourceId: "33333333-3333-4333-8333-333333333333",
        cause: "ordinary_income",
      })
    ).toThrow()
  })

  it("accepts an unknown factual cause without guessing", () => {
    const event = decodeEvent({
      _tag: "disposition",
      id: "11111111-1111-4111-8111-111111111111",
      occurredAt: { epochMillis: 1_700_000_000_000 },
      assetId: "22222222-2222-4222-8222-222222222222",
      quantity: "1",
      custodySourceId: "33333333-3333-4333-8333-333333333333",
      cause: "unknown",
    })

    expect(event).toMatchObject({ _tag: "disposition", cause: "unknown" })
  })
})
