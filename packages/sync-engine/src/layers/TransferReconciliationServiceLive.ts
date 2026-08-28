/**
 * TransferReconciliationServiceLive - Principal-scoped provider-to-onchain transfer
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
  type TransferReconciliationRecordDraft,
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
  candidates: candidates.map((candidate) => ({
    transferId: candidate.transferId,
    observedProviderTransferId: candidate.observedProviderTransferId,
    transactionId: candidate.transactionId,
    sourceId: candidate.sourceId,
    blockchainId: candidate.blockchainId,
    blockchainName: candidate.blockchainName,
    txHash: candidate.txHash,
    timestamp: candidate.timestamp.toISOString(),
    fromAddress: candidate.fromAddress,
    toAddress: candidate.toAddress,
    providerAssetRowId: candidate.providerAssetRowId,
    providerAssetMappingStatus: candidate.providerAssetMappingStatus,
    assetId: candidate.assetId,
    assetRepresentationId: candidate.assetRepresentationId,
    representationType: candidate.representationType,
    contractAddress: candidate.contractAddress,
    mintAddress: candidate.mintAddress,
    decimals: candidate.decimals,
    amount: candidate.amount,
  })),
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
    () => [] as ReadonlyArray<OnchainTransferReconciliationCandidate>,
    (matches, candidate) =>
      hasExactAmountMatch({
        providerAmount,
        onchainAmount: candidate.amount,
      }).pipe(
        Effect.map((isExactAmountMatch) => (isExactAmountMatch ? [...matches, candidate] : matches))
      )
  )

const reconciliationCandidateFingerprint = (
  candidate: OnchainTransferReconciliationCandidate
): string =>
  JSON.stringify([
    candidate.transferId,
    candidate.observedProviderTransferId,
    candidate.transactionId,
    candidate.sourceId,
    candidate.addressId,
    candidate.blockchainId,
    candidate.blockchainName,
    candidate.txHash,
    candidate.timestamp.toISOString(),
    candidate.fromAddress,
    candidate.toAddress,
    candidate.providerAssetRowId,
    candidate.providerAssetMappingStatus,
    candidate.assetId,
    candidate.assetRepresentationId,
    candidate.representationType,
    candidate.contractAddress,
    candidate.mintAddress,
    candidate.decimals,
    candidate.amount,
  ])

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
      const walletAddress = candidateWalletAddress(providerTransfer)

      if (walletAddress === null && providerTransfer.networkHash === null) {
        yield* transferReconciliationRepository.upsertTransferReconciliation({
          principalId: providerTransfer.principalId,
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
          principalId: providerTransfer.principalId,
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
      const candidateSnapshot = {
        search: {
          principalId: providerTransfer.principalId,
          direction: providerTransfer.direction,
          walletAddress,
          timestampStart,
          timestampEnd,
          networkName: providerTransfer.networkName,
          networkHash: providerTransfer.networkHash,
        },
        providerAmount: providerTransfer.amount,
        candidateFingerprints: exactAmountCandidates.map(reconciliationCandidateFingerprint),
      }
      const persistCandidateState = (
        draft: Omit<TransferReconciliationRecordDraft, "candidateSnapshot">
      ) =>
        transferReconciliationRepository
          .upsertTransferReconciliation({
            ...draft,
            candidateSnapshot,
          })
          .pipe(
            Effect.flatMap(({ conflictingProviderTransferId, status: persistedStatus }) =>
              conflictingProviderTransferId === null
                ? Effect.succeed(persistedStatus)
                : transferReconciliationRepository
                    .upsertTransferReconciliation({
                      principalId: draft.principalId,
                      providerTransferId: conflictingProviderTransferId,
                      canonicalTransferId: null,
                      canonicalTransactionId: null,
                      status: "needs_review",
                      matchReason: "canonical_transfer_claim_conflict",
                      confidence: "0.0000",
                      deterministic: false,
                      reviewMetadata: {
                        conflictingProviderTransferId: draft.providerTransferId,
                      },
                    })
                    .pipe(Effect.as(persistedStatus))
            )
          )

      if (exactAmountCandidates.length === 0) {
        return yield* persistCandidateState({
          principalId: providerTransfer.principalId,
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
      }

      if (exactAmountCandidates.length > 1) {
        return yield* persistCandidateState({
          principalId: providerTransfer.principalId,
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
      }

      const matchedCandidate = exactAmountCandidates[0]

      if (matchedCandidate === undefined) {
        return yield* toStorageError({
          operation: "transferReconciliationService.reconcileTransferCandidate",
          cause: "Expected one matched candidate after filtering by exact amount.",
        })
      }

      const candidateMetadata = buildCandidateMetadata({ candidates: [matchedCandidate] })

      if (providerTransfer.canonicalAssetId === null) {
        return yield* persistCandidateState({
          principalId: providerTransfer.principalId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: matchedCandidate.transactionId,
          status: "pending",
          matchReason: "provider_asset_mapping_pending",
          confidence: "0.7500",
          deterministic: false,
          reviewMetadata: {
            ...buildPendingMetadata({
              reason: "provider_asset_mapping_pending",
              providerTransfer,
            }),
            ...candidateMetadata,
          },
        })
      }

      if (matchedCandidate.providerAssetMappingStatus === "rejected") {
        return yield* persistCandidateState({
          principalId: providerTransfer.principalId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: matchedCandidate.transactionId,
          status: "needs_review",
          matchReason: "destination_representation_mapping_rejected",
          confidence: "0.7500",
          deterministic: false,
          reviewMetadata: candidateMetadata,
        })
      }

      if (
        matchedCandidate.providerAssetMappingStatus === "approved" &&
        matchedCandidate.assetId !== null &&
        matchedCandidate.assetRepresentationId !== null
      ) {
        if (matchedCandidate.assetId !== providerTransfer.canonicalAssetId) {
          return yield* persistCandidateState({
            principalId: providerTransfer.principalId,
            providerTransferId: providerTransfer.providerTransferId,
            canonicalTransferId: null,
            canonicalTransactionId: matchedCandidate.transactionId,
            status: "needs_review",
            matchReason: "representation_economic_asset_conflict",
            confidence: "1.0000",
            deterministic: false,
            reviewMetadata: {
              providerCanonicalAssetId: providerTransfer.canonicalAssetId,
              ...candidateMetadata,
            },
          })
        }

        if (
          providerTransfer.assetRepresentationId !== null &&
          matchedCandidate.assetRepresentationId !== providerTransfer.assetRepresentationId
        ) {
          return yield* persistCandidateState({
            principalId: providerTransfer.principalId,
            providerTransferId: providerTransfer.providerTransferId,
            canonicalTransferId: null,
            canonicalTransactionId: matchedCandidate.transactionId,
            status: "needs_review",
            matchReason: "provider_asset_representation_conflict",
            confidence: "1.0000",
            deterministic: false,
            reviewMetadata: {
              providerAssetRepresentationId: providerTransfer.assetRepresentationId,
              ...candidateMetadata,
            },
          })
        }

        if (matchedCandidate.transferId === null) {
          return yield* persistCandidateState({
            principalId: providerTransfer.principalId,
            providerTransferId: providerTransfer.providerTransferId,
            canonicalTransferId: null,
            canonicalTransactionId: matchedCandidate.transactionId,
            status: "pending",
            matchReason: "destination_source_replay_pending",
            confidence: "1.0000",
            deterministic: false,
            reviewMetadata: candidateMetadata,
          })
        }

        return yield* persistCandidateState({
          principalId: providerTransfer.principalId,
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
            representationId: matchedCandidate.assetRepresentationId,
            revalidateMovementFacts: true,
          },
        })
      }

      const hasObservedIdentity =
        matchedCandidate.blockchainId !== null &&
        (matchedCandidate.representationType === "native" ||
          matchedCandidate.contractAddress !== null ||
          matchedCandidate.mintAddress !== null)

      if (
        matchedCandidate.providerAssetRowId !== null &&
        matchedCandidate.observedProviderTransferId !== null &&
        hasObservedIdentity
      ) {
        const persistedStatus = yield* persistCandidateState({
          principalId: providerTransfer.principalId,
          providerTransferId: providerTransfer.providerTransferId,
          canonicalTransferId: null,
          canonicalTransactionId: matchedCandidate.transactionId,
          status: "pending",
          matchReason: "asset_representation_review_pending",
          confidence: providerTransfer.networkHash === null ? "0.9000" : "1.0000",
          deterministic: false,
          reviewMetadata: {
            proposedCanonicalAssetId: providerTransfer.canonicalAssetId,
            evidenceKind:
              providerTransfer.networkHash === null
                ? "owned_address_amount_time_window"
                : walletAddress === null
                  ? "network_hash_amount"
                  : "network_hash_owned_address_amount",
            ...candidateMetadata,
          },
        })

        if (persistedStatus !== "pending") {
          return persistedStatus
        }

        yield* transferReconciliationRepository.recordOnchainRepresentationEvidence({
          providerAssetRowId: matchedCandidate.providerAssetRowId,
          sourceProviderTransferId: providerTransfer.providerTransferId,
          destinationProviderTransferId: matchedCandidate.observedProviderTransferId,
          proposedCanonicalAssetId: providerTransfer.canonicalAssetId,
        })

        return persistedStatus
      }

      return yield* persistCandidateState({
        principalId: providerTransfer.principalId,
        providerTransferId: providerTransfer.providerTransferId,
        canonicalTransferId: null,
        canonicalTransactionId: matchedCandidate.transactionId,
        status: "pending",
        matchReason: "destination_representation_observation_missing",
        confidence: "0.7500",
        deterministic: false,
        reviewMetadata: candidateMetadata,
      })
    })

  const reconcileTransferCandidates: TransferReconciliationServiceShape["reconcileTransferCandidates"] =
    ({ principalId, sourceId, affectedAssetIds, rebuildFrom }) =>
      Effect.gen(function* () {
        const listedProviderTransfers =
          yield* transferReconciliationRepository.listProviderTransfersForReconciliation({
            principalId,
            sourceId,
          })
        const affectedAssetIdSet = affectedAssetIds === undefined ? null : new Set(affectedAssetIds)
        const providerTransfers = listedProviderTransfers.filter(
          (transfer) =>
            (rebuildFrom === undefined || transfer.timestamp >= rebuildFrom) &&
            (affectedAssetIdSet === null ||
              (transfer.canonicalAssetId !== null &&
                affectedAssetIdSet.has(transfer.canonicalAssetId)))
        )

        const summary = yield* Effect.reduce(
          providerTransfers,
          () => ({
            evaluatedProviderTransfers: 0,
            pending: 0,
            needsReview: 0,
            autoApplied: 0,
          }),
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
            principalId,
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

  const rollbackReconciliationsForSourceReplay: TransferReconciliationServiceShape["rollbackReconciliationsForSourceReplay"] =
    (params) => transferReconciliationRepository.rollbackReconciliationsForSourceReplay(params)

  return TransferReconciliationService.of({
    reconcileTransferCandidates,
    rollbackReconciliationsForSourceReplay,
    applyDeterministicInternalTransferCanonicalization,
  } satisfies TransferReconciliationServiceShape)
})

/**
 * TransferReconciliationServiceLive - Live reconciliation orchestration layer.
 */
export const TransferReconciliationServiceLive = Layer.effect(TransferReconciliationService, make)
