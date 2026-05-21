import { HttpApiSchema, HttpClientError } from "@effect/platform"
import { AuthValidationError } from "@my/rest-api/contracts"
import * as Option from "effect/Option"
import * as ParseResult from "effect/ParseResult"
import type * as SchemaAST from "effect/SchemaAST"

export type TaxMaxiFieldError = {
  readonly field?: string
  readonly message: string
}

export class TaxMaxiError extends Error {
  readonly status: number
  readonly _tag: string | undefined
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
    tag,
  }: {
    readonly cause?: unknown
    readonly code?: string | undefined
    readonly fieldErrors?: ReadonlyArray<TaxMaxiFieldError>
    readonly message: string
    readonly requestId?: string | undefined
    readonly status: number
    readonly tag?: string | undefined
  }) {
    super(message, { cause })
    this.name = "TaxMaxiError"
    this.status = status
    this._tag = tag
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

const getErrorTag = (error: unknown): string | undefined => {
  const record = getErrorRecord(error)
  return typeof record?._tag === "string" ? record._tag : undefined
}

const getApiErrorCode = (error: unknown): string | undefined => getStringProperty(error, "code")

const getStringProperty = (error: unknown, property: string): string | undefined => {
  const value = getErrorRecord(error)?.[property]
  return typeof value === "string" && value !== "" ? value : undefined
}

const getActionableMessage = ({
  code,
  error,
  fallbackMessage,
}: {
  readonly code?: string | undefined
  readonly error: unknown
  readonly fallbackMessage: string
}): string => {
  const causeMessage = getCauseMessage(getErrorRecord(error)?.cause)
  const lowLevelReason = causeMessage ?? fallbackMessage

  if (
    code === "transaction_simulation_failed" ||
    lowLevelReason === "transaction_simulation_failed"
  ) {
    return "Payment transaction simulation failed. Check the payer devnet USDC/SOL balance, payer token account, receiver token account, and selected network."
  }

  if (code === "x402_payment_required") {
    return "Payment is required for this request. Retry with a valid x402 payment header."
  }

  if (code === "x402_payment_settlement_failed") {
    return "The payment was signed but could not be settled. Check facilitator/network status and retry or contact support with the request id."
  }

  return fallbackMessage
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

  return HttpApiSchema.getStatusErrorAST(error.constructor.ast)
}

export const toTaxMaxiError = (error: unknown): TaxMaxiError => {
  if (error instanceof TaxMaxiError) {
    return error
  }

  if (HttpClientError.isHttpClientError(error)) {
    if (error instanceof HttpClientError.RequestError) {
      const causeMessage = getCauseMessage(error.cause)

      return new TaxMaxiError({
        cause: error,
        code: getErrorTag(error),
        message:
          causeMessage === undefined
            ? "Could not reach the TaxMaxi API."
            : `Could not reach the TaxMaxi API: ${causeMessage}`,
        status: 0,
      })
    }

    return new TaxMaxiError({
      cause: error,
      code: getErrorTag(error),
      message:
        error.reason === "StatusCode"
          ? "TaxMaxi API request failed."
          : "Received an unexpected response from the TaxMaxi API.",
      status: error.response.status,
    })
  }

  if (ParseResult.isParseError(error)) {
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

  const tag = getErrorTag(error)
  const apiCode = getApiErrorCode(error)
  const code = apiCode ?? tag

  if (code !== undefined) {
    const fallbackMessage = getStringProperty(error, "message") ?? "TaxMaxi API request failed."

    return new TaxMaxiError({
      cause: error,
      code,
      fieldErrors: getFieldErrors(error),
      message: getActionableMessage({ code, error, fallbackMessage }),
      requestId: getStringProperty(error, "requestId"),
      status: getAnnotatedErrorStatus(error) ?? 500,
      tag,
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
