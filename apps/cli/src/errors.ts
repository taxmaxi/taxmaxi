import { Schema } from "effect"

export class CliCommandError extends Schema.TaggedError<CliCommandError>()("CliCommandError", {
  message: Schema.String,
  status: Schema.optional(Schema.Finite),
}) {}

const isCliCommandError = Schema.is(CliCommandError)

export const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") {
      return message
    }
  }
  return fallback
}

export const mapUnknownToCliCommandError = (fallback: string) => (error: unknown) =>
  isCliCommandError(error)
    ? error
    : new CliCommandError({
        message: getErrorMessage(error, fallback),
      })
