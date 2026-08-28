/**
 * PrincipalAccountingRebuildService - Principal-scoped downstream accounting rebuild orchestration.
 *
 * @module PrincipalAccountingRebuildService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type {
  PrincipalAccountingRebuildResult,
  RebuildPrincipalAccountingParams,
} from "./PrincipalAccountingRebuildRepository.ts"
import { SyncEngineStorageError } from "./SyncEngineStorageError.ts"

/** Observable work completed by reconciliation and durable accounting rebuilds. */
export interface PrincipalAccountingRebuildSummary extends PrincipalAccountingRebuildResult {
  readonly transferCandidatesReconciled: number
  readonly transferPairsCanonicalized: number
}

/** Principal accounting rebuild orchestration contract. */
export interface PrincipalAccountingRebuildServiceShape {
  /** Refresh affected transfer reconciliation, then rebuild accounting from stored artifacts. */
  readonly rebuildPrincipalAccounting: (
    params: RebuildPrincipalAccountingParams
  ) => Effect.Effect<PrincipalAccountingRebuildSummary, SyncEngineStorageError>
}

/** Context tag for principal-scoped accounting rebuild orchestration. */
export class PrincipalAccountingRebuildService extends Context.Service<
  PrincipalAccountingRebuildService,
  PrincipalAccountingRebuildServiceShape
>()("PrincipalAccountingRebuildService") {}
