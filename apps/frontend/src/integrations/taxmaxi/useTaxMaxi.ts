import { useWalletConnection } from "@solana/react-hooks"
import { useMemo } from "react"
import { TaxMaxi } from "taxmaxi"
import { createTaxMaxiX402Client } from "./client"

const TAXMAXI_API_BASE_URL = "http://localhost:4000"

export const useTaxMaxiBrowserClient = () =>
  useMemo(
    () =>
      TaxMaxi.fromBrowserSession({
        baseUrl: TAXMAXI_API_BASE_URL,
      }),
    []
  )

export const useTaxMaxiX402Client = () => {
  const walletConnection = useWalletConnection()

  return useMemo(
    () =>
      walletConnection.wallet === undefined
        ? null
        : createTaxMaxiX402Client(walletConnection.wallet, {
            baseUrl: TAXMAXI_API_BASE_URL,
          }),
    [walletConnection.wallet]
  )
}
