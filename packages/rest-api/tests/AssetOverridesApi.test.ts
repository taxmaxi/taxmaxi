import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AssetOverrideConflictError,
  AssetOverrideNotFoundError,
} from "../src/definitions/AssetOverridesApi.ts"

const projection = {
  kind: "inclusion" as const,
  target: {
    _tag: "provider_asset" as const,
    providerAssetRowId: "00000000-0000-4000-8000-000000000001",
  },
  systemRevision: "revision",
  systemConclusion: {
    _tag: "inclusion" as const,
    state: "included" as const,
    reason: null,
  },
  activeOverride: null,
  effectiveConclusion: {
    _tag: "inclusion" as const,
    state: "included" as const,
    reason: null,
  },
  staleSystemRevision: false,
  history: [],
  recomputationState: "complete" as const,
}

describe("asset override API errors", () => {
  it("exposes a stable code for missing targets", () => {
    const error = new AssetOverrideNotFoundError({
      code: "asset_override_target_not_found",
      message: "Asset override target not found.",
    })

    expect(Schema.encodeSync(AssetOverrideNotFoundError)(error)).toMatchObject({
      code: "asset_override_target_not_found",
    })
  })

  it("exposes a stable code for write conflicts", () => {
    const error = new AssetOverrideConflictError({
      code: "asset_override_conflict",
      message: "The TaxMaxi conclusion or active override changed.",
      current: projection,
    })

    expect(Schema.encodeSync(AssetOverrideConflictError)(error)).toMatchObject({
      code: "asset_override_conflict",
    })
  })
})
