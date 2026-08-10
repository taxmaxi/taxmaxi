/**
 * TransactionsApi - Principal-owned accounting transaction read resources.
 *
 * @module TransactionsApi
 */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { InternalServerError, UnauthorizedError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class TransactionBadRequestError extends Schema.TaggedError<TransactionBadRequestError>()(
  "TransactionBadRequestError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 })
) {}

export class TransactionNotFoundError extends Schema.TaggedError<TransactionNotFoundError>()(
  "TransactionNotFoundError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

export const TransactionReviewState = Schema.Literal(
  "unreviewed",
  "auto_applied",
  "needs_review",
  "approved",
  "changed"
)
export const TransactionTaxTreatment = Schema.Literal(
  "taxable",
  "tax_free",
  "deductible",
  "non_taxable",
  "unknown",
  "mixed"
)
export const TransactionCalculationStatus = Schema.Literal("complete", "partial", "pending")

export const TransactionListParams = Schema.Struct({
  sourceId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.NumberFromString.pipe(
      Schema.int(),
      Schema.greaterThanOrEqualTo(1),
      Schema.lessThanOrEqualTo(100)
    )
  ),
  search: Schema.optional(Schema.String),
  classificationKey: Schema.optional(Schema.String),
  categoryKey: Schema.optional(Schema.String),
  reviewState: Schema.optional(TransactionReviewState),
})

export class TransactionAsset extends Schema.Class<TransactionAsset>("TransactionAsset")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
}) {}

export class TransactionSource extends Schema.Class<TransactionSource>("TransactionSource")({
  sourceId: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("onchain", "cex", "dex"),
  provider: Schema.NullOr(Schema.String),
  displayReference: Schema.NullOr(Schema.String),
}) {}

export class TransactionClassification extends Schema.Class<TransactionClassification>(
  "TransactionClassification"
)({
  key: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  categoryKey: Schema.NullOr(Schema.String),
  categoryLabel: Schema.NullOr(Schema.String),
  reviewState: TransactionReviewState,
  needsReview: Schema.Boolean,
}) {}

export class TransactionFiatValue extends Schema.Class<TransactionFiatValue>(
  "TransactionFiatValue"
)({ amount: Schema.String, currency: Schema.String }) {}

export class TransactionDerivation extends Schema.Class<TransactionDerivation>(
  "TransactionDerivation"
)({
  provenance: Schema.Literal("deterministic", "rule", "ai", "manual"),
  rule: Schema.NullOr(Schema.String),
}) {}

export class TransactionCustodyState extends Schema.Class<TransactionCustodyState>(
  "TransactionCustodyState"
)({
  purpose: Schema.Literal("principal", "fee", "reward"),
  taxTreatment: Schema.Literal("taxable", "non_taxable", "pending_review"),
  reconciliationStatus: Schema.Literal("unmatched", "matched", "needs_review"),
}) {}

export class TransactionMovement extends Schema.Class<TransactionMovement>("TransactionMovement")({
  movementId: Schema.String,
  legId: Schema.NullOr(Schema.String),
  asset: TransactionAsset,
  kind: Schema.Literal("acquisition", "disposal", "income", "fee", "custody"),
  direction: Schema.Literal("inbound", "outbound"),
  amount: Schema.String,
  fiatValue: Schema.NullOr(TransactionFiatValue),
  derivation: Schema.NullOr(TransactionDerivation),
  custody: Schema.NullOr(TransactionCustodyState),
}) {}

export class TransactionTotals extends Schema.Class<TransactionTotals>("TransactionTotals")({
  value: Schema.NullOr(Schema.String).annotations({
    description:
      "The transaction value when every non-fee leg has a valuation in one currency; null otherwise.",
  }),
  fees: Schema.NullOr(Schema.String).annotations({
    description:
      'The total fee valuation. "0" means no fee exists; null means a fee exists but its valuation is incomplete or mixed.',
  }),
  proceeds: Schema.NullOr(Schema.String).annotations({
    description:
      "Disposal proceeds, excluding internal transfers, when every disposal is valued in one currency; null when there is no reportable disposal or a valuation is incomplete.",
  }),
  costBasis: Schema.NullOr(Schema.String).annotations({
    description:
      "Disposal cost basis, excluding internal transfers, when FIFO coverage and basis are complete in one currency; null otherwise.",
  }),
  gainLoss: Schema.NullOr(Schema.String).annotations({
    description:
      "Accounting gain or loss when proceeds and cost basis are both complete in one currency; use taxTreatment to determine whether it is taxable.",
  }),
  currency: Schema.NullOr(Schema.String).annotations({
    description:
      'The single fiat currency used by known totals, null when none is known, or "mixed" when known amounts use multiple currencies.',
  }),
  taxTreatment: TransactionTaxTreatment,
  calculationStatus: TransactionCalculationStatus.annotations({
    description:
      "Complete when all applicable totals are known in one currency, partial when only some calculations are available, and pending when normalized accounting legs or calculated amounts are not available yet.",
  }),
}) {}

export class TransactionExternalReferences extends Schema.Class<TransactionExternalReferences>(
  "TransactionExternalReferences"
)({
  externalId: Schema.NullOr(Schema.String),
  externalGroupId: Schema.NullOr(Schema.String),
  providerTransactionType: Schema.NullOr(Schema.String),
  providerStatus: Schema.NullOr(Schema.String),
  providerDescription: Schema.NullOr(Schema.String),
  transactionHash: Schema.NullOr(Schema.String),
}) {}

export class TransactionListItem extends Schema.Class<TransactionListItem>("TransactionListItem")({
  transactionId: Schema.String,
  timestamp: Schema.String,
  classification: TransactionClassification,
  source: TransactionSource,
  movements: Schema.Array(TransactionMovement),
  totals: TransactionTotals,
  externalReferences: TransactionExternalReferences,
}) {}

export class TransactionPageInfo extends Schema.Class<TransactionPageInfo>("TransactionPageInfo")({
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
}) {}

export class TransactionsResponse extends Schema.Class<TransactionsResponse>(
  "TransactionsResponse"
)({ transactions: Schema.Array(TransactionListItem), page: TransactionPageInfo }) {}

export class TransactionMatchedLot extends Schema.Class<TransactionMatchedLot>(
  "TransactionMatchedLot"
)({
  lotId: Schema.String,
  acquiredAt: Schema.String,
  matchedAmount: Schema.String,
  costBasis: Schema.NullOr(Schema.String),
  proceeds: Schema.NullOr(Schema.String),
  gainLoss: Schema.NullOr(Schema.String),
  taxTreatment: Schema.Literal("taxable", "tax_free", "non_taxable"),
}) {}

export class TransactionDisposal extends Schema.Class<TransactionDisposal>("TransactionDisposal")({
  legId: Schema.String,
  asset: TransactionAsset,
  amount: Schema.String,
  disposedAt: Schema.String,
  proceeds: Schema.NullOr(Schema.String),
  costBasis: Schema.NullOr(Schema.String),
  gainLoss: Schema.NullOr(Schema.String),
  taxTreatment: TransactionTaxTreatment,
  calculationStatus: TransactionCalculationStatus,
  matchedLots: Schema.Array(TransactionMatchedLot),
}) {}

export class TransactionCanonicalTransfer extends Schema.Class<TransactionCanonicalTransfer>(
  "TransactionCanonicalTransfer"
)({
  transferId: Schema.String,
  type: Schema.String,
  transactionHash: Schema.NullOr(Schema.String),
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  asset: TransactionAsset,
  amount: Schema.String,
}) {}

export class TransactionProviderTransfer extends Schema.Class<TransactionProviderTransfer>(
  "TransactionProviderTransfer"
)({
  providerTransferId: Schema.String,
  externalId: Schema.NullOr(Schema.String),
  direction: Schema.Literal("inbound", "outbound"),
  assetCode: Schema.NullOr(Schema.String),
  amount: Schema.String,
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  network: Schema.NullOr(Schema.String),
  networkHash: Schema.NullOr(Schema.String),
}) {}

export class TransactionReconciliation extends Schema.Class<TransactionReconciliation>(
  "TransactionReconciliation"
)({
  reconciliationId: Schema.String,
  providerTransferId: Schema.String,
  canonicalTransferId: Schema.NullOr(Schema.String),
  canonicalTransactionId: Schema.NullOr(Schema.String),
  status: Schema.Literal("pending", "needs_review", "approved", "rejected", "auto_applied"),
  reason: Schema.String,
  confidence: Schema.String,
  deterministic: Schema.Boolean,
}) {}

export class TransactionVenueContext extends Schema.Class<TransactionVenueContext>(
  "TransactionVenueContext"
)({
  type: Schema.Literal("cex", "dex"),
  accountReference: Schema.NullOr(Schema.String),
  orderId: Schema.NullOr(Schema.String),
  fillId: Schema.NullOr(Schema.String),
  side: Schema.NullOr(Schema.String),
  instrument: Schema.NullOr(Schema.String),
  fillPrice: Schema.NullOr(Schema.String),
  commissionAmount: Schema.NullOr(Schema.String),
  commissionCurrency: Schema.NullOr(Schema.String),
}) {}

export class TransactionOnchainContext extends Schema.Class<TransactionOnchainContext>(
  "TransactionOnchainContext"
)({
  blockchain: Schema.String,
  chainType: Schema.String,
  explorerUrl: Schema.NullOr(Schema.String),
  transactionHash: Schema.String,
  blockHeight: Schema.NullOr(Schema.String),
  blockHash: Schema.NullOr(Schema.String),
  fromAddress: Schema.String,
  toAddress: Schema.NullOr(Schema.String),
  functionName: Schema.NullOr(Schema.String),
  failed: Schema.Boolean,
  feeAmount: Schema.NullOr(Schema.String).annotations({
    description:
      "The chain fee in whole units of feeAssetSymbol after conversion from base units; null when the fee or native-asset decimal metadata is unavailable.",
  }),
  feeAssetSymbol: Schema.NullOr(Schema.String),
  feeFiatValue: Schema.NullOr(TransactionFiatValue),
}) {}

export class TransactionProviderEvidence extends Schema.Class<TransactionProviderEvidence>(
  "TransactionProviderEvidence"
)({
  provider: Schema.String,
  recordType: Schema.String,
  externalRecordId: Schema.String,
  externalParentId: Schema.NullOr(Schema.String),
  externalAccountId: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
}) {}

export class TransactionClassificationExplanation extends Schema.Class<TransactionClassificationExplanation>(
  "TransactionClassificationExplanation"
)({
  originalKey: Schema.NullOr(Schema.String),
  currentKey: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  matchedLayer: Schema.NullOr(Schema.String),
  userNotes: Schema.NullOr(Schema.String),
  reviewedAt: Schema.NullOr(Schema.String),
}) {}

export class TransactionDetailResponse extends Schema.Class<TransactionDetailResponse>(
  "TransactionDetailResponse"
)({
  transactionId: Schema.String,
  timestamp: Schema.String,
  classification: TransactionClassification,
  source: TransactionSource,
  movements: Schema.Array(TransactionMovement),
  totals: TransactionTotals,
  externalReferences: TransactionExternalReferences,
  disposals: Schema.Array(TransactionDisposal),
  canonicalTransfers: Schema.Array(TransactionCanonicalTransfer),
  providerTransfers: Schema.Array(TransactionProviderTransfer),
  reconciliations: Schema.Array(TransactionReconciliation),
  venue: Schema.NullOr(TransactionVenueContext),
  onchain: Schema.NullOr(TransactionOnchainContext),
  providerEvidence: Schema.NullOr(TransactionProviderEvidence),
  classificationExplanation: Schema.NullOr(TransactionClassificationExplanation),
}) {}

const listTransactions = HttpApiEndpoint.get("listTransactions", "/transactions")
  .setUrlParams(TransactionListParams)
  .addSuccess(TransactionsResponse)
  .addError(TransactionBadRequestError)
  .addError(TransactionNotFoundError)
  .addError(UnauthorizedError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List accounting transactions",
      description:
        "Returns a stable cursor page of transaction read projections for the current principal.",
    })
  )

const getTransaction = HttpApiEndpoint.get("getTransaction", "/transactions/:transactionId")
  .setPath(Schema.Struct({ transactionId: Schema.String }))
  .addSuccess(TransactionDetailResponse)
  .addError(TransactionBadRequestError)
  .addError(TransactionNotFoundError)
  .addError(UnauthorizedError)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "Get accounting transaction",
      description: "Returns the bounded inspector projection for one owned transaction.",
    })
  )

export class TransactionsApi extends HttpApiGroup.make("transactions")
  .add(listTransactions)
  .add(getTransaction)
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateContext(
    OpenApi.annotations({
      title: "Transactions",
      description: "Principal-owned accounting transaction read projections",
    })
  ) {}
