import { HttpApiBuilder, HttpApiError, HttpApp, HttpServerResponse } from "@effect/platform"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"

const decodeHttpApiDecodeError = Schema.decodeUnknownEither(HttpApiError.HttpApiDecodeError)

const toFieldPath = (path: ReadonlyArray<PropertyKey>): string => {
  const segments: string[] = []

  for (const segment of path) {
    if (typeof segment === "string") {
      segments.push(segment)
    } else if (typeof segment === "number") {
      segments.push(`${segment}`)
    }
  }

  return segments.join(".")
}

const extractJsonBody = (response: HttpServerResponse.HttpServerResponse): unknown | null => {
  if (response.body._tag === "Raw") {
    return response.body.body
  }

  if (response.body._tag !== "Uint8Array") {
    return null
  }

  try {
    return JSON.parse(new TextDecoder().decode(response.body.body))
  } catch {
    return null
  }
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
  if (message === "is missing") {
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

const makeValidationErrorResponse = (decodeError: HttpApiError.HttpApiDecodeError) => {
  const hasCredentialIssues = decodeError.issues.some((issue) =>
    toFieldPath(issue.path).startsWith("credentials.")
  )

  return {
    error: {
      code: "VALIDATION_ERROR",
      message: "Some request fields are invalid. Please check your input and try again.",
      details: decodeError.issues.flatMap((issue) => {
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

const toUserFriendlyDecodeResponse = (
  response: HttpServerResponse.HttpServerResponse
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const body = extractJsonBody(response)
  const decodeResult = decodeHttpApiDecodeError(body)

  if (Either.isLeft(decodeResult)) {
    return Effect.succeed(response)
  }

  return HttpServerResponse.json(makeValidationErrorResponse(decodeResult.right), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    cookies: response.cookies,
  }).pipe(Effect.orDie)
}

export const ServeWithUserFriendlyErrorsLive = HttpApiBuilder.serve((httpApp) =>
  HttpApp.withPreResponseHandler(httpApp, (_request, response) =>
    toUserFriendlyDecodeResponse(response)
  )
)
