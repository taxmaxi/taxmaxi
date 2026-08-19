/**
 * PositiveIntConfig - Shared Effect Config helper for positive integer settings.
 *
 * @module PositiveIntConfig
 */

import * as Config from "effect/Config"
import * as Schema from "effect/Schema"

/**
 * Read a positive integer from the environment, falling back to a default.
 * Zero and negative values fail config loading with a named error message.
 */
export const positiveIntConfig = ({
  name,
  defaultValue,
}: {
  readonly name: string
  readonly defaultValue: number
}) =>
  Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0, { message: `${name} must be greater than zero` })),
    name
  ).pipe(Config.withDefault(defaultValue))
