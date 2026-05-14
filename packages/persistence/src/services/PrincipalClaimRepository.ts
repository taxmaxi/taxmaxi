/**
 * PrincipalClaimRepository - Ownership claim persistence contract.
 *
 * @module PrincipalClaimRepository
 */

import type { PrincipalId } from "@my/core/ownership"
import type { ChainType, SourceId } from "@my/core/source"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/**
 * PrincipalClaimType - Stored proof or entitlement claim family.
 */
export type PrincipalClaimType = "x402_receipt" | "siwx_wallet" | "cli_claim_token"

/**
 * CreatePrincipalClaimParams - Data required to persist a principal claim.
 */
export interface CreatePrincipalClaimParams {
  readonly principalId: PrincipalId
  readonly sourceId: SourceId | null
  readonly requestId: string
  readonly claimType: PrincipalClaimType
  readonly claimValueHash: string
  readonly chainType: ChainType | null
  readonly walletAddress: string | null
  readonly year: number | null
  readonly jurisdiction: string | null
  readonly expiresAt: Date | null
}

/**
 * FindValidCliSourceClaimParams - Lookup key for a claim-token-backed source claim.
 */
export interface FindValidCliSourceClaimParams {
  readonly requestId: string
  readonly claimValueHash: string
}

/**
 * ClaimAnonymousSourceForUserParams - Atomic ownership transfer request for a validated source claim.
 */
export interface ClaimAnonymousSourceForUserParams {
  readonly requestId: string
  readonly claimValueHash: string
  readonly anonymousPrincipalId: PrincipalId
  readonly userPrincipalId: PrincipalId
  readonly sourceId: SourceId
}

/**
 * PrincipalClaimTransferConflictError - The target user already owns a conflicting source.
 */
export class PrincipalClaimTransferConflictError extends Schema.TaggedError<PrincipalClaimTransferConflictError>()(
  "PrincipalClaimTransferConflictError",
  {
    message: Schema.String,
  }
) {}

/**
 * PrincipalClaimTransferStaleError - A claim transfer can no longer be applied.
 */
export class PrincipalClaimTransferStaleError extends Schema.TaggedError<PrincipalClaimTransferStaleError>()(
  "PrincipalClaimTransferStaleError",
  {
    message: Schema.String,
  }
) {}

/**
 * Type guard for PrincipalClaimTransferConflictError.
 */
export const isPrincipalClaimTransferConflictError = Schema.is(PrincipalClaimTransferConflictError)

/**
 * Type guard for PrincipalClaimTransferStaleError.
 */
export const isPrincipalClaimTransferStaleError = Schema.is(PrincipalClaimTransferStaleError)

/**
 * PrincipalClaimTransferError - Expected claim transfer failure.
 */
export type PrincipalClaimTransferError =
  | PrincipalClaimTransferConflictError
  | PrincipalClaimTransferStaleError

/**
 * PrincipalClaim - Persisted claim projection.
 */
export interface PrincipalClaim {
  readonly id: string
  readonly principalId: PrincipalId
  readonly sourceId: SourceId | null
  readonly requestId: string
  readonly claimType: PrincipalClaimType
  readonly claimValueHash: string
  readonly chainType: ChainType | null
  readonly walletAddress: string | null
  readonly year: number | null
  readonly jurisdiction: string | null
  readonly expiresAt: Date | null
  readonly consumedAt: Date | null
}

/**
 * PrincipalClaimRepositoryService - Ownership claim operations.
 */
export interface PrincipalClaimRepositoryService {
  /**
   * Create a principal claim.
   */
  readonly create: (
    params: CreatePrincipalClaimParams
  ) => Effect.Effect<PrincipalClaim, PersistenceError>

  /**
   * Find a currently valid CLI source claim for an anonymous wallet principal.
   */
  readonly findValidCliSourceClaim: (
    params: FindValidCliSourceClaimParams
  ) => Effect.Effect<Option.Option<PrincipalClaim>, PersistenceError>

  /**
   * Move a no-conflict anonymous source into a user principal and consume request claims.
   */
  readonly claimAnonymousSourceForUser: (
    params: ClaimAnonymousSourceForUserParams
  ) => Effect.Effect<SourceId, PersistenceError | PrincipalClaimTransferError>
}

/**
 * PrincipalClaimRepository - Context tag for ownership claim persistence.
 */
export class PrincipalClaimRepository extends Context.Tag(
  "@my/persistence/PrincipalClaimRepository"
)<PrincipalClaimRepository, PrincipalClaimRepositoryService>() {}
