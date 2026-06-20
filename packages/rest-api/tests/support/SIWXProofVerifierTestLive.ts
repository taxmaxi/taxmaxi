import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { parseCryptoAddress } from "@my/core/source"
import { encodeSIWxHeader, parseSIWxHeader } from "@x402/extensions/sign-in-with-x"
import {
  SIWXProofVerificationError,
  SIWXProofVerifier,
  type SIWXProofVerifierService,
} from "../../src/services/SIWXProofVerifier.ts"

const SOLANA_DEVNET_CHAIN_ID = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
const EVM_TEST_CHAIN_ID = "eip155:8453"

const chainIdForTestChain = (chainType: "evm" | "solana" | "bitcoin") => {
  switch (chainType) {
    case "evm":
      return EVM_TEST_CHAIN_ID
    case "solana":
      return SOLANA_DEVNET_CHAIN_ID
    case "bitcoin":
      return "bip122:000000000019d6689c085ae165831e93"
  }
}

const typeForTestChain = (chainType: "evm" | "solana" | "bitcoin") =>
  chainType === "solana" ? "ed25519" : "eip191"

export const makeTestSiwxProof = ({
  chainType,
  walletAddress,
  domain = "api.taxmaxi.com",
  uri = "https://api.taxmaxi.com/v1/anon/session",
  nonce = crypto.randomUUID(),
  expirationTime = "2099-01-01T00:00:00.000Z",
}: {
  readonly chainType: "evm" | "solana" | "bitcoin"
  readonly walletAddress: string
  readonly domain?: string
  readonly uri?: string
  readonly nonce?: string | undefined
  readonly expirationTime?: string
}) =>
  encodeSIWxHeader({
    domain,
    address: walletAddress,
    uri,
    version: "1",
    chainId: chainIdForTestChain(chainType),
    type: typeForTestChain(chainType),
    nonce: nonce ?? "",
    issuedAt: new Date().toISOString(),
    expirationTime,
    signature: "test-signature",
  })

export const SIWXProofVerifierTestLive = Layer.succeed(SIWXProofVerifier, {
  verify: ({ proof, expectedNonce }) =>
    Effect.gen(function* () {
      if (typeof proof !== "string" || proof.trim() === "") {
        return yield* Effect.fail(
          new SIWXProofVerificationError({
            reason: "malformed_proof",
            message: "Malformed SIWX proof.",
          })
        )
      }

      const message = yield* Effect.try({
        try: () => parseSIWxHeader(proof),
        catch: () =>
          new SIWXProofVerificationError({
            reason: "malformed_proof",
            message: "Malformed SIWX proof.",
          }),
      })

      if (message.domain !== "api.taxmaxi.com") {
        return yield* Effect.fail(
          new SIWXProofVerificationError({
            reason: "domain_mismatch",
            message: "Invalid SIWX domain.",
          })
        )
      }

      if (message.nonce.trim() === "") {
        return yield* Effect.fail(
          new SIWXProofVerificationError({
            reason: "missing_or_invalid_nonce",
            message: "Invalid SIWX nonce.",
          })
        )
      }

      if (message.nonce !== expectedNonce) {
        return yield* Effect.fail(
          new SIWXProofVerificationError({
            reason: "missing_or_invalid_nonce",
            message: "Invalid SIWX nonce.",
          })
        )
      }

      if (
        message.expirationTime !== undefined &&
        new Date(message.expirationTime).getTime() <= Date.now()
      ) {
        return yield* Effect.fail(
          new SIWXProofVerificationError({
            reason: "expired_proof",
            message: "Expired SIWX proof.",
          })
        )
      }

      const chainType = message.chainId.startsWith("eip155:")
        ? "evm"
        : message.chainId.startsWith("solana:")
          ? "solana"
          : null
      const parsedWallet = parseCryptoAddress(message.address)
      if (chainType === null || parsedWallet === null || parsedWallet.chainType !== chainType) {
        return yield* Effect.fail(
          new SIWXProofVerificationError({
            reason: "unsupported_chain",
            message: "Unsupported SIWX wallet address.",
          })
        )
      }

      return {
        chainType: parsedWallet.chainType,
        walletAddress: parsedWallet.address,
      }
    }),
} satisfies SIWXProofVerifierService)
