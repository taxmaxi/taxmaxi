/**
 * ProcessingJobConflict - Helpers for classifying processing job insert races.
 *
 * @module ProcessingJobConflict
 */

import * as Either from "effect/Either"
import * as Schema from "effect/Schema"

const ACTIVE_PROCESSING_JOB_CONSTRAINT = "processing_jobs_active_source_unique"

const DatabaseErrorSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const decodeDatabaseError = Schema.decodeUnknownEither(DatabaseErrorSchema)

/**
 * Extract nested SQLSTATE metadata from wrapped database errors.
 */
const errorMetadata = (
  error: unknown
): {
  readonly code?: string
  readonly constraint?: string
} | null => {
  const decoded = decodeDatabaseError(error)

  if (Either.isLeft(decoded)) {
    return null
  }

  const nestedMetadata =
    errorMetadata(decoded.right.cause) ?? errorMetadata(decoded.right.error) ?? null

  if (
    decoded.right.code !== undefined ||
    decoded.right.constraint !== undefined ||
    nestedMetadata !== null
  ) {
    const code = decoded.right.code ?? nestedMetadata?.code
    const constraint = decoded.right.constraint ?? nestedMetadata?.constraint

    return {
      ...(code === undefined ? {} : { code }),
      ...(constraint === undefined ? {} : { constraint }),
    }
  }

  return null
}

/**
 * Detect the uniqueness violation raised when another active processing job
 * was inserted concurrently.
 */
export const isActiveProcessingJobConflict = (error: unknown): boolean =>
  errorMetadata(error)?.code === "23505" &&
  errorMetadata(error)?.constraint === ACTIVE_PROCESSING_JOB_CONSTRAINT
