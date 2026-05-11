/**
 * OAuth state schema
 *
 * Stores short-lived, one-time OAuth state records used to validate callback
 * intent, provider, redirect URI, and optional link user ownership.
 *
 * @module OAuthStatesTable
 */

import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"
import { authProviderTypeEnum } from "./IdentitiesTable.ts"
import { users } from "./UsersTable.ts"

/**
 * Supported OAuth flow intents
 */
export const oauthIntentEnum = pgEnum("oauth_intent", ["login", "link"])

/**
 * Pollable OAuth state status values.
 */
export const oauthStateStatusEnum = pgEnum("oauth_state_status", ["pending", "completed", "failed"])

/**
 * oauth_states table
 */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  intent: oauthIntentEnum("intent").notNull(),
  provider: authProviderTypeEnum("provider").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  status: oauthStateStatusEnum("status").notNull().default("pending"),
  sessionToken: text("session_token"),
  statusMessage: text("status_message"),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/**
 * Row type for oauth_states
 */
export type OAuthStateRow = typeof oauthStates.$inferSelect
