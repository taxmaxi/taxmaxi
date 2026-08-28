/**
 * PrincipalAccountingRebuildServiceLive - Refresh reconciliation and affected principal accounting.
 *
 * @module PrincipalAccountingRebuildServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  PrincipalAccountingRebuildRepository,
  SourceRepository,
  TransferReconciliationService,
} from "../services/index.ts"
import {
  PrincipalAccountingRebuildService,
  type PrincipalAccountingRebuildServiceShape,
} from "../services/PrincipalAccountingRebuildService.ts"

const make = Effect.gen(function* () {
  const accountingRepository = yield* PrincipalAccountingRebuildRepository
  const sourceRepository = yield* SourceRepository
  const transferReconciliation = yield* TransferReconciliationService

  const rebuildPrincipalAccounting: PrincipalAccountingRebuildServiceShape["rebuildPrincipalAccounting"] =
    (params) =>
      Effect.gen(function* () {
        if (params.affectedAssetIds.length === 0) {
          const accounting = yield* accountingRepository.rebuildPrincipalAccounting(params)
          return {
            ...accounting,
            transferCandidatesReconciled: 0,
            transferPairsCanonicalized: 0,
          }
        }

        const principalSources = yield* sourceRepository.listPrincipalSourceSyncContexts({
          principalId: params.principalId,
        })
        let transferCandidatesReconciled = 0
        let transferPairsCanonicalized = 0

        for (const source of principalSources) {
          const summary = yield* transferReconciliation.reconcileTransferCandidates({
            principalId: params.principalId,
            sourceId: source.id,
            affectedAssetIds: params.affectedAssetIds,
            rebuildFrom: params.rebuildFrom,
          })
          transferCandidatesReconciled += summary.evaluatedProviderTransfers
        }

        const canonicalization =
          yield* transferReconciliation.applyDeterministicInternalTransferCanonicalization({
            principalId: params.principalId,
            sourceId: null,
            affectedAssetIds: params.affectedAssetIds,
            rebuildFrom: params.rebuildFrom,
          })
        transferPairsCanonicalized += canonicalization.canonicalizedPairs

        const accounting = yield* accountingRepository.rebuildPrincipalAccounting(params)

        return {
          ...accounting,
          transferCandidatesReconciled,
          transferPairsCanonicalized,
        }
      })

  return PrincipalAccountingRebuildService.of({ rebuildPrincipalAccounting })
})

/** Live principal accounting rebuild orchestration layer. */
export const PrincipalAccountingRebuildServiceLive = Layer.effect(
  PrincipalAccountingRebuildService,
  make
)
