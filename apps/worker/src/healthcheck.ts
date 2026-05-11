import { NodeRuntime } from "@effect/platform-node"
import { Config, Effect } from "effect"
import { request } from "node:http"

const DEFAULT_WORKER_HEALTH_PORT = 4001
const HEALTHCHECK_TIMEOUT_MS = 4_000

const healthPort = Config.integer("WORKER_HEALTH_PORT").pipe(
  Config.withDefault(DEFAULT_WORKER_HEALTH_PORT),
  Config.validate({
    message: "WORKER_HEALTH_PORT must be between 0 and 65535",
    validation: (value) => Number.isInteger(value) && value >= 0 && value <= 65535,
  })
)

const checkHealth = (port: number) =>
  Effect.async<boolean>((resume) => {
    let settled = false
    const complete = (healthy: boolean) => {
      if (settled) {
        return
      }

      settled = true
      resume(Effect.succeed(healthy))
    }
    const healthRequest = request(
      { host: "127.0.0.1", port, path: "/health", method: "GET" },
      (response) => {
        response.resume()
        complete(response.statusCode === 200)
      }
    )

    healthRequest.once("error", () => complete(false))
    healthRequest.setTimeout(HEALTHCHECK_TIMEOUT_MS, () => {
      complete(false)
      healthRequest.destroy()
    })
    healthRequest.end()

    return Effect.sync(() => {
      settled = true
      healthRequest.destroy()
    })
  })

const program = Effect.gen(function* () {
  const port = yield* healthPort
  const healthy = yield* checkHealth(port)

  return yield* Effect.sync(() => {
    process.exitCode = healthy ? 0 : 1
  })
})

NodeRuntime.runMain(program)
