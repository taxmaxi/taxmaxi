/**
 * X402PaymentValidatorLive - Configured x402 payment validator.
 *
 * @module X402PaymentValidatorLive
 */

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  X402PaymentRequiredError,
  X402PaymentValidator,
  type X402PaymentValidatorService,
} from "../services/X402PaymentValidator.ts";

const configuredPaymentProofConfig = Config.redacted("X402_ACCEPTED_PAYMENT_PROOF").pipe(
  Config.withDefault(Redacted.make("")),
);

const paymentRequired = (message: string) => new X402PaymentRequiredError({ message });
const normalizePaymentProof = (value: string): string => value.trim();

const make = Effect.gen(function* () {
  const configuredPaymentProof = yield* Effect.configProviderWith((provider) =>
    provider.load(configuredPaymentProofConfig),
  );

  const validateAnonymousSourceCreation: X402PaymentValidatorService["validateAnonymousSourceCreation"] =
    ({ paymentHeader }) =>
      Effect.gen(function* () {
        if (Option.isNone(paymentHeader) || normalizePaymentProof(paymentHeader.value) === "") {
          return yield* Effect.fail(paymentRequired("x402 payment required."));
        }

        const acceptedPaymentProof = normalizePaymentProof(Redacted.value(configuredPaymentProof));
        if (acceptedPaymentProof === "") {
          return yield* Effect.fail(paymentRequired("x402 payment validation is not configured."));
        }

        if (normalizePaymentProof(paymentHeader.value) !== acceptedPaymentProof) {
          return yield* Effect.fail(paymentRequired("Invalid x402 payment."));
        }
      });

  return X402PaymentValidator.of({
    validateAnonymousSourceCreation,
  } satisfies X402PaymentValidatorService);
});

/**
 * X402PaymentValidatorLive - Live x402 validator layer.
 */
export const X402PaymentValidatorLive = Layer.effect(X402PaymentValidator, make);
