import { describe, expect, it } from "vitest"

import { getAssetExceptionDisplaySymbol, readableAssetLabel } from "#/lib/assets"

describe("readableAssetLabel", () => {
  it("returns the trimmed label when it has readable characters", () => {
    expect(readableAssetLabel(" BONK ")).toBe("BONK")
  })

  it("returns null for null and undefined", () => {
    expect(readableAssetLabel(null)).toBeNull()
    expect(readableAssetLabel(undefined)).toBeNull()
  })

  it("returns null for empty and whitespace-only labels", () => {
    expect(readableAssetLabel("")).toBeNull()
    expect(readableAssetLabel("   ")).toBeNull()
  })

  it("returns null for labels made of invisible characters", () => {
    expect(readableAssetLabel("ㅤ")).toBeNull()
    expect(readableAssetLabel("​‍﻿")).toBeNull()
    expect(readableAssetLabel("ᅟᅠﾠ⠀")).toBeNull()
  })

  it("keeps labels that mix invisible and readable characters", () => {
    expect(readableAssetLabel("BO​NK")).toBe("BO​NK")
  })
})

describe("getAssetExceptionDisplaySymbol", () => {
  const exception = {
    currencyCode: "ㅤ",
    name: "Bonk",
    providerAssetId: "9sLV9gY1oLGa65csS2kCGCXw3UKB25PNyFzSt9yFk3bR",
    naturalKey: "helius:9sLV9gY1oLGa65csS2kCGCXw3UKB25PNyFzSt9yFk3bR",
    providerAssetRowId: "3e0f5f56-4c88-4c4c-9d6f-3a2b1c0d9e8f",
  }

  it("uses the symbol when it is readable", () => {
    expect(getAssetExceptionDisplaySymbol({ ...exception, currencyCode: "BONK" })).toBe("BONK")
  })

  it("falls back to the name when the symbol is invisible", () => {
    expect(getAssetExceptionDisplaySymbol(exception)).toBe("Bonk")
  })

  it("falls back to the provider asset id when symbol and name are unreadable", () => {
    expect(getAssetExceptionDisplaySymbol({ ...exception, name: null })).toBe(
      exception.providerAssetId
    )
  })

  it("falls back to the row id when nothing else is available", () => {
    expect(
      getAssetExceptionDisplaySymbol({
        ...exception,
        name: null,
        providerAssetId: null,
        naturalKey: null,
      })
    ).toBe(exception.providerAssetRowId)
  })
})
