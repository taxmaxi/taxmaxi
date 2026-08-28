import { NodeHttpClient } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Random, Result, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import {
  WorkerHealthServerError,
  WorkerHealthServerLive,
} from "../src/layers/WorkerHealthServerLive.ts"

const isWorkerHealthServerError = Schema.is(WorkerHealthServerError)

const assertHealthServerResponds: (
  remainingRetries: number
) => Effect.Effect<void, unknown, HttpClient.HttpClient> = Effect.fnUntraced(
  function* (remainingRetries) {
    const port = yield* Random.nextIntBetween(20_000, 60_000)
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const response = yield* HttpClient.get(`http://127.0.0.1:${port}/health`)
        const body = yield* response.text

        expect(response.status).toBe(200)
        expect(body).toBe("ok")
      }).pipe(
        Effect.provide(WorkerHealthServerLive),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ WORKER_HEALTH_PORT: String(port) })
        )
      )
    ).pipe(Effect.result)

    if (Result.isSuccess(outcome)) {
      return
    }

    if (
      remainingRetries > 0 &&
      isWorkerHealthServerError(outcome.failure) &&
      Schema.is(Schema.Struct({ code: Schema.Literal("EADDRINUSE") }))(outcome.failure.cause)
    ) {
      return yield* assertHealthServerResponds(remainingRetries - 1)
    }

    return yield* Effect.fail(outcome.failure)
  }
)

describe("WorkerHealthServerLive", () => {
  it.effect("serves GET /health with 200 ok", () =>
    assertHealthServerResponds(1).pipe(Effect.provide(NodeHttpClient.layerNodeHttp))
  )
})
