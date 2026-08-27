/**
 * AssetOverrideRepository - Principal-scoped asset identity and inclusion choices.
 *
 * @module AssetOverrideRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** The independent asset decision selected by an override operation. */
export type AssetOverrideKind = "identity" | "inclusion"

/**
 * The durable evidence identity owned by one override history.
 *
 * Representation targets apply across providers, while provider-asset targets
 * apply only to the selected provider asset row.
 */
export type AssetOverrideTarget =
  | {
      readonly _tag: "representation"
      readonly blockchainId: string
      readonly representationType: "native" | "token" | "nft"
      readonly contractAddress: string | null
      readonly mintAddress: string | null
    }
  | { readonly _tag: "provider_asset"; readonly providerAssetRowId: string }

/**
 * The system's current answer for one override kind before a principal choice.
 *
 * Identity conclusions carry a canonical asset only when resolved. For
 * inclusion, `excluded` is a final omission while `blocked` means accounting
 * cannot proceed until a missing identity or technical fact is supplied.
 */
export type AssetOverrideSystemConclusion =
  | {
      readonly _tag: "identity"
      readonly state: "resolved" | "unresolved" | "excluded"
      readonly assetId: string | null
      /** Machine-readable blocker when a stale active choice can no longer be applied. */
      readonly reason?: string | null
    }
  | {
      readonly _tag: "inclusion"
      readonly state: "included" | "excluded" | "blocked"
      readonly reason: string | null
    }

/** The principal's requested replacement for the selected override kind. */
export type AssetOverrideReplacement =
  | { readonly _tag: "identity"; readonly assetId: string }
  | { readonly _tag: "inclusion"; readonly state: "included" | "excluded" }

/**
 * One append-only override decision or withdrawal.
 *
 * The inspected revision and conclusion capture the system state presented to
 * the actor. `supersedesOverrideId` links the entry to the active decision it
 * replaced; withdrawals have no replacement value.
 */
export interface AssetOverrideHistoryEntry {
  readonly id: string
  readonly kind: AssetOverrideKind
  readonly target: AssetOverrideTarget
  readonly action: "set" | "withdraw"
  readonly inspectedSystemRevision: string
  readonly inspectedSystemConclusion: AssetOverrideSystemConclusion
  readonly replacement: AssetOverrideReplacement | null
  readonly actorId: string
  readonly reason: string
  readonly supersedesOverrideId: string | null
  readonly createdAt: Date
}

/**
 * The current override view for a principal, kind, and target.
 *
 * `systemRevision` is the optimistic-concurrency token for the current system
 * conclusion. `staleSystemRevision` reports whether the active override was
 * inspected against an older token. `effectiveConclusion` applies the active
 * choice, while `recomputationState` reports whether affected source replays
 * are still running, fully applied, or failed.
 */
export interface AssetOverrideProjection {
  readonly kind: AssetOverrideKind
  readonly target: AssetOverrideTarget
  readonly systemRevision: string
  readonly systemConclusion: AssetOverrideSystemConclusion
  readonly activeOverride: AssetOverrideHistoryEntry | null
  readonly effectiveConclusion: AssetOverrideSystemConclusion
  readonly staleSystemRevision: boolean
  readonly history: ReadonlyArray<AssetOverrideHistoryEntry>
  readonly recomputationState: "updating" | "complete" | "failed"
}

export class AssetOverrideTargetNotFoundError extends Schema.TaggedError<AssetOverrideTargetNotFoundError>()(
  "AssetOverrideTargetNotFoundError",
  {}
) {
  override get message(): string {
    return "Asset override target not found."
  }
}

/** Stable machine-readable reasons an asset override request can be rejected. */
export const ASSET_OVERRIDE_VALIDATION_ERROR_CODES = [
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
] as const

/** Schema shared by persistence, REST, and SDK error contracts. */
export const AssetOverrideValidationErrorCode = Schema.Literals(
  ASSET_OVERRIDE_VALIDATION_ERROR_CODES
).annotate({
  identifier: "AssetOverrideValidationErrorCode",
  title: "Asset Override Validation Error Code",
  description: "Stable reason an asset override request was rejected",
})

/** A stable machine-readable asset override validation code. */
export type AssetOverrideValidationErrorCode = typeof AssetOverrideValidationErrorCode.Type

export class AssetOverrideValidationError extends Schema.TaggedError<AssetOverrideValidationError>()(
  "AssetOverrideValidationError",
  { code: AssetOverrideValidationErrorCode, message: Schema.String }
) {}

/**
 * Result of an override write guarded by the expected system revision and
 * active override ID. `conflict` records nothing and returns the latest view;
 * `accepted` records the history entry but may still be awaiting replay.
 */
export type AssetOverrideWriteResult =
  | { readonly _tag: "accepted"; readonly projection: AssetOverrideProjection }
  | { readonly _tag: "conflict"; readonly projection: AssetOverrideProjection }

/**
 * Reads, validates, and records principal-scoped asset override choices.
 *
 * Targets and replacements are validated before a projection or write is returned;
 * `validateOverride` performs these checks without recording a choice. Writes use
 * the expected system revision and active override ID as optimistic concurrency
 * checks. A mismatch records nothing and returns `conflict` with the current
 * projection. An accepted write appends to the target's history and schedules or
 * joins a replay for each affected source. The returned projection reports replay
 * progress through `recomputationState`; acceptance does not mean replay is complete.
 */
export interface AssetOverrideRepositoryShape {
  readonly validateOverride: (params: {
    readonly principalId: string
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
    readonly replacement: AssetOverrideReplacement
  }) => Effect.Effect<
    AssetOverrideProjection,
    AssetOverrideTargetNotFoundError | AssetOverrideValidationError | PersistenceError
  >

  readonly findProjection: (params: {
    readonly principalId: string
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
  }) => Effect.Effect<
    Option.Option<AssetOverrideProjection>,
    AssetOverrideValidationError | PersistenceError
  >

  readonly getProjection: (params: {
    readonly principalId: string
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
  }) => Effect.Effect<
    AssetOverrideProjection,
    AssetOverrideTargetNotFoundError | AssetOverrideValidationError | PersistenceError
  >

  readonly setOverride: (params: {
    readonly principalId: string
    readonly actorId: string
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
    readonly expectedSystemRevision: string
    readonly expectedActiveOverrideId: string | null
    readonly replacement: AssetOverrideReplacement
    readonly reason: string
  }) => Effect.Effect<
    AssetOverrideWriteResult,
    AssetOverrideTargetNotFoundError | AssetOverrideValidationError | PersistenceError
  >

  readonly withdrawOverride: (params: {
    readonly principalId: string
    readonly actorId: string
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
    readonly expectedSystemRevision: string
    readonly expectedActiveOverrideId: string | null
    readonly reason: string
  }) => Effect.Effect<
    AssetOverrideWriteResult,
    AssetOverrideTargetNotFoundError | AssetOverrideValidationError | PersistenceError
  >
}

export class AssetOverrideRepository extends Context.Service<
  AssetOverrideRepository,
  AssetOverrideRepositoryShape
>()("AssetOverrideRepository") {}
