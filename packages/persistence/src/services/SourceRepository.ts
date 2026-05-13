/**
 * SourceRepository - Repository interface for source entity persistence
 *
 * Uses Effect Context.Tag pattern for dependency injection.
 * All operations return Effect with typed errors.
 *
 * @module SourceRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { SourceId, Source } from "@my/core/source"
import type { PersistenceError } from "../errors/RepositoryError.ts"
import type { PrincipalId } from "@my/core/ownership"

/**
 * OnchainSourceChainType - Supported chain families for onchain source creation.
 */
export type OnchainSourceChainType = "evm" | "solana" | "bitcoin"

/**
 * CreateSourceInput - Data required to create a new source
 *
 * Contains all fields needed for source creation. `sourceRef` is the
 * discriminated source linkage and drives sourceable_type + FK assignment.
 */
export interface CreateSourceInput {
  readonly id: SourceId
  readonly principalId: Source["principalId"]
  readonly name: Source["name"]
  readonly providerKey?: Source["providerKey"]
  readonly providerMetadata?: unknown
  readonly sourceRef: Source["sourceRef"]
}

/**
 * FindByPrincipalAndProviderKeyParams - Input for provider-key lookup.
 */
export interface FindByPrincipalAndProviderKeyParams {
  readonly principalId: PrincipalId
  readonly providerKey: string
}

/**
 * FindByPrincipalAndSourceRefParams - Input for source-ref lookup.
 */
export interface FindByPrincipalAndSourceRefParams {
  readonly principalId: PrincipalId
  readonly sourceRef: Source["sourceRef"]
}

/**
 * CreateOrReuseOnchainSourceParams - Input for idempotent wallet source creation.
 */
export interface CreateOrReuseOnchainSourceParams {
  readonly principalId: PrincipalId
  readonly chainType: OnchainSourceChainType
  readonly walletAddress: string
  readonly name: string
}

/**
 * CreateOrReuseSourceResult - Source creation result.
 */
export interface CreateOrReuseSourceResult {
  readonly source: Source
  readonly created: boolean
}

/**
 * SourceRepositoryService - Service interface for source persistence
 *
 * Provides CRUD operations for source entities with typed error handling.
 */
export interface SourceRepositoryService {
  /**
   * Find a source by their unique identifier
   *
   * @param id - The source ID to search for
   * @returns Effect containing Option of source (None if not found)
   */
  readonly findById: (id: SourceId) => Effect.Effect<Option.Option<Source>, PersistenceError>

  /**
   * Find sources by ownership principal ID.
   */
  readonly findByPrincipalId: (id: PrincipalId) => Effect.Effect<Source[], PersistenceError>

  /**
   * Find a source by owner principal and concrete provider key.
   */
  readonly findByPrincipalAndProviderKey: (
    params: FindByPrincipalAndProviderKeyParams
  ) => Effect.Effect<Option.Option<Source>, PersistenceError>

  /**
   * Find a source by owner principal and source linkage reference.
   */
  readonly findByPrincipalAndSourceRef: (
    params: FindByPrincipalAndSourceRefParams
  ) => Effect.Effect<Option.Option<Source>, PersistenceError>

  /**
   * Create or reuse an onchain wallet source for an ownership principal.
   */
  readonly createOrReuseOnchainSource: (
    params: CreateOrReuseOnchainSourceParams
  ) => Effect.Effect<CreateOrReuseSourceResult, PersistenceError>

  /**
   * Create a new source
   *
   * @param source - The source data to create
   * @returns Effect containing the created Source
   */
  readonly create: (source: CreateSourceInput) => Effect.Effect<Source, PersistenceError>
}

/**
 * SourceRepository - Context.Tag for dependency injection
 *
 * Usage:
 * ```typescript
 * import { SourceRepository } from "@my/persistence/services"
 *
 * const program = Effect.gen(function* () {
 *   const repo = yield* SourceRepository
 *   const source = yield* repo.findById(sourceId)
 *   // ...
 * })
 * ```
 */
export class SourceRepository extends Context.Tag("@my/persistence/SourceRepository")<
  SourceRepository,
  SourceRepositoryService
>() {}
