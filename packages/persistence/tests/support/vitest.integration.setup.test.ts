import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  cleanupIntegrationTestDatabases,
  prepareTemplateDatabase,
} from "./vitest.integration.setup.ts"

describe("integration test template setup", () => {
  it("cleans up a template when preparation fails", async () => {
    const events: Array<string> = []
    const preparationFailure = "migration failed"

    const failure = await Effect.runPromise(
      prepareTemplateDatabase({
        cleanupTemplate: Effect.sync(() => {
          events.push("cleaned")
        }),
        prepareTemplate: Effect.sync(() => {
          events.push("created")
        }).pipe(Effect.andThen(Effect.fail(preparationFailure))),
      }).pipe(Effect.flip)
    )

    expect(failure).toBe(preparationFailure)
    expect(events).toEqual(["created", "cleaned"])
  })

  it("cleans integration databases sequentially", async () => {
    const events: Array<string> = []

    await Effect.runPromise(
      cleanupIntegrationTestDatabases({
        databaseNames: ["first", "second"],
        cleanupDatabase: (databaseName) =>
          Effect.gen(function* () {
            events.push(`start:${databaseName}`)
            yield* Effect.sleep("1 millis")
            events.push(`finish:${databaseName}`)
          }),
      })
    )

    expect(events).toEqual(["start:first", "finish:first", "start:second", "finish:second"])
  })
})
