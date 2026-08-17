/**
 * ProviderAssetReviewServiceLive - Provider asset review orchestration.
 *
 * @module ProviderAssetReviewServiceLive
 */

import {
  ProviderAssetReplayService,
  ProviderAssetRepository,
  type ProviderAssetReviewReplay,
  type ProviderAssetReviewRecord,
} from "@my/sync-engine/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  AssetCanonicalizationService,
  type AssetCanonicalizationError,
} from "../services/AssetCanonicalizationService.ts"
import { ProviderAssetCandidateService } from "../services/ProviderAssetCandidateService.ts"
import {
  ProviderAssetReviewBadRequestError,
  ProviderAssetReviewConflictError,
  ProviderAssetReviewInternalError,
  ProviderAssetReviewNotFoundError,
  ProviderAssetReviewService,
  type ProviderAssetReviewError,
  type ProviderAssetLatestDecision,
  type ProviderAssetReviewServiceShape,
  type ProviderAssetInvestigationLink,
  type ProviderAssetResolutionEffect,
  type ProviderAssetReviewSummary,
} from "../services/ProviderAssetReviewService.ts"

const ProviderImageEvidence = Schema.Struct({
  image: Schema.optional(Schema.String),
  imageUrl: Schema.optional(Schema.String),
  logoUrl: Schema.optional(Schema.String),
})

const decodeProviderImage = (payload: unknown): string | null => {
  const evidence = Schema.decodeUnknownOption(ProviderImageEvidence)(payload)
  if (Option.isNone(evidence)) return null

  return evidence.value.image ?? evidence.value.imageUrl ?? evidence.value.logoUrl ?? null
}

const investigationLinksFor = ({
  observedRepresentations,
}: {
  readonly observedRepresentations: ReadonlyArray<{
    readonly blockchainName: string
    readonly mintAddress: string | null
  }>
}): ReadonlyArray<ProviderAssetInvestigationLink> =>
  observedRepresentations.flatMap((observation) => {
    if (observation.blockchainName.trim().toLowerCase() !== "solana") return []
    if (observation.mintAddress === null) return []

    return [
      {
        _tag: "chain_explorer",
        label: "View mint on Solscan",
        source: "solscan",
        url: `https://solscan.io/token/${encodeURIComponent(observation.mintAddress)}`,
      } satisfies ProviderAssetInvestigationLink,
    ]
  })

const reviewRevisionFor = (review: {
  readonly providerAsset: { readonly retrievedAt: Date }
  readonly mapping: { readonly updatedAt: Date } | null
  readonly evidenceRevision: string
}): string =>
  `${review.providerAsset.retrievedAt.toISOString()}:${review.mapping?.updatedAt.toISOString() ?? "unmapped"}:${review.evidenceRevision}`

const latestDecisionFor = (
  mapping: ProviderAssetReviewRecord["mapping"]
): ProviderAssetLatestDecision | null =>
  mapping === null
    ? null
    : {
        ...mapping,
        reviewedAt: mapping.reviewedAt?.toISOString() ?? null,
        updatedAt: mapping.updatedAt.toISOString(),
      }

const resolutionEffectsMatch = (
  proposal: ProviderAssetResolutionEffect,
  decision: ProviderAssetResolutionEffect
): boolean => {
  if (proposal._tag !== decision._tag) return false

  switch (proposal._tag) {
    case "UseExistingAsset":
      return (
        decision._tag === proposal._tag && decision.canonicalAssetId === proposal.canonicalAssetId
      )
    case "UseExistingRepresentation":
      return (
        decision._tag === proposal._tag &&
        decision.canonicalAssetId === proposal.canonicalAssetId &&
        decision.assetRepresentationId === proposal.assetRepresentationId
      )
    case "AddRepresentation":
      return (
        decision._tag === proposal._tag &&
        decision.canonicalAssetId === proposal.canonicalAssetId &&
        decision.selectedCoinGeckoCoinId === proposal.selectedCoinGeckoCoinId
      )
    case "CreateEconomicAsset":
    case "CreateAssetWithRepresentation":
      return (
        decision._tag === proposal._tag &&
        decision.selectedCoinGeckoCoinId === proposal.selectedCoinGeckoCoinId
      )
  }
}

const toReviewSummary = ({
  review,
  investigationLinks,
}: {
  readonly review: ProviderAssetReviewRecord
  readonly investigationLinks: ReadonlyArray<ProviderAssetInvestigationLink>
}): ProviderAssetReviewSummary => ({
  id: review.providerAsset.id,
  provider: review.providerAsset.provider,
  providerAssetId: review.providerAsset.providerAssetId,
  naturalKey: review.providerAsset.naturalKey,
  symbol: review.providerAsset.currencyCode,
  name: review.providerAsset.name,
  assetType: review.providerAsset.providerType,
  source: {
    _tag: review.providerAsset.provider.includes("helius") ? "chain" : "cex",
    name: review.providerAsset.provider,
  },
  imageUrl: decodeProviderImage(review.providerAsset.rawProviderPayload),
  evidenceState: review.evidenceState,
  affectedSourceCount: review.affectedSourceCount,
  discoveredAt: review.providerAsset.discoveredAt,
  reviewRevision: reviewRevisionFor(review),
  investigationLinks,
})

const mapCanonicalizationError = (error: {
  readonly _tag: string
  readonly message: string
}): ProviderAssetReviewError => {
  switch (error._tag) {
    case "AssetCanonicalizationBadRequestError":
      return new ProviderAssetReviewBadRequestError({ message: error.message })
    case "AssetCanonicalizationNotFoundError":
      return new ProviderAssetReviewNotFoundError({ message: error.message })
    case "AssetCanonicalizationConflictError":
      return new ProviderAssetReviewConflictError({ message: error.message })
    default:
      return new ProviderAssetReviewInternalError({ message: error.message })
  }
}

const make = Effect.gen(function* () {
  const candidates = yield* ProviderAssetCandidateService
  const canonicalization = yield* AssetCanonicalizationService
  const providerAssets = yield* ProviderAssetRepository
  const replays = yield* ProviderAssetReplayService

  const loadReview = (providerAssetRowId: string) =>
    providerAssets.findProviderAssetReviewById({ providerAssetRowId }).pipe(
      Effect.mapError(
        () => new ProviderAssetReviewInternalError({ message: "Failed to load provider asset." })
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProviderAssetReviewNotFoundError({ message: "Provider asset not found." })
            ),
          onSome: Effect.succeed,
        })
      )
    )

  const scheduleDecisionReplays = ({
    providerAssetRowId,
    pendingReplays,
  }: {
    readonly providerAssetRowId: string
    readonly pendingReplays: ReadonlyArray<ProviderAssetReviewReplay>
  }) =>
    replays.scheduleReplays({ providerAssetRowId, replays: pendingReplays }).pipe(
      Effect.mapError(
        () =>
          new ProviderAssetReviewInternalError({
            message: "Failed to record replay scheduling results.",
          })
      )
    )

  const recoverDecisionError = ({
    providerAssetRowId,
    reviewRevision,
    error,
  }: {
    readonly providerAssetRowId: string
    readonly reviewRevision: string
    readonly error: AssetCanonicalizationError
  }): Effect.Effect<never, ProviderAssetReviewError> =>
    Effect.gen(function* () {
      const latest = yield* loadReview(providerAssetRowId)
      if (
        latest.mapping?.mappingStatus !== "pending_review" ||
        reviewRevisionFor(latest) !== reviewRevision
      ) {
        return yield* new ProviderAssetReviewConflictError({
          message: "Provider asset changed while applying the decision.",
          latestDecision: latestDecisionFor(latest.mapping),
        })
      }
      return yield* mapCanonicalizationError(error)
    })

  const recoverRejectionError = ({
    providerAssetRowId,
    reviewRevision,
  }: {
    readonly providerAssetRowId: string
    readonly reviewRevision: string
  }): Effect.Effect<never, ProviderAssetReviewError> =>
    Effect.gen(function* () {
      const latest = yield* loadReview(providerAssetRowId)
      if (
        latest.mapping?.mappingStatus !== "pending_review" ||
        reviewRevisionFor(latest) !== reviewRevision
      ) {
        return yield* new ProviderAssetReviewConflictError({
          message: "Provider asset changed before rejection.",
          latestDecision: latestDecisionFor(latest.mapping),
        })
      }
      return yield* new ProviderAssetReviewInternalError({
        message: "Failed to reject provider asset.",
      })
    })

  const decide: ProviderAssetReviewServiceShape["decide"] = ({
    providerAssetRowId,
    decision,
    proposalQuery = null,
    reviewRevision,
    reviewerNotes,
    reviewedBy,
  }) =>
    Effect.gen(function* () {
      const review = yield* loadReview(providerAssetRowId)
      if (
        review.mapping?.mappingStatus !== "pending_review" ||
        reviewRevisionFor(review) !== reviewRevision
      ) {
        return yield* new ProviderAssetReviewConflictError({
          message: "Provider asset changed or has already been reviewed.",
          latestDecision: latestDecisionFor(review.mapping),
        })
      }

      if (decision._tag === "Reject") {
        const notes = reviewerNotes?.trim() ?? ""
        if (notes === "") {
          return yield* new ProviderAssetReviewBadRequestError({
            message: "Reviewer notes are required when rejecting an observation.",
          })
        }
        const updated = yield* providerAssets
          .rejectProviderAssetMapping({
            providerAssetRowId,
            reviewerNotes: notes,
            reviewedBy,
            reviewedAt: new Date(),
            expectedProviderAssetRetrievedAt: review.providerAsset.retrievedAt,
            expectedMappingUpdatedAt: review.mapping.updatedAt,
            expectedEvidenceRevision: review.evidenceRevision,
          })
          .pipe(Effect.catch(() => recoverRejectionError({ providerAssetRowId, reviewRevision })))
        if (!updated) {
          const latest = yield* loadReview(providerAssetRowId)
          return yield* new ProviderAssetReviewConflictError({
            message: "Provider asset has already been reviewed.",
            latestDecision: latestDecisionFor(latest.mapping),
          })
        }
        return {
          resolutionEffect: null,
          replays: [],
        }
      }

      const available = yield* candidates
        .searchProposals({ providerAssetRowId, query: proposalQuery })
        .pipe(
          Effect.mapError(
            (error) => new ProviderAssetReviewInternalError({ message: error.message })
          )
        )
      const proposal = available.proposals.find(({ id }) => id === decision.proposalId)
      if (
        proposal === undefined ||
        !resolutionEffectsMatch(proposal.effect, decision.effect) ||
        proposal.conflicts.length > 0
      ) {
        return yield* new ProviderAssetReviewBadRequestError({
          message: "The selected resolution proposal is no longer valid.",
        })
      }

      switch (decision.effect._tag) {
        case "UseExistingAsset":
        case "UseExistingRepresentation": {
          const result = yield* canonicalization
            .approveProviderAssetMapping({
              providerAssetRowId,
              canonicalAssetId: decision.effect.canonicalAssetId,
              assetRepresentationId:
                decision.effect._tag === "UseExistingRepresentation"
                  ? decision.effect.assetRepresentationId
                  : null,
              reviewerNotes,
              reviewedBy,
              requirePendingReview: true,
              expectedMappingUpdatedAt: review.mapping.updatedAt,
            })
            .pipe(
              Effect.catch((error) =>
                recoverDecisionError({ providerAssetRowId, reviewRevision, error })
              )
            )
          const replayStatuses = yield* scheduleDecisionReplays({
            providerAssetRowId,
            pendingReplays: result.replays,
          })
          return {
            resolutionEffect: decision.effect,
            replays: replayStatuses,
          }
        }
        case "CreateEconomicAsset": {
          const result = yield* canonicalization
            .canonicalizeEconomicAssetFromCoinGecko({
              providerAssetRowId,
              coinId: decision.effect.selectedCoinGeckoCoinId,
              reviewerNotes,
              reviewedBy,
              requirePendingReview: true,
              expectedMappingUpdatedAt: review.mapping.updatedAt,
            })
            .pipe(
              Effect.catch((error) =>
                recoverDecisionError({ providerAssetRowId, reviewRevision, error })
              )
            )
          const replayStatuses = yield* scheduleDecisionReplays({
            providerAssetRowId,
            pendingReplays: result.replays,
          })
          return {
            resolutionEffect: decision.effect,
            replays: replayStatuses,
          }
        }
        case "AddRepresentation":
        case "CreateAssetWithRepresentation": {
          const result = yield* canonicalization
            .canonicalizeProviderAssetFromCoinGecko({
              providerAssetRowId,
              coinId: decision.effect.selectedCoinGeckoCoinId,
              ...(decision.effect._tag === "AddRepresentation"
                ? { expectedCanonicalAssetId: decision.effect.canonicalAssetId }
                : {}),
              reviewerNotes,
              reviewedBy,
              requirePendingReview: true,
              expectedMappingUpdatedAt: review.mapping.updatedAt,
            })
            .pipe(
              Effect.catch((error) =>
                recoverDecisionError({ providerAssetRowId, reviewRevision, error })
              )
            )
          const replayStatuses = yield* scheduleDecisionReplays({
            providerAssetRowId,
            pendingReplays: result.replays,
          })
          return { resolutionEffect: decision.effect, replays: replayStatuses }
        }
      }
    })

  const mapReplayError = (error: { readonly kind: "conflict" | "internal" | "not_found" }) => {
    switch (error.kind) {
      case "conflict":
        return new ProviderAssetReviewConflictError({
          message: "Replay was retried by another request.",
        })
      case "not_found":
        return new ProviderAssetReviewNotFoundError({ message: "Replay not found." })
      case "internal":
        return new ProviderAssetReviewInternalError({ message: "Replay operation failed." })
    }
  }

  return ProviderAssetReviewService.of({
    listReviews: (params) =>
      providerAssets
        .listProviderAssetReviews({
          providerKey: params.provider,
          mappingStatus: params.status,
          evidenceState: params.evidenceState,
          query: params.query,
          cursor: params.cursor,
          limit: params.limit,
        })
        .pipe(
          Effect.map((reviews) =>
            reviews.map((review) => toReviewSummary({ review, investigationLinks: [] }))
          ),
          Effect.mapError(
            () => new ProviderAssetReviewInternalError({ message: "Failed to list reviews." })
          )
        ),
    getReview: ({ providerAssetRowId }) =>
      Effect.gen(function* () {
        const review = yield* loadReview(providerAssetRowId)
        if (review.mapping?.mappingKind === "fiat") {
          return yield* new ProviderAssetReviewNotFoundError({
            message: "Provider asset review not found.",
          })
        }
        const [observedRepresentations, reviewReplays] = yield* Effect.all([
          providerAssets.listProviderAssetObservedRepresentations({ providerAssetRowId }).pipe(
            Effect.mapError(
              () =>
                new ProviderAssetReviewInternalError({
                  message: "Failed to load review evidence.",
                })
            )
          ),
          providerAssets.listProviderAssetReviewReplays({ providerAssetRowId }).pipe(
            Effect.mapError(
              () =>
                new ProviderAssetReviewInternalError({
                  message: "Failed to load review replays.",
                })
            )
          ),
        ])
        const replayStatuses = yield* Effect.forEach(
          reviewReplays,
          (replay) =>
            replays
              .getReplay({
                providerAssetRowId,
                sourceId: replay.sourceId,
                jobId: replay.jobId,
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new ProviderAssetReviewInternalError({
                      message: "Failed to load review replay status.",
                    })
                )
              ),
          { concurrency: 5 }
        )
        const investigationLinks = investigationLinksFor({ observedRepresentations })

        return {
          ...toReviewSummary({ review, investigationLinks }),
          rawEvidence: review.providerAsset.rawProviderPayload,
          observedRepresentations,
          mapping: review.mapping,
          replays: replayStatuses,
        }
      }),
    searchProposals: ({ providerAssetRowId, query }) =>
      Effect.gen(function* () {
        const review = yield* loadReview(providerAssetRowId)
        if (review.mapping?.mappingKind === "fiat") {
          return yield* new ProviderAssetReviewBadRequestError({
            message: "Fiat observations are resolved outside the review workflow.",
          })
        }

        return yield* candidates
          .searchProposals({ providerAssetRowId, query })
          .pipe(
            Effect.mapError(
              (error) => new ProviderAssetReviewInternalError({ message: error.message })
            )
          )
      }),
    decide,
    getReplay: (params) => replays.getReplay(params).pipe(Effect.mapError(mapReplayError)),
    retryReplay: (params) => replays.retryReplay(params).pipe(Effect.mapError(mapReplayError)),
  })
})

/** Live provider asset review orchestration. */
export const ProviderAssetReviewServiceLive = Layer.effect(ProviderAssetReviewService, make)
