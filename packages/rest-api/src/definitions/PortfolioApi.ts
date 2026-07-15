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

export const PortfolioDecimal = Schema.String.pipe(Schema.pattern(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/))

export class PortfolioAssetRow extends Schema.Class<PortfolioAssetRow>("PortfolioAssetRow")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  amount: PortfolioDecimal,
  currentPrice: Schema.NullOr(PortfolioDecimal),
  totalValue: Schema.NullOr(PortfolioDecimal),
  profitLoss: Schema.NullOr(PortfolioDecimal),
}) {}

export class PortfolioSummary extends Schema.Class<PortfolioSummary>("PortfolioSummary")({
  totalValue: Schema.NullOr(PortfolioDecimal),
  costBasis: Schema.NullOr(PortfolioDecimal),
  profitLoss: Schema.NullOr(PortfolioDecimal),
  profitLossPercentage: Schema.NullOr(PortfolioDecimal),
}) {}

export class PortfolioAssetsResponse extends Schema.Class<PortfolioAssetsResponse>(
  "PortfolioAssetsResponse"
)({
  currency: Schema.String,
  summary: PortfolioSummary,
  assets: Schema.Array(PortfolioAssetRow),
}) {}

export const PortfolioCurrency = Schema.Lowercase.pipe(Schema.pattern(/^[a-z]{3}$/))

const PortfolioAssetsQuery = Schema.Struct({
  sourceId: Schema.optional(Schema.UUID),
  currency: Schema.optional(PortfolioCurrency),
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
