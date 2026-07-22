import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { prepareTemplateDatabase } from "../vitest.integration.setup.ts"

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
})
