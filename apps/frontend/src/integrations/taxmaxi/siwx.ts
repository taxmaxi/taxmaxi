import type { WalletSession } from "@solana/client"
import {
  SOLANA_DEVNET,
  createSIWxPayload,
  encodeSIWxHeader,
  type SolanaSigner,
} from "@x402/extensions/sign-in-with-x"

const SIWX_DOMAIN = "api.taxmaxi.com"
const SIWX_RESOURCE_URI = "https://api.taxmaxi.com/v1/anon/session"

export const createAnonSessionSiwxProof = async ({
  nonce,
  wallet,
}: {
  readonly nonce: string
  readonly wallet: WalletSession
}): Promise<string> => {
  if (wallet.signMessage === undefined) {
    throw new Error("The connected wallet must support message signing for SIWX recovery.")
  }

  const signer: SolanaSigner = {
    publicKey: wallet.account.address,
    signMessage: wallet.signMessage,
  }
  const issuedAt = new Date()
  const expirationTime = new Date(issuedAt.getTime() + 5 * 60 * 1000)
  const payload = await createSIWxPayload(
    {
      domain: SIWX_DOMAIN,
      uri: SIWX_RESOURCE_URI,
      version: "1",
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
      chainId: SOLANA_DEVNET,
      type: "ed25519",
      statement: "Restore anonymous TaxMaxi sources paid by this wallet.",
    },
    signer
  )

  return encodeSIWxHeader(payload)
}
