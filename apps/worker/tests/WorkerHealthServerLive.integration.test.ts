import { ConfigProvider, Effect, Either, Schema } from "effect"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import {
  WorkerHealthServerError,
  WorkerHealthServerLive,
} from "../src/layers/WorkerHealthServerLive.ts"

const AddressInUseCause = Schema.Struct({
  code: Schema.Literal("EADDRINUSE"),
})

const isAddressInUseError = (cause: unknown) =>
  Either.isRight(Schema.decodeUnknownEither(AddressInUseCause)(cause))

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()

      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a TCP port")))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error === undefined) {
          resolve(port)
          return
        }

        reject(error)
      })
    })
  })

describe("WorkerHealthServerLive", () => {
  const assertHealthServerResponds = async (remainingRetries: number): Promise<void> => {
    const port = await getFreePort()

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
              try: () => fetch(`http://127.0.0.1:${port}/health`),
              catch: (cause) => cause,
            })
            const body = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: (cause) => cause,
            })

            expect(response.status).toBe(200)
            expect(body).toBe("ok")
          }).pipe(
            Effect.provide(WorkerHealthServerLive),
            Effect.withConfigProvider(
              ConfigProvider.fromMap(new Map([["WORKER_HEALTH_PORT", String(port)]]))
            )
          )
        )
      )
      return
    } catch (cause) {
      if (
        remainingRetries > 0 &&
        cause instanceof WorkerHealthServerError &&
        isAddressInUseError(cause.cause)
      ) {
        await assertHealthServerResponds(remainingRetries - 1)
        return
      }

      throw cause
    }
  }

  it("serves GET /health with 200 ok", async () => {
    await assertHealthServerResponds(1)
  })
})
