/**
 * X402PaymentValidator - x402 payment validation contract.
 *
 * @module X402PaymentValidator
 */

import type { ChainType } from "@my/core/source"
import type { PaymentRequired, SettleResponse } from "@x402/core/types"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * X402PaymentRequiredError - The request has not supplied a valid x402 payment.
 */
export class X402PaymentRequiredError extends Schema.TaggedError<X402PaymentRequiredError>()(
  "X402PaymentRequiredError",
  {
    message: Schema.String,
    paymentRequired: Schema.optional(Schema.Unknown),
    paymentRequiredHeader: Schema.optional(Schema.String),
  }
) {}

/**
 * X402PaymentSettlementError - A verified x402 payment could not be settled.
 */
export class X402PaymentSettlementError extends Schema.TaggedError<X402PaymentSettlementError>()(
  "X402PaymentSettlementError",
  {
    message: Schema.String,
    paymentRequired: Schema.optional(Schema.Unknown),
    paymentRequiredHeader: Schema.optional(Schema.String),
  }
) {}

/**
 * ValidateX402PaymentParams - Request context bound to an anonymous paid source creation.
 */
export interface ValidateX402PaymentParams {
  readonly paymentHeader: Option.Option<string>
  readonly chainType: ChainType
  readonly walletAddress: string
  readonly year: number
  readonly jurisdiction: string
}

/**
 * X402VerifiedPayment - A request payment that has been verified but not settled.
 */
export interface X402VerifiedPayment {
  /**
   * Settle the verified payment after the protected work succeeds.
   */
  readonly settle: () => Effect.Effect<X402PaymentSettlement, X402PaymentSettlementError>
}

/**
 * X402PaymentSettlement - Successful x402 settlement data used for receipt persistence.
 */
export interface X402PaymentSettlement {
  readonly receiptValue: string
  readonly paymentResponseHeader: string
  readonly response: SettleResponse
}

/**
 * X402PaymentValidatorService - Validates x402 payment proofs.
 */
export interface X402PaymentValidatorService {
  /**
   * Validate that the supplied payment proof authorizes this anonymous source request.
   */
  readonly validateAnonymousSourceCreation: (
    params: ValidateX402PaymentParams
  ) => Effect.Effect<X402VerifiedPayment, X402PaymentRequiredError>
}

/**
 * BuildX402PaymentRequiredErrorParams - Data used to return a protocol-shaped 402.
 */
export interface BuildX402PaymentRequiredErrorParams {
  readonly message: string
  readonly paymentRequired?: PaymentRequired | undefined
  readonly paymentRequiredHeader?: string | undefined
}

/**
 * X402PaymentValidator - Context tag for x402 payment validation.
 */
export class X402PaymentValidator extends Context.Tag("@my/rest-api/X402PaymentValidator")<
  X402PaymentValidator,
  X402PaymentValidatorService
>() {}
