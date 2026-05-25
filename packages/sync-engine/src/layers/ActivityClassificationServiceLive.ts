/**
 * ActivityClassificationServiceLive - Deterministic fallback activity classifier.
 *
 * @module ActivityClassificationServiceLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  ActivityClassificationResult,
  ActivityClassificationReviewState,
  ActivityClassificationService,
  type ActivityClassificationServiceShape,
} from "../services/index.ts"

const buildFallbackReview = () =>
  new ActivityClassificationReviewState({
    reviewStatus: "needs_review",
    needsReview: true,
    reason: "Activity could not be classified deterministically from available facts.",
    matchedLayer: "activity_classification_fallback",
  })

const service = ActivityClassificationService.of({
  classifyActivity: ({ facts }) =>
    Effect.succeed(
      new ActivityClassificationResult({
        transactionType: "uncategorized",
        inventoryEffect: "unknown",
        taxTreatment: "requires_additional_rule_logic",
        confidence: "0.00",
        review: buildFallbackReview(),
        evidence: facts.evidence,
      })
    ),
} satisfies ActivityClassificationServiceShape)

/**
 * ActivityClassificationServiceLive - Default classifier layer with deterministic review fallback.
 */
export const ActivityClassificationServiceLive = Layer.succeed(
  ActivityClassificationService,
  service
)
