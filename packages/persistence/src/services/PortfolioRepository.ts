/**
 * PortfolioRepository - User portfolio read projections.
 *
 * @module PortfolioRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** A requested source is absent or does not belong to the principal. */
export class PortfolioSourceNotFoundError extends Schema.TaggedError<PortfolioSourceNotFoundError>()(
  "PortfolioSourceNotFoundError",
  { sourceId: Schema.String }
) {}

export interface PortfolioAssetScope {
  readonly principalId: string
  readonly sourceId: string | null
}

/** Open asset position before current market valuation. */
export interface PortfolioAssetPosition {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly logoUrl: string | null
  readonly coingeckoCoinId: string | null
  readonly amount: string
  readonly costBasis: string | null
  readonly costBasisCurrency: string | null
  readonly costBasisStatus: "known" | "pending_review"
}

export interface PortfolioRepositoryShape {
  /** List open positions across all owned sources or one owned source. */
  readonly listAssetPositions: (
    scope: PortfolioAssetScope
  ) => Effect.Effect<
    ReadonlyArray<PortfolioAssetPosition>,
    PortfolioSourceNotFoundError | PersistenceError
  >
}

export class PortfolioRepository extends Context.Tag("PortfolioRepository")<
  PortfolioRepository,
  PortfolioRepositoryShape
>() {}
