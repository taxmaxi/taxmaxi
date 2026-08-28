/**
 * WorkerHealthServerLive - Lightweight worker health endpoint.
 *
 * @module WorkerHealthServerLive
 */

import { NodeHttpServer } from "@effect/platform-node"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
// NodeHttpServer requires the Node server constructor as its platform adapter.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http"

const DEFAULT_WORKER_HEALTH_PORT = 4001

/**
 * WorkerHealthServerConfig - Runtime configuration for the health server.
 */
export interface WorkerHealthServerConfig {
  readonly port: number
}

/**
 * WorkerHealthServerError - Health server lifecycle failure.
 */
export class WorkerHealthServerError extends Schema.TaggedError<WorkerHealthServerError>()(
  "WorkerHealthServerError",
  {
    operation: Schema.String,
    cause: Schema.Unknown,
  }
) {}

const loadConfig = Effect.gen(function* () {
  return {
    port: yield* Config.schema(
      Schema.Int.check(
        Schema.isBetween(
          { minimum: 0, maximum: 65_535 },
          { message: "WORKER_HEALTH_PORT must be between 0 and 65535" }
        )
      ),
      "WORKER_HEALTH_PORT"
    ).pipe(Config.withDefault(DEFAULT_WORKER_HEALTH_PORT)),
  } satisfies WorkerHealthServerConfig
})

const HealthRoutesLive = HttpRouter.add(
  "GET",
  "/health",
  HttpServerResponse.text("ok", {
    contentType: "text/plain; charset=utf-8",
  })
)

/**
 * WorkerHealthServerLive - Live worker health server.
 */
export const WorkerHealthServerLive = Layer.unwrap(
  loadConfig.pipe(
    Effect.map((config) =>
      HttpRouter.serve(HealthRoutesLive).pipe(
        Layer.provide(
          NodeHttpServer.layer(createServer, {
            host: "0.0.0.0",
            port: config.port,
          })
        ),
        Layer.catchTag("ServeError", (error) =>
          Layer.effectDiscard(
            Effect.fail(
              new WorkerHealthServerError({
                operation: "workerHealthServer.listen",
                cause: error.cause,
              })
            )
          )
        ),
        Layer.tap(() => Effect.logInfo({ port: config.port }, "worker-health:started"))
      )
    )
  )
)
