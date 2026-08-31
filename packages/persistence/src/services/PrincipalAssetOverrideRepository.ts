/**
 * PrincipalAssetOverrideRepository - Principal-scoped override reads and validation.
 *
 * @module PrincipalAssetOverrideRepository
 */

import type {
  PrincipalAssetEffectiveDecision,
  PrincipalAssetIdentity,
  PrincipalAssetInclusion,
  PrincipalAssetOverrideTarget,
  PrincipalAssetTechnicalBlocker,
  ResolvedPrincipalAssetIdentity,
} from "@my/core/assets"
import type { PrincipalId } from "@my/core/ownership"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** A target cannot be resolved to one canonical database key. */
export class PrincipalAssetOverrideInvalidTargetError extends Schema.TaggedError<PrincipalAssetOverrideInvalidTargetError>()(
  "PrincipalAssetOverrideInvalidTargetError",
  {
    reason: Schema.Literals(["invalid_evm_address", "unknown_blockchain"]),
  }
) {}

/** One append-only identity or inclusion override record. */
export interface PrincipalAssetOverrideHistoryRecord {
  readonly id: string
  readonly kind: "identity" | "inclusion"
  readonly operation: "create" | "replace" | "withdraw"
  readonly inspectedSystemRevision: string
  readonly inspectedSystemIdentity: PrincipalAssetIdentity | null
  readonly inspectedSystemInclusion: PrincipalAssetInclusion | null
  readonly replacementIdentity: ResolvedPrincipalAssetIdentity | null
  readonly replacementInclusion: PrincipalAssetInclusion | null
  readonly actorUserId: string
  readonly reason: string
  readonly supersedesOverrideId: string | null
  readonly recordedAt: Date
}

/** TaxMaxi's current conclusion and revision for one override kind. */
export interface PrincipalAssetOverrideSystemState {
  readonly identity: PrincipalAssetIdentity
  readonly identityRevision: string
  readonly inclusion: PrincipalAssetInclusion
  readonly inclusionRevision: string
}

/** The current principal-scoped answer for one owned target. */
export interface PrincipalAssetOverrideProjection {
  readonly target: PrincipalAssetOverrideTarget
  readonly system: PrincipalAssetOverrideSystemState
  readonly activeIdentityOverride: PrincipalAssetOverrideHistoryRecord | null
  readonly activeInclusionOverride: PrincipalAssetOverrideHistoryRecord | null
  readonly effectiveDecision: PrincipalAssetEffectiveDecision
  /** Blocker kinds this read could derive from currently stored facts. */
  readonly checkedTechnicalBlockerKinds: ReadonlyArray<PrincipalAssetTechnicalBlocker>
  readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
  readonly identityOverrideUsesStaleSystemRevision: boolean
  readonly inclusionOverrideUsesStaleSystemRevision: boolean
  readonly history: ReadonlyArray<PrincipalAssetOverrideHistoryRecord>
}

/** Non-blocking difference between a selected asset and stored evidence. */
export interface PrincipalAssetOverrideValidationWarning {
  readonly code:
    | "market_data_identity_mismatch"
    | "name_mismatch"
    | "symbol_mismatch"
    | "system_confidence_conflict"
    | "system_confidence_fail_closed"
    | "system_confidence_pending"
    | "system_identity_mismatch"
  readonly current: string | null
  readonly selected: string | null
}

/** Existing economic asset selected by an identity override. */
export interface PrincipalAssetOverrideSelectedAsset {
  readonly id: string
  readonly type: "fungible" | "nft"
  readonly name: string
  readonly symbol: string
  readonly marketDataId: string | null
}

/** Result of validating an identity replacement for one owned target. */
export type PrincipalAssetIdentityOverrideValidation =
  | {
      readonly _tag: "asset_not_found"
      readonly assetId: string
      readonly checkedTechnicalBlockerKinds: ReadonlyArray<PrincipalAssetTechnicalBlocker>
      readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
    }
  | {
      readonly _tag: "incompatible_asset_type"
      readonly asset: PrincipalAssetOverrideSelectedAsset
      readonly targetAssetType: "fungible" | "nft"
      readonly checkedTechnicalBlockerKinds: ReadonlyArray<PrincipalAssetTechnicalBlocker>
      readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
    }
  | {
      readonly _tag: "ready"
      readonly asset: PrincipalAssetOverrideSelectedAsset
      readonly projection: PrincipalAssetOverrideProjection
      /** Blocker kinds this validation could derive from currently stored facts. */
      readonly checkedTechnicalBlockerKinds: ReadonlyArray<PrincipalAssetTechnicalBlocker>
      readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
      readonly warnings: ReadonlyArray<PrincipalAssetOverrideValidationWarning>
    }

/** Expected failures while reading one canonical target. */
export type PrincipalAssetOverrideReadError =
  | PrincipalAssetOverrideInvalidTargetError
  | PersistenceError

/** Read-only persistence contract for principal asset overrides. */
export interface PrincipalAssetOverrideRepositoryShape {
  /**
   * Read the current effective projection and full history for one owned target.
   * Missing and other-principal targets both return `Option.none`.
   */
  readonly findProjection: (params: {
    readonly principalId: PrincipalId
    readonly target: PrincipalAssetOverrideTarget
  }) => Effect.Effect<
    Option.Option<PrincipalAssetOverrideProjection>,
    PrincipalAssetOverrideReadError
  >

  /**
   * Validate one existing economic asset as an identity replacement.
   * Missing and other-principal targets both return `Option.none`.
   */
  readonly validateIdentityReplacement: (params: {
    readonly assetId: string
    readonly principalId: PrincipalId
    readonly target: PrincipalAssetOverrideTarget
  }) => Effect.Effect<
    Option.Option<PrincipalAssetIdentityOverrideValidation>,
    PrincipalAssetOverrideReadError
  >
}

/** Principal-scoped asset override read and validation service. */
export class PrincipalAssetOverrideRepository extends Context.Service<
  PrincipalAssetOverrideRepository,
  PrincipalAssetOverrideRepositoryShape
>()("@my/persistence/PrincipalAssetOverrideRepository") {}
