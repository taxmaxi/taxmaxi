/**
 * SIWXProofVerifier - Verifies signed wallet proofs for payer entitlements.
 *
 * @module SIWXProofVerifier
 */

import { ChainType } from "@my/core/source"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * VerifiedSIWXProof - Normalized wallet identity proven by SIWX.
 */
export interface VerifiedSIWXProof {
  readonly chainType: ChainType
  readonly walletAddress: string
}

/**
 * VerifySIWXProofParams - Proof plus server-generated nonce expected in the signed message.
 */
export interface VerifySIWXProofParams {
  readonly proof: unknown
  readonly expectedNonce: string
}

/**
 * SIWXProofVerificationError - Expected proof verification failure.
 */
export class SIWXProofVerificationError extends Schema.TaggedError<SIWXProofVerificationError>()(
  "SIWXProofVerificationError",
  {
    reason: Schema.Literal(
      "malformed_proof",
      "unsupported_chain",
      "domain_mismatch",
      "audience_mismatch",
      "missing_or_invalid_nonce",
      "expired_proof",
      "signature_mismatch"
    ),
    message: Schema.String,
  }
) {}

/**
 * SIWXProofVerifierService - Verifies signed wallet proofs.
 */
export interface SIWXProofVerifierService {
  /**
   * Verify a SIWX proof and return normalized payer wallet identity.
   */
  readonly verify: (
    params: VerifySIWXProofParams
  ) => Effect.Effect<VerifiedSIWXProof, SIWXProofVerificationError>
}

/**
 * SIWXProofVerifier - Context tag for SIWX proof verification.
 */
export class SIWXProofVerifier extends Context.Tag("@my/rest-api/SIWXProofVerifier")<
  SIWXProofVerifier,
  SIWXProofVerifierService
>() {}
