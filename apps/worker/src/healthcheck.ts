import { NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"

const DEFAULT_WORKER_HEALTH_PORT = 4001
const HEALTHCHECK_TIMEOUT_MS = 4_000

const healthPort = Config.schema(
  Schema.Int.check(
    Schema.isBetween(
      { minimum: 0, maximum: 65_535 },
      { message: "WORKER_HEALTH_PORT must be between 0 and 65535" }
    )
  ),
  "WORKER_HEALTH_PORT"
).pipe(Config.withDefault(DEFAULT_WORKER_HEALTH_PORT))

const checkHealth = (port: number) =>
  HttpClient.get(`http://127.0.0.1:${port}/health`).pipe(
    Effect.flatMap((response) => response.text.pipe(Effect.as(response.status === 200))),
    Effect.timeout(HEALTHCHECK_TIMEOUT_MS),
    Effect.orElseSucceed(() => false)
  )

const program = Effect.gen(function* () {
  const port = yield* healthPort
  const healthy = yield* checkHealth(port)

  return yield* Effect.sync(() => {
    process.exitCode = healthy ? 0 : 1
  })
})

program.pipe(Effect.provide(NodeHttpClient.layerNodeHttp), NodeRuntime.runMain)
