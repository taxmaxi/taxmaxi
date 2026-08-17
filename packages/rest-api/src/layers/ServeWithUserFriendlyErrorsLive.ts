import { HttpApiError } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as SchemaIssue from "effect/SchemaIssue"

const formatSchemaIssue = SchemaIssue.makeFormatterStandardSchemaV1()

type StandardSchemaPathSegment = PropertyKey | { readonly key: PropertyKey }

const toFieldPath = (path: ReadonlyArray<StandardSchemaPathSegment> | undefined): string => {
  const segments: string[] = []

  for (const segment of path ?? []) {
    const key = typeof segment === "object" ? segment.key : segment

    if (typeof key === "string") {
      segments.push(key)
    } else if (typeof key === "number") {
      segments.push(`${key}`)
    }
  }

  return segments.join(".")
}

const isProviderNoiseIssue = ({
  field,
  message,
  hasCredentialIssues,
}: {
  field: string
  message: string
  hasCredentialIssues: boolean
}): boolean => field === "provider" && hasCredentialIssues && message.startsWith('Expected "local"')

const normalizeIssueMessage = ({ field, message }: { field: string; message: string }): string => {
  if (message === "is missing" || message === "Missing key") {
    return "This field is required"
  }

  if (field.endsWith("email") && message.includes("matching the pattern")) {
    return "Must be a valid email address"
  }

  if (message.startsWith("Expected ")) {
    const actualIndex = message.indexOf(", actual")
    if (actualIndex > 0) {
      return message.slice(0, actualIndex)
    }
  }

  return message
}

const makeValidationErrorResponse = (decodeError: HttpApiError.HttpApiSchemaError) => {
  const issues = formatSchemaIssue(decodeError.cause.issue).issues
  const hasCredentialIssues = issues.some((issue) =>
    toFieldPath(issue.path).startsWith("credentials.")
  )

  return {
    error: {
      code: "VALIDATION_ERROR",
      message: "Some request fields are invalid. Please check your input and try again.",
      details: issues.flatMap((issue) => {
        const field = toFieldPath(issue.path) || "request"
        const normalizedMessage = normalizeIssueMessage({
          field,
          message: issue.message,
        })

        if (
          isProviderNoiseIssue({
            field,
            message: normalizedMessage,
            hasCredentialIssues,
          })
        ) {
          return []
        }

        return [
          {
            field,
            message: normalizedMessage,
          },
        ]
      }),
    },
  }
}

export const ServeWithUserFriendlyErrorsLive = HttpMiddleware.make(
  <E, R>(
    httpEffect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest
    >
  ) =>
    httpEffect.pipe(
      Effect.catchCause((cause) => {
        const defect = Cause.findDefect(cause)
        if (Result.isSuccess(defect) && HttpApiError.HttpApiSchemaError.is(defect.success)) {
          return HttpServerResponse.json(makeValidationErrorResponse(defect.success), {
            status: 400,
          }).pipe(Effect.orDie)
        }
        return Effect.failCause(cause)
      })
    )
)
