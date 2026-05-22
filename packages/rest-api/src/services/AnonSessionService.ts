/**
 * AnonSessionService - Signed anonymous payer session and challenge tokens.
 *
 * @module AnonSessionService
 */

import { ChainType } from "@my/core/source"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * AnonPayerSessionSubject - Wallet identity scoped into an anonymous payer session.
 */
export interface AnonPayerSessionSubject {
  readonly payerChainType: ChainType
  readonly payerWalletAddress: string
}

/**
 * AnonSessionChallenge - Server-generated SIWX recovery nonce.
 */
export interface AnonSessionChallenge {
  readonly nonce: string
  readonly expiresAt: string
  readonly token: string
}

/**
 * AnonSessionTokenError - Signed token is missing, malformed, expired, or invalid.
 */
export class AnonSessionTokenError extends Schema.TaggedError<AnonSessionTokenError>()(
  "AnonSessionTokenError",
  {
    message: Schema.String,
  }
) {}

/**
 * AnonSessionServiceShape - Stateless signed token operations for anon payer sessions.
 */
export interface AnonSessionServiceShape {
  /**
   * Create a signed session token for a payer wallet.
   */
  readonly createSessionToken: (
    subject: AnonPayerSessionSubject
  ) => Effect.Effect<string, AnonSessionTokenError>

  /**
   * Verify a signed session token and return the payer wallet subject.
   */
  readonly verifySessionToken: (
    token: string
  ) => Effect.Effect<AnonPayerSessionSubject, AnonSessionTokenError>

  /**
   * Create a signed SIWX challenge token and public nonce.
   */
  readonly createChallenge: () => Effect.Effect<AnonSessionChallenge, AnonSessionTokenError>

  /**
   * Verify a signed challenge token and return the expected SIWX nonce.
   */
  readonly verifyChallengeToken: (token: string) => Effect.Effect<string, AnonSessionTokenError>
}

/**
 * AnonSessionService - Context tag for anonymous payer session tokens.
 */
export class AnonSessionService extends Context.Tag("@my/rest-api/AnonSessionService")<
  AnonSessionService,
  AnonSessionServiceShape
>() {}
