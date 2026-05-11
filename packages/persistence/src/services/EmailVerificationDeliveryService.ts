/**
 * @module EmailVerificationDeliveryService
 *
 * Contract for sending local email verification codes through an external
 * delivery provider.
 */

import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type { Email, EmailVerificationCode } from "@my/core/authentication"

/**
 * Input for sending a verification code email.
 */
export interface SendEmailVerificationCodeInput {
  readonly email: Email
  readonly code: EmailVerificationCode
}

/**
 * Error raised when verification email delivery fails.
 */
export class EmailVerificationDeliveryError extends Data.TaggedError(
  "EmailVerificationDeliveryError"
)<{
  readonly message: string
  readonly cause: unknown
}> {}

/**
 * Service contract for sending local email verification codes.
 */
export interface EmailVerificationDeliveryServiceShape {
  readonly sendVerificationCode: (
    input: SendEmailVerificationCodeInput
  ) => Effect.Effect<void, EmailVerificationDeliveryError>
}

/**
 * Context tag for verification email delivery.
 */
export class EmailVerificationDeliveryService extends Context.Tag(
  "EmailVerificationDeliveryService"
)<EmailVerificationDeliveryService, EmailVerificationDeliveryServiceShape>() {}
