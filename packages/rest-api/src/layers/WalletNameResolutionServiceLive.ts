/**
 * WalletNameResolutionServiceLive - Wallet name resolution with a durable cache.
 *
 * Resolves ENS names against the Ethereum mainnet registry using viem's
 * getEnsAddress, and SNS names through the Helius wallet identity API.
 * Results are cached through the persistence wallet name cache with a TTL,
 * because name records can change over time.
 *
 * SNS goes through Helius instead of an on-chain lookup because the
 * @bonfida/spl-name-service SDK paused .sol resolution during the SRS
 * migration (its resolve throws UnsupportedTld past a cutoff slot). Helius
 * runs a maintained resolver and TaxMaxi already uses Helius for Solana.
 *
 * Configuration:
 * - ETHEREUM_RPC_URL: Ethereum mainnet RPC endpoint. Defaults to the public
 *   PublicNode endpoint, which supports the ENS universal resolver calls
 *   viem makes. (Cloudflare's public endpoint does not.)
 * - HELIUS_API_KEY: Helius API key used for SNS resolution. When missing,
 *   SNS names fail with resolution_failed.
 *
 * @module WalletNameResolutionServiceLive
 */

import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { createPublicClient, http } from "viem"
import { mainnet } from "viem/chains"
import { normalize } from "viem/ens"
import {
  chainTypeForNamespace,
  detectNameServiceNamespace,
  type WalletNameResolutionErrorCode,
} from "@my/core/source"
import { WalletNameCacheRepository } from "@my/persistence/services"
import {
  WalletNameResolutionError,
  WalletNameResolutionService,
  type WalletNameResolutionServiceShape,
} from "../services/WalletNameResolutionService.ts"

/** Cache lifetime for resolved names (24 hours). Name records can change. */
const CACHE_TTL_MILLIS = 24 * 60 * 60 * 1000

const DEFAULT_ETHEREUM_RPC_URL = "https://ethereum-rpc.publicnode.com"
const HELIUS_WALLET_API_BASE_URL = "https://api.helius.xyz"

/** Developer-facing messages per code. Clients map codes to their own copy. */
const ERROR_MESSAGES: Record<WalletNameResolutionErrorCode, string> = {
  invalid_name:
    "Not a supported wallet name. Expected an ENS name (.eth, .cb.id, .xyz, .id) or an SNS name (.sol).",
  name_unresolved: "This wallet name does not exist or has no address set.",
  network_unavailable: "Could not reach the name resolution endpoint.",
  rate_limited: "The name resolution endpoint rate-limited the request.",
  resolution_failed: "Wallet name resolution failed.",
}

const HeliusWalletIdentityResponse = Schema.Struct({
  address: Schema.String,
})

const isNetworkCause = (causeText: string): boolean =>
  causeText.includes("network") ||
  causeText.includes("timeout") ||
  causeText.includes("ECONNREFUSED") ||
  causeText.includes("fetch failed")

const isRateLimitCause = (causeText: string): boolean =>
  causeText.includes("rate limit") || causeText.includes("429")

/**
 * Classify ENS RPC failures into stable resolution error codes.
 */
const classifyEnsError = (cause: unknown, name: string): WalletNameResolutionError => {
  const causeText = String(cause)

  const code: WalletNameResolutionErrorCode = isNetworkCause(causeText)
    ? "network_unavailable"
    : isRateLimitCause(causeText)
      ? "rate_limited"
      : causeText.includes("reverted")
        ? "name_unresolved"
        : "resolution_failed"

  return new WalletNameResolutionError({
    code,
    name,
    namespace: "ens",
    message: ERROR_MESSAGES[code],
    cause,
  })
}

const snsError = ({
  cause,
  code,
  name,
}: {
  readonly code: WalletNameResolutionErrorCode
  readonly name: string
  readonly cause?: unknown
}) =>
  new WalletNameResolutionError({
    code,
    name,
    namespace: "sns",
    message: ERROR_MESSAGES[code],
    cause,
  })

const make = Effect.gen(function* () {
  const cache = yield* WalletNameCacheRepository
  const httpClient = yield* HttpClient.HttpClient
  const ethereumRpcUrl = yield* Config.string("ETHEREUM_RPC_URL").pipe(
    Config.withDefault(DEFAULT_ETHEREUM_RPC_URL)
  )
  const heliusApiKey = yield* Config.option(Config.redacted("HELIUS_API_KEY"))

  const ethereumClient = createPublicClient({
    chain: mainnet,
    transport: http(ethereumRpcUrl),
  })

  /**
   * Resolve a name against the ENS registry on Ethereum mainnet.
   */
  const resolveEnsOnChain = (name: string) =>
    Effect.gen(function* () {
      const address = yield* Effect.tryPromise({
        try: () => ethereumClient.getEnsAddress({ name: normalize(name) }),
        catch: (cause) => classifyEnsError(cause, name),
      })

      if (!address) {
        return yield* new WalletNameResolutionError({
          code: "name_unresolved",
          name,
          namespace: "ens",
          message: ERROR_MESSAGES.name_unresolved,
        })
      }

      return address
    })

  /**
   * Resolve a name through the Helius wallet identity API, which accepts
   * SNS .sol domains and returns the wallet address they resolve to.
   */
  const resolveSnsViaHelius = (name: string) =>
    Effect.gen(function* () {
      if (Option.isNone(heliusApiKey)) {
        return yield* new WalletNameResolutionError({
          code: "resolution_failed",
          name,
          namespace: "sns",
          message: "SNS resolution is not configured: HELIUS_API_KEY is missing.",
        })
      }

      const request = HttpClientRequest.get(
        `${HELIUS_WALLET_API_BASE_URL}/v1/wallet/${encodeURIComponent(name)}/identity`
      ).pipe(HttpClientRequest.setHeader("x-api-key", Redacted.value(heliusApiKey.value)))

      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError((cause) =>
          snsError({
            code: isNetworkCause(String(cause)) ? "network_unavailable" : "resolution_failed",
            name,
            cause,
          })
        )
      )

      if (response.status === 404) {
        return yield* snsError({ code: "name_unresolved", name })
      }

      if (response.status === 429) {
        return yield* snsError({ code: "rate_limited", name })
      }

      if (response.status < 200 || response.status >= 300) {
        const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* snsError({
          code: "resolution_failed",
          name,
          cause: `Helius wallet identity request failed (${response.status}): ${bodyText}`,
        })
      }

      const payload = yield* response.json.pipe(
        Effect.mapError((cause) => snsError({ code: "resolution_failed", name, cause }))
      )
      const identity = yield* Schema.decodeUnknownEffect(HeliusWalletIdentityResponse)(
        payload
      ).pipe(Effect.mapError((cause) => snsError({ code: "resolution_failed", name, cause })))

      return identity.address
    })

  const resolve: WalletNameResolutionServiceShape["resolve"] = (rawName) =>
    Effect.gen(function* () {
      const name = rawName.toLowerCase().trim()
      const namespace = detectNameServiceNamespace(name)

      if (namespace === null) {
        return yield* new WalletNameResolutionError({
          code: "invalid_name",
          name,
          namespace: null,
          message: ERROR_MESSAGES.invalid_name,
        })
      }

      const chainType = chainTypeForNamespace(namespace)
      const cachedAddress = yield* cache.get({ namespace, name })

      if (cachedAddress !== null) {
        return { namespace, name, resolvedAddress: cachedAddress, chainType, fromCache: true }
      }

      const resolvedAddress = yield* (
        namespace === "ens" ? resolveEnsOnChain(name) : resolveSnsViaHelius(name)
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            { namespace, name, code: error.code, cause: error.cause },
            "Wallet name resolution failed"
          )
        )
      )

      const now = new Date()
      yield* cache.upsert({
        namespace,
        name,
        resolvedAddress,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MILLIS),
      })
      yield* Effect.logInfo({ namespace, name, resolvedAddress }, "Wallet name resolved")

      return { namespace, name, resolvedAddress, chainType, fromCache: false }
    })

  return {
    resolve,
  } satisfies WalletNameResolutionServiceShape
})

/**
 * WalletNameResolutionServiceLive - Layer providing the live implementation
 */
export const WalletNameResolutionServiceLive = Layer.effect(WalletNameResolutionService, make).pipe(
  Layer.provide(FetchHttpClient.layer)
)
