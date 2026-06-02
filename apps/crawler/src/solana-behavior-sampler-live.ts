import { createHelius } from "helius-sdk"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  SolanaBehaviorSamplerClient,
  SolanaBehaviorSamplerClientError,
  type SolanaBehaviorSamplerClientShape,
} from "./solana-behavior-sampler.ts"

const HELIUS_API_KEY_CONFIG = Config.redacted("HELIUS_API_KEY")
const SOLANA_RPC_URL_CONFIG = Config.option(Config.string("SOLANA_RPC_URL"))

const JsonRpcResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const decodeJsonRpcResponseEither = Schema.decodeUnknownEither(JsonRpcResponseSchema)

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

const readOptionalRpcUrl = SOLANA_RPC_URL_CONFIG.pipe(
  Effect.mapError(() => toClientError("Failed to read SOLANA_RPC_URL")),
  Effect.map((maybeUrl) =>
    maybeUrl._tag === "Some" && maybeUrl.value.trim() !== "" ? maybeUrl.value.trim() : null
  )
)

const heliusRpcUrl = (apiKey: string): string =>
  `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`

const makeRpcRequest = ({
  method,
  params,
}: {
  readonly method: string
  readonly params: ReadonlyArray<unknown>
}) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
})

const executeJsonRpc = ({
  rpcUrl,
  method,
  params,
}: {
  readonly rpcUrl: string
  readonly method: string
  readonly params: ReadonlyArray<unknown>
}): Effect.Effect<unknown, SolanaBehaviorSamplerClientError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(makeRpcRequest({ method, params })),
      })

      const body: unknown = await response.json()

      if (!response.ok) {
        throw toClientError(`Solana RPC ${method} failed (${response.status}): ${stringifyUnknown(body)}`)
      }

      const decoded = decodeJsonRpcResponseEither(body)
      if (Either.isLeft(decoded)) {
        throw toClientError(`Solana RPC ${method} returned malformed JSON-RPC: ${decoded.left.message}`)
      }

      if (decoded.right.error !== undefined) {
        throw toClientError(`Solana RPC ${method} failed: ${stringifyUnknown(decoded.right.error)}`)
      }

      if (decoded.right.result === undefined) {
        throw toClientError(`Solana RPC ${method} returned no result`)
      }

      return decoded.right.result
    },
    catch: (cause) =>
      cause instanceof SolanaBehaviorSamplerClientError
        ? cause
        : toClientError(`Solana RPC ${method} request failed: ${String(cause)}`),
  })

const makeClient = (apiKey: string, rpcUrl: string): SolanaBehaviorSamplerClientShape => {
  createHelius({ apiKey, network: "mainnet" })

  return {
    fetchTransactionBySignature: ({ signature }) =>
      executeJsonRpc({
        rpcUrl,
        method: "getTransaction",
        params: [
          signature,
          {
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    fetchFinalizedBlock: ({ slot }) =>
      executeJsonRpc({
        rpcUrl,
        method: "getBlock",
        params: [
          slot,
          {
            commitment: "finalized",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
            transactionDetails: "full",
          },
        ],
      }),
  }
}

export const SolanaBehaviorSamplerClientLive: Layer.Layer<SolanaBehaviorSamplerClient> =
  Layer.succeed(
    SolanaBehaviorSamplerClient,
    SolanaBehaviorSamplerClient.of({
      fetchTransactionBySignature: (params) =>
        Effect.gen(function* () {
          const apiKey = yield* readApiKey
          const configuredRpcUrl = yield* readOptionalRpcUrl
          return yield* makeClient(apiKey, configuredRpcUrl ?? heliusRpcUrl(apiKey))
            .fetchTransactionBySignature(params)
        }),
      fetchFinalizedBlock: (params) =>
        Effect.gen(function* () {
          const apiKey = yield* readApiKey
          const configuredRpcUrl = yield* readOptionalRpcUrl
          return yield* makeClient(apiKey, configuredRpcUrl ?? heliusRpcUrl(apiKey))
            .fetchFinalizedBlock(params)
        }),
    })
  )
