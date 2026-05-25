import { autoDiscover, createClient } from "@solana/client"

let solanaClient: ReturnType<typeof createClient> | null = null

export const getSolanaClient = (): ReturnType<typeof createClient> => {
  if (solanaClient === null) {
    solanaClient = createClient({
      endpoint: "https://api.devnet.solana.com",
      websocketEndpoint: "wss://api.devnet.solana.com",
      walletConnectors: autoDiscover(),
    })
  }

  return solanaClient
}
