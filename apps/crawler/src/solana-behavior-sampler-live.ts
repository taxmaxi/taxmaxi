/**
 * Live Helius/RPC client for the Solana behavior sampler.
 *
 * @module
 */
import { signature } from "@solana/keys"
import { createHelius } from "helius-sdk"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import {
  SolanaBehaviorSamplerClient,
  SolanaBehaviorSamplerClientError,
  type SolanaBehaviorSamplerClientShape,
} from "./solana-behavior-sampler.ts"

const HELIUS_API_KEY_CONFIG = Config.redacted("HELIUS_API_KEY")
const SOLANA_RPC_URL_CONFIG = Config.option(Config.string("SOLANA_RPC_URL"))

const stringifyUnknown = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const toClientError = (message: string): SolanaBehaviorSamplerClientError =>
  new SolanaBehaviorSamplerClientError({ message })

const readApiKey = HELIUS_API_KEY_CONFIG.pipe(
  Effect.map(Redacted.value),
  Effect.mapError(() => toClientError("HELIUS_API_KEY is not configured")),
  Effect.flatMap((apiKey) => {
    const trimmed = apiKey.trim()
    return trimmed === ""
      ? Effect.fail(toClientError("HELIUS_API_KEY is empty"))
      : Effect.succeed(trimmed)
  })
)

const readOptionalApiKey = Config.option(HELIUS_API_KEY_CONFIG).pipe(
  Effect.mapError(() => toClientError("Failed to read HELIUS_API_KEY")),
  Effect.map((maybeApiKey) => {
    if (maybeApiKey._tag === "None") {
      return null
    }

    const trimmed = Redacted.value(maybeApiKey.value).trim()
    return trimmed === "" ? null : trimmed
  })
)

const readOptionalRpcUrl = SOLANA_RPC_URL_CONFIG.pipe(
  Effect.mapError(() => toClientError("Failed to read SOLANA_RPC_URL")),
  Effect.map((maybeUrl) =>
    maybeUrl._tag === "Some" && maybeUrl.value.trim() !== "" ? maybeUrl.value.trim() : null
  )
)

const DEFAULT_HELIUS_RPC_BASE_URL = "https://mainnet.helius-rpc.com/"

/** Runtime configuration for the Solana behavior sampler RPC client. */
export interface SolanaBehaviorSamplerClientConfig {
  readonly apiKey: string | null
  readonly rpcUrl: string
}

/** Reads sampler client configuration from Effect Config. */
export const readSolanaBehaviorSamplerClientConfig: Effect.Effect<
  SolanaBehaviorSamplerClientConfig,
  SolanaBehaviorSamplerClientError
> = Effect.gen(function* () {
  const configuredRpcUrl = yield* readOptionalRpcUrl

  if (configuredRpcUrl !== null) {
    const apiKey = yield* readOptionalApiKey
    return {
      apiKey,
      rpcUrl: configuredRpcUrl,
    } satisfies SolanaBehaviorSamplerClientConfig
  }

  const apiKey = yield* readApiKey
  return {
    apiKey,
    rpcUrl: DEFAULT_HELIUS_RPC_BASE_URL,
  } satisfies SolanaBehaviorSamplerClientConfig
})

const sdkError = (method: string, cause: unknown): SolanaBehaviorSamplerClientError =>
  toClientError(`Solana RPC ${method} request failed: ${stringifyUnknown(cause)}`)

const makeClient = ({
  apiKey,
  rpcUrl,
}: {
  readonly apiKey: string | null
  readonly rpcUrl: string
}): SolanaBehaviorSamplerClientShape => {
  const helius =
    apiKey === null
      ? createHelius({ network: "mainnet", baseUrl: rpcUrl })
      : createHelius({ apiKey, network: "mainnet", baseUrl: rpcUrl })

  return {
    fetchTransactionBySignature: ({ signature: transactionSignature }) =>
      Effect.tryPromise({
        try: () =>
          helius.getTransaction(signature(transactionSignature), {
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          }),
        catch: (cause) => sdkError("getTransaction", cause),
      }),
    fetchFinalizedBlock: ({ slot }) =>
      Effect.tryPromise({
        try: () =>
          helius.getBlock(BigInt(slot), {
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            transactionDetails: "full",
          }),
        catch: (cause) => sdkError("getBlock", cause),
      }),
  }
}

/** Live sampler client layer backed by Helius SDK RPC calls. */
export const SolanaBehaviorSamplerClientLive: Layer.Layer<SolanaBehaviorSamplerClient> =
  Layer.succeed(
    SolanaBehaviorSamplerClient,
    SolanaBehaviorSamplerClient.of({
      fetchTransactionBySignature: (params) =>
        Effect.gen(function* () {
          const config = yield* readSolanaBehaviorSamplerClientConfig
          return yield* makeClient(config).fetchTransactionBySignature(params)
        }),
      fetchFinalizedBlock: (params) =>
        Effect.gen(function* () {
          const config = yield* readSolanaBehaviorSamplerClientConfig
          return yield* makeClient(config).fetchFinalizedBlock(params)
        }),
    })
  )
