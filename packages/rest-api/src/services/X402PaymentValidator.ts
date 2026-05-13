/**
 * X402PaymentValidator - x402 payment validation contract.
 *
 * @module X402PaymentValidator
 */

import type { ChainType } from "@my/core/source";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * X402PaymentRequiredError - The request has not supplied a valid x402 payment.
 */
export class X402PaymentRequiredError extends Schema.TaggedError<X402PaymentRequiredError>()(
  "X402PaymentRequiredError",
  {
    message: Schema.String,
  },
) {}

/**
 * ValidateX402PaymentParams - Request context bound to an anonymous paid source creation.
 */
export interface ValidateX402PaymentParams {
  readonly paymentHeader: Option.Option<string>;
  readonly chainType: ChainType;
  readonly walletAddress: string;
  readonly year: number;
  readonly jurisdiction: string;
}

/**
 * X402PaymentValidatorService - Validates x402 payment proofs.
 */
export interface X402PaymentValidatorService {
  /**
   * Validate that the supplied payment proof authorizes this anonymous source request.
   */
  readonly validateAnonymousSourceCreation: (
    params: ValidateX402PaymentParams,
  ) => Effect.Effect<void, X402PaymentRequiredError>;
}

/**
 * X402PaymentValidator - Context tag for x402 payment validation.
 */
export class X402PaymentValidator extends Context.Tag("@my/rest-api/X402PaymentValidator")<
  X402PaymentValidator,
  X402PaymentValidatorService
>() {}
