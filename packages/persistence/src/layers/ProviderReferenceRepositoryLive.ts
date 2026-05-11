/**
 * ProviderReferenceRepositoryLive - Provider reference catalog and mapping persistence.
 *
 * @module ProviderReferenceRepositoryLive
 */

import { and, eq, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"
import {
  ProviderReferenceRepository,
  type ProviderReferenceRepositoryShape,
} from "@my/sync-engine/services"
import { nowDate, wrapSyncEngineSqlError } from "./SyncEngineRepositorySupport.ts"

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const upsertTransactionTypeCatalog: ProviderReferenceRepositoryShape["upsertTransactionTypeCatalog"] =
    ({ providerKey, entries }) =>
      Effect.gen(function* () {
        if (entries.length === 0) {
          return 0
        }

        const now = nowDate()
        yield* db
          .insert(schema.providerTransactionTypeCatalog)
          .values(
            entries.map((entry) => ({
              provider: providerKey,
              providerTransactionType: entry.providerTransactionType,
              description: entry.displayName,
              sourceUrl: null,
              retrievedAt: now,
              rawSourcePayload: entry.payload,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [
              schema.providerTransactionTypeCatalog.provider,
              schema.providerTransactionTypeCatalog.providerTransactionType,
            ],
            set: {
              description: sql.raw("excluded.description"),
              retrievedAt: sql.raw("excluded.retrieved_at"),
              rawSourcePayload: sql.raw("excluded.raw_source_payload"),
              updatedAt: now,
            },
          })
          .pipe(wrapSyncEngineSqlError("providerReferenceRepository.upsertTransactionTypeCatalog"))

        return entries.length
      })

  const ensureTransactionTypeMappings: ProviderReferenceRepositoryShape["ensureTransactionTypeMappings"] =
    ({ providerKey, mappings }) =>
      Effect.gen(function* () {
        if (mappings.length === 0) {
          return 0
        }

        const now = nowDate()
        yield* db
          .insert(schema.providerTransactionTypeMappings)
          .values(
            mappings.map((mapping) => ({
              provider: providerKey,
              providerTransactionType: mapping.providerTransactionType,
              transactionTypeKey: mapping.transactionType,
              inventoryEffect: mapping.inventoryEffect,
              taxTreatment: mapping.taxTreatment,
              resolutionStrategy: mapping.resolutionStrategy,
              pairedRecordRequired: mapping.pairedRecordRequired,
              mappingStatus: mapping.mappingStatus,
              reviewerNotes: mapping.reviewerNotes,
              sourceNotes: mapping.sourceNotes,
              createdAt: now,
              updatedAt: now,
            }))
          )
          .onConflictDoUpdate({
            target: [
              schema.providerTransactionTypeMappings.provider,
              schema.providerTransactionTypeMappings.providerTransactionType,
            ],
            set: {
              transactionTypeKey: sql.raw("excluded.transaction_type_key"),
              inventoryEffect: sql.raw("excluded.inventory_effect"),
              taxTreatment: sql.raw("excluded.tax_treatment"),
              resolutionStrategy: sql.raw("excluded.resolution_strategy"),
              pairedRecordRequired: sql.raw("excluded.paired_record_required"),
              mappingStatus: sql.raw("excluded.mapping_status"),
              reviewerNotes: sql.raw("excluded.reviewer_notes"),
              sourceNotes: sql.raw("excluded.source_notes"),
              updatedAt: now,
            },
          })
          .pipe(wrapSyncEngineSqlError("providerReferenceRepository.ensureTransactionTypeMappings"))

        return mappings.length
      })

  const findTransactionTypeMapping: ProviderReferenceRepositoryShape["findTransactionTypeMapping"] =
    ({ providerKey, providerTransactionType }) =>
      Effect.gen(function* () {
        const [row] = yield* db
          .select({
            providerTransactionType: schema.providerTransactionTypeMappings.providerTransactionType,
            transactionType: schema.providerTransactionTypeMappings.transactionTypeKey,
            inventoryEffect: schema.providerTransactionTypeMappings.inventoryEffect,
            taxTreatment: schema.providerTransactionTypeMappings.taxTreatment,
            resolutionStrategy: schema.providerTransactionTypeMappings.resolutionStrategy,
            pairedRecordRequired: schema.providerTransactionTypeMappings.pairedRecordRequired,
            mappingStatus: schema.providerTransactionTypeMappings.mappingStatus,
          })
          .from(schema.providerTransactionTypeMappings)
          .where(
            and(
              eq(schema.providerTransactionTypeMappings.provider, providerKey),
              eq(
                schema.providerTransactionTypeMappings.providerTransactionType,
                providerTransactionType
              )
            )
          )
          .limit(1)
          .pipe(wrapSyncEngineSqlError("providerReferenceRepository.findTransactionTypeMapping"))

        return Option.fromNullable(row)
      })

  const recordPendingTransactionTypeMapping: ProviderReferenceRepositoryShape["recordPendingTransactionTypeMapping"] =
    (mapping) =>
      ensureTransactionTypeMappings({
        providerKey: mapping.providerKey,
        mappings: [mapping],
      }).pipe(Effect.asVoid)

  return ProviderReferenceRepository.of({
    upsertTransactionTypeCatalog,
    ensureTransactionTypeMappings,
    findTransactionTypeMapping,
    recordPendingTransactionTypeMapping,
  } satisfies ProviderReferenceRepositoryShape)
})

export const ProviderReferenceRepositoryLive = Layer.effect(ProviderReferenceRepository, make)
