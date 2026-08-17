import { Console, Effect, Schema } from "effect"
import { CliCommandError } from "../errors.ts"

const JsonOutput = Schema.fromJsonString(Schema.Unknown)

export const printJson = (value: unknown) =>
  Schema.encodeEffect(JsonOutput)(value).pipe(
    Effect.mapError(
      () =>
        new CliCommandError({
          message: "Failed to encode JSON output",
        })
    ),
    Effect.flatMap(Console.log)
  )
