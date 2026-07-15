import { describe, expect, it } from "vitest"
import { PortfolioAssetRow } from "../src/definitions/PortfolioApi.ts"
import { makePortfolioSummary } from "../src/layers/PortfolioApiLive.ts"

const makeAsset = ({
  assetId,
  profitLoss,
  totalValue,
}: {
  readonly assetId: string
  readonly profitLoss: string | null
  readonly totalValue: string | null
}) =>
  PortfolioAssetRow.make({
    assetId,
    symbol: assetId,
    name: assetId,
    logoUrl: null,
    amount: "1",
    currentPrice: totalValue,
    totalValue,
    profitLoss,
  })

describe("makePortfolioSummary", () => {
  it("keeps aggregate values unavailable when an asset is unpriced", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "one", totalValue: "100.1", profitLoss: "20.1" }),
      makeAsset({ assetId: "two", totalValue: "49.9", profitLoss: "-5.1" }),
      makeAsset({ assetId: "unpriced", totalValue: null, profitLoss: null }),
    ])

    expect(summary).toEqual({
      totalValue: null,
      costBasis: null,
      profitLoss: null,
      profitLossPercentage: null,
    })
  })

  it("aggregates decimal values without floating-point rounding", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "one", totalValue: "100.1", profitLoss: "20.1" }),
      makeAsset({ assetId: "two", totalValue: "49.9", profitLoss: "-5.1" }),
    ])

    expect(summary).toEqual({
      totalValue: "150",
      costBasis: "135",
      profitLoss: "15",
      profitLossPercentage: "11.11111111",
    })
  })

  it("omits the percentage when cost basis is zero", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "zero", totalValue: "0", profitLoss: "0" }),
    ])

    expect(summary.profitLossPercentage).toBeNull()
  })

  it("keeps aggregate profit and cost basis unavailable when a priced asset has no P/L", () => {
    const summary = makePortfolioSummary([
      makeAsset({ assetId: "known", totalValue: "100", profitLoss: "25" }),
      makeAsset({ assetId: "unknown", totalValue: "50", profitLoss: null }),
    ])

    expect(summary).toEqual({
      totalValue: "150",
      costBasis: null,
      profitLoss: null,
      profitLossPercentage: null,
    })
  })
})
