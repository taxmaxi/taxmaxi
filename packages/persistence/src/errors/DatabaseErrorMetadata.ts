/**
 * DatabaseErrorMetadata - SQLSTATE details from nested database errors.
 *
 * @module DatabaseErrorMetadata
 */

import * as Cause from "effect/Cause"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const DatabaseErrorSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const decodeDatabaseError = Schema.decodeUnknownOption(DatabaseErrorSchema)

/** Extract nested SQLSTATE metadata from wrapped database errors. */
export const databaseErrorMetadata = (
  error: unknown
): {
  readonly code?: string
  readonly constraint?: string
} | null => {
  if (Cause.isCause(error)) {
    const causeError = Cause.findErrorOption(error)
    return Option.isSome(causeError) ? databaseErrorMetadata(causeError.value) : null
  }

  const decoded = decodeDatabaseError(error)
  if (Option.isNone(decoded)) return null

  const nestedMetadata =
    databaseErrorMetadata(decoded.value.cause) ?? databaseErrorMetadata(decoded.value.error) ?? null
  if (
    decoded.value.code === undefined &&
    decoded.value.constraint === undefined &&
    nestedMetadata === null
  ) {
    return null
  }

  const code = decoded.value.code ?? nestedMetadata?.code
  const constraint = decoded.value.constraint ?? nestedMetadata?.constraint
  return {
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
  }
}
