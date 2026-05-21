/**
 * ClaimTokenHash - Shared hashing helpers for bearer-style claim tokens.
 *
 * @module ClaimTokenHash
 */

import { createHash } from "node:crypto"
import * as Config from "effect/Config"
import * as Redacted from "effect/Redacted"

/**
 * Server-side pepper used when hashing anonymous source claim tokens for storage and lookup.
 */
export const claimTokenPepperConfig = Config.redacted("CLAIM_TOKEN_PEPPER").pipe(
  Config.withDefault(Redacted.make(""))
)

/**
 * Hash a raw anonymous source claim token for storage or lookup.
 */
export const hashAnonymousSourceClaimToken = ({
  claimToken,
  pepper,
}: {
  readonly claimToken: string
  readonly pepper: Redacted.Redacted<string>
}): string =>
  createHash("sha256")
    .update("anonymous_source_claim_token")
    .update("\0")
    .update(Redacted.value(pepper))
    .update("\0")
    .update(claimToken)
    .digest("hex")
