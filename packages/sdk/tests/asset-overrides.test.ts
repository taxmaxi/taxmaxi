import { describe, expect, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  TaxMaxi,
  getTaxMaxiAssetOverrideError,
  toTaxMaxiError,
  type AssetOverrideIdentityValidation,
  type AssetOverrideTarget,
} from "../src/index.ts"

type FetchInput = Parameters<typeof globalThis.fetch>[0]

type CapturedRequest = {
  readonly body: unknown
  readonly method: string
  readonly url: string
}

class CaughtPromiseError extends Data.TaggedError("CaughtPromiseError")<{
  readonly cause: unknown
}> {}

const ids = {
  activeOverride: "00000000-0000-4000-8000-000000000101",
  asset: "00000000-0000-4000-8000-000000000102",
  actor: "00000000-0000-4000-8000-000000000105",
  replacementAsset: "00000000-0000-4000-8000-000000000103",
  providerAsset: "00000000-0000-4000-8000-000000000104",
} as const

const contractAddress = "0x1111111111111111111111111111111111111111"

const representationTarget = {
  _tag: "representation",
  blockchain: "Base",
  type: "token",
  contractAddress,
  mintAddress: null,
} as const satisfies AssetOverrideTarget

const canonicalRepresentationTarget = {
  ...representationTarget,
  blockchain: "base",
}

const providerAssetTarget = {
  _tag: "provider_asset",
  providerAssetRowId: ids.providerAsset,
} as const satisfies AssetOverrideTarget

const Json = Schema.fromJsonString(Schema.Unknown)
const decodeJson = Schema.decodeSync(Json)
const encodeJson = Schema.encodeSync(Json)

const currentResponse = {
  target: canonicalRepresentationTarget,
  system: {
    identity: { _tag: "resolved", assetId: ids.asset },
    identityRevision: "identity-revision",
    inclusion: "included",
    inclusionRevision: "inclusion-revision",
  },
  activeIdentityOverride: null,
  activeInclusionOverride: null,
  effectiveDecision: { _tag: "included", assetId: ids.asset },
  checkedTechnicalBlockerKinds: ["missing_decimals", "unsupported_asset_type"],
  technicalBlockers: [],
  identityOverrideUsesStaleSystemRevision: false,
  inclusionOverrideUsesStaleSystemRevision: false,
  history: [],
  recomputation: { status: "not_scheduled" },
} as const

const historyRecord = {
  id: ids.activeOverride,
  kind: "identity",
  operation: "create",
  inspectedSystemRevision: "identity-revision",
  inspectedSystemIdentity: { _tag: "resolved", assetId: ids.asset },
  inspectedSystemInclusion: null,
  replacementIdentity: { _tag: "resolved", assetId: ids.replacementAsset },
  replacementInclusion: null,
  actorUserId: ids.actor,
  reason: "Use the existing USDC economic asset.",
  supersedesOverrideId: null,
  recordedAt: "2026-09-01T08:00:00.000Z",
} as const

const currentResponseWithHistory = {
  ...currentResponse,
  activeIdentityOverride: historyRecord,
  effectiveDecision: { _tag: "included", assetId: ids.replacementAsset },
  history: [historyRecord],
} as const

const historyResponse = {
  target: providerAssetTarget,
  history: [],
  recomputation: { status: "not_scheduled" },
} as const

const validationResponse = {
  _tag: "ready",
  asset: {
    id: ids.replacementAsset,
    type: "fungible",
    name: "USD Coin",
    symbol: "USDC",
    marketDataId: "usd-coin",
  },
  projection: currentResponse,
  warnings: [
    {
      code: "symbol_mismatch",
      current: "USDbC",
      selected: "USDC",
    },
  ],
  checkedTechnicalBlockerKinds: ["missing_decimals", "unsupported_asset_type"],
  technicalBlockers: ["missing_decimals"],
  recomputation: { status: "not_scheduled" },
} as const satisfies AssetOverrideIdentityValidation

const getRequestUrl = (input: FetchInput): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

const makeSequenceFetch =
  ({
    captured,
    responseBodies,
  }: {
    readonly captured: Array<CapturedRequest>
    readonly responseBodies: Array<unknown>
  }): typeof globalThis.fetch =>
  (input, init) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const requestBody =
          init?.body === undefined
            ? undefined
            : yield* Effect.promise(() => new Response(init.body).text())
        captured.push({
          body:
            requestBody === undefined || requestBody === "" ? undefined : decodeJson(requestBody),
          method:
            typeof input === "string" || input instanceof URL
              ? (init?.method ?? "GET")
              : input.method,
          url: getRequestUrl(input),
        })

        return new Response(encodeJson(responseBodies.shift() ?? currentResponse), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      })
    )

const query = (request: CapturedRequest): Readonly<Record<string, string>> =>
  Object.fromEntries(new URL(request.url).searchParams)

const makeErrorFetch = ({ body, status }: { readonly body: unknown; readonly status: number }) =>
  (() =>
    Promise.resolve(
      new Response(encodeJson(body), {
        headers: { "Content-Type": "application/json" },
        status,
      })
    )) satisfies typeof globalThis.fetch

describe("TaxMaxi asset override resources", () => {
  it.effect("exposes current, history, validation, replace, and withdraw in both clients", () =>
    Effect.gen(function* () {
      const captured: Array<CapturedRequest> = []
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_asset_overrides",
        baseUrl: "https://sdk.example.test",
        fetch: makeSequenceFetch({
          captured,
          responseBodies: [
            currentResponse,
            historyResponse,
            validationResponse,
            currentResponse,
            currentResponse,
          ],
        }),
      })

      const current = yield* Effect.promise(() =>
        taxmaxi.assetOverrides.getCurrent(representationTarget)
      )
      const history = yield* taxmaxi.effect.assetOverrides.getHistory(providerAssetTarget)
      const validation = yield* Effect.promise(() =>
        taxmaxi.assetOverrides.validateIdentity({
          target: representationTarget,
          assetId: ids.replacementAsset,
        })
      )
      const replaced = yield* taxmaxi.effect.assetOverrides.replace({
        target: representationTarget,
        replacement: {
          _tag: "identity",
          assetId: ids.replacementAsset,
          expectedActiveOverrideId: ids.activeOverride,
          expectedSystemRevision: "identity-revision",
          reason: "Use the existing USDC economic asset.",
        },
      })
      const withdrawn = yield* Effect.promise(() =>
        taxmaxi.assetOverrides.withdraw({
          target: representationTarget,
          withdrawal: {
            kind: "identity",
            expectedActiveOverrideId: ids.activeOverride,
            expectedSystemRevision: "identity-revision",
            reason: "Return to TaxMaxi's current conclusion.",
          },
        })
      )

      expect(current).toEqual(currentResponse)
      expect(history).toEqual(historyResponse)
      expect(validation).toEqual(validationResponse)
      expect(replaced.recomputation.status).toBe("not_scheduled")
      expect(withdrawn.checkedTechnicalBlockerKinds).toEqual([
        "missing_decimals",
        "unsupported_asset_type",
      ])
      expect("create" in taxmaxi.assetOverrides).toBe(false)
      expect("create" in taxmaxi.effect.assetOverrides).toBe(false)

      const currentRequest = captured[0]
      const historyRequest = captured[1]
      const validationRequest = captured[2]
      const replaceRequest = captured[3]
      const withdrawRequest = captured[4]
      if (
        currentRequest === undefined ||
        historyRequest === undefined ||
        validationRequest === undefined ||
        replaceRequest === undefined ||
        withdrawRequest === undefined
      ) {
        return yield* Effect.die("Expected all five asset override requests.")
      }

      expect(captured.map(({ method, url }) => ({ method, path: new URL(url).pathname }))).toEqual([
        { method: "GET", path: "/v1/asset-overrides/current" },
        { method: "GET", path: "/v1/asset-overrides/history" },
        { method: "GET", path: "/v1/asset-overrides/validation" },
        { method: "POST", path: "/v1/asset-overrides/replace" },
        { method: "POST", path: "/v1/asset-overrides/withdraw" },
      ])
      expect(query(currentRequest)).toEqual({
        targetKind: "representation",
        blockchain: "Base",
        representationType: "token",
        contractAddress,
      })
      expect(query(historyRequest)).toEqual({
        targetKind: "provider_asset",
        providerAssetRowId: ids.providerAsset,
      })
      expect(query(validationRequest)).toEqual({
        targetKind: "representation",
        blockchain: "Base",
        representationType: "token",
        contractAddress,
        assetId: ids.replacementAsset,
      })
      expect(replaceRequest.body).toEqual({
        _tag: "identity",
        assetId: ids.replacementAsset,
        expectedActiveOverrideId: ids.activeOverride,
        expectedSystemRevision: "identity-revision",
        reason: "Use the existing USDC economic asset.",
      })
      expect(withdrawRequest.body).toEqual({
        kind: "identity",
        expectedActiveOverrideId: ids.activeOverride,
        expectedSystemRevision: "identity-revision",
        reason: "Return to TaxMaxi's current conclusion.",
      })
    })
  )

  it.each([
    {
      error: {
        _tag: "AssetOverrideCanonicalTargetError",
        code: "invalid_canonical_target",
        reason: "invalid_evm_address",
      },
      tag: "AssetOverrideCanonicalTargetError",
    },
    {
      error: {
        _tag: "AssetOverrideTargetNotFoundError",
        code: "target_not_found",
      },
      tag: "AssetOverrideTargetNotFoundError",
    },
    {
      error: {
        _tag: "AssetOverrideReadonlyError",
        code: "readonly_user",
      },
      tag: "AssetOverrideReadonlyError",
    },
    {
      error: {
        _tag: "AssetOverrideMutationConflictError",
        code: "override_conflict",
        conflictKinds: ["active_override", "system_revision"],
        currentProjection: currentResponse,
        currentActiveOverrideId: ids.activeOverride,
        currentSystemRevision: "current-revision",
        expectedActiveOverrideId: ids.activeOverride,
        expectedSystemRevision: "stale-revision",
      },
      tag: "AssetOverrideMutationConflictError",
    },
    {
      error: {
        _tag: "AssetOverrideReplacementValidationError",
        code: "invalid_replacement",
        validation: {
          _tag: "asset_not_found",
          assetId: ids.replacementAsset,
          checkedTechnicalBlockerKinds: ["missing_decimals", "unsupported_asset_type"],
          technicalBlockers: ["missing_decimals"],
          recomputation: { status: "not_scheduled" },
        },
        currentProjection: currentResponse,
      },
      tag: "AssetOverrideReplacementValidationError",
    },
  ] as const)("extracts structured $tag details from Promise-style errors", ({ error, tag }) => {
    const details = getTaxMaxiAssetOverrideError(toTaxMaxiError(error))

    expect(details?._tag).toBe(tag)
    expect(details).toMatchObject(error)
  })

  it.effect("preserves a decoded Promise conflict with dated history", () =>
    Effect.gen(function* () {
      const conflict = {
        _tag: "AssetOverrideMutationConflictError",
        code: "override_conflict",
        conflictKinds: ["system_revision"],
        currentProjection: currentResponseWithHistory,
        currentActiveOverrideId: ids.activeOverride,
        currentSystemRevision: "current-revision",
        expectedActiveOverrideId: ids.activeOverride,
        expectedSystemRevision: "stale-revision",
      } as const
      const taxmaxi = new TaxMaxi({
        apiKey: "tm_asset_overrides",
        baseUrl: "https://sdk.example.test",
        fetch: makeErrorFetch({ body: conflict, status: 409 }),
      })

      const error = yield* Effect.tryPromise({
        try: () =>
          taxmaxi.assetOverrides.replace({
            target: representationTarget,
            replacement: {
              _tag: "identity",
              assetId: ids.replacementAsset,
              expectedActiveOverrideId: ids.activeOverride,
              expectedSystemRevision: "stale-revision",
              reason: "Use the existing USDC economic asset.",
            },
          }),
        catch: (cause) => new CaughtPromiseError({ cause }),
      }).pipe(Effect.flip)
      const details = getTaxMaxiAssetOverrideError(error.cause)

      expect(details?._tag).toBe("AssetOverrideMutationConflictError")
      if (details?._tag !== "AssetOverrideMutationConflictError") {
        return yield* Effect.die("Expected structured conflict details.")
      }
      expect(details.conflictKinds).toEqual(["system_revision"])
      expect(details.currentProjection.history[0]?.id).toBe(ids.activeOverride)
      expect(details.currentProjection.recomputation.status).toBe("not_scheduled")
    })
  )

  it("returns null for unrelated errors", () => {
    expect(getTaxMaxiAssetOverrideError(new Error("unrelated"))).toBeNull()
  })
})
