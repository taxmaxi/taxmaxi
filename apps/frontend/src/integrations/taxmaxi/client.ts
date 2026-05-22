import type { WalletSession } from "@solana/client"
import { TaxMaxi, type TaxMaxiBrowserSessionOptions } from "taxmaxi"

import { createFetchWithPayment } from "#/integrations/solana/x402"

export type TaxMaxiX402Options = TaxMaxiBrowserSessionOptions

export const createTaxMaxiX402Client = (
  wallet: WalletSession,
  options: TaxMaxiX402Options = {}
): TaxMaxi =>
  TaxMaxi.fromBrowserSession({
    ...options,
    credentials: options.credentials ?? "include",
    fetch: createFetchWithPayment(wallet, options.fetch),
  })
