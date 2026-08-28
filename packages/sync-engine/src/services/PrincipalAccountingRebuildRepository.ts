/**
 * PrincipalAccountingRebuildRepository - Principal-scoped downstream accounting rebuild contract.
 *
 * @module PrincipalAccountingRebuildRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/** Inputs that define one principal accounting rebuild boundary. */
export interface RebuildPrincipalAccountingParams {
  readonly principalId: string
  readonly affectedAssetIds: ReadonlyArray<string>
  readonly rebuildFrom: Date
}

/** Observable work completed by one principal accounting rebuild. */
export interface PrincipalAccountingRebuildResult extends RebuildPrincipalAccountingParams {
  readonly rebuiltSourceIds: ReadonlyArray<string>
  readonly fifoLotsRebuilt: number
  readonly disposalMatchesRebuilt: number
  readonly inventoryAllocationsRebuilt: number
}

/** Persistence operations for rebuilding downstream accounting without replaying raw records. */
export interface PrincipalAccountingRebuildRepositoryShape {
  /** Rebuild affected FIFO, custody allocation, valuation, and tax inputs from one event. */
  readonly rebuildPrincipalAccounting: (
    params: RebuildPrincipalAccountingParams
  ) => Effect.Effect<PrincipalAccountingRebuildResult, SyncEngineStorageError>
}

/** Context tag for principal-scoped accounting rebuild persistence. */
export class PrincipalAccountingRebuildRepository extends Context.Service<
  PrincipalAccountingRebuildRepository,
  PrincipalAccountingRebuildRepositoryShape
>()("PrincipalAccountingRebuildRepository") {}
