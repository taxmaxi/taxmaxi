/** PortfolioApi - Current user portfolio endpoints. */

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "@effect/platform"
import * as Schema from "effect/Schema"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class PortfolioSourceNotFoundResponse extends Schema.TaggedError<PortfolioSourceNotFoundResponse>()(
  "PortfolioSourceNotFoundResponse",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 })
) {}

export class PortfolioAssetRow extends Schema.Class<PortfolioAssetRow>("PortfolioAssetRow")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  amount: Schema.String,
  currentPrice: Schema.NullOr(Schema.String),
  totalValue: Schema.NullOr(Schema.String),
  profitLoss: Schema.NullOr(Schema.String),
}) {}

export class PortfolioSummary extends Schema.Class<PortfolioSummary>("PortfolioSummary")({
  totalValue: Schema.String,
  costBasis: Schema.NullOr(Schema.String),
  profitLoss: Schema.NullOr(Schema.String),
  profitLossPercentage: Schema.NullOr(Schema.String),
}) {}

export class PortfolioAssetsResponse extends Schema.Class<PortfolioAssetsResponse>(
  "PortfolioAssetsResponse"
)({
  currency: Schema.String,
  summary: PortfolioSummary,
  assets: Schema.Array(PortfolioAssetRow),
}) {}

const PortfolioAssetsQuery = Schema.Struct({
  sourceId: Schema.optional(Schema.UUID),
  currency: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{3}$/))),
})

const listPortfolioAssets = HttpApiEndpoint.get("listPortfolioAssets", "/assets")
  .setUrlParams(PortfolioAssetsQuery)
  .addSuccess(PortfolioAssetsResponse)
  .addError(PortfolioSourceNotFoundResponse)
  .addError(InternalServerError)
  .annotateContext(
    OpenApi.annotations({
      summary: "List portfolio assets",
      description:
        "Returns current open asset positions across all user sources or one selected source, valued with CoinGecko prices.",
    })
  )

export class PortfolioApi extends HttpApiGroup.make("portfolio")
  .add(listPortfolioAssets)
  .middlewareEndpoints(AuthMiddleware)
  .prefix("/v1/portfolio")
  .annotateContext(OpenApi.annotations({ title: "Portfolio" })) {}
