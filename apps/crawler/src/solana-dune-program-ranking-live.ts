/**
 * Live Dune API client for historical Solana program rankings.
 *
 * @module
 */
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  SolanaDuneProgramRankingClient,
  SolanaDuneProgramRankingError,
  type ExecuteSolanaDuneQueryParams,
  type SolanaDuneProgramRankingClientShape,
} from "./solana-dune-program-ranking.ts"

const DUNE_API_URL = "https://api.dune.com/api/v1"
const DUNE_API_KEY_CONFIG = Config.redacted("DUNE_API_KEY")
const DUNE_EXECUTION_POLL_LIMIT = 60

const DuneExecuteResponse = Schema.Struct({
  execution_id: Schema.String,
  state: Schema.String,
})

const DuneExecutionStatusResponse = Schema.Struct({
  execution_id: Schema.String,
  is_execution_finished: Schema.Boolean,
  state: Schema.String,
  error: Schema.optional(Schema.Unknown),
})

const stringifyUnknown = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const toDuneError = ({
  message,
  queryId,
}: {
  readonly message: string
  readonly queryId?: number
}): SolanaDuneProgramRankingError =>
  new SolanaDuneProgramRankingError({
    message,
    ...(queryId === undefined ? {} : { queryId }),
  })

export const readSolanaDuneApiKey: Effect.Effect<string, SolanaDuneProgramRankingError> =
  DUNE_API_KEY_CONFIG.pipe(
    Effect.map(Redacted.value),
    Effect.mapError(() => toDuneError({ message: "DUNE_API_KEY is not configured" })),
    Effect.flatMap((apiKey) => {
      const trimmed = apiKey.trim()
      return trimmed === ""
        ? Effect.fail(toDuneError({ message: "DUNE_API_KEY is empty" }))
        : Effect.succeed(trimmed)
    })
  )

const decodeJson =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (
    response: HttpClientResponse.HttpClientResponse
  ): Effect.Effect<A, SolanaDuneProgramRankingError> =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => toDuneError({ message: "Failed to decode Dune API response" }))
    )

const executeAndDecode = <A, I>({
  client,
  request,
  schema,
  queryId,
}: {
  readonly client: HttpClient.HttpClient
  readonly request: HttpClientRequest.HttpClientRequest
  readonly schema: Schema.Schema<A, I>
  readonly queryId: number
}): Effect.Effect<A, SolanaDuneProgramRankingError> =>
  Effect.gen(function* () {
    const response = yield* client.execute(request).pipe(
      Effect.mapError((error) =>
        toDuneError({
          queryId,
          message: `Dune API request failed: ${error.message}`,
        })
      )
    )
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* toDuneError({
        queryId,
        message: `Dune API request failed (${response.status}): ${body}`,
      })
    }

    return yield* decodeJson(schema)(response)
  }).pipe(Effect.scoped)

const authenticatedRequest = ({
  apiKey,
  request,
}: {
  readonly apiKey: string
  readonly request: HttpClientRequest.HttpClientRequest
}) =>
  request.pipe(
    HttpClientRequest.setHeader("X-Dune-API-Key", apiKey),
    HttpClientRequest.setHeader("Content-Type", "application/json")
  )

const executeSavedQuery = ({
  client,
  apiKey,
  params,
}: {
  readonly client: HttpClient.HttpClient
  readonly apiKey: string
  readonly params: ExecuteSolanaDuneQueryParams
}) =>
  executeAndDecode({
    client,
    queryId: params.query.queryId,
    schema: DuneExecuteResponse,
    request: authenticatedRequest({
      apiKey,
      request: HttpClientRequest.post(`/query/${params.query.queryId}/execute`).pipe(
        HttpClientRequest.bodyUnsafeJson({
          query_parameters: params.parameters,
        })
      ),
    }),
  })

const fetchExecutionStatus = ({
  client,
  apiKey,
  executionId,
  queryId,
}: {
  readonly client: HttpClient.HttpClient
  readonly apiKey: string
  readonly executionId: string
  readonly queryId: number
}) =>
  executeAndDecode({
    client,
    queryId,
    schema: DuneExecutionStatusResponse,
    request: authenticatedRequest({
      apiKey,
      request: HttpClientRequest.get(`/execution/${executionId}/status`),
    }),
  })

const fetchExecutionResult = ({
  client,
  apiKey,
  executionId,
  queryId,
}: {
  readonly client: HttpClient.HttpClient
  readonly apiKey: string
  readonly executionId: string
  readonly queryId: number
}) =>
  executeAndDecode({
    client,
    queryId,
    schema: Schema.Unknown,
    request: authenticatedRequest({
      apiKey,
      request: HttpClientRequest.get(`/execution/${executionId}/results`),
    }),
  })

const waitForExecutionResult = ({
  client,
  apiKey,
  executionId,
  queryId,
  remainingPolls,
}: {
  readonly client: HttpClient.HttpClient
  readonly apiKey: string
  readonly executionId: string
  readonly queryId: number
  readonly remainingPolls: number
}): Effect.Effect<unknown, SolanaDuneProgramRankingError> =>
  Effect.gen(function* () {
    if (remainingPolls <= 0) {
      return yield* toDuneError({
        queryId,
        message: `Dune execution ${executionId} did not finish before the poll limit`,
      })
    }

    const status = yield* fetchExecutionStatus({ client, apiKey, executionId, queryId })
    if (status.state === "QUERY_STATE_COMPLETED") {
      return yield* fetchExecutionResult({ client, apiKey, executionId, queryId })
    }

    if (
      status.state === "QUERY_STATE_FAILED" ||
      status.state === "QUERY_STATE_CANCELED" ||
      status.state === "QUERY_STATE_EXPIRED" ||
      status.state === "QUERY_STATE_COMPLETED_PARTIAL"
    ) {
      return yield* toDuneError({
        queryId,
        message: `Dune execution ${executionId} ended with ${status.state}: ${stringifyUnknown(
          status.error
        )}`,
      })
    }

    yield* Effect.sleep("1 second")
    return yield* waitForExecutionResult({
      client,
      apiKey,
      executionId,
      queryId,
      remainingPolls: remainingPolls - 1,
    })
  })

const makeClient = ({
  apiKey,
  client,
}: {
  readonly apiKey: string
  readonly client: HttpClient.HttpClient
}): SolanaDuneProgramRankingClientShape => ({
  executeQuery: (params) =>
    Effect.gen(function* () {
      const execution = yield* executeSavedQuery({ client, apiKey, params })
      return yield* waitForExecutionResult({
        client,
        apiKey,
        executionId: execution.execution_id,
        queryId: params.query.queryId,
        remainingPolls: DUNE_EXECUTION_POLL_LIMIT,
      })
    }),
})

/** Live Dune client layer backed by the Dune HTTP API. */
export const SolanaDuneProgramRankingClientLive: Layer.Layer<
  SolanaDuneProgramRankingClient,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  SolanaDuneProgramRankingClient,
  Effect.gen(function* () {
    const defaultClient = yield* HttpClient.HttpClient
    const client = defaultClient.pipe(
      HttpClient.mapRequest(HttpClientRequest.prependUrl(DUNE_API_URL))
    )
    return SolanaDuneProgramRankingClient.of({
      executeQuery: (params) =>
        Effect.gen(function* () {
          const apiKey = yield* readSolanaDuneApiKey
          return yield* makeClient({ apiKey, client }).executeQuery(params)
        }),
    })
  })
)
