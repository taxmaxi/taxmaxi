import { autoDiscover, createClient } from "@solana/client"

export const client = createClient({
  endpoint: "https://api.devnet.solana.com",
  websocketEndpoint: "wss://api.devnet.solana.com",
  walletConnectors: autoDiscover(),
})
