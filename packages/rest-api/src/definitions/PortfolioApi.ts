/** PortfolioApi - Current user portfolio endpoints. */

import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import { InternalServerError } from "./ApiErrors.ts"
import { AuthMiddleware } from "./AuthMiddleware.ts"

export class PortfolioSourceNotFoundResponse extends Schema.TaggedError<PortfolioSourceNotFoundResponse>()(
  "PortfolioSourceNotFoundResponse",
  { message: Schema.String },
  { httpApiStatus: 404 }
) {}

export class PortfolioAssetRow extends Schema.Class<PortfolioAssetRow>("PortfolioAssetRow")({
  assetId: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  amount: Schema.BigDecimalFromString,
  currentPrice: Schema.NullOr(Schema.BigDecimalFromString),
  totalValue: Schema.NullOr(Schema.BigDecimalFromString),
  profitLoss: Schema.NullOr(Schema.BigDecimalFromString),
}) {}

export class PortfolioSummary extends Schema.Class<PortfolioSummary>("PortfolioSummary")({
  totalValue: Schema.NullOr(Schema.BigDecimalFromString),
  costBasis: Schema.NullOr(Schema.BigDecimalFromString),
  profitLoss: Schema.NullOr(Schema.BigDecimalFromString),
  profitLossPercentage: Schema.NullOr(Schema.BigDecimalFromString),
}) {}

export class PortfolioAssetsResponse extends Schema.Class<PortfolioAssetsResponse>(
  "PortfolioAssetsResponse"
)({
  currency: Schema.String,
  summary: PortfolioSummary,
  assets: Schema.Array(PortfolioAssetRow),
}) {}

export const PortfolioCurrency = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(Schema.isLowercased(), Schema.isPattern(/^[a-z]{3}$/)),
    SchemaTransformation.toLowerCase()
  )
)

const PortfolioAssetsQuery = Schema.Struct({
  sourceId: Schema.optional(Schema.String.check(Schema.isUUID())),
  currency: Schema.optional(PortfolioCurrency),
})

const listPortfolioAssets = HttpApiEndpoint.get("listPortfolioAssets", "/assets", {
  query: PortfolioAssetsQuery,
  success: PortfolioAssetsResponse,
  error: [PortfolioSourceNotFoundResponse, InternalServerError],
}).annotateMerge(
  OpenApi.annotations({
    summary: "List portfolio assets",
    description:
      "Returns current open asset positions across all user sources or one selected source, valued with CoinGecko prices.",
  })
)

export class PortfolioApi extends HttpApiGroup.make("portfolio")
  .add(listPortfolioAssets)
  .middleware(AuthMiddleware)
  .prefix("/v1/portfolio")
  .annotateMerge(OpenApi.annotations({ title: "Portfolio" })) {}
