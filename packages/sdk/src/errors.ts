import {
  AssetDecisionConflictError,
  AssetDecisionValidationError,
  AssetStaleRevisionError,
  AuthValidationError,
  SourceCreditRequiredError,
} from "@my/rest-api/contracts"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"
import { resolveAt } from "effect/SchemaAST"
import { HttpClientError } from "effect/unstable/http"

export type TaxMaxiFieldError = {
  readonly field?: string
  readonly message: string
}

export class TaxMaxiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly requestId: string | undefined
  readonly fieldErrors: ReadonlyArray<TaxMaxiFieldError>

  constructor({
    cause,
    code,
    fieldErrors = [],
    message,
    requestId,
    status,
  }: {
    readonly cause?: unknown
    readonly code?: string | undefined
    readonly fieldErrors?: ReadonlyArray<TaxMaxiFieldError>
    readonly message: string
    readonly requestId?: string | undefined
    readonly status: number
  }) {
    super(message, { cause })
    this.name = "TaxMaxiError"
    this.status = status
    this.code = code
    this.requestId = requestId
    this.fieldErrors = fieldErrors
  }
}

const getErrorRecord = (error: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof error === "object" && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : undefined

type SchemaConstructor = {
  readonly ast: SchemaAST.AST
}

const hasSchemaAst = (value: unknown): value is SchemaConstructor =>
  typeof value === "object" && value !== null && "ast" in value

const getErrorCode = (error: unknown): string | undefined => {
  const record = getErrorRecord(error)
  return typeof record?._tag === "string" ? record._tag : undefined
}

const getStringProperty = (error: unknown, property: string): string | undefined => {
  const value = getErrorRecord(error)?.[property]
  return typeof value === "string" && value !== "" ? value : undefined
}

const getCauseMessage = (cause: unknown): string | undefined => {
  if (cause instanceof Error && cause.message !== "") {
    return cause.message
  }

  if (typeof cause === "string" && cause !== "") {
    return cause
  }

  return undefined
}

const getFieldErrors = (error: unknown): ReadonlyArray<TaxMaxiFieldError> => {
  if (!(error instanceof AuthValidationError)) {
    return []
  }

  const field = Option.getOrUndefined(error.field)

  if (field === undefined) {
    return []
  }

  return [{ field, message: error.message }]
}

const getAnnotatedErrorStatus = (error: unknown): number | undefined => {
  if (!(error instanceof Error) || !hasSchemaAst(error.constructor)) {
    return undefined
  }

  return resolveAt<number>("httpApiStatus")(error.constructor.ast) ?? 500
}

const getErrorStatusFromCode = (code: string | undefined): number | undefined => {
  if (code === undefined) {
    return undefined
  }

  if (code.includes("UnauthorizedError")) {
    return 401
  }

  if (code.includes("ForbiddenError")) {
    return 403
  }

  if (
    code.includes("BadRequestError") ||
    code.includes("ValidationError") ||
    code.includes("ParseError")
  ) {
    return 400
  }

  if (code.includes("NotFoundError")) {
    return 404
  }

  return undefined
}

export const isTaxMaxiUnauthorizedError = (error: unknown): error is TaxMaxiError =>
  error instanceof TaxMaxiError &&
  (error.status === 401 || getErrorStatusFromCode(error.code) === 401)

export type TaxMaxiCreditRequired = {
  readonly reasonCode: SourceCreditRequiredError["reasonCode"]
  readonly availableCredits: number
}

const decodeCreditRequired = Schema.decodeUnknownExit(SourceCreditRequiredError)

/**
 * Extract the structured credit details from a credit-required (402) sync
 * refusal, or null for any other error. Clients use these fields to render
 * their own recovery copy instead of the error message.
 */
export const getTaxMaxiCreditRequired = (error: unknown): TaxMaxiCreditRequired | null => {
  const candidate = error instanceof TaxMaxiError ? error.cause : error

  return Exit.match(decodeCreditRequired(candidate), {
    onFailure: () => null,
    onSuccess: ({ availableCredits, reasonCode }) => ({ availableCredits, reasonCode }),
  })
}

export type TaxMaxiAssetDecisionConflict =
  | "stale_revision"
  | "ambiguous_identity"
  | "identity_changed"

export type TaxMaxiAssetDecisionErrorCode =
  | TaxMaxiAssetDecisionConflict
  | "invalid_evidence"
  | "invalid_claim"

const decodeAssetDecisionError = Schema.decodeUnknownExit(
  Schema.Union([AssetStaleRevisionError, AssetDecisionConflictError, AssetDecisionValidationError])
)

/** Extract the machine-readable code from an asset exception decision failure. */
export const getTaxMaxiAssetDecisionErrorCode = (
  error: unknown
): TaxMaxiAssetDecisionErrorCode | null => {
  const candidate = error instanceof TaxMaxiError ? error.cause : error

  return Exit.match(decodeAssetDecisionError(candidate), {
    onFailure: () => null,
    onSuccess: ({ code }) => code,
  })
}

/** Extract the machine-readable conflict from an asset exception decision failure. */
export const getTaxMaxiAssetDecisionConflict = (
  error: unknown
): TaxMaxiAssetDecisionConflict | null => {
  const code = getTaxMaxiAssetDecisionErrorCode(error)
  return code === "stale_revision" || code === "ambiguous_identity" || code === "identity_changed"
    ? code
    : null
}

export const toTaxMaxiError = (error: unknown): TaxMaxiError => {
  if (error instanceof TaxMaxiError) {
    return error
  }

  if (HttpClientError.isHttpClientError(error)) {
    if (error.reason._tag === "TransportError") {
      const causeMessage = getCauseMessage(error.reason.cause)

      return new TaxMaxiError({
        cause: error,
        code: getErrorCode(error),
        message:
          causeMessage === undefined
            ? "Could not reach the TaxMaxi API."
            : `Could not reach the TaxMaxi API: ${causeMessage}`,
        status: 0,
      })
    }

    return new TaxMaxiError({
      cause: error,
      code: getErrorCode(error),
      message:
        error.reason._tag === "StatusCodeError"
          ? "TaxMaxi API request failed."
          : "Received an unexpected response from the TaxMaxi API.",
      status: error.response?.status ?? 0,
    })
  }

  if (Schema.isSchemaError(error)) {
    return new TaxMaxiError({
      cause: error,
      code: "ParseError",
      message: "TaxMaxi API request or response validation failed.",
      status: 400,
    })
  }

  if (error instanceof TypeError) {
    return new TaxMaxiError({
      cause: error,
      code: error.name,
      message:
        error.message === ""
          ? "Could not reach the TaxMaxi API."
          : `Could not reach the TaxMaxi API: ${error.message}`,
      status: 0,
    })
  }

  if (
    error instanceof Error &&
    (error.name.includes("RequestError") || error.message.startsWith("Transport error"))
  ) {
    return new TaxMaxiError({
      cause: error,
      code: error.name,
      message:
        error.message === ""
          ? "Could not reach the TaxMaxi API."
          : `Could not reach the TaxMaxi API: ${error.message}`,
      status: 0,
    })
  }

  const code = getErrorCode(error)

  if (code !== undefined) {
    return new TaxMaxiError({
      cause: error,
      code,
      fieldErrors: getFieldErrors(error),
      message: getStringProperty(error, "message") ?? "TaxMaxi API request failed.",
      requestId: getStringProperty(error, "requestId"),
      status: getAnnotatedErrorStatus(error) ?? getErrorStatusFromCode(code) ?? 500,
    })
  }

  if (error instanceof Error) {
    return new TaxMaxiError({
      cause: error,
      code: error.name,
      message: error.message === "" ? "TaxMaxi API request failed." : error.message,
      status: 500,
    })
  }

  return new TaxMaxiError({
    cause: error,
    message: "TaxMaxi API request failed.",
    status: 500,
  })
}
