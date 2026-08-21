/**
 * Automatic asset resolution policy.
 *
 * Decodes exact chain facts and CoinGecko contract-lookup responses into
 * typed claims and decides attach, create-standalone, pending, or
 * fail-closed. CoinGecko may prove representation ownership for an existing
 * economic asset under exact platform, address, type, and decimals checks. A
 * new exact representation with no plausible existing candidate, no
 * ownership conflict, and no authoritative spam evidence may become a
 * standalone economic asset. Names and symbols are display data: they can
 * block automatic creation by raising a possible duplicate, but they never
 * prove a merge or separation.
 *
 * @module assets/AssetResolutionPolicy
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Policy revision recorded with every automatic resolution decision. */
export const ASSET_RESOLUTION_POLICY_REVISION = "2026-08-21.standalone-create.1"

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

/**
 * Representation types the policy may turn into a standalone economic asset.
 * Fungible tokens only for now: native assets ship as reference data, and
 * NFTs wait for spam evidence and an NFT accounting story. Adding a type
 * here (for example EVM contracts arrive as "token" too) is a policy
 * revision, not a restructure.
 */
export const STANDALONE_CREATION_SUPPORTED_TYPES: ReadonlyArray<RepresentationType> = ["token"]

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
  description: "CoinGecko coin response used as resolution evidence",
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

/** Typed CoinGecko claim. Ownership may be proved only under exact checks. */
export class CoinGeckoClaim extends Schema.TaggedClass<CoinGeckoClaim>()("coingecko_claim", {
  coinId: NonEmptyString,
  name: Schema.String,
  symbol: Schema.String,
  platforms: Schema.Array(CoinGeckoPlatformMapping),
}) {}

/** Type guard for CoinGeckoClaim. */
export const isCoinGeckoClaim = Schema.is(CoinGeckoClaim)

/**
 * Definitive registry answer that no coin exists for the looked-up
 * representation. Unlike an upstream failure, this is evidence: the registry
 * was reached and does not know the asset.
 */
export class CoinGeckoLookupNotFound extends Schema.TaggedClass<CoinGeckoLookupNotFound>()(
  "registry_not_found",
  {}
) {}

/** Type guard for CoinGeckoLookupNotFound. */
export const isCoinGeckoLookupNotFound = Schema.is(CoinGeckoLookupNotFound)

/**
 * Typed legitimacy or spam claim from an allowlisted authority such as
 * Jupiter. Only an explicit `banned` verdict is authoritative spam evidence;
 * `unverified` or `suspicious` alone never blocks a legitimate asset.
 */
export class AssetLegitimacyClaim extends Schema.TaggedClass<AssetLegitimacyClaim>()(
  "legitimacy_claim",
  {
    authority: NonEmptyString,
    verdict: Schema.Literals(["verified", "unverified", "suspicious", "banned"]),
  }
) {}

/** Type guard for AssetLegitimacyClaim. */
export const isAssetLegitimacyClaim = Schema.is(AssetLegitimacyClaim)

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

/** Stored evidence records that contradict each other. */
export class AssetResolutionConflictingEvidence extends Schema.TaggedError<AssetResolutionConflictingEvidence>()(
  "conflicting_evidence",
  {
    source: AssetResolutionEvidenceSource,
  }
) {}

/** Type guard for AssetResolutionConflictingEvidence. */
export const isAssetResolutionConflictingEvidence = Schema.is(AssetResolutionConflictingEvidence)

/** Reason a well-formed claim set stays pending instead of resolving. */
export const PendingResolutionReason = Schema.Literals([
  "display_collision",
  "non_exact_platform_match",
  "spam_evidence",
  "unsupported_representation_type",
]).annotate({
  identifier: "PendingResolutionReason",
  title: "Pending Resolution Reason",
  description: "Why the policy neither attached nor created",
})

/** The PendingResolutionReason type. */
export type PendingResolutionReason = typeof PendingResolutionReason.Type

/** Reason the policy failed closed. */
export const FailClosedResolutionReason = Schema.Literals([
  "conflicting_evidence",
  "incompatible_decimals",
  "incompatible_type",
  "malformed_payload",
  "ownership_conflict",
  "upstream_failure",
]).annotate({
  identifier: "FailClosedResolutionReason",
  title: "Fail Closed Resolution Reason",
  description: "Why the policy failed closed",
})

/** The FailClosedResolutionReason type. */
export type FailClosedResolutionReason = typeof FailClosedResolutionReason.Type

const PolicyRevision = Schema.Literal(ASSET_RESOLUTION_POLICY_REVISION)

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

/**
 * Create a standalone economic asset owning one new exact representation.
 * The display name and symbol are untrusted display data carried from the
 * evidence the decision links to; identity is the representation and, when
 * present, the stamped CoinGecko coin id.
 */
export class CreateStandaloneAssetDecision extends Schema.TaggedClass<CreateStandaloneAssetDecision>()(
  "create_standalone",
  {
    policyRevision: PolicyRevision,
    blockchain: NonEmptyString,
    type: RepresentationType,
    contractAddress: Schema.NullOr(NonEmptyString),
    mintAddress: Schema.NullOr(NonEmptyString),
    decimals: AssetDecimals,
    coingeckoCoinId: Schema.NullOr(NonEmptyString),
    name: NonEmptyString,
    symbol: NonEmptyString,
  }
) {}

/** Type guard for CreateStandaloneAssetDecision. */
export const isCreateStandaloneAssetDecision = Schema.is(CreateStandaloneAssetDecision)

/** Evidence is well-formed but not enough to attach or create. */
export class PendingResolutionDecision extends Schema.TaggedClass<PendingResolutionDecision>()(
  "pending",
  {
    policyRevision: PolicyRevision,
    reason: PendingResolutionReason,
  }
) {}

/** Type guard for PendingResolutionDecision. */
export const isPendingResolutionDecision = Schema.is(PendingResolutionDecision)

/** Evidence is unsafe or unusable; do not attach or create. */
export class FailClosedResolutionDecision extends Schema.TaggedClass<FailClosedResolutionDecision>()(
  "fail_closed",
  {
    policyRevision: PolicyRevision,
    reason: FailClosedResolutionReason,
  }
) {}

/** Type guard for FailClosedResolutionDecision. */
export const isFailClosedResolutionDecision = Schema.is(FailClosedResolutionDecision)

/** Automatic resolution policy outcome. */
export type AssetResolutionDecision =
  | AttachRepresentationDecision
  | CreateStandaloneAssetDecision
  | FailClosedResolutionDecision
  | PendingResolutionDecision

/** Schema for automatic resolution policy outcomes. */
export const AssetResolutionDecisionSchema = Schema.Union([
  AttachRepresentationDecision,
  CreateStandaloneAssetDecision,
  PendingResolutionDecision,
  FailClosedResolutionDecision,
]).annotate({
  identifier: "AssetResolutionDecision",
  title: "Asset Resolution Decision",
  description: "Attach, create-standalone, pending, or fail-closed policy outcome",
})

/** Type guard for AssetResolutionDecision. */
export const isAssetResolutionDecision = Schema.is(AssetResolutionDecisionSchema)

/** Existing economic asset that owns the looked-up CoinGecko coin id. */
export interface AssetResolutionEconomicAsset {
  readonly assetKey: string
  readonly coingeckoCoinId: string
  readonly type: EconomicAssetType
}

/**
 * Existing economic asset whose display name or symbol matches the
 * observation. Display matches can raise a possible duplicate but never
 * prove one.
 */
export interface AssetResolutionDisplayCandidate {
  readonly assetKey: string
  readonly coingeckoCoinId: string | null
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

/** Local identity snapshot consulted by the resolution policy. */
export interface AssetResolutionIdentitySnapshot {
  /** Local asset owning the coin id the registry lookup returned, if any. */
  readonly registryOwner: AssetResolutionEconomicAsset | null
  /** Local assets whose display name or symbol matches the observation. */
  readonly displayCandidates: ReadonlyArray<AssetResolutionDisplayCandidate>
  /** Exact representations already owned locally for this identity. */
  readonly representations: ReadonlyArray<AssetResolutionOwnedRepresentation>
}

/** Untrusted provider display metadata used to name a standalone asset. */
export interface ProviderDisplayMetadata {
  readonly name: string | null
  readonly symbol: string
}

/** Chain input at the policy boundary. */
export type ChainResolutionInput =
  | AssetResolutionConflictingEvidence
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure
  | ChainClaim

/** Registry contract-lookup input at the policy boundary. */
export type RegistryResolutionInput =
  | AssetResolutionConflictingEvidence
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure
  | CoinGeckoClaim
  | CoinGeckoLookupNotFound

/** Provider evidence before decoding. */
export type AssetResolutionProviderEvidence =
  | { readonly _tag: "payload"; readonly payload: unknown }
  | AssetResolutionConflictingEvidence
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure

/** Registry lookup evidence before decoding: a payload, a definitive miss, or a failure. */
export type AssetResolutionRegistryEvidence =
  | AssetResolutionProviderEvidence
  | CoinGeckoLookupNotFound

const isEvmAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address)

/**
 * Canonical address form used everywhere resolution compares identities:
 * EVM-shaped addresses are case-insensitive and lowercase; every other
 * address keeps its case because it is significant on its chain.
 */
export const canonicalizeAddress = (address: string | null): string | null => {
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

/**
 * Canonical form used everywhere resolution compares display names and
 * symbols: unicode-normalized (NFKC) and case-folded, so trivial lookalikes
 * collide instead of slipping past the duplicate brake.
 */
export const canonicalizeDisplayText = (value: string): string =>
  value.normalize("NFKC").toLowerCase().trim()

/**
 * Canonical identity key of one network representation, or null when a
 * non-native shape carries no address and therefore has no identity to
 * compare. Null never matches anything, so malformed rows cannot collide.
 */
export const exactRepresentationKey = ({
  blockchain,
  type,
  contractAddress,
  mintAddress,
}: {
  readonly blockchain: string
  readonly type: RepresentationType
  readonly contractAddress: string | null
  readonly mintAddress: string | null
}): string | null => {
  const chain = blockchain.toLowerCase()
  if (type === "native") {
    return `${chain}:native`
  }

  const contract = canonicalizeAddress(contractAddress)
  if (contract !== null) {
    return `${chain}:contract:${contract}`
  }

  const mint = canonicalizeAddress(mintAddress)
  return mint === null ? null : `${chain}:mint:${mint}`
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
    policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
    reason,
  })

const failClosed = (reason: FailClosedResolutionReason): FailClosedResolutionDecision =>
  FailClosedResolutionDecision.make({
    policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
    reason,
  })

const evidenceFailureReason = (
  evidence:
    | AssetResolutionConflictingEvidence
    | AssetResolutionMalformedPayload
    | AssetResolutionUpstreamFailure
): FailClosedResolutionReason => evidence._tag

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
}: {
  readonly asset: { readonly type: EconomicAssetType }
  readonly chain: ChainClaim
}): boolean => (chain.type === "nft" ? asset.type === "nft" : asset.type === "fungible")

const attach = ({
  assetKey,
  chain,
}: {
  readonly assetKey: string
  readonly chain: ChainClaim
}): AttachRepresentationDecision =>
  AttachRepresentationDecision.make({
    policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
    assetKey,
    blockchain: chain.blockchain.toLowerCase(),
    type: chain.type,
    contractAddress: chain.contractAddress,
    mintAddress: chain.mintAddress,
    decimals: chain.decimals,
  })

const decideForOwnedRepresentation = ({
  owned,
  chain,
  registry,
  identity,
}: {
  readonly owned: AssetResolutionOwnedRepresentation
  readonly chain: ChainClaim
  readonly registry: RegistryResolutionInput
  readonly identity: AssetResolutionIdentitySnapshot
}): AssetResolutionDecision => {
  if (owned.type !== chain.type) {
    return failClosed("incompatible_type")
  }
  if (owned.decimals !== chain.decimals) {
    return failClosed("incompatible_decimals")
  }
  if (
    registry._tag === "coingecko_claim" &&
    identity.registryOwner !== null &&
    identity.registryOwner.assetKey !== owned.assetKey
  ) {
    return failClosed("ownership_conflict")
  }

  return attach({ assetKey: owned.assetKey, chain })
}

const decideStandaloneCreation = ({
  chain,
  coinGecko,
  legitimacy,
  identity,
  providerDisplay,
}: {
  readonly chain: ChainClaim
  readonly coinGecko: CoinGeckoClaim | null
  readonly legitimacy: ReadonlyArray<AssetLegitimacyClaim>
  readonly identity: AssetResolutionIdentitySnapshot
  readonly providerDisplay: ProviderDisplayMetadata
}): AssetResolutionDecision => {
  if (legitimacy.some((claim) => claim.verdict === "banned")) {
    return pending("spam_evidence")
  }
  if (!STANDALONE_CREATION_SUPPORTED_TYPES.includes(chain.type)) {
    return pending("unsupported_representation_type")
  }
  if (identity.displayCandidates.length > 0) {
    return pending("display_collision")
  }

  const symbol =
    (coinGecko === null ? null : emptyToNull(coinGecko.symbol)) ??
    emptyToNull(providerDisplay.symbol)
  const name =
    (coinGecko === null ? null : emptyToNull(coinGecko.name)) ??
    (providerDisplay.name === null ? null : emptyToNull(providerDisplay.name)) ??
    symbol
  if (symbol === null || name === null) {
    return failClosed("malformed_payload")
  }

  return CreateStandaloneAssetDecision.make({
    policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
    blockchain: chain.blockchain.toLowerCase(),
    type: chain.type,
    contractAddress: chain.contractAddress,
    mintAddress: chain.mintAddress,
    decimals: chain.decimals,
    coingeckoCoinId: coinGecko === null ? null : coinGecko.coinId,
    name,
    symbol,
  })
}

/**
 * Decide attach, create-standalone, pending, or fail-closed from typed
 * claims or evidence failures.
 *
 * Deterministic evidence decides: an exact representation already owned
 * locally attaches to its owner, and a registry contract lookup whose coin
 * id belongs to a local asset attaches under exact platform, address, type,
 * and decimals checks. Display metadata only blocks: a name or symbol match
 * without authoritative linkage stays pending as a possible duplicate. An
 * exact, supported, collision-free representation with no authoritative spam
 * evidence becomes a standalone economic asset.
 */
export const decideAssetResolution = ({
  chain,
  registry,
  identity,
  legitimacy,
  providerDisplay,
}: {
  readonly chain: ChainResolutionInput
  readonly registry: RegistryResolutionInput
  readonly identity: AssetResolutionIdentitySnapshot
  readonly legitimacy: ReadonlyArray<AssetLegitimacyClaim>
  readonly providerDisplay: ProviderDisplayMetadata
}): AssetResolutionDecision => {
  if (chain._tag !== "chain_claim") {
    return failClosed(evidenceFailureReason(chain))
  }

  const representationKey = exactRepresentationKey(chain)
  const owned = identity.representations.find((representation) => {
    const ownedKey = exactRepresentationKey(representation)
    return ownedKey !== null && ownedKey === representationKey
  })
  if (owned !== undefined) {
    return decideForOwnedRepresentation({ owned, chain, registry, identity })
  }

  if (registry._tag !== "coingecko_claim" && registry._tag !== "registry_not_found") {
    return failClosed(evidenceFailureReason(registry))
  }

  if (registry._tag === "coingecko_claim") {
    const platform = findMatchingPlatform({ chain, coinGecko: registry })
    if (platform === undefined) {
      // The registry answered a lookup for this exact representation with a
      // coin that does not list it. That is contradictory evidence, not a
      // safe basis to attach or create.
      return failClosed("conflicting_evidence")
    }

    const registryOwner = identity.registryOwner
    if (registryOwner !== null && registryOwner.coingeckoCoinId === registry.coinId) {
      if (!typesAreCompatible({ asset: registryOwner, chain })) {
        return failClosed("incompatible_type")
      }
      if (platform.decimals === null) {
        return pending("non_exact_platform_match")
      }
      if (platform.decimals !== chain.decimals) {
        return failClosed("incompatible_decimals")
      }

      return attach({ assetKey: registryOwner.assetKey, chain })
    }

    // No local asset owns the coin id. Registry decimals must not contradict
    // the chain, but their absence is missing data, not a conflict.
    if (platform.decimals !== null && platform.decimals !== chain.decimals) {
      return failClosed("incompatible_decimals")
    }
  }

  return decideStandaloneCreation({
    chain,
    coinGecko: registry._tag === "coingecko_claim" ? registry : null,
    legitimacy,
    identity,
    providerDisplay,
  })
}

const decodeChainEvidence = (
  evidence: AssetResolutionProviderEvidence
): Effect.Effect<ChainResolutionInput> => {
  if (evidence._tag !== "payload") {
    return Effect.succeed(evidence)
  }

  return Effect.result(decodeChainClaim(evidence.payload)).pipe(
    Effect.map((result) => (result._tag === "Success" ? result.success : result.failure))
  )
}

const decodeRegistryEvidence = (
  evidence: AssetResolutionRegistryEvidence
): Effect.Effect<RegistryResolutionInput> => {
  if (evidence._tag !== "payload") {
    return Effect.succeed(evidence)
  }

  return Effect.result(decodeCoinGeckoClaim(evidence.payload)).pipe(
    Effect.map((result) => (result._tag === "Success" ? result.success : result.failure))
  )
}

/**
 * Decode provider evidence and decide at the resolution policy boundary.
 *
 * Malformed or changed payloads and upstream failures fail closed and never
 * produce an attach or create decision.
 */
export const evaluateAssetResolution = ({
  chain,
  registry,
  identity,
  legitimacy,
  providerDisplay,
}: {
  readonly chain: AssetResolutionProviderEvidence
  readonly registry: AssetResolutionRegistryEvidence
  readonly identity: AssetResolutionIdentitySnapshot
  readonly legitimacy: ReadonlyArray<AssetLegitimacyClaim>
  readonly providerDisplay: ProviderDisplayMetadata
}): Effect.Effect<AssetResolutionDecision> =>
  Effect.gen(function* () {
    const chainInput = yield* decodeChainEvidence(chain)
    const registryInput = yield* decodeRegistryEvidence(registry)
    return decideAssetResolution({
      chain: chainInput,
      registry: registryInput,
      identity,
      legitimacy,
      providerDisplay,
    })
  })
