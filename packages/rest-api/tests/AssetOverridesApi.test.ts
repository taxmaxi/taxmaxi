import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import {
  AssetOverrideBadRequestError,
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
  it.each([
    "invalid_target",
    "invalid_representation_target",
    "override_kind_mismatch",
    "asset_not_found",
    "asset_type_mismatch",
    "fiat_not_overrideable",
    "missing_decimals",
    "unsupported_asset_type",
    "cyclic_replay_dependency",
    "cross_principal_replay_dependency",
    "reason_required",
    "no_active_override",
  ] as const)("exposes the stable %s validation code", (code) => {
    const error = new AssetOverrideBadRequestError({ code, message: "Invalid override." })
    expect(Schema.encodeSync(AssetOverrideBadRequestError)(error)).toMatchObject({ code })
  })

  it("rejects undocumented validation codes", () => {
    expect(() =>
      Schema.decodeUnknownSync(AssetOverrideBadRequestError)({
        _tag: "AssetOverrideBadRequestError",
        code: "new_undocumented_code",
        message: "Invalid override.",
      })
    ).toThrow()
  })

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
