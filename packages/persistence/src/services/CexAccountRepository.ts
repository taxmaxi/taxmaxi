/**
 * CexAccountRepository - Repository interface for cex_account persistence
 *
 * Uses Effect Context.Tag pattern for dependency injection.
 * All operations return Effect with typed errors.
 *
 * @module CexAccountRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { OAuthCredentials } from "@my/core/authentication"
import type { EntityNotFoundError, PersistenceError } from "../errors/RepositoryError.ts"

/**
 * CexAccountRecord - Minimal account projection used by auth/source flows.
 */
export interface CexAccountRecord {
  readonly id: string
  readonly cexId: string
  readonly principalId: string
  readonly providerUserId: string | null
  readonly providerAccountId: string | null
}

/**
 * EnsureCexAccountForProviderWithOAuthParams - Provisioning and credential payload.
 */
export interface EnsureCexAccountForProviderWithOAuthParams {
  readonly principalId: string
  readonly cexName: string
  readonly providerUserId: string
  readonly providerAccountId?: string
  readonly oauthCredentials: OAuthCredentials
}

/**
 * CexAccountRepositoryService - Service interface for cex account persistence.
 */
export interface CexAccountRepositoryService {
  /**
   * Ensure a cex account exists and persist OAuth credentials atomically.
   *
   * @param params - Provisioning and credential payload
   * @returns Effect containing the ensured account record
   */
  readonly ensureForProviderWithOAuthCredentials: (
    params: EnsureCexAccountForProviderWithOAuthParams
  ) => Effect.Effect<CexAccountRecord, EntityNotFoundError | PersistenceError>
}

/**
 * CexAccountRepository - Context.Tag for dependency injection.
 */
export class CexAccountRepository extends Context.Tag("CexAccountRepository")<
  CexAccountRepository,
  CexAccountRepositoryService
>() {}
