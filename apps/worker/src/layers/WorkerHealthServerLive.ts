/**
 * WorkerHealthServerLive - Lightweight worker health endpoint.
 *
 * @module WorkerHealthServerLive
 */

import { Config, Effect, Layer, Schema } from "effect"
import { createServer, type Server } from "node:http"

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

/**
 * WorkerHealthServerOptions - Optional dependency injection hooks for tests.
 */
export interface WorkerHealthServerOptions {
  readonly acquireServer?: (
    config: WorkerHealthServerConfig
  ) => Effect.Effect<Server, WorkerHealthServerError>
}

const loadConfig = Effect.gen(function* () {
  return {
    port: yield* Config.integer("WORKER_HEALTH_PORT").pipe(
      Config.withDefault(DEFAULT_WORKER_HEALTH_PORT),
      Config.validate({
        message: "WORKER_HEALTH_PORT must be between 0 and 65535",
        validation: (value) => Number.isInteger(value) && value >= 0 && value <= 65535,
      })
    ),
  } satisfies WorkerHealthServerConfig
})

const closeServer = (server: Server): Effect.Effect<void, WorkerHealthServerError> =>
  Effect.async<void, WorkerHealthServerError>((resume) => {
    let completed = false
    const complete = (effect: Effect.Effect<void, WorkerHealthServerError>) => {
      if (completed) {
        return
      }

      completed = true
      resume(effect)
    }

    if (!server.listening) {
      complete(Effect.void)
      return Effect.void
    }

    server.close((cause) => {
      if (cause === undefined) {
        complete(Effect.void)
        return
      }

      complete(
        Effect.fail(
          new WorkerHealthServerError({
            operation: "workerHealthServer.close",
            cause,
          })
        )
      )
    })

    return Effect.sync(() => {
      completed = true
    })
  })

const acquireLiveServer = ({
  port,
}: WorkerHealthServerConfig): Effect.Effect<Server, WorkerHealthServerError> =>
  Effect.async<Server, WorkerHealthServerError>((resume) => {
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        response.end("ok")
        return
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end("not found")
    })

    const cleanup = () => {
      server.off("error", onError)
      server.off("listening", onListening)
    }
    let completed = false
    const complete = (effect: Effect.Effect<Server, WorkerHealthServerError>) => {
      if (completed) {
        return
      }

      completed = true
      cleanup()
      resume(effect)
    }
    const onError = (cause: Error) => {
      complete(
        Effect.fail(
          new WorkerHealthServerError({
            operation: "workerHealthServer.listen",
            cause,
          })
        )
      )
    }
    const onListening = () => {
      complete(Effect.succeed(server))
    }

    server.once("error", onError)
    server.once("listening", onListening)
    server.listen({ host: "0.0.0.0", port })

    return Effect.sync(() => {
      if (completed) {
        return
      }

      completed = true
      cleanup()
      try {
        server.close()
      } catch {
        // Server may not have reached the listening state before interruption.
      }
    })
  })

/**
 * Construct a scoped health server layer.
 */
export const makeWorkerHealthServerLive = (options: WorkerHealthServerOptions = {}) =>
  Layer.scopedDiscard(
    Effect.gen(function* () {
      const config = yield* loadConfig
      const acquireServer = options.acquireServer ?? acquireLiveServer

      yield* Effect.acquireRelease(acquireServer(config), (server) =>
        closeServer(server).pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(
              { operation: error.operation, cause: error.cause },
              "worker-health:close-failed"
            )
          )
        )
      )

      yield* Effect.logInfo({ port: config.port }, "worker-health:started")
    })
  )

/**
 * WorkerHealthServerLive - Live worker health server.
 */
export const WorkerHealthServerLive = makeWorkerHealthServerLive()
