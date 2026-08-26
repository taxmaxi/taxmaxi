/**
 * Declarative human claims and ranking policy for asset exceptions.
 *
 * @module assets/AssetException
 */

import * as Schema from "effect/Schema"
import { AssetDecimals, EconomicAssetType, RepresentationType } from "./AssetResolutionPolicy.ts"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())
const NonEmptyTrimmedString = Schema.Trimmed.check(Schema.isNonEmpty())

/** Stable token used when an observation has no active decision. */
export const NO_ACTIVE_ASSET_DECISION = "no_active_decision" as const

/** Reasons that require a domain conclusion from an administrator. */
export const AssetExceptionReason = Schema.Literals([
  "ownership_conflict",
  "conflicting_evidence",
  "incompatible_decimals",
  "incompatible_type",
  "display_collision",
  "non_exact_platform_match",
  "spam_evidence",
  "unsupported_representation_type",
  "unverified_asset",
])

export type AssetExceptionReason = typeof AssetExceptionReason.Type

/** Fixed impact-independent severity attached to a resolver reason. */
export const AssetExceptionSeverity = Schema.Literals(["critical", "high", "medium", "low"])

export type AssetExceptionSeverity = typeof AssetExceptionSeverity.Type

const ASSET_EXCEPTION_SEVERITY_BY_REASON = {
  ownership_conflict: "critical",
  conflicting_evidence: "critical",
  incompatible_decimals: "high",
  incompatible_type: "high",
  display_collision: "medium",
  non_exact_platform_match: "medium",
  spam_evidence: "low",
  unsupported_representation_type: "low",
  unverified_asset: "low",
} as const satisfies Readonly<Record<AssetExceptionReason, AssetExceptionSeverity>>

/** Return the versioned severity for one actionable resolver reason. */
export const assetExceptionSeverityForReason = (
  reason: AssetExceptionReason
): AssetExceptionSeverity => ASSET_EXCEPTION_SEVERITY_BY_REASON[reason]

/** Typed reasons an administrator may use to exclude an observation. */
export const AssetExceptionExclusionReason = Schema.Literals([
  "authority_banned",
  "confirmed_spam",
  "unsupported_asset_type",
  "provider_artifact",
])

export type AssetExceptionExclusionReason = typeof AssetExceptionExclusionReason.Type

/** Exact representation facts declared by a human identity claim. */
export const AssetExceptionRepresentation = Schema.Struct({
  blockchain: NonEmptyString,
  type: RepresentationType,
  contractAddress: Schema.NullOr(NonEmptyString),
  mintAddress: Schema.NullOr(NonEmptyString),
  decimals: AssetDecimals,
}).pipe(
  Schema.check(
    Schema.makeFilter((representation) => {
      const addressCount =
        Number(representation.contractAddress !== null) +
        Number(representation.mintAddress !== null)
      return representation.type === "native"
        ? addressCount === 0
          ? undefined
          : "Native representations cannot declare an address."
        : addressCount === 1
          ? undefined
          : "Token and NFT representations require exactly one address."
    })
  )
)

export type AssetExceptionRepresentation = typeof AssetExceptionRepresentation.Type

/** Display facts required when the claimed economic identity does not exist yet. */
export const AssetExceptionNewAsset = Schema.Struct({
  name: NonEmptyTrimmedString,
  symbol: NonEmptyTrimmedString,
  type: EconomicAssetType,
})

export type AssetExceptionNewAsset = typeof AssetExceptionNewAsset.Type

const AssetExceptionIdentityClaim = Schema.TaggedStruct("identity", {
  assetId: Schema.NullOr(Schema.String.check(Schema.isUUID())),
  newAsset: Schema.NullOr(AssetExceptionNewAsset),
  representation: Schema.NullOr(AssetExceptionRepresentation),
}).pipe(
  Schema.check(
    Schema.makeFilter((claim) =>
      (claim.assetId === null) === (claim.newAsset === null)
        ? "Identity claims require exactly one of assetId or newAsset."
        : undefined
    )
  )
)

const AssetExceptionExclusionClaim = Schema.TaggedStruct("exclusion", {
  reason: AssetExceptionExclusionReason,
})

/** Declarative conclusion accepted by preview and confirmation. */
export const AssetExceptionClaim = Schema.Union([
  AssetExceptionIdentityClaim,
  AssetExceptionExclusionClaim,
])

export type AssetExceptionClaim = typeof AssetExceptionClaim.Type

/** Aggregate rematerialization state kept separate from review completion. */
export const AssetExceptionRematerializationStatus = Schema.Literals([
  "pending",
  "running",
  "complete",
  "operator_attention",
])

export type AssetExceptionRematerializationStatus =
  typeof AssetExceptionRematerializationStatus.Type
