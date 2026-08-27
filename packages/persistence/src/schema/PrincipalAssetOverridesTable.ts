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

export const principalAssetOverrideKindEnum = pgEnum("principal_asset_override_kind", [
  "identity",
  "inclusion",
])
export const principalAssetOverrideTargetKindEnum = pgEnum("principal_asset_override_target_kind", [
  "representation",
  "provider_asset",
])
export const principalAssetOverrideActionEnum = pgEnum("principal_asset_override_action", [
  "set",
  "withdraw",
])
export const principalAssetIdentityStateEnum = pgEnum("principal_asset_identity_state", [
  "resolved",
  "unresolved",
  "excluded",
])
export const principalAssetInclusionStateEnum = pgEnum("principal_asset_inclusion_state", [
  "included",
  "excluded",
  "blocked",
])

/** Principal-scoped append-only identity and calculation-inclusion choices. */
export const principalAssetOverrides = pgTable(
  "principal_asset_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    kind: principalAssetOverrideKindEnum("kind").notNull(),
    targetKind: principalAssetOverrideTargetKindEnum("target_kind").notNull(),
    blockchainId: uuid("blockchain_id").references(() => blockchains.id),
    representationType: assetRepresentationTypeEnum("representation_type"),
    contractAddress: text("contract_address"),
    mintAddress: text("mint_address"),
    providerAssetRowId: uuid("provider_asset_row_id").references(() => providerAssets.id),
    action: principalAssetOverrideActionEnum("action").notNull(),
    inspectedSystemRevision: text("inspected_system_revision").notNull(),
    inspectedIdentityState: principalAssetIdentityStateEnum("inspected_identity_state"),
    inspectedInclusionState: principalAssetInclusionStateEnum("inspected_inclusion_state"),
    inspectedInclusionReason: text("inspected_inclusion_reason"),
    inspectedAssetId: uuid("inspected_asset_id").references(() => assets.id),
    replacementAssetId: uuid("replacement_asset_id").references(() => assets.id),
    replacementInclusionState: principalAssetInclusionStateEnum("replacement_inclusion_state"),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    supersedesOverrideId: uuid("supersedes_override_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("principal_asset_overrides_supersedes_unique")
      .on(table.supersedesOverrideId)
      .where(sql`${table.supersedesOverrideId} is not null`),
    index("idx_principal_asset_overrides_provider_target").on(
      table.principalId,
      table.kind,
      table.providerAssetRowId,
      table.createdAt
    ),
    index("idx_principal_asset_overrides_representation_target").on(
      table.principalId,
      table.kind,
      table.blockchainId,
      table.representationType,
      table.contractAddress,
      table.mintAddress,
      table.createdAt
    ),
    check(
      "principal_asset_overrides_target_complete",
      sql`(
        ${table.targetKind} = 'provider_asset'
        and ${table.providerAssetRowId} is not null
        and ${table.blockchainId} is null
        and ${table.representationType} is null
        and ${table.contractAddress} is null
        and ${table.mintAddress} is null
      ) or (
        ${table.targetKind} = 'representation'
        and ${table.providerAssetRowId} is null
        and ${table.blockchainId} is not null
        and ${table.representationType} is not null
        and (
          (${table.representationType} = 'native' and ${table.contractAddress} is null and ${table.mintAddress} is null)
          or (${table.representationType} in ('token', 'nft') and num_nonnulls(${table.contractAddress}, ${table.mintAddress}) = 1)
        )
      )`
    ),
    check(
      "principal_asset_overrides_inspected_conclusion_matches_kind",
      sql`(
        ${table.kind} = 'identity'
        and ${table.inspectedIdentityState} is not null
        and ${table.inspectedInclusionState} is null
        and ${table.inspectedInclusionReason} is null
      ) or (
        ${table.kind} = 'inclusion'
        and ${table.inspectedIdentityState} is null
        and ${table.inspectedInclusionState} is not null
        and ${table.inspectedAssetId} is null
      )`
    ),
    check(
      "principal_asset_overrides_replacement_matches_action_and_kind",
      sql`(
        ${table.action} = 'withdraw'
        and ${table.replacementAssetId} is null
        and ${table.replacementInclusionState} is null
      ) or (
        ${table.action} = 'set'
        and ${table.kind} = 'identity'
        and ${table.replacementAssetId} is not null
        and ${table.replacementInclusionState} is null
      ) or (
        ${table.action} = 'set'
        and ${table.kind} = 'inclusion'
        and ${table.replacementAssetId} is null
        and ${table.replacementInclusionState} in ('included', 'excluded')
      )`
    ),
    check("principal_asset_overrides_reason_present", sql`length(trim(${table.reason})) > 0`),
    check(
      "principal_asset_overrides_not_self_superseding",
      sql`${table.supersedesOverrideId} is null or ${table.supersedesOverrideId} <> ${table.id}`
    ),
    foreignKey({
      columns: [table.supersedesOverrideId],
      foreignColumns: [table.id],
      name: "principal_asset_overrides_supersedes_fk",
    }),
  ]
)

export type PrincipalAssetOverrideRow = typeof principalAssetOverrides.$inferSelect
export type PrincipalAssetOverrideInsert = typeof principalAssetOverrides.$inferInsert
