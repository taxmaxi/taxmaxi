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
}

/**
 * PrincipalClaimRepository - Context tag for ownership claim persistence.
 */
export class PrincipalClaimRepository extends Context.Tag(
  "@my/persistence/PrincipalClaimRepository"
)<PrincipalClaimRepository, PrincipalClaimRepositoryService>() {}
