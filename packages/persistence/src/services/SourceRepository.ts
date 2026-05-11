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
import type { AuthUserId } from "@my/core/authentication"

/**
 * CreateSourceInput - Data required to create a new source
 *
 * Contains all fields needed for source creation. `sourceRef` is the
 * discriminated source linkage and drives sourceable_type + FK assignment.
 */
export interface CreateSourceInput {
  readonly id: SourceId
  readonly userId: Source["userId"]
  readonly name: Source["name"]
  readonly providerKey?: Source["providerKey"]
  readonly providerMetadata?: unknown
  readonly sourceRef: Source["sourceRef"]
}

/**
 * FindByUserAndProviderKeyParams - Input for provider-key lookup.
 */
export interface FindByUserAndProviderKeyParams {
  readonly userId: Source["userId"]
  readonly providerKey: string
}

/**
 * FindByUserAndSourceRefParams - Input for source-ref lookup.
 */
export interface FindByUserAndSourceRefParams {
  readonly userId: Source["userId"]
  readonly sourceRef: Source["sourceRef"]
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
   * Find sources by user ID
   *
   * @param id - The user ID to search for
   * @returns Effect containing Option of source (None if not found)
   */
  readonly findByUserId: (id: AuthUserId) => Effect.Effect<Source[], PersistenceError>

  /**
   * Find a source by user owner and concrete provider key
   *
   * @param params - User and provider key lookup input
   * @returns Effect containing Option of source (None if not found)
   */
  readonly findByUserAndProviderKey: (
    params: FindByUserAndProviderKeyParams
  ) => Effect.Effect<Option.Option<Source>, PersistenceError>

  /**
   * Find a source by user owner and source linkage reference
   *
   * @param params - User and source reference lookup input
   * @returns Effect containing Option of source (None if not found)
   */
  readonly findByUserAndSourceRef: (
    params: FindByUserAndSourceRefParams
  ) => Effect.Effect<Option.Option<Source>, PersistenceError>

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
