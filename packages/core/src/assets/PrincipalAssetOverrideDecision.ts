/**
 * Principal-scoped asset override decision rules.
 *
 * @module assets/PrincipalAssetOverrideDecision
 */

import * as Schema from "effect/Schema"
import { representationIdentityMatchesType, RepresentationType } from "./AssetResolutionPolicy.ts"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())
const Uuid = Schema.String.check(Schema.isUUID())

/** Exact immutable network representation selected by a principal. */
export const PrincipalAssetRepresentationTarget = Schema.TaggedStruct("representation", {
  blockchain: NonEmptyString,
  type: RepresentationType,
  contractAddress: Schema.NullOr(NonEmptyString),
  mintAddress: Schema.NullOr(NonEmptyString),
})
  .pipe(
    Schema.check(
      Schema.makeFilter((target) => {
        return representationIdentityMatchesType(target)
          ? undefined
          : "Representation target identity does not match its type."
      })
    )
  )
  .annotate({
    identifier: "PrincipalAssetRepresentationTarget",
    title: "Principal Asset Representation Target",
    description: "Exact blockchain-native, contract, or mint identity",
  })

/** The PrincipalAssetRepresentationTarget type. */
export type PrincipalAssetRepresentationTarget = typeof PrincipalAssetRepresentationTarget.Type

/** Chainless provider-asset row selected as the fallback target. */
export const PrincipalAssetProviderAssetTarget = Schema.TaggedStruct("provider_asset", {
  providerAssetRowId: Uuid,
}).annotate({
  identifier: "PrincipalAssetProviderAssetTarget",
  title: "Principal Asset Provider Asset Target",
  description: "Provider-asset row fallback for an observation without exact chain identity",
})

/** The PrincipalAssetProviderAssetTarget type. */
export type PrincipalAssetProviderAssetTarget = typeof PrincipalAssetProviderAssetTarget.Type

/** Exact representation or chainless provider-asset row selected by a principal. */
export const PrincipalAssetOverrideTarget = Schema.Union([
  PrincipalAssetRepresentationTarget,
  PrincipalAssetProviderAssetTarget,
]).annotate({
  identifier: "PrincipalAssetOverrideTarget",
  title: "Principal Asset Override Target",
  description: "Exact network representation or chainless provider-asset fallback target",
})

/** The PrincipalAssetOverrideTarget type. */
export type PrincipalAssetOverrideTarget = typeof PrincipalAssetOverrideTarget.Type

/** Resolved TaxMaxi economic asset identity. */
export const ResolvedPrincipalAssetIdentity = Schema.TaggedStruct("resolved", {
  assetId: Uuid,
})

/** The ResolvedPrincipalAssetIdentity type. */
export type ResolvedPrincipalAssetIdentity = typeof ResolvedPrincipalAssetIdentity.Type

/** Asset identity not yet settled by TaxMaxi. */
export const UnresolvedPrincipalAssetIdentity = Schema.TaggedStruct("unresolved", {})

/** The UnresolvedPrincipalAssetIdentity type. */
export type UnresolvedPrincipalAssetIdentity = typeof UnresolvedPrincipalAssetIdentity.Type

/** TaxMaxi's or a principal's conclusion about an asset's economic identity. */
export const PrincipalAssetIdentity = Schema.Union([
  ResolvedPrincipalAssetIdentity,
  UnresolvedPrincipalAssetIdentity,
]).annotate({
  identifier: "PrincipalAssetIdentity",
  title: "Principal Asset Identity",
  description: "Resolved or unresolved economic asset identity",
})

/** The PrincipalAssetIdentity type. */
export type PrincipalAssetIdentity = typeof PrincipalAssetIdentity.Type

/** TaxMaxi's or a principal's conclusion about calculation inclusion. */
export const PrincipalAssetInclusion = Schema.Literals(["included", "excluded"]).annotate({
  identifier: "PrincipalAssetInclusion",
  title: "Principal Asset Inclusion",
  description: "Whether an asset is eligible to enter derived accounting",
})

/** The PrincipalAssetInclusion type. */
export type PrincipalAssetInclusion = typeof PrincipalAssetInclusion.Type

/** Technical fact that must be present before an asset can enter accounting. */
export const PrincipalAssetTechnicalBlocker = Schema.Literals([
  "malformed_movement",
  "missing_decimals",
  "unsupported_asset_type",
]).annotate({
  identifier: "PrincipalAssetTechnicalBlocker",
  title: "Principal Asset Technical Blocker",
  description: "Missing or unsupported technical fact that prevents accounting",
})

/** The PrincipalAssetTechnicalBlocker type. */
export type PrincipalAssetTechnicalBlocker = typeof PrincipalAssetTechnicalBlocker.Type

/** Effective decision that lets a resolved asset enter accounting. */
export const IncludedPrincipalAssetDecision = Schema.TaggedStruct("included", {
  assetId: Uuid,
})

/** The IncludedPrincipalAssetDecision type. */
export type IncludedPrincipalAssetDecision = typeof IncludedPrincipalAssetDecision.Type

/** Effective decision that waits for identity or technical facts. */
export const BlockedPrincipalAssetDecision = Schema.TaggedStruct("blocked", {
  identity: PrincipalAssetIdentity,
  reason: Schema.Literals(["technical_blocker", "unresolved_identity"]),
  technicalBlockers: Schema.Array(PrincipalAssetTechnicalBlocker),
}).pipe(
  Schema.check(
    Schema.makeFilter((decision) => {
      if (decision.reason === "technical_blocker") {
        return decision.technicalBlockers.length > 0
          ? undefined
          : "Technical-blocker decisions require at least one technical blocker."
      }

      return decision.identity._tag === "unresolved" && decision.technicalBlockers.length === 0
        ? undefined
        : "Unresolved-identity decisions require unresolved identity and no technical blockers."
    })
  )
)

/** The BlockedPrincipalAssetDecision type. */
export type BlockedPrincipalAssetDecision = typeof BlockedPrincipalAssetDecision.Type

/** Effective decision that omits an asset from accounting. */
export const ExcludedPrincipalAssetDecision = Schema.TaggedStruct("excluded", {
  identity: PrincipalAssetIdentity,
})

/** The ExcludedPrincipalAssetDecision type. */
export type ExcludedPrincipalAssetDecision = typeof ExcludedPrincipalAssetDecision.Type

/** Final principal-scoped decision used by derived accounting. */
export const PrincipalAssetEffectiveDecision = Schema.Union([
  IncludedPrincipalAssetDecision,
  BlockedPrincipalAssetDecision,
  ExcludedPrincipalAssetDecision,
]).annotate({
  identifier: "PrincipalAssetEffectiveDecision",
  title: "Principal Asset Effective Decision",
  description: "Included, excluded, or blocked principal-scoped accounting decision",
})

/** The PrincipalAssetEffectiveDecision type. */
export type PrincipalAssetEffectiveDecision = typeof PrincipalAssetEffectiveDecision.Type

/** Typed inputs to the pure principal asset override decision. */
export interface PrincipalAssetOverrideDecisionInput {
  readonly systemIdentity: PrincipalAssetIdentity
  readonly systemInclusion: PrincipalAssetInclusion
  readonly identityReplacement: ResolvedPrincipalAssetIdentity | null
  readonly inclusionReplacement: PrincipalAssetInclusion | null
  readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
}

/** Decide the principal-scoped effective identity and inclusion outcome. */
export const decidePrincipalAssetOverride = ({
  systemIdentity,
  systemInclusion,
  identityReplacement,
  inclusionReplacement,
  technicalBlockers,
}: PrincipalAssetOverrideDecisionInput): PrincipalAssetEffectiveDecision => {
  const effectiveIdentity = identityReplacement ?? systemIdentity
  const effectiveInclusion = inclusionReplacement ?? systemInclusion

  if (effectiveInclusion === "excluded") {
    return { _tag: "excluded", identity: effectiveIdentity }
  }

  if (technicalBlockers.length > 0) {
    return {
      _tag: "blocked",
      identity: effectiveIdentity,
      reason: "technical_blocker",
      technicalBlockers,
    }
  }

  return effectiveIdentity._tag === "resolved"
    ? { _tag: "included", assetId: effectiveIdentity.assetId }
    : {
        _tag: "blocked",
        identity: effectiveIdentity,
        reason: "unresolved_identity",
        technicalBlockers: [],
      }
}
