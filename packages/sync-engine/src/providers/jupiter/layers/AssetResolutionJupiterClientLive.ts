/**
 * AssetResolutionJupiterClientLive - Live Jupiter token lookup for asset resolution.
 *
 * Calls the authenticated Jupiter API host and classifies fetch failures
 * before they become durable decisions: rate limits, server errors,
 * timeouts, and transport failures are retried with backoff and then raised
 * as retryable so the job runs again later. A 2xx response is payload
 * evidence the caller decodes; an unreadable body or unexpected status stays
 * a terminal upstream failure the policy fails closed on.
 *
 * Requires JUPITER_API_KEY. A worker without spam detection must fail loudly
 * at boot rather than silently resolve without banned evidence.
 *
 * Dependencies: HttpClient (provided via FetchHttpClient).
 *
 * @module AssetResolutionJupiterClientLive
 */

import {
  AssetResolutionUpstreamFailure,
  type AssetResolutionRegistryEvidence,
} from "@my/core/assets"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { positiveIntConfig } from "../../../shared/PositiveIntConfig.ts"
import {
  AssetResolutionJupiterClient,
  AssetResolutionJupiterRetryableError,
  type AssetResolutionJupiterClientShape,
} from "../services/AssetResolutionJupiterClient.ts"

export const JUPITER_API_BASE_URL = "https://api.jup.ag"

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_ATTEMPTS = 2
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000

const jupiterApiKeyConfig = Config.schema(
  Schema.Trim.check(Schema.isNonEmpty({ message: "JUPITER_API_KEY must not be empty" })),
  "JUPITER_API_KEY"
)

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient
  const apiKey = yield* jupiterApiKeyConfig
  const configuredBaseUrl = yield* Config.option(Config.string("JUPITER_API_BASE_URL"))
  const baseUrl = Option.getOrElse(configuredBaseUrl, () => JUPITER_API_BASE_URL)
  const requestTimeoutMs = yield* positiveIntConfig({
    name: "JUPITER_REQUEST_TIMEOUT_MS",
    defaultValue: DEFAULT_REQUEST_TIMEOUT_MS,
  })
  const retryAttempts = yield* positiveIntConfig({
    name: "JUPITER_RETRY_ATTEMPTS",
    defaultValue: DEFAULT_RETRY_ATTEMPTS,
  })
  const retryBaseDelayMs = yield* positiveIntConfig({
    name: "JUPITER_RETRY_BASE_DELAY_MS",
    defaultValue: DEFAULT_RETRY_BASE_DELAY_MS,
  })

  const upstreamFailure = new AssetResolutionUpstreamFailure({ source: "jupiter" })

  const fetchTokenByMint: AssetResolutionJupiterClientShape["fetchTokenByMint"] = ({
    mintAddress,
  }) => {
    const request = HttpClientRequest.get(
      `${baseUrl}/tokens/v2/search?query=${encodeURIComponent(mintAddress)}`
    ).pipe(HttpClientRequest.setHeader("x-api-key", apiKey))

    const attempt = httpClient.execute(request).pipe(
      Effect.timeout(requestTimeoutMs),
      Effect.mapError((cause) => new AssetResolutionJupiterRetryableError({ status: null, cause })),
      Effect.flatMap(
        (
          response
        ): Effect.Effect<AssetResolutionRegistryEvidence, AssetResolutionJupiterRetryableError> => {
          if (isRetryableStatus(response.status)) {
            return Effect.fail(
              new AssetResolutionJupiterRetryableError({
                status: response.status,
                cause: `Jupiter responded ${response.status}`,
              })
            )
          }

          if (response.status < 200 || response.status >= 300) {
            return Effect.succeed(upstreamFailure)
          }

          return response.json.pipe(
            Effect.map((payload) => ({ _tag: "payload", payload }) as const),
            Effect.orElseSucceed(() => upstreamFailure)
          )
        }
      )
    )

    return attempt.pipe(
      Effect.retry({
        times: retryAttempts,
        schedule: Schedule.exponential(retryBaseDelayMs),
      })
    )
  }

  return AssetResolutionJupiterClient.of({ fetchTokenByMint })
})

/**
 * AssetResolutionJupiterClientLayer - Client layer that still requires an
 * HttpClient, so tests can stub the transport.
 */
export const AssetResolutionJupiterClientLayer = Layer.effect(AssetResolutionJupiterClient, make)

/**
 * AssetResolutionJupiterClientLive - Live layer backed by the authenticated Jupiter API.
 */
export const AssetResolutionJupiterClientLive = AssetResolutionJupiterClientLayer.pipe(
  Layer.provide(FetchHttpClient.layer)
)
