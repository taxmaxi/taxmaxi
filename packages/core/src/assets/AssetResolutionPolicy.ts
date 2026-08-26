/**
 * Automatic asset resolution policy.
 *
 * Decodes exact chain facts, CoinGecko contract-lookup responses, and
 * Jupiter legitimacy responses into typed claims and decides attach,
 * create-standalone, excluded, pending, or fail-closed. CoinGecko may prove
 * representation ownership for an existing economic asset under exact
 * platform, address, type, and decimals checks. A new exact representation
 * with no plausible existing candidate and no ownership conflict may become
 * a standalone economic asset only when a registry vouches for it: a
 * CoinGecko coin that lists the exact representation, or a verified verdict
 * from an allowlisted authority. The absence of spam evidence alone never
 * creates; an unvouched token stays pending for human review. An
 * explicit banned verdict from an allowlisted authority excludes the
 * observation unless exact attach evidence contradicts it, in which case the
 * conflict fails closed for human review. Names and symbols are display
 * data: they can block automatic creation by raising a possible duplicate,
 * but they never prove a merge or separation.
 *
 * @module assets/AssetResolutionPolicy
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Policy revision recorded with every automatic resolution decision. */
export const ASSET_RESOLUTION_POLICY_REVISION = "2026-08-26.standalone-positive-signal.1"

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
export class RegistryLookupNotFound extends Schema.TaggedClass<RegistryLookupNotFound>()(
  "registry_not_found",
  {}
) {}

/** Type guard for RegistryLookupNotFound. */
export const isRegistryLookupNotFound = Schema.is(RegistryLookupNotFound)

/**
 * No registry lookup was performed because the observation carries nothing
 * to look up, such as a native representation with no address. Unlike
 * RegistryLookupNotFound this says nothing about what the registry knows.
 */
export class RegistryLookupSkipped extends Schema.TaggedClass<RegistryLookupSkipped>()(
  "registry_not_queried",
  {}
) {}

/** Type guard for RegistryLookupSkipped. */
export const isRegistryLookupSkipped = Schema.is(RegistryLookupSkipped)

/**
 * Typed legitimacy or spam claim from an allowlisted authority such as
 * Jupiter. Only an explicit `banned` verdict is authoritative spam evidence;
 * `unverified`, `suspicious`, or `low_activity` alone stays non-final.
 */
export class AssetLegitimacyClaim extends Schema.TaggedClass<AssetLegitimacyClaim>()(
  "legitimacy_claim",
  {
    authority: NonEmptyString,
    verdict: Schema.Literals(["verified", "unverified", "suspicious", "low_activity", "banned"]),
  }
) {}

/** Type guard for AssetLegitimacyClaim. */
export const isAssetLegitimacyClaim = Schema.is(AssetLegitimacyClaim)

/** Authority string recorded on Jupiter legitimacy claims and evidence. */
export const JUPITER_AUTHORITY = "jupiter"

const JupiterAudit = Schema.Struct({
  isSus: Schema.optional(Schema.NullOr(Schema.Boolean)),
})

/**
 * One Jupiter token search result. Only the fields the legitimacy verdict
 * reads are decoded; the full raw payload stays in evidence storage. The
 * banned state has no dedicated field upstream: it arrives as a `banned`
 * entry in `tags`.
 */
export const JupiterTokenPayload = Schema.Struct({
  id: NonEmptyString,
  isVerified: Schema.optional(Schema.NullOr(Schema.Boolean)),
  organicScoreLabel: Schema.optional(Schema.NullOr(Schema.Literals(["high", "medium", "low"]))),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  audit: Schema.optional(Schema.NullOr(JupiterAudit)),
}).annotate({
  identifier: "JupiterTokenPayload",
  title: "Jupiter Token Payload",
  description: "Jupiter token search result used as legitimacy evidence",
})

/** The JupiterTokenPayload type. */
export type JupiterTokenPayload = typeof JupiterTokenPayload.Type

/** Jupiter token search response: an array of token results. */
export const JupiterTokenSearchPayload = Schema.Array(JupiterTokenPayload).annotate({
  identifier: "JupiterTokenSearchPayload",
  title: "Jupiter Token Search Payload",
  description: "Jupiter token search response used as legitimacy evidence",
})

/** The JupiterTokenSearchPayload type. */
export type JupiterTokenSearchPayload = typeof JupiterTokenSearchPayload.Type

const jupiterVerdict = (
  token: JupiterTokenPayload
): "verified" | "unverified" | "suspicious" | "low_activity" | "banned" => {
  if ((token.tags ?? []).includes("banned")) {
    return "banned"
  }
  if (token.audit?.isSus === true) {
    return "suspicious"
  }
  if (token.organicScoreLabel === "low") {
    return "low_activity"
  }
  if (token.isVerified === true) {
    return "verified"
  }

  return "unverified"
}

/**
 * Decode an unknown Jupiter token search response into a typed legitimacy
 * claim for one exact mint. A response that does not contain the mint is a
 * definitive not-indexed answer, not a verdict; it says nothing about the
 * asset's legitimacy.
 */
export const decodeJupiterLegitimacyClaim = ({
  payload,
  mintAddress,
}: {
  readonly payload: unknown
  readonly mintAddress: string
}): Effect.Effect<AssetLegitimacyClaim | RegistryLookupNotFound, AssetResolutionMalformedPayload> =>
  Schema.decodeUnknownEffect(JupiterTokenSearchPayload)(payload).pipe(
    Effect.mapError(() => new AssetResolutionMalformedPayload({ source: "jupiter" })),
    Effect.map((tokens) => {
      const token = tokens.find((candidate) => candidate.id === mintAddress)
      if (token === undefined) {
        return new RegistryLookupNotFound()
      }

      return AssetLegitimacyClaim.make({
        authority: JUPITER_AUTHORITY,
        verdict: jupiterVerdict(token),
      })
    })
  )

/** Evidence source whose payload could not be decoded or fetched. */
export const AssetResolutionEvidenceSource = Schema.Literals([
  "chain",
  "coingecko",
  "jupiter",
]).annotate({
  identifier: "AssetResolutionEvidenceSource",
  title: "Asset Resolution Evidence Source",
  description: "Chain facts, CoinGecko, or Jupiter response that failed closed",
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
  "unverified_asset",
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

/**
 * Reason an observation is excluded from derived accounting. Exclusion is a
 * final answer with evidence behind it, not an unresolved identity: the
 * observation's transactions stay stored and visible but never enter
 * derived accounting, and the calculation is complete without them.
 */
export const ObservationExclusionReason = Schema.Literals(["authority_banned"]).annotate({
  identifier: "ObservationExclusionReason",
  title: "Observation Exclusion Reason",
  description: "Why the policy excluded the observation from derived accounting",
})

/** The ObservationExclusionReason type. */
export type ObservationExclusionReason = typeof ObservationExclusionReason.Type

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

/**
 * Exclude the observation from derived accounting with a final typed
 * reason. Only an explicit banned verdict from an allowlisted authority
 * produces this; weaker signals never do. Reversal requires a
 * human-approved superseding decision, never new registry evidence alone.
 */
export class ExcludeObservationDecision extends Schema.TaggedClass<ExcludeObservationDecision>()(
  "excluded",
  {
    policyRevision: PolicyRevision,
    reason: ObservationExclusionReason,
  }
) {}

/** Type guard for ExcludeObservationDecision. */
export const isExcludeObservationDecision = Schema.is(ExcludeObservationDecision)

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
  | ExcludeObservationDecision
  | FailClosedResolutionDecision
  | PendingResolutionDecision

/** Schema for automatic resolution policy outcomes. */
export const AssetResolutionDecisionSchema = Schema.Union([
  AttachRepresentationDecision,
  CreateStandaloneAssetDecision,
  ExcludeObservationDecision,
  PendingResolutionDecision,
  FailClosedResolutionDecision,
]).annotate({
  identifier: "AssetResolutionDecision",
  title: "Asset Resolution Decision",
  description: "Attach, create-standalone, excluded, pending, or fail-closed policy outcome",
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
  | RegistryLookupNotFound
  | RegistryLookupSkipped

/**
 * One legitimacy input at the policy boundary: a typed claim from an
 * allowlisted authority, or the failure that prevented one. A failure fails
 * the decision closed instead of silently deciding without spam evidence,
 * with the same exception registry failures have: a representation whose
 * owner is already settled locally still attaches, because settled local
 * identity outranks a broken external lookup. A decoded banned claim is
 * different — it conflicts with any attach and always fails closed.
 */
export type LegitimacyResolutionInput =
  | AssetLegitimacyClaim
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure

/** Provider evidence before decoding. */
export type AssetResolutionProviderEvidence =
  | { readonly _tag: "payload"; readonly payload: unknown }
  | AssetResolutionConflictingEvidence
  | AssetResolutionMalformedPayload
  | AssetResolutionUpstreamFailure

/** Registry lookup evidence before decoding: a payload, a definitive miss, a skipped lookup, or a failure. */
export type AssetResolutionRegistryEvidence =
  | AssetResolutionProviderEvidence
  | RegistryLookupNotFound
  | RegistryLookupSkipped

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

const excluded = (reason: ObservationExclusionReason): ExcludeObservationDecision =>
  ExcludeObservationDecision.make({
    policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
    reason,
  })

const partitionLegitimacy = (
  legitimacy: ReadonlyArray<LegitimacyResolutionInput>
): {
  readonly claims: ReadonlyArray<AssetLegitimacyClaim>
  readonly failure: AssetResolutionMalformedPayload | AssetResolutionUpstreamFailure | null
} => {
  const claims: Array<AssetLegitimacyClaim> = []
  let failure: AssetResolutionMalformedPayload | AssetResolutionUpstreamFailure | null = null

  for (const input of legitimacy) {
    if (isAssetLegitimacyClaim(input)) {
      claims.push(input)
    } else {
      failure = failure ?? input
    }
  }

  return { claims, failure }
}

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
  // An explicit banned verdict is a final answer, not an open question: the
  // observation is excluded from derived accounting instead of waiting for
  // review. A suspicious signal pauses automatic creation, while unverified
  // and low-activity signals decide nothing.
  if (legitimacy.some((claim) => claim.verdict === "banned")) {
    return excluded("authority_banned")
  }
  if (legitimacy.some((claim) => claim.verdict === "suspicious")) {
    return pending("spam_evidence")
  }
  if (!STANDALONE_CREATION_SUPPORTED_TYPES.includes(chain.type)) {
    return pending("unsupported_representation_type")
  }
  if (identity.displayCandidates.length > 0) {
    return pending("display_collision")
  }

  // Creation needs a registry that vouches for the token: a CoinGecko coin
  // listing this exact representation, or a verified verdict from an
  // allowlisted authority. The absence of spam evidence is not evidence of
  // legitimacy — a mint no registry knows stays pending for human review.
  const hasPositiveSignal =
    coinGecko !== null || legitimacy.some((claim) => claim.verdict === "verified")
  if (!hasPositiveSignal) {
    return pending("unverified_asset")
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
 * Decide attach, create-standalone, excluded, pending, or fail-closed from
 * typed claims or evidence failures.
 *
 * Deterministic evidence decides: an exact representation already owned
 * locally attaches to its owner, and a registry contract lookup whose coin
 * id belongs to a local asset attaches under exact platform, address, type,
 * and decimals checks. An explicit banned verdict excludes the observation
 * when nothing would attach; banned plus exact attach evidence is a real
 * conflict between allowlisted authorities and fails closed for human
 * review. Display metadata only blocks: a name or symbol match without
 * authoritative linkage stays pending as a possible duplicate. An exact,
 * supported, collision-free representation becomes a standalone economic
 * asset only when a registry vouches for it — a CoinGecko coin listing the
 * exact representation, or a verified authority verdict. Without that
 * positive signal the observation stays pending as an unverified asset.
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
  readonly legitimacy: ReadonlyArray<LegitimacyResolutionInput>
  readonly providerDisplay: ProviderDisplayMetadata
}): AssetResolutionDecision => {
  if (chain._tag !== "chain_claim") {
    return failClosed(evidenceFailureReason(chain))
  }

  const { claims: legitimacyClaims, failure: legitimacyFailure } = partitionLegitimacy(legitimacy)
  const hasBannedClaim = legitimacyClaims.some((claim) => claim.verdict === "banned")
  const settleWithBannedClaim = (decision: AssetResolutionDecision): AssetResolutionDecision => {
    if (!hasBannedClaim) {
      return decision
    }
    return decision._tag === "attach"
      ? failClosed("conflicting_evidence")
      : excluded("authority_banned")
  }

  const representationKey = exactRepresentationKey(chain)
  const owned = identity.representations.find((representation) => {
    const ownedKey = exactRepresentationKey(representation)
    return ownedKey !== null && ownedKey === representationKey
  })
  if (owned !== undefined) {
    return settleWithBannedClaim(decideForOwnedRepresentation({ owned, chain, registry, identity }))
  }

  if (
    registry._tag !== "coingecko_claim" &&
    registry._tag !== "registry_not_found" &&
    registry._tag !== "registry_not_queried"
  ) {
    return settleWithBannedClaim(failClosed(evidenceFailureReason(registry)))
  }

  if (legitimacyFailure !== null) {
    return settleWithBannedClaim(failClosed(evidenceFailureReason(legitimacyFailure)))
  }

  if (registry._tag === "coingecko_claim") {
    const platform = findMatchingPlatform({ chain, coinGecko: registry })
    const registryOwner = identity.registryOwner
    const matchingRegistryOwner =
      registryOwner !== null && registryOwner.coingeckoCoinId === registry.coinId
        ? registryOwner
        : null
    const hasExactRegistryAttach =
      platform !== undefined &&
      matchingRegistryOwner !== null &&
      typesAreCompatible({ asset: matchingRegistryOwner, chain }) &&
      platform.decimals !== null &&
      platform.decimals === chain.decimals

    if (hasExactRegistryAttach) {
      return settleWithBannedClaim(attach({ assetKey: matchingRegistryOwner.assetKey, chain }))
    }

    if (hasBannedClaim) {
      return excluded("authority_banned")
    }

    if (platform === undefined) {
      // The registry answered a lookup for this exact representation with a
      // coin that does not list it. That is contradictory evidence, not a
      // safe basis to attach or create.
      return failClosed("conflicting_evidence")
    }

    if (matchingRegistryOwner !== null) {
      if (!typesAreCompatible({ asset: matchingRegistryOwner, chain })) {
        return failClosed("incompatible_type")
      }
      if (platform.decimals === null) {
        return pending("non_exact_platform_match")
      }
      if (platform.decimals !== chain.decimals) {
        return failClosed("incompatible_decimals")
      }
    }

    // No local asset owns the coin id. Registry decimals must not contradict
    // the chain, but their absence is missing data, not a conflict.
    if (platform.decimals !== null && platform.decimals !== chain.decimals) {
      return failClosed("incompatible_decimals")
    }
  }

  return settleWithBannedClaim(
    decideStandaloneCreation({
      chain,
      coinGecko: registry._tag === "coingecko_claim" ? registry : null,
      legitimacy: legitimacyClaims,
      identity,
      providerDisplay,
    })
  )
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
  readonly legitimacy: ReadonlyArray<LegitimacyResolutionInput>
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
