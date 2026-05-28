/**
 * HeliusSolanaSyncClientLive - Live Helius raw transaction history client.
 *
 * @module HeliusSolanaSyncClientLive
 */

import { createHelius } from "helius-sdk"
import type { GetTransactionsForAddressConfigFull } from "helius-sdk/types/types"
import type { GetTransfersRequest } from "helius-sdk/wallet/types"
import * as Config from "effect/Config"
import * as Either from "effect/Either"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  HeliusSolanaAuthError,
  HeliusSolanaProviderError,
  HeliusSolanaSyncClient,
  type HeliusSolanaSyncClientShape,
} from "../services/HeliusSolanaSyncClient.ts"

const HELIUS_API_KEY_CONFIG = Config.redacted("HELIUS_API_KEY")
const HELIUS_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

const UnknownProviderErrorSchema = Schema.Struct({
  message: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  statusCode: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
})

type UnknownProviderError = Schema.Schema.Type<typeof UnknownProviderErrorSchema>

const decodeUnknownProviderError = Schema.decodeUnknownEither(UnknownProviderErrorSchema)
const decodeUnknownString = Schema.decodeUnknownEither(Schema.String)

const trimOrNull = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const parseStatusCode = (message: string): number | null => {
  const match = /(?:status|http|code)\D*(\d{3})/iu.exec(message)
  const rawStatus = match?.[1]

  if (rawStatus === undefined) {
    return null
  }

  const statusCode = Number.parseInt(rawStatus, 10)
  return Number.isFinite(statusCode) ? statusCode : null
}

const statusCodeFromDecoded = (decoded: UnknownProviderError): number | null => {
  if (decoded.status !== undefined) {
    return decoded.status
  }

  if (decoded.statusCode !== undefined) {
    return decoded.statusCode
  }

  if (typeof decoded.code === "number") {
    return decoded.code
  }

  if (typeof decoded.code === "string") {
    return parseStatusCode(decoded.code)
  }

  return null
}

const messageFromUnknown = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return cause.message
  }

  const decodedString = decodeUnknownString(cause)
  if (Either.isRight(decodedString) && decodedString.right.trim() !== "") {
    return decodedString.right
  }

  const decoded = decodeUnknownProviderError(cause)
  if (Either.isRight(decoded)) {
    const message = trimOrNull(decoded.right.message)
    if (message !== null) {
      return message
    }
  }

  return "Helius request failed"
}

const statusCodeFromUnknown = (cause: unknown, message: string): number | null => {
  const decoded = decodeUnknownProviderError(cause)
  if (Either.isRight(decoded)) {
    const decodedStatus = statusCodeFromDecoded(decoded.right)
    if (decodedStatus !== null) {
      return decodedStatus
    }
  }

  return parseStatusCode(message)
}

const isTransientNetworkMessage = (message: string): boolean => {
  const normalized = message.toLowerCase()

  return (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("etimedout") ||
    normalized.includes("socket")
  )
}

const toHeliusClientError = (cause: unknown): HeliusSolanaAuthError | HeliusSolanaProviderError => {
  const message = messageFromUnknown(cause)
  const statusCode = statusCodeFromUnknown(cause, message)

  if (statusCode === 401 || statusCode === 403) {
    return new HeliusSolanaAuthError({
      message: `Helius authentication failed (${statusCode}). Check HELIUS_API_KEY.`,
    })
  }

  return new HeliusSolanaProviderError({
    message,
    statusCode,
    retryable:
      statusCode === null
        ? isTransientNetworkMessage(message)
        : HELIUS_RETRYABLE_STATUS_CODES.has(statusCode),
  })
}

const loadApiKey = HELIUS_API_KEY_CONFIG.pipe(
  Effect.mapError(
    () =>
      new HeliusSolanaAuthError({
        message: "HELIUS_API_KEY is not configured",
      })
  ),
  Effect.map(Redacted.value),
  Effect.flatMap((apiKey) => {
    const trimmed = apiKey.trim()

    return trimmed === ""
      ? Effect.fail(
          new HeliusSolanaAuthError({
            message: "HELIUS_API_KEY is empty",
          })
        )
      : Effect.succeed(trimmed)
  })
)

const make = HeliusSolanaSyncClient.of({
  fetchTransactionsForAddress: ({ walletAddress, config: paramsConfig }) =>
    Effect.gen(function* () {
      const apiKey = yield* loadApiKey
      const helius = createHelius({ apiKey, network: "mainnet" })
      const config: GetTransactionsForAddressConfigFull = {
        limit: paramsConfig.limit,
        paginationToken: paramsConfig.paginationToken,
        transactionDetails: paramsConfig.transactionDetails,
        sortOrder: paramsConfig.sortOrder,
        filters: {
          status: paramsConfig.filters.status,
          tokenAccounts: paramsConfig.filters.tokenAccounts,
        },
      }

      return yield* Effect.tryPromise({
        try: () => helius.getTransactionsForAddress([walletAddress, config]),
        catch: toHeliusClientError,
      })
    }),
  fetchAssetBatch: ({ mintAddresses }) =>
    Effect.gen(function* () {
      const apiKey = yield* loadApiKey
      const helius = createHelius({ apiKey, network: "mainnet" })

      return yield* Effect.tryPromise({
        try: () =>
          helius.getAssetBatch({
            ids: [...mintAddresses],
            options: {
              showFungible: true,
              showUnverifiedCollections: true,
              showCollectionMetadata: true,
            },
          }),
        catch: toHeliusClientError,
      })
    }),
  fetchTransfersForAddress: ({ walletAddress, limit, cursor }) =>
    Effect.gen(function* () {
      const apiKey = yield* loadApiKey
      const helius = createHelius({ apiKey, network: "mainnet" })
      const request: GetTransfersRequest =
        cursor === null
          ? {
              wallet: walletAddress,
              limit,
            }
          : {
              wallet: walletAddress,
              limit,
              cursor,
            }

      return yield* Effect.tryPromise({
        try: () => helius.wallet.getTransfers(request),
        catch: toHeliusClientError,
      })
    }),
} satisfies HeliusSolanaSyncClientShape)

/**
 * HeliusSolanaSyncClientLive - Live layer for Helius raw transaction retrieval.
 */
export const HeliusSolanaSyncClientLive: Layer.Layer<HeliusSolanaSyncClient> = Layer.succeed(
  HeliusSolanaSyncClient,
  make
)
