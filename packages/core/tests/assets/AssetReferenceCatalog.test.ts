import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  assetReferenceCatalog,
  deriveAssetReferenceCatalogProjections,
  type AssetReferenceCatalog,
} from "../../src/assets/AssetReferenceCatalog.ts"

const validationCodes = (catalog: AssetReferenceCatalog) => {
  const result = Effect.runSync(Effect.result(deriveAssetReferenceCatalogProjections(catalog)))

  expect(result._tag).toBe("Failure")
  if (result._tag === "Success") {
    return []
  }

  return result.failure.violations.map((violation) => violation.code)
}

describe("AssetReferenceCatalog", () => {
  it("derives deterministic local projections with one shared USDC identity", () => {
    const first = Effect.runSync(deriveAssetReferenceCatalogProjections(assetReferenceCatalog))
    const second = Effect.runSync(deriveAssetReferenceCatalogProjections(assetReferenceCatalog))

    const coinbaseUsdc = first.providerAliases.find(
      (alias) => alias.provider === "coinbase" && alias.alias === "USDC"
    )
    const solanaUsdc = first.providerAliases.find(
      (alias) =>
        alias.provider === "helius-solana" &&
        alias.alias === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    )

    expect(second).toEqual(first)
    expect(coinbaseUsdc?.assetKey).toBe("usdc")
    expect(solanaUsdc).toMatchObject({
      assetKey: "usdc",
      representationKey: "solana:mint:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    })
  })

  it("rejects duplicate stable asset and representation keys", () => {
    const firstAsset = assetReferenceCatalog.assets[0]
    const firstRepresentation = assetReferenceCatalog.representations.find(
      (representation) => representation.contractAddress !== null
    )

    if (firstRepresentation === undefined) {
      expect.fail("Missing built-in contract representation")
    }

    const catalog = {
      ...assetReferenceCatalog,
      assets: [...assetReferenceCatalog.assets, { ...firstAsset, symbol: "XBT" }],
      representations: [
        ...assetReferenceCatalog.representations,
        {
          ...firstRepresentation,
          contractAddress: "0x0000000000000000000000000000000000000001",
        },
      ],
    } satisfies AssetReferenceCatalog

    expect(validationCodes(catalog)).toEqual(
      expect.arrayContaining(["duplicate_asset_key", "duplicate_representation_key"])
    )
  })

  it("rejects duplicate exact representations and conflicting ownership", () => {
    const solanaUsdc = assetReferenceCatalog.representations.find(
      (representation) =>
        representation.assetKey === "usdc" && representation.blockchain === "solana"
    )

    if (solanaUsdc === undefined) {
      expect.fail("Missing built-in Solana USDC representation")
    }

    const duplicate = { ...solanaUsdc, key: "solana:mint:duplicate-solana-usdc" } as const
    const conflict = {
      ...solanaUsdc,
      key: "solana:mint:conflicting-solana-usdc",
      assetKey: "usdt",
    } as const

    expect(
      validationCodes({
        ...assetReferenceCatalog,
        representations: [...assetReferenceCatalog.representations, duplicate, conflict],
      })
    ).toEqual(
      expect.arrayContaining([
        "duplicate_exact_representation",
        "conflicting_representation_ownership",
      ])
    )
  })

  it("rejects duplicate provider aliases and missing asset references", () => {
    const firstAlias = assetReferenceCatalog.providerAliases[0]

    expect(
      validationCodes({
        ...assetReferenceCatalog,
        assets: assetReferenceCatalog.assets.filter((asset) => asset.key !== firstAlias.assetKey),
        providerAliases: [...assetReferenceCatalog.providerAliases, firstAlias],
      })
    ).toEqual(expect.arrayContaining(["duplicate_provider_alias", "missing_referenced_asset"]))
  })

  it("treats Coinbase currency aliases as case-insensitive provider identities", () => {
    const usdcAlias = assetReferenceCatalog.providerAliases.find(
      (alias) => alias.provider === "coinbase" && alias.alias === "USDC"
    )

    if (usdcAlias === undefined) {
      expect.fail("Missing built-in Coinbase USDC alias")
    }

    expect(
      validationCodes({
        ...assetReferenceCatalog,
        providerAliases: [
          ...assetReferenceCatalog.providerAliases,
          { ...usdcAlias, alias: "usdc" },
        ],
      })
    ).toContain("duplicate_provider_alias")
  })
})
