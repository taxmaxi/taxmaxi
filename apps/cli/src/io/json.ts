import { Console, Effect, Schema } from "effect"
import { CliCommandError } from "../errors.ts"

const JsonOutput = Schema.parseJson(Schema.Unknown)

export const printJson = (value: unknown) =>
  Schema.encode(JsonOutput)(value).pipe(
    Effect.mapError(
      () =>
        new CliCommandError({
          message: "Failed to encode JSON output",
        })
    ),
    Effect.flatMap(Console.log)
  )
