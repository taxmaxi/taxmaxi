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

export type AssetOverrideKind = "identity" | "inclusion"

export type AssetOverrideTarget =
  | {
      readonly _tag: "representation"
      readonly blockchainId: string
      readonly representationType: "native" | "token" | "nft"
      readonly contractAddress: string | null
      readonly mintAddress: string | null
    }
  | { readonly _tag: "provider_asset"; readonly providerAssetRowId: string }

export type AssetOverrideSystemConclusion =
  | {
      readonly _tag: "identity"
      readonly state: "resolved" | "unresolved" | "excluded"
      readonly assetId: string | null
    }
  | {
      readonly _tag: "inclusion"
      readonly state: "included" | "excluded" | "blocked"
      readonly reason: string | null
    }

export type AssetOverrideReplacement =
  | { readonly _tag: "identity"; readonly assetId: string }
  | { readonly _tag: "inclusion"; readonly state: "included" | "excluded" }

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

export class AssetOverrideValidationError extends Schema.TaggedError<AssetOverrideValidationError>()(
  "AssetOverrideValidationError",
  { code: Schema.String, message: Schema.String }
) {}

export type AssetOverrideWriteResult =
  | { readonly _tag: "accepted"; readonly projection: AssetOverrideProjection }
  | { readonly _tag: "conflict"; readonly projection: AssetOverrideProjection }

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
  }) => Effect.Effect<Option.Option<AssetOverrideProjection>, PersistenceError>

  readonly getProjection: (params: {
    readonly principalId: string
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
  }) => Effect.Effect<AssetOverrideProjection, AssetOverrideTargetNotFoundError | PersistenceError>

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
