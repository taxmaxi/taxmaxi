/**
 * Shared helpers for persistence-backed sync-engine repository layers.
 *
 * @module SyncEngineRepositorySupport
 */

import { ASSET_RESOLUTION_POLICY_ACTOR, ASSET_RESOLUTION_POLICY_REVISION } from "@my/core/assets"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import { eq, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, isPersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import {
  SourceSyncJobModeSchema,
  SourceSyncPhaseSchema,
  SyncEngineStorageError,
  type AssetResolutionPolicyEvaluationRecord,
  type SourceSyncJobProgressSnapshot,
} from "@my/sync-engine/services"
import { drizzle } from "./PgClientLive.ts"
import { schema } from "../schema/index.ts"

const ProgressCounterSchema = Schema.Union([Schema.Number, Schema.NumberFromString])

const SourceSyncProgressDetailsSchema = Schema.Struct({
  mode: Schema.optional(SourceSyncJobModeSchema),
  phase: Schema.optional(SourceSyncPhaseSchema),
  processedRecords: Schema.optional(ProgressCounterSchema),
  totalRecords: Schema.optional(Schema.NullOr(ProgressCounterSchema)),
  fetchedRecords: Schema.optional(ProgressCounterSchema),
  normalizedRecords: Schema.optional(ProgressCounterSchema),
  failedRecords: Schema.optional(ProgressCounterSchema),
  cursorPayload: Schema.optional(Schema.Unknown),
  highWatermark: Schema.optional(Schema.NullOr(Schema.String)),
})

type SourceSyncProgressDetails = Schema.Schema.Type<typeof SourceSyncProgressDetailsSchema>

/**
 * Create a new timestamp using the repo's shared clock helper.
 */
export const nowDate = (): Date => Timestamp.now().toDate()

/**
 * Serialize a nullable high watermark for job progress payloads.
 */
export const highWatermarkToIso = (highWatermark: Date | null): string | null =>
  highWatermark === null ? null : Timestamp.fromDate(highWatermark).toISOString()

/**
 * Normalize lower-level repository failures into the sync-engine storage error surface.
 *
 * Existing `SyncEngineStorageError` values pass through unchanged so callers do not
 * lose the original operation or end up with nested storage-error wrappers.
 */
export const toSyncEngineStorageError = ({
  error,
  operation,
}: {
  readonly error: PersistenceError | unknown
  readonly operation?: string
}): SyncEngineStorageError =>
  error instanceof SyncEngineStorageError
    ? error
    : isPersistenceError(error)
      ? new SyncEngineStorageError({
          operation: error.operation,
          cause: error.cause,
        })
      : new SyncEngineStorageError({
          operation: operation ?? "syncEngineRepository",
          cause: error,
        })

/**
 * Wrap SQL errors in SyncEngineStorageError.
 */
export const wrapSyncEngineSqlError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SyncEngineStorageError, R> =>
    wrapSyncEngineStorageError(operation)(wrapSqlError(operation)(effect))

/**
 * Wrap arbitrary repository errors in SyncEngineStorageError.
 */
export const wrapSyncEngineStorageError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SyncEngineStorageError, R> =>
    Effect.mapError(effect, (error) => toSyncEngineStorageError({ error, operation }))

type SyncEngineDb = Effect.Success<typeof drizzle>

/** One drizzle transaction handle as passed to `db.transaction` callbacks. */
export type SyncEngineDbTransaction = Parameters<Parameters<SyncEngineDb["transaction"]>[0]>[0]

/** Mapping status considered when scheduling an asset-resolution job. */
export type ResolutionJobMappingStatus =
  | "approved"
  | "pending_review"
  | "rejected"
  | "excluded"
  | null

/**
 * An observed asset with no mapping row or a pending_review mapping is
 * unresolved; approved and rejected are not.
 */
export const OBSERVED_UNRESOLVED_STATUSES: ReadonlyArray<ResolutionJobMappingStatus> = [
  null,
  "pending_review",
]

/**
 * The catalog path deliberately skips assets with no mapping row: a mapping
 * row appears once an asset is actually observed, so a bare catalog entry
 * has never been seen in a transaction and must not trigger research. Settled
 * mappings are reevaluated at later evidence revisions without replacing the
 * current conclusion, so actionable evidence can reopen review.
 */
export const CATALOG_REVIEWABLE_STATUSES: ReadonlyArray<ResolutionJobMappingStatus> = [
  "pending_review",
  "approved",
  "excluded",
]

/**
 * Insert one pending resolution job per eligible provider asset at its current
 * evidence revision and the current policy revision, inside the caller's
 * transaction. Existing jobs for the same (observation, evidence revision,
 * policy revision) triple are left untouched. Shared by
 * AssetResolutionJobRepositoryLive (the standalone scheduling API) and
 * ProviderAssetRepositoryLive (scheduling inside observation transactions)
 * so both paths follow the same unresolved-status and conflict rules.
 */
export const insertResolutionJobsForMappings = ({
  tx,
  providerAssetRowIds,
  now,
  mappingStatuses,
}: {
  readonly tx: SyncEngineDbTransaction
  readonly providerAssetRowIds: ReadonlyArray<string>
  readonly now: Date
  readonly mappingStatuses: ReadonlyArray<ResolutionJobMappingStatus>
}) =>
  Effect.gen(function* () {
    if (providerAssetRowIds.length === 0) {
      return [] as ReadonlyArray<{
        readonly providerAssetRowId: string
        readonly evidenceRevision: number
      }>
    }

    const candidates = yield* tx
      .select({
        providerAssetRowId: schema.providerAssets.id,
        evidenceRevision: schema.providerAssets.evidenceRevision,
        providerType: schema.providerAssets.providerType,
        mappingKind: schema.providerAssetMappings.mappingKind,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        currentPolicyEvidenceRevision: schema.assetResolutionDecisions.evidenceRevision,
        currentPolicyRevision: schema.assetResolutionDecisions.policyRevision,
        currentPolicyActor: schema.assetResolutionDecisions.actor,
      })
      .from(schema.providerAssets)
      .leftJoin(
        schema.providerAssetMappings,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .leftJoin(
        schema.assetResolutionCurrentState,
        eq(schema.assetResolutionCurrentState.providerAssetRowId, schema.providerAssets.id)
      )
      .leftJoin(
        schema.assetResolutionDecisions,
        eq(
          schema.assetResolutionDecisions.id,
          schema.assetResolutionCurrentState.currentPolicyEvaluationId
        )
      )
      .where(inArray(schema.providerAssets.id, providerAssetRowIds))
      .pipe(wrapSyncEngineSqlError("assetResolutionJobScheduling.load"))

    const eligible = candidates.filter((candidate) => {
      if (!mappingStatuses.some((status) => status === candidate.mappingStatus)) {
        return false
      }
      const settled =
        candidate.mappingStatus === "approved" || candidate.mappingStatus === "excluded"
      if (!settled) {
        return true
      }
      // A policy-revision change only makes automatic evaluations stale.
      // Trusted seeds, canonicalization, and human decisions carry their own
      // policy revisions and are not redone when the resolution policy ships
      // a new revision.
      const evaluationCurrent =
        candidate.currentPolicyEvidenceRevision === candidate.evidenceRevision &&
        (candidate.currentPolicyActor !== ASSET_RESOLUTION_POLICY_ACTOR ||
          candidate.currentPolicyRevision === ASSET_RESOLUTION_POLICY_REVISION)
      if (evaluationCurrent) {
        return false
      }
      // A settled fiat mapping stays settled while the provider still reports
      // the currency as fiat; the resolution policy only answers questions
      // about crypto assets. When the provider reclassifies the currency, the
      // old fiat approval must not keep deciding accounting, so the
      // observation is reevaluated. A null provider type is no report at all.
      const reportedFiat = candidate.providerType?.trim().toLowerCase() === "fiat"
      return candidate.mappingKind === "asset" || (candidate.providerType !== null && !reportedFiat)
    })
    if (eligible.length === 0) {
      return []
    }

    const inserted = yield* tx
      .insert(schema.assetResolutionJobs)
      .values(
        eligible.map((candidate) => ({
          providerAssetRowId: candidate.providerAssetRowId,
          evidenceRevision: candidate.evidenceRevision,
          policyRevision: ASSET_RESOLUTION_POLICY_REVISION,
          status: "pending" as const,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .onConflictDoNothing({
        target: [
          schema.assetResolutionJobs.providerAssetRowId,
          schema.assetResolutionJobs.evidenceRevision,
          schema.assetResolutionJobs.policyRevision,
        ],
      })
      .returning({
        providerAssetRowId: schema.assetResolutionJobs.providerAssetRowId,
        evidenceRevision: schema.assetResolutionJobs.evidenceRevision,
      })
      .pipe(wrapSyncEngineSqlError("assetResolutionJobScheduling.insert"))

    return inserted
  })

/**
 * Insert one immutable automatic policy evaluation and its evidence snapshots
 * inside the caller's transaction. Shared by ProviderAssetRepositoryLive and
 * AssetRepositoryLive so every automatic writer follows the same history and
 * current-role rules.
 *
 * The idempotency key is provider asset, evidence revision, and policy
 * revision. With skipOnEvaluationConflict, an existing evaluation for that key
 * leaves history untouched and returns null. A late evaluation is retained in
 * history but cannot move either current pointer backward.
 */
export const insertAssetResolutionDecision = ({
  tx,
  decision,
  supersedesDecisionId = null,
  skipOnEvaluationConflict = false,
  operation,
}: {
  readonly tx: SyncEngineDbTransaction
  readonly decision: AssetResolutionPolicyEvaluationRecord
  readonly supersedesDecisionId?: string | null
  readonly skipOnEvaluationConflict?: boolean
  readonly operation: string
}): Effect.Effect<{ readonly id: string } | null, SyncEngineStorageError> =>
  Effect.gen(function* () {
    // Serialize decision writers and mapping approvals before inserting rows
    // that take a provider-asset FK lock. NO KEY UPDATE is compatible with
    // source-use FK writes while still preventing stale policy pointer moves.
    const [providerAsset] = yield* tx
      .select({ evidenceRevision: schema.providerAssets.evidenceRevision })
      .from(schema.providerAssets)
      .where(eq(schema.providerAssets.id, decision.providerAssetRowId))
      .for("no key update")
      .limit(1)
      .pipe(wrapSyncEngineSqlError(operation))

    const insert = tx.insert(schema.assetResolutionDecisions).values({
      providerAssetRowId: decision.providerAssetRowId,
      evidenceRevision: decision.evidenceRevision,
      policyRevision: decision.policyRevision,
      outcome: decision.outcome,
      supersedesDecisionId,
      assetId: decision.assetId,
      assetRepresentationId: decision.assetRepresentationId,
      blockchain: decision.blockchain,
      representationType: decision.representationType,
      contractAddress: decision.contractAddress,
      mintAddress: decision.mintAddress,
      decimals: decision.decimals,
      reason: decision.reason,
      actor: decision.actor,
    })
    const conflictAwareInsert = skipOnEvaluationConflict
      ? insert.onConflictDoNothing({
          target: [
            schema.assetResolutionDecisions.providerAssetRowId,
            schema.assetResolutionDecisions.evidenceRevision,
            schema.assetResolutionDecisions.policyRevision,
          ],
          where: sql`${schema.assetResolutionDecisions.humanClaim} is null and ${schema.assetResolutionDecisions.supersedesDecisionId} is null`,
        })
      : insert

    const [inserted] = yield* conflictAwareInsert
      .returning({ id: schema.assetResolutionDecisions.id })
      .pipe(wrapSyncEngineSqlError(operation))

    if (inserted === undefined) {
      if (skipOnEvaluationConflict) {
        return null
      }

      return yield* new SyncEngineStorageError({
        operation,
        cause: {
          providerAssetRowId: decision.providerAssetRowId,
          evidenceRevision: decision.evidenceRevision,
          message: "Resolution decision was not inserted.",
        },
      })
    }

    if (decision.evidence.length > 0) {
      yield* tx
        .insert(schema.assetResolutionEvidence)
        .values(
          decision.evidence.map((entry) => ({
            decisionId: inserted.id,
            authority: entry.authority,
            claimKind: entry.claimKind,
            sourceLocator: entry.sourceLocator,
            retrievedAt: entry.retrievedAt,
            evidenceRevision: entry.evidenceRevision,
            decodedClaim: entry.decodedClaim,
            rawPayload: entry.rawPayload,
          }))
        )
        .pipe(wrapSyncEngineSqlError(operation))
    }

    if (providerAsset?.evidenceRevision !== decision.evidenceRevision) {
      return inserted
    }

    const establishesConclusion =
      decision.outcome === "excluded" ||
      (!["pending", "fail_closed"].includes(decision.outcome) &&
        decision.assetId !== null &&
        (decision.blockchain === null || decision.assetRepresentationId !== null))
    yield* tx
      .insert(schema.assetResolutionCurrentState)
      .values({
        providerAssetRowId: decision.providerAssetRowId,
        currentConclusionId: establishesConclusion ? inserted.id : null,
        currentPolicyEvaluationId: inserted.id,
      })
      .onConflictDoUpdate({
        target: schema.assetResolutionCurrentState.providerAssetRowId,
        set: {
          ...(establishesConclusion
            ? {
                currentConclusionId: sql`coalesce(
                  ${schema.assetResolutionCurrentState.currentConclusionId},
                  ${inserted.id}::uuid
                )`,
              }
            : {}),
          currentPolicyEvaluationId: inserted.id,
          updatedAt: nowDate(),
        },
      })
      .pipe(wrapSyncEngineSqlError(operation))

    return inserted
  })

/**
 * Insert an automatic policy evaluation only while its evidence revision is
 * still current. The provider-row lock keeps the revision check and decision
 * insert in one transaction, so evidence cannot advance between them.
 */
export const insertCurrentAssetResolutionDecision = ({
  tx,
  decision,
  operation,
}: {
  readonly tx: SyncEngineDbTransaction
  readonly decision: AssetResolutionPolicyEvaluationRecord
  readonly operation: string
}): Effect.Effect<
  | { readonly _tag: "inserted"; readonly id: string }
  | { readonly _tag: "duplicate" }
  | { readonly _tag: "stale" },
  SyncEngineStorageError
> =>
  Effect.gen(function* () {
    const [providerAsset] = yield* tx
      .select({ evidenceRevision: schema.providerAssets.evidenceRevision })
      .from(schema.providerAssets)
      .where(eq(schema.providerAssets.id, decision.providerAssetRowId))
      .for("no key update")
      .limit(1)
      .pipe(wrapSyncEngineSqlError(operation))

    if (providerAsset?.evidenceRevision !== decision.evidenceRevision) {
      return { _tag: "stale" as const }
    }

    const inserted = yield* insertAssetResolutionDecision({
      tx,
      decision,
      skipOnEvaluationConflict: true,
      operation,
    })

    return inserted === null
      ? { _tag: "duplicate" as const }
      : { _tag: "inserted" as const, id: inserted.id }
  })

/**
 * Decode persisted job progress JSON into the sync-engine snapshot shape.
 */
export const decodeSourceSyncJobProgressSnapshot = (
  progressDetails: unknown
): Effect.Effect<SourceSyncJobProgressSnapshot | null> =>
  Schema.decodeUnknownEffect(SourceSyncProgressDetailsSchema)(progressDetails).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((details: SourceSyncProgressDetails | null) =>
      details === null
        ? null
        : {
            mode: details.mode ?? null,
            phase: details.phase ?? null,
            processedRecords: details.processedRecords ?? null,
            totalRecords: details.totalRecords ?? null,
            fetchedRecords: details.fetchedRecords ?? null,
            normalizedRecords: details.normalizedRecords ?? null,
            failedRecords: details.failedRecords ?? null,
            cursorPayload: details.cursorPayload ?? null,
            highWatermark: details.highWatermark ?? null,
          }
    )
  )
