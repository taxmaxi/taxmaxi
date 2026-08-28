import * as Effect from "effect/Effect"
import { describe, expect, it } from "@effect/vitest"
import {
  cleanupIntegrationTestDatabases,
  prepareTemplateDatabase,
} from "./vitest.integration.setup.ts"

describe("integration test template setup", () => {
  it.effect("cleans up a template when preparation fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = []
      const preparationFailure = "migration failed"

      const failure = yield* prepareTemplateDatabase({
        cleanupTemplate: Effect.sync(() => {
          events.push("cleaned")
        }),
        prepareTemplate: Effect.sync(() => {
          events.push("created")
        }).pipe(Effect.andThen(Effect.fail(preparationFailure))),
      }).pipe(Effect.flip)

      expect(failure).toBe(preparationFailure)
      expect(events).toEqual(["created", "cleaned"])
    })
  )

  it.live("cleans integration databases concurrently", () =>
    Effect.gen(function* () {
      const events: Array<string> = []

      yield* cleanupIntegrationTestDatabases({
        databaseNames: ["first", "second"],
        cleanupDatabase: (databaseName) =>
          Effect.gen(function* () {
            events.push(`start:${databaseName}`)
            yield* Effect.sleep("1 millis")
            events.push(`finish:${databaseName}`)
          }),
      })

      expect(events).toEqual(["start:first", "start:second", "finish:first", "finish:second"])
    })
  )
})
