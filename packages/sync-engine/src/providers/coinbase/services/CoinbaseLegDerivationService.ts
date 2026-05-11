/**
 * CoinbaseLegDerivationService - Deterministic Coinbase leg derivation contract.
 *
 * @module CoinbaseLegDerivationService
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type {
  PersistedSourceTransaction,
  PersistedSourceTransfer,
  PersistedSourceVenueContext,
  SourceTransactionLegDraft,
} from "../../../services/SourceNormalizationRepository.ts"

/**
 * CoinbaseDerivedAsset - Asset projection required for Coinbase leg metadata.
 */
export interface CoinbaseDerivedAsset {
  readonly id: string
  readonly symbol: string
}

/**
 * CoinbaseResolvedFeeTransfer - Fee transfer plus resolved asset metadata.
 */
export interface CoinbaseResolvedFeeTransfer {
  readonly transfer: PersistedSourceTransfer
  readonly asset: CoinbaseDerivedAsset
}

/**
 * DeriveCoinbaseLegsParams - Input required to derive Coinbase transaction legs.
 */
export interface DeriveCoinbaseLegsParams {
  readonly transaction: PersistedSourceTransaction
  readonly venueContext: PersistedSourceVenueContext | null
  readonly primaryAsset: CoinbaseDerivedAsset | null
  readonly feeTransfers: ReadonlyArray<CoinbaseResolvedFeeTransfer>
}

/**
 * CoinbaseLegDerivationResult - Derived canonical legs for one Coinbase transaction.
 */
export interface CoinbaseLegDerivationResult {
  readonly legs: ReadonlyArray<SourceTransactionLegDraft>
}

/**
 * CoinbaseLegDerivationError - Tagged error for deterministic Coinbase leg derivation failures.
 */
export class CoinbaseLegDerivationError extends Schema.TaggedError<CoinbaseLegDerivationError>()(
  "CoinbaseLegDerivationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }
) {}

/**
 * CoinbaseLegDerivationServiceShape - Contract for deterministic Coinbase transaction leg derivation.
 */
export interface CoinbaseLegDerivationServiceShape {
  readonly deriveLegs: (
    params: DeriveCoinbaseLegsParams
  ) => Effect.Effect<CoinbaseLegDerivationResult, CoinbaseLegDerivationError>
}

/**
 * CoinbaseLegDerivationService - Context tag for Coinbase leg derivation.
 */
export class CoinbaseLegDerivationService extends Context.Tag("CoinbaseLegDerivationService")<
  CoinbaseLegDerivationService,
  CoinbaseLegDerivationServiceShape
>() {}
