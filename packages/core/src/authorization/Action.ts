/**
 * Action - Authorization action types
 *
 * Defines all the actions that can be performed in the system,
 * used for permission checking and ABAC policy evaluation.
 *
 * @module authorization/Action
 */

import * as Schema from "effect/Schema"

/**
 * Action - An authorization action that can be performed
 *
 * Actions follow the pattern "{resource}:{verb}" where:
 * - resource: The type of entity being acted upon
 * - verb: The operation being performed (create, read, update, delete, etc.)
 *
 * The wildcard "*" matches any action.
 */
export const Action = Schema.Literal(
  // Workspace actions
  "workspace:manage_settings",
  "workspace:manage_members",
  "workspace:delete",
  "workspace:transfer_ownership",

  // Account actions
  "account:create",
  "account:read",
  "account:update",
  "account:deactivate",

  // Report actions
  "report:read",
  "report:export",

  // Audit log actions
  "audit_log:read",

  // Wildcard (matches any action)
  "*"
).annotations({
  identifier: "Action",
  title: "Authorization Action",
  description: "An authorization action that can be performed in the system",
})

/**
 * The Action type
 */
export type Action = typeof Action.Type

/**
 * Type guard for Action using Schema.is
 */
export const isAction = Schema.is(Action)

/**
 * All valid Action values (excluding wildcard)
 */
export const ActionValues: readonly Action[] = [
  // Workspace actions
  "workspace:manage_settings",
  "workspace:manage_members",
  "workspace:delete",
  "workspace:transfer_ownership",

  // Account actions
  "account:create",
  "account:read",
  "account:update",
  "account:deactivate",

  // Report actions
  "report:read",
  "report:export",

  // Audit log actions
  "audit_log:read",

  // Wildcard
  "*",
] as const

/**
 * Resource types derived from action prefixes
 */
export const ResourceType = Schema.Literal(
  "workspace",
  "account",
  "report",
  "audit_log",
  "*"
).annotations({
  identifier: "ResourceType",
  title: "Resource Type",
  description: "The type of resource being accessed",
})

/**
 * The ResourceType type
 */
export type ResourceType = typeof ResourceType.Type

/**
 * Type guard for ResourceType using Schema.is
 */
export const isResourceType = Schema.is(ResourceType)
