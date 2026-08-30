import { describe, expect, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { MarketQuoteFact, ObservedConsiderationFact } from "../../src/accounting/index.ts"

const decodeObservedConsideration = Schema.decodeUnknownSync(ObservedConsiderationFact)
const decodeMarketQuote = Schema.decodeUnknownSync(MarketQuoteFact)

describe("ValuationFact", () => {
  it("keeps observed consideration distinct from a market quote", () => {
    const observed = decodeObservedConsideration({
      _tag: "observed_consideration",
      eventId: "11111111-1111-4111-8111-111111111111",
      amount: { amount: "30000", currency: "EUR" },
      evidenceReference: "coinbase-transaction-42",
    })
    const quote = decodeMarketQuote({
      _tag: "market_quote",
      eventId: "22222222-2222-4222-8222-222222222222",
      unitPrice: { amount: "30100", currency: "EUR" },
      quotedAt: { epochMillis: 1_700_000_000_000 },
      source: "coingecko",
    })

    expect(observed.amount.toString()).toBe("30000 EUR")
    expect(quote.unitPrice.toString()).toBe("30100 EUR")
  })

  it("rejects crypto asset codes as fiat valuation currency", () => {
    expect(() =>
      decodeObservedConsideration({
        _tag: "observed_consideration",
        eventId: "11111111-1111-4111-8111-111111111111",
        amount: { amount: "1", currency: "BTC" },
        evidenceReference: "coinbase-transaction-42",
      })
    ).toThrow()
  })

  it("rejects negative observed consideration", () => {
    expect(() =>
      decodeObservedConsideration({
        _tag: "observed_consideration",
        eventId: "11111111-1111-4111-8111-111111111111",
        amount: { amount: "-0.01", currency: "EUR" },
        evidenceReference: "coinbase-transaction-42",
      })
    ).toThrow()
  })

  it("accepts zero observed consideration", () => {
    const observed = decodeObservedConsideration({
      _tag: "observed_consideration",
      eventId: "11111111-1111-4111-8111-111111111111",
      amount: { amount: "0", currency: "EUR" },
      evidenceReference: "coinbase-transaction-42",
    })

    expect(observed.amount.toString()).toBe("0 EUR")
  })

  it("rejects a negative market quote", () => {
    expect(() =>
      decodeMarketQuote({
        _tag: "market_quote",
        eventId: "22222222-2222-4222-8222-222222222222",
        unitPrice: { amount: "-0.01", currency: "EUR" },
        quotedAt: { epochMillis: 1_700_000_000_000 },
        source: "coingecko",
      })
    ).toThrow()
  })

  it("rejects a zero market quote", () => {
    expect(() =>
      decodeMarketQuote({
        _tag: "market_quote",
        eventId: "22222222-2222-4222-8222-222222222222",
        unitPrice: { amount: "0", currency: "EUR" },
        quotedAt: { epochMillis: 1_700_000_000_000 },
        source: "coingecko",
      })
    ).toThrow()
  })
})
