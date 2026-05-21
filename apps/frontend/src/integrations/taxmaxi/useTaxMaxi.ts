import { useWalletConnection } from "@solana/react-hooks"
import { useMemo } from "react"
import { createTaxMaxiX402Client } from "./client"

export const useTaxMaxiX402Client = () => {
  const walletConnection = useWalletConnection()

  return useMemo(
    () =>
      walletConnection.wallet === undefined
        ? null
        : createTaxMaxiX402Client(walletConnection.wallet, {
            baseUrl: "http://localhost:4000",
          }),
    [walletConnection.wallet]
  )
}
