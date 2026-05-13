/**
 * Principal ownership value objects.
 *
 * @module ownership/Principal
 */

import * as Schema from "effect/Schema"
import { AuthUserId } from "../authentication/AuthUserId.ts"

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

/**
 * Principal - Durable sync/tax ownership principal.
 */
export class Principal extends Schema.Class<Principal>("Principal")({
  /**
   * Unique ownership principal identifier.
   */
  id: PrincipalId,

  /**
   * Principal family.
   */
  kind: PrincipalKind,

  /**
   * Authentication user linked to user principals. Anonymous wallet principals
   * intentionally have no user id.
   */
  userId: Schema.NullOr(AuthUserId),
}) {}

/**
 * Type guard for Principal using Schema.is.
 */
export const isPrincipal = Schema.is(Principal)
