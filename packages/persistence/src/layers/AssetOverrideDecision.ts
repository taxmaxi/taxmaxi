/**
 * AssetOverrideDecision - Shared effective identity and inclusion rules.
 *
 * @module AssetOverrideDecision
 */

export type AssetInclusionState = "included" | "excluded" | "blocked"

/**
 * Inputs used to choose the effective asset and inclusion state.
 *
 * `technicalBlocker` is true for non-overridable facts such as missing decimals or an
 * unsupported provider asset type. The identity override falls back to the system asset,
 * and the inclusion override falls back to the system inclusion state. An included result
 * without either an override or system asset remains blocked.
 */
export interface AssetOverrideDecisionInput {
  readonly systemAssetId: string | null
  readonly systemInclusionState: AssetInclusionState
  readonly technicalBlocker: boolean
  readonly identityOverrideAssetId: string | null
  readonly inclusionOverrideState: "included" | "excluded" | null
}

/**
 * The combined identity and inclusion answer after overrides are applied.
 *
 * `assetId` is only set when the result is `included`; an excluded or blocked
 * result clears it so no accounting can accidentally use the identity. An
 * included result that still has no asset is reported as `blocked`.
 */
export interface EffectiveAssetOverrideDecision {
  readonly assetId: string | null
  readonly inclusionState: AssetInclusionState
}

/** Resolve identity and inclusion together while preserving hard technical blockers. */
export const resolveEffectiveAssetOverrideDecision = ({
  systemAssetId,
  systemInclusionState,
  technicalBlocker,
  identityOverrideAssetId,
  inclusionOverrideState,
}: AssetOverrideDecisionInput): EffectiveAssetOverrideDecision => {
  const assetId = identityOverrideAssetId ?? systemAssetId
  const inclusionState = technicalBlocker
    ? "blocked"
    : (inclusionOverrideState ?? systemInclusionState)

  return {
    assetId: inclusionState === "included" ? assetId : null,
    inclusionState: inclusionState === "included" && assetId === null ? "blocked" : inclusionState,
  }
}

/** Match a provider movement to the canonical transfer referenced by a derived leg. */
export const providerTransferOwnsLeg = ({
  canonicalTransferExternalId,
  legSourceTransferId,
  canonicalTransfers,
}: {
  readonly canonicalTransferExternalId: string | null
  readonly legSourceTransferId: string | null
  readonly canonicalTransfers: ReadonlyArray<{
    readonly id: string
    readonly externalId: string | null
  }>
}): boolean =>
  canonicalTransferExternalId !== null &&
  legSourceTransferId !== null &&
  canonicalTransfers.some(
    (transfer) =>
      transfer.id === legSourceTransferId && transfer.externalId === canonicalTransferExternalId
  )
