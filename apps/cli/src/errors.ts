import { Schema } from "effect"

export class CliCommandError extends Schema.TaggedError<CliCommandError>()("CliCommandError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

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
  error instanceof CliCommandError
    ? error
    : new CliCommandError({
        message: getErrorMessage(error, fallback),
      })
