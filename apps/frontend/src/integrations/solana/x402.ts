import type { WalletSession } from "@solana/client"
import { createWalletTransactionSigner } from "@solana/client"
import { wrapFetchWithPayment } from "@x402/fetch"
import { x402Client } from "@x402/core/client"
import { registerExactSvmScheme } from "@x402/svm/exact/client"

export type FetchWithPayment = ReturnType<typeof wrapFetchWithPayment>

export const createX402Client = (wallet: WalletSession) => {
  const walletSigner = createWalletTransactionSigner(wallet)

  if (walletSigner.mode !== "partial") {
    throw new Error("The connected wallet must support transaction signing for x402 payments.")
  }

  return registerExactSvmScheme(new x402Client(), {
    signer: walletSigner.signer,
  })
}

export const createFetchWithPayment = (
  wallet: WalletSession,
  baseFetch: typeof globalThis.fetch = fetch
): FetchWithPayment => wrapFetchWithPayment(baseFetch, createX402Client(wallet))
