import { describe, expect, it } from "@effect/vitest"
import { AccountingQuantity, MonetaryAmount } from "@my/core/accounting"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { matchFifoLots, type FifoMatchResult } from "../src/index.ts"

const quantity = Schema.decodeUnknownSync(AccountingQuantity)

const renderResult = (result: FifoMatchResult) => {
  const rendered = {
    ...result,
    allocations: result.allocations.map((allocation) => ({
      lotId: allocation.lotId,
      matchedQuantity: Schema.encodeSync(AccountingQuantity)(allocation.matchedQuantity),
      remainingQuantity: Schema.encodeSync(AccountingQuantity)(allocation.remainingQuantity),
      costBasis: allocation.costBasis.format(),
      proceeds: allocation.proceeds.format(),
      gainLoss: allocation.gainLoss.format(),
    })),
  }

  return result._tag === "InventoryShortage"
    ? {
        ...rendered,
        shortage: Schema.encodeSync(AccountingQuantity)(result.shortage),
      }
    : rendered
}

describe("matchFifoLots", () => {
  it.effect("matches ordered lots and calculates each allocation", () =>
    Effect.gen(function* () {
      const result = yield* matchFifoLots({
        lots: [
          {
            id: "oldest-lot",
            remainingQuantity: quantity("1"),
            costBasisPerUnit: MonetaryAmount.unsafeFromString("2", "EUR"),
          },
          {
            id: "newer-lot",
            remainingQuantity: quantity("2"),
            costBasisPerUnit: MonetaryAmount.unsafeFromString("3", "EUR"),
          },
        ],
        disposal: {
          quantity: quantity("3"),
          proceeds: MonetaryAmount.unsafeFromString("10", "EUR"),
        },
      })

      expect(renderResult(result)).toEqual({
        _tag: "FullyMatched",
        allocations: [
          {
            lotId: "oldest-lot",
            matchedQuantity: "1",
            remainingQuantity: "0",
            costBasis: "2",
            proceeds: "3.33333333",
            gainLoss: "1.33333333",
          },
          {
            lotId: "newer-lot",
            matchedQuantity: "2",
            remainingQuantity: "0",
            costBasis: "6",
            proceeds: "6.66666667",
            gainLoss: "0.66666667",
          },
        ],
      })
    })
  )

  it.effect("calculates a loss when allocated cost basis exceeds proceeds", () =>
    Effect.gen(function* () {
      const result = yield* matchFifoLots({
        lots: [
          {
            id: "loss-lot",
            remainingQuantity: quantity("1"),
            costBasisPerUnit: MonetaryAmount.unsafeFromString("12", "EUR"),
          },
        ],
        disposal: {
          quantity: quantity("1"),
          proceeds: MonetaryAmount.unsafeFromString("10", "EUR"),
        },
      })

      expect(renderResult(result)).toEqual({
        _tag: "FullyMatched",
        allocations: [
          {
            lotId: "loss-lot",
            matchedQuantity: "1",
            remainingQuantity: "0",
            costBasis: "12",
            proceeds: "10",
            gainLoss: "-2",
          },
        ],
      })
    })
  )

  it.effect("returns partial allocations and the missing quantity when inventory is short", () =>
    Effect.gen(function* () {
      const result = yield* matchFifoLots({
        lots: [
          {
            id: "available-lot",
            remainingQuantity: quantity("1"),
            costBasisPerUnit: MonetaryAmount.unsafeFromString("4", "EUR"),
          },
        ],
        disposal: {
          quantity: quantity("2"),
          proceeds: MonetaryAmount.unsafeFromString("20", "EUR"),
        },
      })

      expect(renderResult(result)).toEqual({
        _tag: "InventoryShortage",
        allocations: [
          {
            lotId: "available-lot",
            matchedQuantity: "1",
            remainingQuantity: "0",
            costBasis: "4",
            proceeds: "10",
            gainLoss: "6",
          },
        ],
        shortage: "1",
      })
    })
  )
})
