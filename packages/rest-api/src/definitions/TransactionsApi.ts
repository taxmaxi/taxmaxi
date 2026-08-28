/**
 * TransactionsApi - Principal-owned canonical transaction list.
 *
 * @module TransactionsApi
 */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class TransactionBadRequestError extends Schema.TaggedError<TransactionBadRequestError>()(
  "TransactionBadRequestError",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export const TransactionListQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(
    Schema.FiniteFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(100)
    )
  ),
})

/** Compact source facts for a transaction row. */
export class TransactionListSource extends Schema.Class<TransactionListSource>(
  "TransactionListSource"
)({
  sourceId: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["onchain", "cex", "dex"]),
}) {}

/** Compact movement facts for a transaction row. */
export class TransactionListMovement extends Schema.Class<TransactionListMovement>(
  "TransactionListMovement"
)({
  amount: Schema.String,
  assetSymbol: Schema.String,
  kind: Schema.Literals(["acquisition", "disposal", "income", "fee"]),
}) {}

/** One compact transaction row for the web table. */
export class TransactionListItem extends Schema.Class<TransactionListItem>("TransactionListItem")({
  transactionId: Schema.String,
  timestamp: Schema.String,
  source: TransactionListSource,
  transactionType: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  externalId: Schema.NullOr(Schema.String),
  movements: Schema.Array(TransactionListMovement),
  realizedGainLoss: Schema.NullOr(Schema.String),
  fiatCurrency: Schema.NullOr(Schema.String),
  calculationState: Schema.Literals(["complete", "partial"]),
  needsReview: Schema.Boolean,
}) {}

export class TransactionListPageInfo extends Schema.Class<TransactionListPageInfo>(
  "TransactionListPageInfo"
)({
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
}) {}

/** Cursor page plus an exact count of principal-owned transactions that have accounting legs. */
export class TransactionListResponse extends Schema.Class<TransactionListResponse>(
  "TransactionListResponse"
)({
  transactions: Schema.Array(TransactionListItem),
  page: TransactionListPageInfo,
  totalCount: Schema.Finite,
}) {}

const listTransactions = HttpApiEndpoint.get("listTransactions", "/transactions", {
  query: TransactionListQuery,
  success: TransactionListResponse,
  error: [TransactionBadRequestError, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List transactions",
    description:
      "Returns a stable cursor page of compact transactions owned by the authenticated principal.",
  })
)

export class TransactionsApi extends HttpApiGroup.make("transactions")
  .add(listTransactions)
  .middleware(AuthMiddleware)
  .prefix("/v1")
  .annotateMerge(
    OpenApi.annotations({
      title: "Transactions",
      description: "Principal-owned canonical transaction reads",
    })
  ) {}
