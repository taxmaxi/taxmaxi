/**
 * Principal-scoped asset override targets and append-only history.
 *
 * @module PrincipalAssetOverridesTables
 */

import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { assetRepresentationTypeEnum } from "./AssetRepresentationsTable.ts"
import { assets } from "./AssetsTable.ts"
import { blockchains } from "./BlockchainsTable.ts"
import { principals } from "./PrincipalsTable.ts"
import { providerAssets } from "./ProviderAssetsTable.ts"
import { users } from "./UsersTable.ts"

const unicodeWhitespaceCharacters = sql`U&'!0009!000A!000B!000C!000D!0020!0085!00A0!1680!2000!2001!2002!2003!2004!2005!2006!2007!2008!2009!200A!2028!2029!202F!205F!3000!FEFF' UESCAPE '!'`

export const principalAssetOverrideTargetKindEnum = pgEnum("principal_asset_override_target_kind", [
  "representation",
  "provider_asset",
])

export const principalAssetOverrideKindEnum = pgEnum("principal_asset_override_kind", [
  "identity",
  "inclusion",
])

export const principalAssetOverrideOperationEnum = pgEnum("principal_asset_override_operation", [
  "create",
  "replace",
  "withdraw",
])

export const principalAssetIdentityConclusionEnum = pgEnum("principal_asset_identity_conclusion", [
  "resolved",
  "unresolved",
])

export const principalAssetInclusionConclusionEnum = pgEnum(
  "principal_asset_inclusion_conclusion",
  ["included", "excluded"]
)

/** A principal-local exact representation or chainless provider-asset target. */
export const principalAssetOverrideTargets = pgTable(
  "principal_asset_override_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    targetKind: principalAssetOverrideTargetKindEnum("target_kind").notNull(),
    blockchainId: uuid("blockchain_id").references(() => blockchains.id),
    representationType: assetRepresentationTypeEnum("representation_type"),
    contractAddress: text("contract_address"),
    mintAddress: text("mint_address"),
    providerAssetRowId: uuid("provider_asset_row_id").references(() => providerAssets.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "principal_asset_override_targets_shape",
      sql`(
        ${table.targetKind} = 'representation'
        and ${table.providerAssetRowId} is null
        and ${table.blockchainId} is not null
        and ${table.representationType} is not null
        and (
          (
            ${table.representationType} = 'native'
            and ${table.contractAddress} is null
            and ${table.mintAddress} is null
          ) or (
            ${table.representationType} in ('token', 'nft')
            and num_nonnulls(${table.contractAddress}, ${table.mintAddress}) = 1
            and coalesce(
              length(btrim(${table.contractAddress}, ${unicodeWhitespaceCharacters})) > 0,
              length(btrim(${table.mintAddress}, ${unicodeWhitespaceCharacters})) > 0,
              false
            )
          )
        )
      ) or (
        ${table.targetKind} = 'provider_asset'
        and ${table.providerAssetRowId} is not null
        and num_nonnulls(
          ${table.blockchainId},
          ${table.representationType},
          ${table.contractAddress},
          ${table.mintAddress}
        ) = 0
      )`
    ),
    uniqueIndex("principal_asset_override_targets_principal_id_unique").on(
      table.principalId,
      table.id
    ),
    uniqueIndex("principal_asset_override_targets_native_unique")
      .on(table.principalId, table.blockchainId)
      .where(
        sql`${table.targetKind} = 'representation' and ${table.representationType} = 'native'`
      ),
    uniqueIndex("principal_asset_override_targets_contract_unique")
      .on(table.principalId, table.blockchainId, table.representationType, table.contractAddress)
      .where(sql`${table.targetKind} = 'representation' and ${table.contractAddress} is not null`),
    uniqueIndex("principal_asset_override_targets_mint_unique")
      .on(table.principalId, table.blockchainId, table.representationType, table.mintAddress)
      .where(sql`${table.targetKind} = 'representation' and ${table.mintAddress} is not null`),
    uniqueIndex("principal_asset_override_targets_provider_asset_unique")
      .on(table.principalId, table.providerAssetRowId)
      .where(sql`${table.targetKind} = 'provider_asset'`),
    index("idx_principal_asset_override_targets_principal").on(table.principalId),
  ]
)

/**
 * Append-only identity and inclusion override history for one principal target.
 *
 * The migration protects this table and its target table from direct updates
 * and deletes while their principal exists.
 */
export const principalAssetOverrides = pgTable(
  "principal_asset_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id),
    targetId: uuid("target_id").notNull(),
    kind: principalAssetOverrideKindEnum("kind").notNull(),
    operation: principalAssetOverrideOperationEnum("operation").notNull(),
    inspectedSystemRevision: text("inspected_system_revision").notNull(),
    inspectedSystemIdentity: principalAssetIdentityConclusionEnum("inspected_system_identity"),
    inspectedSystemAssetId: uuid("inspected_system_asset_id").references(() => assets.id),
    inspectedSystemInclusion: principalAssetInclusionConclusionEnum("inspected_system_inclusion"),
    replacementAssetId: uuid("replacement_asset_id").references(() => assets.id),
    replacementInclusion: principalAssetInclusionConclusionEnum("replacement_inclusion"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    supersedesOverrideId: uuid("supersedes_override_id"),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "principal_asset_overrides_system_conclusion_shape",
      sql`(
        ${table.kind} = 'identity'
        and ${table.inspectedSystemIdentity} is not null
        and ${table.inspectedSystemInclusion} is null
        and (
          (
            ${table.inspectedSystemIdentity} = 'resolved'
            and ${table.inspectedSystemAssetId} is not null
          ) or (
            ${table.inspectedSystemIdentity} = 'unresolved'
            and ${table.inspectedSystemAssetId} is null
          )
        )
      ) or (
        ${table.kind} = 'inclusion'
        and ${table.inspectedSystemIdentity} is null
        and ${table.inspectedSystemAssetId} is null
        and ${table.inspectedSystemInclusion} is not null
      )`
    ),
    check(
      "principal_asset_overrides_replacement_shape",
      sql`(
        ${table.operation} in ('create', 'replace')
        and (
          (
            ${table.kind} = 'identity'
            and ${table.replacementAssetId} is not null
            and ${table.replacementInclusion} is null
          ) or (
            ${table.kind} = 'inclusion'
            and ${table.replacementAssetId} is null
            and ${table.replacementInclusion} is not null
          )
        )
      ) or (
        ${table.operation} = 'withdraw'
        and ${table.replacementAssetId} is null
        and ${table.replacementInclusion} is null
      )`
    ),
    check(
      "principal_asset_overrides_supersession_shape",
      sql`(
        ${table.operation} = 'create'
      ) or (
        ${table.operation} in ('replace', 'withdraw')
        and ${table.supersedesOverrideId} is not null
      )`
    ),
    check(
      "principal_asset_overrides_no_self_supersession",
      sql`${table.supersedesOverrideId} is null or ${table.id} <> ${table.supersedesOverrideId}`
    ),
    check(
      "principal_asset_overrides_revision_required",
      sql`length(btrim(${table.inspectedSystemRevision}, ${unicodeWhitespaceCharacters})) > 0`
    ),
    check(
      "principal_asset_overrides_reason_required",
      sql`length(btrim(${table.reason}, ${unicodeWhitespaceCharacters})) > 0`
    ),
    uniqueIndex("principal_asset_overrides_stream_record_unique").on(
      table.principalId,
      table.targetId,
      table.kind,
      table.id
    ),
    uniqueIndex("principal_asset_overrides_supersedes_unique")
      .on(table.supersedesOverrideId)
      .where(sql`${table.supersedesOverrideId} is not null`),
    uniqueIndex("principal_asset_overrides_root_unique")
      .on(table.principalId, table.targetId, table.kind)
      .where(sql`${table.supersedesOverrideId} is null`),
    foreignKey({
      columns: [table.principalId, table.targetId],
      foreignColumns: [principalAssetOverrideTargets.principalId, principalAssetOverrideTargets.id],
      name: "principal_asset_overrides_target_principal_fk",
    }),
    foreignKey({
      columns: [table.principalId, table.targetId, table.kind, table.supersedesOverrideId],
      foreignColumns: [table.principalId, table.targetId, table.kind, table.id],
      name: "principal_asset_overrides_supersedes_fk",
    }),
    index("idx_principal_asset_overrides_principal_target_kind").on(
      table.principalId,
      table.targetId,
      table.kind,
      table.recordedAt
    ),
  ]
)

export type PrincipalAssetOverrideTarget = typeof principalAssetOverrideTargets.$inferSelect
export type PrincipalAssetOverrideTargetInsert = typeof principalAssetOverrideTargets.$inferInsert
export type PrincipalAssetOverride = typeof principalAssetOverrides.$inferSelect
export type PrincipalAssetOverrideInsert = typeof principalAssetOverrides.$inferInsert
