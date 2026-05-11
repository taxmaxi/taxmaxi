/**
 * TransferReconciliationServiceLive - User-scoped provider-to-onchain transfer
 * reconciliation orchestration.
 *
 * @module TransferReconciliationServiceLive
 */

import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  TransferReconciliationRepository,
  TransferReconciliationService,
  type TransferReconciliationServiceShape,
  type ProviderTransferReconciliationCandidate,
  type OnchainTransferReconciliationCandidate,
  type TransferReconciliationStatus,
  SyncEngineStorageError,
} from "../services/index.ts"

const RECONCILIATION_TIME_WINDOW_MILLIS = 12 * 60 * 60 * 1000

const toStorageError = ({
  operation,
  cause,
}: {
  readonly operation: string
  readonly cause: unknown
}) =>
  new SyncEngineStorageError({
    operation,
    cause,
  })

const decodeBigDecimal = ({
  value,
  operation,
}: {
  readonly value: string
  readonly operation: string
}): Effect.Effect<BigDecimal.BigDecimal, SyncEngineStorageError> =>
  Option.match(BigDecimal.fromString(value.trim()), {
    onNone: () =>
      toStorageError({
        operation,
        cause: `Invalid decimal value: ${value}`,
      }),
    onSome: Effect.succeed,
  })

const hasExactAmountMatch = ({
  providerAmount,
  onchainAmount,
}: {
  readonly providerAmount: string
  readonly onchainAmount: string
}) =>
  Effect.all([
    decodeBigDecimal({
      value: providerAmount,
      operation: "transferReconciliationService.compareAmounts.provider",
    }),
    decodeBigDecimal({
      value: onchainAmount,
      operation: "transferReconciliationService.compareAmounts.onchain",
    }),
  ]).pipe(Effect.map(([provider, onchain]) => BigDecimal.equals(provider, onchain)))

const candidateWalletAddress = (
  providerTransfer: ProviderTransferReconciliationCandidate
): string | null =>
  providerTransfer.direction === "outbound"
    ? providerTransfer.toAddress
    : providerTransfer.fromAddress

const toTimestampWindow = (timestamp: Date) => ({
  timestampStart: new Date(timestamp.getTime() - RECONCILIATION_TIME_WINDOW_MILLIS),
  timestampEnd: new Date(timestamp.getTime() + RECONCILIATION_TIME_WINDOW_MILLIS),
})

const buildPendingMetadata = ({
  reason,
  providerTransfer,
}: {
  readonly reason: string
  readonly providerTransfer: ProviderTransferReconciliationCandidate
}) => ({
  reason,
  direction: providerTransfer.direction,
  networkName: providerTransfer.networkName,
  networkHash: providerTransfer.networkHash,
})

const buildCandidateMetadata = ({
  candidates,
}: {
  readonly candidates: ReadonlyArray<OnchainTransferReconciliationCandidate>
}) => ({
  candidateCount: candidates.length,
  candidateTransferIds: candidates.map((candidate) => candidate.transferId),
  candidateTransactionIds: candidates.map((candidate) => candidate.transactionId),
})

const filterExactAmountCandidates = ({
  providerAmount,
  candidates,
}: {
  readonly providerAmount: string
  readonly candidates: ReadonlyArray<OnchainTransferReconciliationCandidate>
}): Effect.Effect<ReadonlyArray<OnchainTransferReconciliationCandidate>, SyncEngineStorageError> =>
  Effect.reduce(
    candidates,
    [] as ReadonlyArray<OnchainTransferReconciliationCandidate>,
    (matches, candidate) =>
      hasExactAmountMatch({
        providerAmount,
        onchainAmount: candidate.amount,
      }).pipe(
        Effect.map((isExactAmountMatch) => (isExactAmountMatch ? [...matches, candidate] : matches))
      )
  )

const summarizeOutcome = ({
  status,
  current,
}: {
  readonly status: TransferReconciliationStatus
  readonly current: {
    readonly evaluatedProviderTransfers: number
    readonly pending: number
    readonly needsReview: number
    readonly autoApplied: number
  }
}) => {
  switch (status) {
    case "pending":
      return {
        ...current,
        evaluatedProviderTransfers: current.evaluatedProviderTransfers + 1,
        pending: current.pending + 1,
      }
    case "needs_review":
      return {
        ...current,
        evaluatedProviderTransfers: current.evaluatedProviderTransfers + 1,
        needsReview: current.needsReview + 1,
      }
    case "auto_applied":
      return {
        ...current,
        evaluatedProviderTransfers: current.evaluatedProviderTransfers + 1,
        autoApplied: current.autoApplied + 1,
      }
    case "approved":
    case "rejected":
      return current
  }
}

const make = Effect.gen(function* () {
  const transferReconciliationRepository = yield* TransferReconciliationRepository

  const reconcileTransferCandidate = (
    providerTransfer: ProviderTransferReconciliationCandidate
  ): Effect.Effect<TransferReconciliationStatus, SyncEngineStorageError> =>
    Effect.gen(function* () {
      if (providerTransfer.canonicalAssetId === null) {
        yield* transferReconciliationRepository.upsertTransferReconciliation({
          userId: providerTransfer.userId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "pending",
          matchReason: "provider_asset_mapping_pending",
          confidence: "0",
          deterministic: false,
          reviewMetadata: buildPendingMetadata({
            reason: "provider_asset_mapping_pending",
            providerTransfer,
          }),
        })

        return "pending"
      }

      const walletAddress = candidateWalletAddress(providerTransfer)

      if (walletAddress === null) {
        yield* transferReconciliationRepository.upsertTransferReconciliation({
          userId: providerTransfer.userId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "pending",
          matchReason: "provider_transfer_missing_wallet_address",
          confidence: "0",
          deterministic: false,
          reviewMetadata: buildPendingMetadata({
            reason: "provider_transfer_missing_wallet_address",
            providerTransfer,
          }),
        })

        return "pending"
      }

      const { timestampStart, timestampEnd } = toTimestampWindow(providerTransfer.timestamp)
      const broadCandidates = yield* transferReconciliationRepository.findOnchainTransferCandidates(
        {
          userId: providerTransfer.userId,
          canonicalAssetId: providerTransfer.canonicalAssetId,
          direction: providerTransfer.direction,
          walletAddress,
          timestampStart,
          timestampEnd,
          networkName: providerTransfer.networkName,
          networkHash: providerTransfer.networkHash,
        }
      )

      const exactAmountCandidates = yield* filterExactAmountCandidates({
        providerAmount: providerTransfer.amount,
        candidates: broadCandidates,
      })

      if (exactAmountCandidates.length === 0) {
        yield* transferReconciliationRepository.upsertTransferReconciliation({
          userId: providerTransfer.userId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "pending",
          matchReason: "no_candidate_onchain_receipt",
          confidence: "0",
          deterministic: false,
          reviewMetadata: {
            ...buildPendingMetadata({
              reason: "no_candidate_onchain_receipt",
              providerTransfer,
            }),
            broadCandidateCount: broadCandidates.length,
            broadCandidateTransferIds: broadCandidates.map((candidate) => candidate.transferId),
          },
        })

        return "pending"
      }

      if (exactAmountCandidates.length > 1) {
        yield* transferReconciliationRepository.upsertTransferReconciliation({
          userId: providerTransfer.userId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: null,
          status: "needs_review",
          matchReason: "multiple_candidate_onchain_receipts",
          confidence: "0.5000",
          deterministic: false,
          reviewMetadata: buildCandidateMetadata({
            candidates: exactAmountCandidates,
          }),
        })

        return "needs_review"
      }

      const matchedCandidate = exactAmountCandidates[0]

      if (matchedCandidate === undefined) {
        return yield* Effect.fail(
          toStorageError({
            operation: "transferReconciliationService.reconcileTransferCandidate",
            cause: "Expected one matched candidate after filtering by exact amount.",
          })
        )
      }

      yield* transferReconciliationRepository.upsertTransferReconciliation({
        userId: providerTransfer.userId,
        providerTransferId: providerTransfer.providerTransferId,
        canonicalTransferId: matchedCandidate.transferId,
        canonicalTransactionId: matchedCandidate.transactionId,
        status: "auto_applied",
        matchReason: "deterministic_wallet_receipt_match",
        confidence: "1.0000",
        deterministic: true,
        reviewMetadata: {
          matchedTransferId: matchedCandidate.transferId,
          matchedTransactionId: matchedCandidate.transactionId,
          candidateCount: exactAmountCandidates.length,
        },
      })

      return "auto_applied"
    })

  const reconcileTransferCandidates: TransferReconciliationServiceShape["reconcileTransferCandidates"] =
    ({ userId, sourceId }) =>
      Effect.gen(function* () {
        const providerTransfers =
          yield* transferReconciliationRepository.listProviderTransfersForReconciliation({
            userId,
            sourceId,
          })

        const summary = yield* Effect.reduce(
          providerTransfers,
          {
            evaluatedProviderTransfers: 0,
            pending: 0,
            needsReview: 0,
            autoApplied: 0,
          },
          (state, providerTransfer) =>
            reconcileTransferCandidate(providerTransfer).pipe(
              Effect.map((status) =>
                summarizeOutcome({
                  status,
                  current: state,
                })
              )
            )
        )

        yield* Effect.logInfo(
          {
            userId,
            sourceId,
            evaluatedProviderTransfers: summary.evaluatedProviderTransfers,
            pending: summary.pending,
            needsReview: summary.needsReview,
            autoApplied: summary.autoApplied,
          },
          "transfer-reconciliation:completed"
        )

        return summary
      })

  const applyDeterministicInternalTransferCanonicalization: TransferReconciliationServiceShape["applyDeterministicInternalTransferCanonicalization"] =
    (params) =>
      transferReconciliationRepository.applyDeterministicInternalTransferCanonicalization(params)

  return TransferReconciliationService.of({
    reconcileTransferCandidates,
    applyDeterministicInternalTransferCanonicalization,
  } satisfies TransferReconciliationServiceShape)
})

/**
 * TransferReconciliationServiceLive - Live reconciliation orchestration layer.
 */
export const TransferReconciliationServiceLive = Layer.effect(TransferReconciliationService, make)
