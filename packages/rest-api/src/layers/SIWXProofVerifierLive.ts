/**
 * SIWXProofVerifierLive - Structured SIWX proof verifier.
 *
 * @module SIWXProofVerifierLive
 */

import { parseCryptoAddress } from "@my/core/source"
import {
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
} from "@x402/extensions/sign-in-with-x"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import {
  SIWXProofVerificationError,
  SIWXProofVerifier,
  type SIWXProofVerifierService,
} from "../services/SIWXProofVerifier.ts"

const DEFAULT_SIWX_DOMAIN = "api.taxmaxi.com"
const DEFAULT_SIWX_RESOURCE_URI = "https://api.taxmaxi.com"

const siwxConfig = {
  domain: Config.string("SIWX_DOMAIN").pipe(
    Config.withDefault(DEFAULT_SIWX_DOMAIN),
    Config.map((value) => value.trim())
  ),
  resourceUri: Config.string("SIWX_RESOURCE_URI").pipe(
    Config.withDefault(DEFAULT_SIWX_RESOURCE_URI),
    Config.map((value) => value.trim())
  ),
}

const verificationError = (
  reason: SIWXProofVerificationError["reason"],
  message: string
): SIWXProofVerificationError => new SIWXProofVerificationError({ reason, message })

const SIWXHeaderProof = Schema.NonEmptyTrimmedString

const chainTypeFromChainId = (chainId: string) => {
  if (chainId.startsWith("eip155:")) return "evm" as const
  if (chainId.startsWith("solana:")) return "solana" as const
  return null
}

const make = Effect.gen(function* () {
  const domain = yield* siwxConfig.domain
  const resourceUri = yield* siwxConfig.resourceUri

  const verify: SIWXProofVerifierService["verify"] = ({ proof: rawProof, expectedNonce }) =>
    Effect.gen(function* () {
      const header = yield* Schema.decodeUnknown(SIWXHeaderProof)(rawProof).pipe(
        Effect.mapError(() => verificationError("malformed_proof", "Malformed SIWX proof."))
      )

      const payload = yield* Effect.try({
        try: () => parseSIWxHeader(header),
        catch: () => verificationError("malformed_proof", "Malformed SIWX proof."),
      })

      if (payload.domain !== domain) {
        return yield* Effect.fail(verificationError("domain_mismatch", "Invalid SIWX domain."))
      }

      if (payload.nonce.trim() === "" || payload.nonce !== expectedNonce) {
        return yield* Effect.fail(
          verificationError("missing_or_invalid_nonce", "Invalid SIWX nonce.")
        )
      }

      const validation = yield* Effect.tryPromise({
        try: () =>
          validateSIWxMessage(payload, resourceUri, {
            checkNonce: (nonce) => nonce === expectedNonce,
          }),
        catch: () => verificationError("malformed_proof", "Malformed SIWX proof."),
      })

      if (!validation.valid) {
        const validationError = validation.error?.toLowerCase() ?? ""
        return yield* Effect.fail(
          verificationError(
            validationError.includes("domain mismatch")
              ? "domain_mismatch"
              : validationError.includes("nonce")
                ? "missing_or_invalid_nonce"
                : validationError.includes("expired")
                  ? "expired_proof"
                  : "malformed_proof",
            validation.error ?? "Invalid SIWX message."
          )
        )
      }

      const verification = yield* Effect.tryPromise({
        try: () => verifySIWxSignature(payload),
        catch: () => verificationError("signature_mismatch", "Invalid signature."),
      })

      if (!verification.valid) {
        return yield* Effect.fail(
          verificationError("signature_mismatch", verification.error ?? "Invalid signature.")
        )
      }

      const chainType = chainTypeFromChainId(payload.chainId)
      const walletAddress = verification.address ?? payload.address
      const parsedWallet = parseCryptoAddress(walletAddress)
      if (chainType === null || parsedWallet === null || parsedWallet.chainType !== chainType) {
        return yield* Effect.fail(
          verificationError("unsupported_chain", "Unsupported SIWX wallet address.")
        )
      }

      return {
        chainType: parsedWallet.chainType,
        walletAddress: parsedWallet.address,
      }
    })

  return SIWXProofVerifier.of({ verify } satisfies SIWXProofVerifierService)
})

/**
 * SIWXProofVerifierLive - Live SIWX proof verifier layer.
 */
export const SIWXProofVerifierLive = Layer.effect(SIWXProofVerifier, make)
