/**
 * ActivityClassificationService - Source-agnostic activity classification contract.
 *
 * @module ActivityClassificationService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * ActivitySourceKind - Provider family represented by normalized activity facts.
 */
export const ActivitySourceKind = Schema.Literal("cex", "solana", "evm", "bitcoin", "unknown")

export type ActivitySourceKind = typeof ActivitySourceKind.Type

/**
 * ActivityMovementDirection - Principal-relative movement direction.
 */
export const ActivityMovementDirection = Schema.Literal("inbound", "outbound", "neutral")

export type ActivityMovementDirection = typeof ActivityMovementDirection.Type

/**
 * ActivityMovementRole - Accounting role suggested by normalized facts.
 */
export const ActivityMovementRole = Schema.Literal(
  "principal",
  "fee",
  "gas",
  "reward",
  "rent",
  "change",
  "unknown"
)

export type ActivityMovementRole = typeof ActivityMovementRole.Type

/**
 * ActivityEvidenceKind - Evidence categories classifiers may preserve for review.
 */
export const ActivityEvidenceKind = Schema.Literal(
  "provider_label",
  "provider_payload",
  "balance_delta",
  "token_balance_delta",
  "parsed_transfer",
  "instruction",
  "event",
  "utxo_pattern",
  "cex_row",
  "transfer_row",
  "review_note"
)

export type ActivityEvidenceKind = typeof ActivityEvidenceKind.Type

/**
 * ActivityInventoryEffect - Source-agnostic inventory effect vocabulary.
 */
export const ActivityInventoryEffect = Schema.Literal(
  "acquisition",
  "disposal",
  "income",
  "internal_transfer",
  "non_inventory",
  "unknown"
)

export type ActivityInventoryEffect = typeof ActivityInventoryEffect.Type

/**
 * ActivityTaxTreatment - Source-agnostic tax treatment vocabulary.
 */
export const ActivityTaxTreatment = Schema.Literal(
  "taxable_by_default",
  "non_taxable_by_default",
  "requires_additional_rule_logic"
)

export type ActivityTaxTreatment = typeof ActivityTaxTreatment.Type

/**
 * ActivityReviewStatus - Review lifecycle values produced by classification.
 */
export const ActivityReviewStatus = Schema.Literal(
  "auto_applied",
  "needs_review",
  "approved",
  "changed"
)

export type ActivityReviewStatus = typeof ActivityReviewStatus.Type

/**
 * ActivityEvidence - Structured evidence that explains a classification decision.
 */
export class ActivityEvidence extends Schema.Class<ActivityEvidence>("ActivityEvidence")({
  kind: ActivityEvidenceKind,
  source: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
}) {}

/**
 * ActivityMovementFacts - Source-agnostic principal movement facts.
 */
export class ActivityMovementFacts extends Schema.Class<ActivityMovementFacts>(
  "ActivityMovementFacts"
)({
  direction: ActivityMovementDirection,
  role: ActivityMovementRole,
  assetId: Schema.NullOr(Schema.String),
  assetSymbol: Schema.NullOr(Schema.String),
  amount: Schema.NullOr(Schema.String),
  fiatAmount: Schema.NullOr(Schema.String),
  fiatCurrency: Schema.NullOr(Schema.String),
  address: Schema.NullOr(Schema.String),
  accountRef: Schema.NullOr(Schema.String),
  tokenId: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
}) {}

/**
 * ActivityCexFacts - CEX-specific normalized context carried as facts, not result fields.
 */
export class ActivityCexFacts extends Schema.Class<ActivityCexFacts>("ActivityCexFacts")({
  cexName: Schema.NullOr(Schema.String),
  externalAccountId: Schema.NullOr(Schema.String),
  externalOrderId: Schema.NullOr(Schema.String),
  externalFillId: Schema.NullOr(Schema.String),
  venueSide: Schema.NullOr(Schema.String),
  instrument: Schema.NullOr(Schema.String),
  rowType: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
}) {}

/**
 * ActivityOnchainEntrypointFacts - Chain entrypoint evidence such as programs,
 * instructions, contracts, selectors, events, and scripts.
 */
export class ActivityOnchainEntrypointFacts extends Schema.Class<ActivityOnchainEntrypointFacts>(
  "ActivityOnchainEntrypointFacts"
)({
  kind: Schema.Literal("program", "instruction", "contract", "selector", "event", "script"),
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  metadata: Schema.Unknown,
}) {}

/**
 * ActivityOnchainFacts - Onchain context shared by Solana, EVM, Bitcoin, and future chains.
 */
export class ActivityOnchainFacts extends Schema.Class<ActivityOnchainFacts>(
  "ActivityOnchainFacts"
)({
  chainType: Schema.Literal("solana", "evm", "bitcoin", "unknown"),
  blockchainId: Schema.NullOr(Schema.String),
  txHash: Schema.NullOr(Schema.String),
  blockNumber: Schema.NullOr(Schema.String),
  status: Schema.Literal("succeeded", "failed", "unknown"),
  feePayer: Schema.NullOr(Schema.String),
  entrypoints: Schema.Array(ActivityOnchainEntrypointFacts),
  metadata: Schema.Unknown,
}) {}

/**
 * ActivityUtxoFacts - Bitcoin/UTXO pattern facts without committing result shape to Bitcoin.
 */
export class ActivityUtxoFacts extends Schema.Class<ActivityUtxoFacts>("ActivityUtxoFacts")({
  inputCount: Schema.Number,
  outputCount: Schema.Number,
  ownedInputCount: Schema.Number,
  ownedOutputCount: Schema.Number,
  changeOutputCount: Schema.Number,
  metadata: Schema.Unknown,
}) {}

/**
 * ActivityFacts - Provider-normalized activity facts consumed by classifiers.
 */
export class ActivityFacts extends Schema.Class<ActivityFacts>("ActivityFacts")({
  sourceKind: ActivitySourceKind,
  providerKey: Schema.String,
  sourceId: Schema.NullOr(Schema.String),
  externalId: Schema.NullOr(Schema.String),
  occurredAt: Schema.DateFromSelf,
  providerActivityType: Schema.NullOr(Schema.String),
  movements: Schema.Array(ActivityMovementFacts),
  cex: Schema.NullOr(ActivityCexFacts),
  onchain: Schema.NullOr(ActivityOnchainFacts),
  utxo: Schema.NullOr(ActivityUtxoFacts),
  rawPayload: Schema.Unknown,
  evidence: Schema.Array(ActivityEvidence),
}) {}

/**
 * ActivityClassificationReviewState - Review metadata produced by classification.
 */
export class ActivityClassificationReviewState extends Schema.Class<ActivityClassificationReviewState>(
  "ActivityClassificationReviewState"
)({
  reviewStatus: ActivityReviewStatus,
  needsReview: Schema.Boolean,
  reason: Schema.String,
  matchedLayer: Schema.String,
}) {}

/**
 * ActivityClassificationResult - Canonical classification output for persistence and UX.
 */
export class ActivityClassificationResult extends Schema.Class<ActivityClassificationResult>(
  "ActivityClassificationResult"
)({
  transactionType: Schema.String,
  inventoryEffect: ActivityInventoryEffect,
  taxTreatment: ActivityTaxTreatment,
  confidence: Schema.String,
  review: ActivityClassificationReviewState,
  evidence: Schema.Array(ActivityEvidence),
}) {}

/**
 * ClassifyActivityParams - Facts required to classify one normalized activity.
 */
export interface ClassifyActivityParams {
  readonly facts: ActivityFacts
}

/**
 * ActivityClassificationServiceShape - Source-agnostic activity classification service.
 */
export interface ActivityClassificationServiceShape {
  readonly classifyActivity: (
    params: ClassifyActivityParams
  ) => Effect.Effect<ActivityClassificationResult>
}

/**
 * ActivityClassificationService - Context tag for activity classification.
 */
export class ActivityClassificationService extends Context.Tag("ActivityClassificationService")<
  ActivityClassificationService,
  ActivityClassificationServiceShape
>() {}
