import { describe, expect, it } from "@effect/vitest"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  TaxMaxi,
  getTaxMaxiAssetOverrideError,
  toTaxMaxiError,
  type AssetOverrideCreateError,
  type AssetOverrideCreateInput,
  type AssetOverrideCreateResult,
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
  inclusionOverride: "00000000-0000-4000-8000-000000000108",
  job: "00000000-0000-4000-8000-000000000106",
  replacementAsset: "00000000-0000-4000-8000-000000000103",
  providerAsset: "00000000-0000-4000-8000-000000000104",
  source: "00000000-0000-4000-8000-000000000107",
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

const updatingRecomputation = {
  status: "updating",
  overrideIds: [ids.activeOverride, ids.inclusionOverride],
  sourceJobs: [
    {
      overrideId: ids.activeOverride,
      sourceId: ids.source,
      requestedJobId: ids.job,
      jobId: ids.job,
      status: "pending",
      failureCode: null,
    },
    {
      overrideId: ids.inclusionOverride,
      sourceId: ids.source,
      requestedJobId: ids.job,
      jobId: ids.job,
      status: "running",
      failureCode: null,
    },
  ],
} as const

const identityCreateResponse = {
  ...currentResponseWithHistory,
  recomputation: updatingRecomputation,
} as const

const inclusionCreateRecord = {
  ...historyRecord,
  id: ids.inclusionOverride,
  kind: "inclusion",
  inspectedSystemIdentity: null,
  inspectedSystemInclusion: "included",
  replacementIdentity: null,
  replacementInclusion: "excluded",
  reason: "Exclude this asset from my calculation.",
} as const

const inclusionCreateResponse = {
  ...currentResponse,
  activeInclusionOverride: inclusionCreateRecord,
  effectiveDecision: {
    _tag: "excluded",
    identity: { _tag: "resolved", assetId: ids.asset },
  },
  history: [inclusionCreateRecord],
  recomputation: updatingRecomputation,
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
  it.effect("supports create in both clients alongside existing asset override methods", () =>
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
            identityCreateResponse,
            inclusionCreateResponse,
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
      const identityCreateInput = {
        target: representationTarget,
        override: {
          _tag: "identity",
          assetId: ids.replacementAsset,
          expectedSystemRevision: "identity-revision",
          reason: "Use the existing USDC economic asset.",
        },
      } as const satisfies AssetOverrideCreateInput
      const identityCreated: AssetOverrideCreateResult = yield* Effect.promise(() =>
        taxmaxi.assetOverrides.create(identityCreateInput)
      )
      const inclusionCreated: AssetOverrideCreateResult =
        yield* taxmaxi.effect.assetOverrides.create({
          target: representationTarget,
          override: {
            _tag: "inclusion",
            inclusion: "excluded",
            expectedSystemRevision: "inclusion-revision",
            reason: "Exclude this asset from my calculation.",
          },
        })
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
      expect(identityCreated.recomputation).toEqual(updatingRecomputation)
      expect(inclusionCreated.recomputation).toEqual(updatingRecomputation)
      expect(replaced.recomputation.status).toBe("not_scheduled")
      expect(withdrawn.checkedTechnicalBlockerKinds).toEqual([
        "missing_decimals",
        "unsupported_asset_type",
      ])

      const currentRequest = captured[0]
      const historyRequest = captured[1]
      const validationRequest = captured[2]
      const identityCreateRequest = captured[3]
      const inclusionCreateRequest = captured[4]
      const replaceRequest = captured[5]
      const withdrawRequest = captured[6]
      if (
        currentRequest === undefined ||
        historyRequest === undefined ||
        validationRequest === undefined ||
        identityCreateRequest === undefined ||
        inclusionCreateRequest === undefined ||
        replaceRequest === undefined ||
        withdrawRequest === undefined
      ) {
        return yield* Effect.die("Expected all seven asset override requests.")
      }

      expect(captured.map(({ method, url }) => ({ method, path: new URL(url).pathname }))).toEqual([
        { method: "GET", path: "/v1/asset-overrides/current" },
        { method: "GET", path: "/v1/asset-overrides/history" },
        { method: "GET", path: "/v1/asset-overrides/validation" },
        { method: "POST", path: "/v1/asset-overrides/create" },
        { method: "POST", path: "/v1/asset-overrides/create" },
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
      expect(query(identityCreateRequest)).toEqual({
        targetKind: "representation",
        blockchain: "Base",
        representationType: "token",
        contractAddress,
      })
      expect(identityCreateRequest.body).toEqual(identityCreateInput.override)
      expect(inclusionCreateRequest.body).toEqual({
        _tag: "inclusion",
        inclusion: "excluded",
        expectedSystemRevision: "inclusion-revision",
        reason: "Exclude this asset from my calculation.",
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

  it.effect("decodes typed create validation and conflict errors", () =>
    Effect.gen(function* () {
      const validationError = {
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
      } as const
      const effectClient = new TaxMaxi({
        apiKey: "tm_asset_overrides",
        baseUrl: "https://sdk.example.test",
        fetch: makeErrorFetch({ body: validationError, status: 422 }),
      })
      const effectError: AssetOverrideCreateError = yield* effectClient.effect.assetOverrides
        .create({
          target: representationTarget,
          override: {
            _tag: "identity",
            assetId: ids.replacementAsset,
            expectedSystemRevision: "identity-revision",
            reason: "Use the existing USDC economic asset.",
          },
        })
        .pipe(Effect.flip)

      expect(effectError).toMatchObject(validationError)

      const conflict = {
        _tag: "AssetOverrideMutationConflictError",
        code: "override_conflict",
        conflictKinds: ["active_override"],
        currentProjection: identityCreateResponse,
        currentActiveOverrideId: ids.activeOverride,
        currentSystemRevision: "current-revision",
        expectedActiveOverrideId: null,
        expectedSystemRevision: "identity-revision",
      } as const
      const promiseClient = new TaxMaxi({
        apiKey: "tm_asset_overrides",
        baseUrl: "https://sdk.example.test",
        fetch: makeErrorFetch({ body: conflict, status: 409 }),
      })
      const promiseError = yield* Effect.tryPromise({
        try: () =>
          promiseClient.assetOverrides.create({
            target: representationTarget,
            override: {
              _tag: "identity",
              assetId: ids.replacementAsset,
              expectedSystemRevision: "identity-revision",
              reason: "Use the existing USDC economic asset.",
            },
          }),
        catch: (cause) => new CaughtPromiseError({ cause }),
      }).pipe(Effect.flip)
      const conflictDetails = getTaxMaxiAssetOverrideError(promiseError.cause)

      expect(conflictDetails).toMatchObject({
        _tag: "AssetOverrideMutationConflictError",
        code: "override_conflict",
        conflictKinds: ["active_override"],
        currentActiveOverrideId: ids.activeOverride,
        currentSystemRevision: "current-revision",
        expectedActiveOverrideId: null,
        expectedSystemRevision: "identity-revision",
      })
      if (conflictDetails?._tag !== "AssetOverrideMutationConflictError") {
        return yield* Effect.die("Expected structured create conflict details.")
      }
      expect(conflictDetails.currentProjection.recomputation).toEqual(updatingRecomputation)
      expect(conflictDetails.currentProjection.recomputation.status).toBe("updating")
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
