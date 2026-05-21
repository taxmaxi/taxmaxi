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
  readonly payerChainType: ChainType | null
  readonly payerWalletAddress: string | null
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
 * FindAnonymousSourceEntitlementsByPayerParams - Lookup key for payer-wallet access.
 */
export interface FindAnonymousSourceEntitlementsByPayerParams {
  readonly payerChainType: ChainType
  readonly payerWalletAddress: string
}

/**
 * FindAnonymousSourceEntitlementByPayerParams - Lookup key for one payer-visible source.
 */
export interface FindAnonymousSourceEntitlementByPayerParams extends FindAnonymousSourceEntitlementsByPayerParams {
  readonly sourceId: SourceId
}

/**
 * FindValidSiwxSourceClaimParams - Lookup key for a payer-SIWX-backed source claim.
 */
export interface FindValidSiwxSourceClaimParams {
  readonly requestId: string
  readonly payerChainType: ChainType
  readonly payerWalletAddress: string
}

/**
 * ClaimAnonymousSourceForUserByPayerParams - Atomic ownership transfer request for a payer SIWX claim.
 */
export interface ClaimAnonymousSourceForUserByPayerParams {
  readonly requestId: string
  readonly payerChainType: ChainType
  readonly payerWalletAddress: string
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
  readonly payerChainType: ChainType | null
  readonly payerWalletAddress: string | null
  readonly year: number | null
  readonly jurisdiction: string | null
  readonly expiresAt: Date | null
  readonly consumedAt: Date | null
}

/**
 * AnonymousSourceEntitlement - Anonymous paid source handle visible to a payer wallet.
 */
export interface AnonymousSourceEntitlement {
  readonly principalId: PrincipalId
  readonly sourceId: SourceId
  readonly requestId: string
  readonly chainType: ChainType
  readonly walletAddress: string
  readonly year: number
  readonly jurisdiction: string
}

/**
 * AnonymousSourceSyncJob - Sync job visible through an anonymous payer session.
 */
export interface AnonymousSourceSyncJob {
  readonly sourceId: SourceId
  readonly jobId: string
  readonly status: "queued" | "running" | "completed" | "failed"
  readonly importedRecords: number | null
  readonly normalizedRecords: number | null
  readonly failedRecords: number | null
  readonly message: string | null
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
   * List unclaimed anonymous paid source handles for a verified payer wallet.
   */
  readonly findAnonymousSourceEntitlementsByPayer: (
    params: FindAnonymousSourceEntitlementsByPayerParams
  ) => Effect.Effect<ReadonlyArray<AnonymousSourceEntitlement>, PersistenceError>

  /**
   * Find one unclaimed anonymous paid source handle for a verified payer wallet.
   */
  readonly findAnonymousSourceEntitlementByPayer: (
    params: FindAnonymousSourceEntitlementByPayerParams
  ) => Effect.Effect<Option.Option<AnonymousSourceEntitlement>, PersistenceError>

  /**
   * List sync jobs for one unclaimed anonymous paid source visible to a payer wallet.
   */
  readonly listAnonymousSourceSyncJobsByPayer: (
    params: FindAnonymousSourceEntitlementByPayerParams
  ) => Effect.Effect<ReadonlyArray<AnonymousSourceSyncJob>, PersistenceError>

  /**
   * Find one sync job for one unclaimed anonymous paid source visible to a payer wallet.
   */
  readonly findAnonymousSourceSyncJobByPayer: (
    params: FindAnonymousSourceEntitlementByPayerParams & { readonly jobId: string }
  ) => Effect.Effect<Option.Option<AnonymousSourceSyncJob>, PersistenceError>

  /**
   * Find a currently valid x402 receipt for an anonymous source paid by a verified payer wallet.
   */
  readonly findValidSiwxSourceClaim: (
    params: FindValidSiwxSourceClaimParams
  ) => Effect.Effect<Option.Option<PrincipalClaim>, PersistenceError>

  /**
   * Move a no-conflict anonymous source into a user principal and consume request claims.
   */
  readonly claimAnonymousSourceForUser: (
    params: ClaimAnonymousSourceForUserParams
  ) => Effect.Effect<SourceId, PersistenceError | PrincipalClaimTransferError>

  /**
   * Move a no-conflict anonymous source into a user principal using payer-wallet SIWX proof.
   */
  readonly claimAnonymousSourceForUserByPayer: (
    params: ClaimAnonymousSourceForUserByPayerParams
  ) => Effect.Effect<SourceId, PersistenceError | PrincipalClaimTransferError>
}

/**
 * PrincipalClaimRepository - Context tag for ownership claim persistence.
 */
export class PrincipalClaimRepository extends Context.Tag(
  "@my/persistence/PrincipalClaimRepository"
)<PrincipalClaimRepository, PrincipalClaimRepositoryService>() {}
