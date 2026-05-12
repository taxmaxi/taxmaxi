/**
 * Principal ownership value objects.
 *
 * @module ownership/Principal
 */

import * as Schema from "effect/Schema"

/**
 * PrincipalId - Durable owner identifier for sync and tax data.
 */
export const PrincipalId = Schema.UUID.pipe(
  Schema.brand("PrincipalId"),
  Schema.annotations({
    identifier: "PrincipalId",
    title: "Principal ID",
    description: "A durable ownership principal identifier",
  })
)

/**
 * The branded PrincipalId type.
 */
export type PrincipalId = typeof PrincipalId.Type

/**
 * PrincipalKind - Supported ownership principal families.
 */
export const PrincipalKind = Schema.Literal("user", "anonymous_wallet").annotations({
  identifier: "PrincipalKind",
  title: "Principal Kind",
  description: "The family of ownership principal",
})

/**
 * The PrincipalKind type.
 */
export type PrincipalKind = typeof PrincipalKind.Type
