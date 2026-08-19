/**
 * Attach-only asset resolution policy.
 *
 * Decodes exact chain facts and CoinGecko responses into typed claims and
 * decides attach, pending, or fail-closed. CoinGecko may prove representation
 * ownership only for an existing economic asset under exact platform, address,
 * type, and decimals checks. Names and symbols are display data.
 *
 * @module assets/AssetResolutionPolicy
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Policy revision recorded with every attach-only decision. */
export const ATTACH_ONLY_RESOLUTION_POLICY_REVISION = "2026-08-19.attach-only.1"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())

/** Non-negative integer decimal places for a network representation. */
export const AssetDecimals = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(0))
).annotate({
  identifier: "AssetDecimals",
  title: "Asset Decimals",
  description: "Non-negative integer decimal places for a network representation",
})

/** The AssetDecimals type. */
export type AssetDecimals = typeof AssetDecimals.Type

/** Exact representation type observed on a chain. */
export const RepresentationType = Schema.Literals(["native", "token", "nft"]).annotate({
  identifier: "RepresentationType",
  title: "Representation Type",
  description: "Native asset, fungible token, or NFT representation",
})

/** The RepresentationType type. */
export type RepresentationType = typeof RepresentationType.Type

/** Economic asset type used to reject nft/fungible mixes. */
export const EconomicAssetType = Schema.Literals(["fungible", "nft"]).annotate({
  identifier: "EconomicAssetType",
  title: "Economic Asset Type",
  description: "Chain-independent economic asset type",
})

/** The EconomicAssetType type. */
export type EconomicAssetType = typeof EconomicAssetType.Type

const chainFactIdentityMatchesType = ({
  type,
  contractAddress,
  mintAddress,
}: {
  readonly type: RepresentationType
  readonly contractAddress: string | null
  readonly mintAddress: string | null
}): boolean => {
  const addressCount = (contractAddress === null ? 0 : 1) + (mintAddress === null ? 0 : 1)
  return type === "native" ? addressCount === 0 : addressCount === 1
}

/**
 * Unknown chain-fact payload. Exact chain evidence proves chain, address or
 * mint, representation type, and observed decimals.
 */
export const ChainFactPayload = Schema.Struct({
  blockchain: NonEmptyString,
  type: RepresentationType,
  contractAddress: Schema.NullOr(NonEmptyString),
  mintAddress: Schema.NullOr(NonEmptyString),
  decimals: AssetDecimals,
})
  .pipe(
    Schema.check(
      Schema.makeFilter((fact) =>
        chainFactIdentityMatchesType(fact)
          ? undefined
          : "Chain fact identity does not match representation type."
      )
    )
  )
  .annotate({
    identifier: "ChainFactPayload",
    title: "Chain Fact Payload",
    description: "Exact chain observation of one native, contract, or mint representation",
  })

/** The ChainFactPayload type. */
export type ChainFactPayload = typeof ChainFactPayload.Type

/**
 * Typed chain claim. Chain evidence does not by itself prove cross-network
 * economic identity.
 */
export class ChainClaim extends Schema.TaggedClass<ChainClaim>()("chain_claim", {
  blockchain: NonEmptyString,
  type: RepresentationType,
  contractAddress: Schema.NullOr(NonEmptyString),
  mintAddress: Schema.NullOr(NonEmptyString),
  decimals: AssetDecimals,
}) {}

/** Type guard for ChainClaim. */
export const isChainClaim = Schema.is(ChainClaim)

const CoinGeckoDetailPlatform = Schema.Struct({
  decimal_place: Schema.NullOr(AssetDecimals),
  contract_address: Schema.String,
})

/**
 * Unknown CoinGecko coin payload. Stable identity is `id`; name and symbol are
 * display data and must never prove a merge.
 */
export const CoinGeckoCoinPayload = Schema.Struct({
  id: NonEmptyString,
  symbol: Schema.String,
  name: Schema.String,
  asset_platform_id: Schema.NullOr(Schema.String),
  platforms: Schema.Record(Schema.String, Schema.String),
  detail_platforms: Schema.Record(Schema.String, CoinGeckoDetailPlatform),
}).annotate({
  identifier: "CoinGeckoCoinPayload",
  title: "CoinGecko Coin Payload",
  description: "CoinGecko coin response used as attach-only representation evidence",
})

/** The CoinGeckoCoinPayload type. */
export type CoinGeckoCoinPayload = typeof CoinGeckoCoinPayload.Type

/** One CoinGecko platform mapping extracted from a decoded coin payload. */
export class CoinGeckoPlatformMapping extends Schema.Class<CoinGeckoPlatformMapping>(
  "CoinGeckoPlatformMapping"
)({
  platformId: NonEmptyString,
  contractAddress: Schema.NullOr(NonEmptyString),
  decimals: Schema.NullOr(AssetDecimals),
}) {}

/** Typed CoinGecko claim. Ownership may be proved only under existing-asset checks. */
export class CoinGeckoClaim extends Schema.TaggedClass<CoinGeckoClaim>()("coingecko_claim", {
  coinId: NonEmptyString,
  name: Schema.String,
  symbol: Schema.String,
  platforms: Schema.Array(CoinGeckoPlatformMapping),
}) {}

/** Type guard for CoinGeckoClaim. */
export const isCoinGeckoClaim = Schema.is(CoinGeckoClaim)

/** Evidence source whose payload could not be decoded or fetched. */
export const AssetResolutionEvidenceSource = Schema.Literals(["chain", "coingecko"]).annotate({
  identifier: "AssetResolutionEvidenceSource",
  title: "Asset Resolution Evidence Source",
  description: "Chain facts or CoinGecko response that failed closed",
})

/** The AssetResolutionEvidenceSource type. */
export type AssetResolutionEvidenceSource = typeof AssetResolutionEvidenceSource.Type

/** Malformed or changed evidence payload. */
export class AssetResolutionMalformedPayload extends Schema.TaggedError<AssetResolutionMalformedPayload>()(
  "malformed_payload",
  {
    source: AssetResolutionEvidenceSource,
  }
) {}

/** Type guard for AssetResolutionMalformedPayload. */
export const isAssetResolutionMalformedPayload = Schema.is(AssetResolutionMalformedPayload)

/** Upstream fetch or provider failure. */
export class AssetResolutionUpstreamFailure extends Schema.TaggedError<AssetResolutionUpstreamFailure>()(
  "upstream_failure",
  {
    source: AssetResolutionEvidenceSource,
  }
) {}

/** Type guard for AssetResolutionUpstreamFailure. */
export const isAssetResolutionUpstreamFailure = Schema.is(AssetResolutionUpstreamFailure)

/** Reason a well-formed claim set stays pending instead of attaching. */
export const PendingResolutionReason = Schema.Literals([
  "missing_existing_economic_asset",
  "non_exact_platform_match",
]).annotate({
  identifier: "PendingResolutionReason",
  title: "Pending Resolution Reason",
  description: "Why attach-only policy did not attach a representation",
})

/** The PendingResolutionReason type. */
export type PendingResolutionReason = typeof PendingResolutionReason.Type

/** Reason attach-only policy failed closed. */
export const FailClosedResolutionReason = Schema.Literals([
  "ambiguous_economic_asset",
  "incompatible_decimals",
  "incompatible_type",
  "malformed_payload",
  "ownership_conflict",
  "upstream_failure",
]).annotate({
  identifier: "FailClosedResolutionReason",
  title: "Fail Closed Resolution Reason",
  description: "Why attach-only policy failed closed",
})

/** The FailClosedResolutionReason type. */
export type FailClosedResolutionReason = typeof FailClosedResolutionReason.Type

const PolicyRevision = Schema.Literal(ATTACH_ONLY_RESOLUTION_POLICY_REVISION)

/** Attach a new exact representation to an existing economic asset. */
export class AttachRepresentationDecision extends Schema.TaggedClass<AttachRepresentationDecision>()(
  "attach",
  {
    policyRevision: PolicyRevision,
    assetKey: NonEmptyString,
    blockchain: NonEmptyString,
    type: RepresentationType,
    contractAddress: Schema.NullOr(NonEmptyString),
    mintAddress: Schema.NullOr(NonEmptyString),
    decimals: AssetDecimals,
  }
) {}

/** Type guard for AttachRepresentationDecision. */
export const isAttachRepresentationDecision = Schema.is(AttachRepresentationDecision)

/** Evidence is well-formed but not enough to attach. */
export class PendingResolutionDecision extends Schema.TaggedClass<PendingResolutionDecision>()(
  "pending",
  {
    policyRevision: PolicyRevision,
    reason: PendingResolutionReason,
  }
) {}

/** Type guard for PendingResolutionDecision. */
export const isPendingResolutionDecision = Schema.is(PendingResolutionDecision)

/** Evidence is unsafe or unusable; do not attach. */
export class FailClosedResolutionDecision extends Schema.TaggedClass<FailClosedResolutionDecision>()(
  "fail_closed",
  {
    policyRevision: PolicyRevision,
    reason: FailClosedResolutionReason,
  }
) {}

/** Type guard for FailClosedResolutionDecision. */
export const isFailClosedResolutionDecision = Schema.is(FailClosedResolutionDecision)

/** Attach-only policy outcome. */
export type AssetResolutionDecision =
  | AttachRepresentationDecision
  | FailClosedResolutionDecision
  | PendingResolutionDecision

/** Schema for attach-only policy outcomes. */
export const AssetResolutionDecisionSchema = Schema.Union([
  AttachRepresentationDecision,
  PendingResolutionDecision,
  FailClosedResolutionDecision,
]).annotate({
  identifier: "AssetResolutionDecision",
  title: "Asset Resolution Decision",
  description: "Attach, pending, or fail-closed outcome at the attach-only policy boundary",
})

/** Type guard for AssetResolutionDecision. */
export const isAssetResolutionDecision = Schema.is(AssetResolutionDecisionSchema)

/** Existing economic asset that CoinGecko may attach a representation to. */
export interface AssetResolutionEconomicAsset {
  readonly assetKey: string
  readonly coingeckoCoinId: string
  readonly type: EconomicAssetType
}

/** Exact representation already owned by an economic asset. */
export interface AssetResolutionOwnedRepresentation {
  readonly assetKey: string
  readonly blockchain: string
  readonly type: RepresentationType
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly decimals: number
}

/** Local identity snapshot consulted by attach-only policy. */
export interface AssetResolutionIdentitySnapshot {
  readonly economicAssets: ReadonlyArray<AssetResolutionEconomicAsset>
  readonly representations: ReadonlyArray<AssetResolutionOwnedRepresentation>
}

/** Chain input at the policy boundary. */
export type ChainResolutionInput =
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure
  | ChainClaim

/** CoinGecko input at the policy boundary. */
export type CoinGeckoResolutionInput =
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure
  | CoinGeckoClaim

/** Provider evidence before decoding. */
export type AssetResolutionProviderEvidence =
  | { readonly _tag: "payload"; readonly payload: unknown }
  | AssetResolutionUpstreamFailure

const isEvmAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address)

const canonicalizeAddress = (address: string | null): string | null => {
  if (address === null) {
    return null
  }

  return isEvmAddress(address) ? address.toLowerCase() : address
}

const emptyToNull = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const addressesMatch = (left: string | null, right: string | null): boolean =>
  canonicalizeAddress(left) === canonicalizeAddress(right)

const exactRepresentationKey = ({
  blockchain,
  type,
  contractAddress,
  mintAddress,
}: {
  readonly blockchain: string
  readonly type: RepresentationType
  readonly contractAddress: string | null
  readonly mintAddress: string | null
}): string => {
  const chain = blockchain.toLowerCase()
  if (type === "native") {
    return `${chain}:native`
  }

  const contract = canonicalizeAddress(contractAddress)
  if (contract !== null) {
    return `${chain}:contract:${contract}`
  }

  const mint = canonicalizeAddress(mintAddress)
  return `${chain}:mint:${mint ?? ""}`
}

const chainAddress = (claim: ChainClaim): string | null =>
  claim.contractAddress ?? claim.mintAddress

const toChainClaim = (fact: ChainFactPayload): ChainClaim =>
  ChainClaim.make({
    blockchain: fact.blockchain,
    type: fact.type,
    contractAddress: canonicalizeAddress(fact.contractAddress),
    mintAddress: canonicalizeAddress(fact.mintAddress),
    decimals: fact.decimals,
  })

const toCoinGeckoClaim = (
  payload: CoinGeckoCoinPayload
): Effect.Effect<CoinGeckoClaim, AssetResolutionMalformedPayload> => {
  const platformIds = new Set([
    ...Object.keys(payload.platforms),
    ...Object.keys(payload.detail_platforms),
  ])
  const platforms: Array<CoinGeckoPlatformMapping> = []

  for (const platformId of platformIds) {
    const trimmedPlatformId = platformId.trim()
    if (trimmedPlatformId === "") {
      continue
    }

    const rawPlatformAddress = payload.platforms[platformId]
    const detail = payload.detail_platforms[platformId]
    const platformAddress =
      rawPlatformAddress === undefined ? undefined : emptyToNull(rawPlatformAddress)
    const detailAddress = detail === undefined ? undefined : emptyToNull(detail.contract_address)

    if (platformAddress !== undefined && detailAddress !== undefined) {
      if (!addressesMatch(platformAddress, detailAddress)) {
        return Effect.fail(new AssetResolutionMalformedPayload({ source: "coingecko" }))
      }
    }

    const contractAddress = detailAddress ?? platformAddress ?? null
    platforms.push(
      CoinGeckoPlatformMapping.make({
        platformId: trimmedPlatformId,
        contractAddress: canonicalizeAddress(contractAddress),
        decimals: detail?.decimal_place ?? null,
      })
    )
  }

  return Effect.succeed(
    CoinGeckoClaim.make({
      coinId: payload.id,
      name: payload.name,
      symbol: payload.symbol,
      platforms,
    })
  )
}

/**
 * Decode unknown chain facts into a typed chain claim.
 */
export const decodeChainClaim = (
  payload: unknown
): Effect.Effect<ChainClaim, AssetResolutionMalformedPayload> =>
  Schema.decodeUnknownEffect(ChainFactPayload)(payload).pipe(
    Effect.map(toChainClaim),
    Effect.mapError(() => new AssetResolutionMalformedPayload({ source: "chain" }))
  )

/**
 * Decode an unknown CoinGecko coin response into a typed CoinGecko claim.
 */
export const decodeCoinGeckoClaim = (
  payload: unknown
): Effect.Effect<CoinGeckoClaim, AssetResolutionMalformedPayload> =>
  Schema.decodeUnknownEffect(CoinGeckoCoinPayload)(payload).pipe(
    Effect.mapError(() => new AssetResolutionMalformedPayload({ source: "coingecko" })),
    Effect.flatMap(toCoinGeckoClaim)
  )

const pending = (reason: PendingResolutionReason): PendingResolutionDecision =>
  PendingResolutionDecision.make({
    policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
    reason,
  })

const failClosed = (reason: FailClosedResolutionReason): FailClosedResolutionDecision =>
  FailClosedResolutionDecision.make({
    policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
    reason,
  })

const evidenceFailureReason = (
  evidence: AssetResolutionMalformedPayload | AssetResolutionUpstreamFailure
): FailClosedResolutionReason =>
  evidence._tag === "upstream_failure" ? "upstream_failure" : "malformed_payload"

const findMatchingPlatform = ({
  chain,
  coinGecko,
}: {
  readonly chain: ChainClaim
  readonly coinGecko: CoinGeckoClaim
}): CoinGeckoPlatformMapping | undefined =>
  coinGecko.platforms.find(
    (platform) =>
      platform.platformId.toLowerCase() === chain.blockchain.toLowerCase() &&
      addressesMatch(platform.contractAddress, chainAddress(chain))
  )

const typesAreCompatible = ({
  asset,
  chain,
  platform,
}: {
  readonly asset: AssetResolutionEconomicAsset
  readonly chain: ChainClaim
  readonly platform: CoinGeckoPlatformMapping
}): boolean => {
  const platformLooksNative = platform.contractAddress === null
  if ((chain.type === "native") !== platformLooksNative) {
    return false
  }

  if (chain.type === "nft") {
    return asset.type === "nft"
  }

  return asset.type === "fungible"
}

/**
 * Decide attach, pending, or fail-closed from typed claims or evidence failures.
 *
 * CoinGecko may support representation ownership only when its stable identity
 * already belongs to an existing economic asset, the platform chain and address
 * match the chain claim exactly, type and decimals are compatible, and no other
 * asset owns the representation.
 */
export const decideAttachOnlyResolution = ({
  chain,
  coinGecko,
  identity,
}: {
  readonly chain: ChainResolutionInput
  readonly coinGecko: CoinGeckoResolutionInput
  readonly identity: AssetResolutionIdentitySnapshot
}): AssetResolutionDecision => {
  if (chain._tag !== "chain_claim") {
    return failClosed(evidenceFailureReason(chain))
  }

  if (coinGecko._tag !== "coingecko_claim") {
    return failClosed(evidenceFailureReason(coinGecko))
  }

  const matchingAssets = identity.economicAssets.filter(
    (asset) => asset.coingeckoCoinId === coinGecko.coinId
  )
  if (matchingAssets.length > 1) {
    return failClosed("ambiguous_economic_asset")
  }

  const [asset] = matchingAssets
  if (asset === undefined) {
    return pending("missing_existing_economic_asset")
  }

  const platform = findMatchingPlatform({ chain, coinGecko })
  if (platform === undefined) {
    return pending("non_exact_platform_match")
  }

  if (!typesAreCompatible({ asset, chain, platform })) {
    return failClosed("incompatible_type")
  }

  if (platform.decimals === null) {
    return pending("non_exact_platform_match")
  }
  if (platform.decimals !== chain.decimals) {
    return failClosed("incompatible_decimals")
  }

  const representationKey = exactRepresentationKey(chain)
  const owned = identity.representations.find(
    (representation) => exactRepresentationKey(representation) === representationKey
  )
  if (owned !== undefined && owned.assetKey !== asset.assetKey) {
    return failClosed("ownership_conflict")
  }
  if (owned !== undefined && owned.decimals !== chain.decimals) {
    return failClosed("incompatible_decimals")
  }

  return AttachRepresentationDecision.make({
    policyRevision: ATTACH_ONLY_RESOLUTION_POLICY_REVISION,
    assetKey: asset.assetKey,
    blockchain: chain.blockchain.toLowerCase(),
    type: chain.type,
    contractAddress: chain.contractAddress,
    mintAddress: chain.mintAddress,
    decimals: chain.decimals,
  })
}

const decodeChainEvidence = (
  evidence: AssetResolutionProviderEvidence
): Effect.Effect<ChainResolutionInput> => {
  if (evidence._tag === "upstream_failure") {
    return Effect.succeed(evidence)
  }

  return Effect.result(decodeChainClaim(evidence.payload)).pipe(
    Effect.map((result) => (result._tag === "Success" ? result.success : result.failure))
  )
}

const decodeCoinGeckoEvidence = (
  evidence: AssetResolutionProviderEvidence
): Effect.Effect<CoinGeckoResolutionInput> => {
  if (evidence._tag === "upstream_failure") {
    return Effect.succeed(evidence)
  }

  return Effect.result(decodeCoinGeckoClaim(evidence.payload)).pipe(
    Effect.map((result) => (result._tag === "Success" ? result.success : result.failure))
  )
}

/**
 * Decode provider evidence and decide at the attach-only policy boundary.
 *
 * Malformed or changed payloads and upstream failures fail closed and never
 * produce an attach decision.
 */
export const evaluateAttachOnlyResolution = ({
  chain,
  coinGecko,
  identity,
}: {
  readonly chain: AssetResolutionProviderEvidence
  readonly coinGecko: AssetResolutionProviderEvidence
  readonly identity: AssetResolutionIdentitySnapshot
}): Effect.Effect<AssetResolutionDecision> =>
  Effect.gen(function* () {
    const chainInput = yield* decodeChainEvidence(chain)
    const coinGeckoInput = yield* decodeCoinGeckoEvidence(coinGecko)
    return decideAttachOnlyResolution({
      chain: chainInput,
      coinGecko: coinGeckoInput,
      identity,
    })
  })
