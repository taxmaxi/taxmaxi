/**
 * AssetOverrideRepositoryLive - PostgreSQL principal asset override persistence.
 *
 * @module AssetOverrideRepositoryLive
 */

import { and, asc, desc, eq, exists, inArray, isNull, notExists, or, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  AssetOverrideRepository,
  AssetOverrideTargetNotFoundError,
  AssetOverrideValidationError,
  type AssetOverrideHistoryEntry,
  type AssetOverrideKind,
  type AssetOverrideProjection,
  type AssetOverrideReplacement,
  type AssetOverrideRepositoryShape,
  type AssetOverrideSystemConclusion,
  type AssetOverrideTarget,
  type AssetOverrideWriteResult,
} from "../services/AssetOverrideRepository.ts"
import { PersistenceError } from "../errors/RepositoryError.ts"
import { schema, type PrincipalAssetOverrideRow } from "../schema/index.ts"
import { drizzle } from "./PgClientLive.ts"

const currentDate = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (milliseconds) => new Date(milliseconds)
)

const wrapAssetOverrideError =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, (error) =>
      error instanceof AssetOverrideTargetNotFoundError ||
      error instanceof AssetOverrideValidationError ||
      error instanceof PersistenceError
        ? error
        : new PersistenceError({ operation, cause: error })
    )

const canonicalizeTarget = (target: AssetOverrideTarget): AssetOverrideTarget =>
  target._tag === "representation"
    ? {
        ...target,
        contractAddress: target.contractAddress?.toLowerCase() ?? null,
      }
    : target

const targetPredicate = (target: AssetOverrideTarget) =>
  target._tag === "provider_asset"
    ? and(
        eq(schema.principalAssetOverrides.targetKind, "provider_asset"),
        eq(schema.principalAssetOverrides.providerAssetRowId, target.providerAssetRowId)
      )
    : and(
        eq(schema.principalAssetOverrides.targetKind, "representation"),
        eq(schema.principalAssetOverrides.blockchainId, target.blockchainId),
        eq(schema.principalAssetOverrides.representationType, target.representationType),
        target.contractAddress === null
          ? sql`${schema.principalAssetOverrides.contractAddress} is null`
          : sql`lower(${schema.principalAssetOverrides.contractAddress}) = lower(${target.contractAddress})`,
        target.mintAddress === null
          ? sql`${schema.principalAssetOverrides.mintAddress} is null`
          : eq(schema.principalAssetOverrides.mintAddress, target.mintAddress)
      )

const providerTransferTargetPredicate = (
  target: Extract<AssetOverrideTarget, { _tag: "representation" }>
) =>
  and(
    eq(schema.providerTransfers.observedBlockchainId, target.blockchainId),
    eq(schema.providerTransfers.observedRepresentationType, target.representationType),
    target.contractAddress === null
      ? sql`${schema.providerTransfers.observedContractAddress} is null`
      : sql`lower(${schema.providerTransfers.observedContractAddress}) = lower(${target.contractAddress})`,
    target.mintAddress === null
      ? sql`${schema.providerTransfers.observedMintAddress} is null`
      : eq(schema.providerTransfers.observedMintAddress, target.mintAddress)
  )

const representationTargetPredicate = (
  target: Extract<AssetOverrideTarget, { _tag: "representation" }>
) =>
  and(
    eq(schema.assetRepresentations.blockchainId, target.blockchainId),
    eq(schema.assetRepresentations.type, target.representationType),
    target.contractAddress === null
      ? sql`${schema.assetRepresentations.contractAddress} is null`
      : sql`lower(${schema.assetRepresentations.contractAddress}) = lower(${target.contractAddress})`,
    target.mintAddress === null
      ? sql`${schema.assetRepresentations.mintAddress} is null`
      : eq(schema.assetRepresentations.mintAddress, target.mintAddress)
  )

const targetValues = (target: AssetOverrideTarget) =>
  target._tag === "provider_asset"
    ? {
        targetKind: "provider_asset" as const,
        providerAssetRowId: target.providerAssetRowId,
        blockchainId: null,
        representationType: null,
        contractAddress: null,
        mintAddress: null,
      }
    : {
        targetKind: "representation" as const,
        providerAssetRowId: null,
        blockchainId: target.blockchainId,
        representationType: target.representationType,
        contractAddress: target.contractAddress?.toLowerCase() ?? null,
        mintAddress: target.mintAddress,
      }

const validateTargetShape = (target: AssetOverrideTarget) => {
  if (target._tag === "provider_asset") return Effect.void

  const identityCount =
    Number(target.contractAddress !== null) + Number(target.mintAddress !== null)
  const valid =
    (target.representationType === "native" && identityCount === 0) ||
    (target.representationType !== "native" && identityCount === 1)

  return valid
    ? Effect.void
    : Effect.fail(
        new AssetOverrideValidationError({
          code: "invalid_representation_target",
          message: "Representation target does not match its representation type.",
        })
      )
}

const rowTarget = (row: PrincipalAssetOverrideRow): AssetOverrideTarget =>
  row.targetKind === "provider_asset" && row.providerAssetRowId !== null
    ? { _tag: "provider_asset", providerAssetRowId: row.providerAssetRowId }
    : {
        _tag: "representation",
        blockchainId: row.blockchainId ?? "",
        representationType: row.representationType ?? "native",
        contractAddress: row.contractAddress,
        mintAddress: row.mintAddress,
      }

const rowInspectedConclusion = (row: PrincipalAssetOverrideRow): AssetOverrideSystemConclusion =>
  row.kind === "identity"
    ? {
        _tag: "identity",
        state: row.inspectedIdentityState ?? "unresolved",
        assetId: row.inspectedAssetId,
      }
    : {
        _tag: "inclusion",
        state: row.inspectedInclusionState ?? "blocked",
        reason: row.inspectedInclusionReason,
      }

const rowReplacement = (row: PrincipalAssetOverrideRow): AssetOverrideReplacement | null => {
  if (row.action === "withdraw") return null
  if (row.kind === "identity" && row.replacementAssetId !== null) {
    return { _tag: "identity", assetId: row.replacementAssetId }
  }
  if (
    row.kind === "inclusion" &&
    (row.replacementInclusionState === "included" || row.replacementInclusionState === "excluded")
  ) {
    return { _tag: "inclusion", state: row.replacementInclusionState }
  }
  return null
}

const rowHistoryEntry = (row: PrincipalAssetOverrideRow): AssetOverrideHistoryEntry => ({
  id: row.id,
  kind: row.kind,
  target: rowTarget(row),
  action: row.action,
  inspectedSystemRevision: row.inspectedSystemRevision,
  inspectedSystemConclusion: rowInspectedConclusion(row),
  replacement: rowReplacement(row),
  actorId: row.actorId,
  reason: row.reason,
  supersedesOverrideId: row.supersedesOverrideId,
  createdAt: row.createdAt,
})

const effectiveConclusion = ({
  activeOverride,
  systemConclusion,
}: {
  readonly activeOverride: AssetOverrideHistoryEntry | null
  readonly systemConclusion: AssetOverrideSystemConclusion
}): AssetOverrideSystemConclusion => {
  const replacement = activeOverride?.replacement
  if (replacement?._tag === "identity") {
    return { _tag: "identity", state: "resolved", assetId: replacement.assetId }
  }
  if (replacement?._tag === "inclusion") {
    return { _tag: "inclusion", state: replacement.state, reason: null }
  }
  return systemConclusion
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type AssetOverrideExecutor = Omit<typeof db, "$client">

  const loadOwnedSourceIds = ({
    executor,
    principalId,
    target,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly principalId: string
    readonly target: AssetOverrideTarget
  }) => {
    if (target._tag === "representation") {
      return executor
        .selectDistinct({ sourceId: schema.sources.id })
        .from(schema.providerTransfers)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.providerTransfers.sourceId))
        .where(
          and(eq(schema.sources.principalId, principalId), providerTransferTargetPredicate(target))
        )
        .orderBy(asc(schema.sources.id))
        .pipe(Effect.map((rows) => rows.map((row) => row.sourceId)))
    }

    return executor
      .selectDistinct({ sourceId: schema.sources.id })
      .from(schema.providerAssetSourceUses)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.providerAssetSourceUses.sourceId))
      .where(
        and(
          eq(schema.sources.principalId, principalId),
          eq(schema.providerAssetSourceUses.providerAssetRowId, target.providerAssetRowId),
          or(
            notExists(
              executor
                .select({ id: schema.providerTransfers.id })
                .from(schema.providerTransfers)
                .where(
                  and(
                    eq(schema.providerTransfers.sourceId, schema.sources.id),
                    eq(schema.providerTransfers.providerAssetId, target.providerAssetRowId)
                  )
                )
            ),
            exists(
              executor
                .select({ id: schema.providerTransfers.id })
                .from(schema.providerTransfers)
                .where(
                  and(
                    eq(schema.providerTransfers.sourceId, schema.sources.id),
                    eq(schema.providerTransfers.providerAssetId, target.providerAssetRowId),
                    or(
                      isNull(schema.providerTransfers.observedBlockchainId),
                      isNull(schema.providerTransfers.observedRepresentationType)
                    )
                  )
                )
            )
          )
        )
      )
      .orderBy(asc(schema.sources.id))
      .pipe(Effect.map((rows) => rows.map((row) => row.sourceId)))
  }

  const loadSystemConclusion = ({
    executor,
    kind,
    target,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly kind: AssetOverrideKind
    readonly target: AssetOverrideTarget
  }) =>
    Effect.gen(function* () {
      if (target._tag === "provider_asset") {
        const [row] = yield* executor
          .select({
            evidenceRevision: schema.providerAssets.evidenceRevision,
            exponent: schema.providerAssets.exponent,
            providerType: schema.providerAssets.providerType,
            mappingId: schema.providerAssetMappings.id,
            mappingStatus: schema.providerAssetMappings.mappingStatus,
            assetId: schema.providerAssetMappings.canonicalAssetId,
            representationId: schema.providerAssetMappings.assetRepresentationId,
            mappingUpdatedAt: schema.providerAssetMappings.updatedAt,
          })
          .from(schema.providerAssets)
          .leftJoin(
            schema.providerAssetMappings,
            eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
          )
          .where(eq(schema.providerAssets.id, target.providerAssetRowId))
          .limit(1)

        if (row === undefined) {
          return yield* new AssetOverrideTargetNotFoundError()
        }

        const revision = JSON.stringify({
          evidenceRevision: row.evidenceRevision,
          mappingId: row.mappingId,
          mappingStatus: row.mappingStatus,
          assetId: row.assetId,
          representationId: row.representationId,
          mappingUpdatedAt: row.mappingUpdatedAt?.toISOString() ?? null,
        })
        if (kind === "identity") {
          const conclusion: AssetOverrideSystemConclusion =
            row.mappingStatus === "approved" && row.assetId !== null
              ? { _tag: "identity", state: "resolved", assetId: row.assetId }
              : row.mappingStatus === "rejected"
                ? { _tag: "identity", state: "excluded", assetId: null }
                : { _tag: "identity", state: "unresolved", assetId: null }
          return { revision, conclusion }
        }

        const technicalBlocker =
          row.exponent === null
            ? "missing_decimals"
            : row.providerType === "unsupported"
              ? "unsupported_asset_type"
              : null
        const conclusion: AssetOverrideSystemConclusion =
          technicalBlocker !== null
            ? { _tag: "inclusion", state: "blocked", reason: technicalBlocker }
            : row.mappingStatus === "approved"
              ? { _tag: "inclusion", state: "included", reason: null }
              : row.mappingStatus === "rejected"
                ? { _tag: "inclusion", state: "excluded", reason: "taxmaxi_policy" }
                : { _tag: "inclusion", state: "blocked", reason: "asset_identity_unresolved" }
        return { revision, conclusion }
      }

      const [representation] = yield* executor
        .select({
          id: schema.assetRepresentations.id,
          assetId: schema.assetRepresentations.assetId,
          isSpam: schema.assetRepresentations.isSpam,
          decimals: schema.assetRepresentations.decimals,
          updatedAt: schema.assetRepresentations.updatedAt,
        })
        .from(schema.assetRepresentations)
        .where(representationTargetPredicate(target))
        .limit(1)

      const mappings = yield* executor
        .selectDistinct({
          providerAssetRowId: schema.providerAssets.id,
          evidenceRevision: schema.providerAssets.evidenceRevision,
          mappingId: schema.providerAssetMappings.id,
          mappingStatus: schema.providerAssetMappings.mappingStatus,
          assetId: schema.providerAssetMappings.canonicalAssetId,
          updatedAt: schema.providerAssetMappings.updatedAt,
          decimals: schema.providerTransfers.observedDecimals,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.providerAssets,
          eq(schema.providerAssets.id, schema.providerTransfers.providerAssetId)
        )
        .leftJoin(
          schema.providerAssetMappings,
          eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
        )
        .where(providerTransferTargetPredicate(target))
        .orderBy(
          asc(schema.providerAssets.id),
          asc(schema.providerAssets.evidenceRevision),
          asc(schema.providerAssetMappings.id),
          asc(schema.providerAssetMappings.mappingStatus),
          asc(schema.providerAssetMappings.canonicalAssetId),
          asc(sql`${schema.providerAssetMappings.updatedAt}::text`),
          asc(schema.providerTransfers.observedDecimals)
        )

      const revision = JSON.stringify({
        representation:
          representation === undefined
            ? null
            : {
                id: representation.id,
                assetId: representation.assetId,
                isSpam: representation.isSpam,
                updatedAt: representation.updatedAt.toISOString(),
              },
        mappings: mappings.map((row) => ({
          ...row,
          updatedAt: row.updatedAt?.toISOString() ?? null,
        })),
      })
      const approved = mappings.find(
        (mapping) => mapping.mappingStatus === "approved" && mapping.assetId !== null
      )
      const rejected = mappings.some((mapping) => mapping.mappingStatus === "rejected")

      if (kind === "identity") {
        const conclusion: AssetOverrideSystemConclusion =
          representation !== undefined
            ? { _tag: "identity", state: "resolved", assetId: representation.assetId }
            : approved?.assetId !== null && approved?.assetId !== undefined
              ? { _tag: "identity", state: "resolved", assetId: approved.assetId }
              : rejected
                ? { _tag: "identity", state: "excluded", assetId: null }
                : { _tag: "identity", state: "unresolved", assetId: null }
        return { revision, conclusion }
      }

      const missingDecimals =
        representation?.decimals === null ||
        (representation === undefined && mappings.some((mapping) => mapping.decimals === null))
      const conclusion: AssetOverrideSystemConclusion = missingDecimals
        ? { _tag: "inclusion", state: "blocked", reason: "missing_decimals" }
        : representation?.isSpam === true || rejected
          ? { _tag: "inclusion", state: "excluded", reason: "taxmaxi_policy" }
          : representation !== undefined || approved !== undefined
            ? { _tag: "inclusion", state: "included", reason: null }
            : { _tag: "inclusion", state: "blocked", reason: "asset_identity_unresolved" }
      return { revision, conclusion }
    })

  const loadHistory = ({
    executor,
    kind,
    principalId,
    target,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly kind: AssetOverrideKind
    readonly principalId: string
    readonly target: AssetOverrideTarget
  }) =>
    executor
      .select({
        id: schema.principalAssetOverrides.id,
        principalId: schema.principalAssetOverrides.principalId,
        kind: schema.principalAssetOverrides.kind,
        targetKind: schema.principalAssetOverrides.targetKind,
        blockchainId: schema.principalAssetOverrides.blockchainId,
        representationType: schema.principalAssetOverrides.representationType,
        contractAddress: schema.principalAssetOverrides.contractAddress,
        mintAddress: schema.principalAssetOverrides.mintAddress,
        providerAssetRowId: schema.principalAssetOverrides.providerAssetRowId,
        action: schema.principalAssetOverrides.action,
        inspectedSystemRevision: schema.principalAssetOverrides.inspectedSystemRevision,
        inspectedIdentityState: schema.principalAssetOverrides.inspectedIdentityState,
        inspectedInclusionState: schema.principalAssetOverrides.inspectedInclusionState,
        inspectedInclusionReason: schema.principalAssetOverrides.inspectedInclusionReason,
        inspectedAssetId: schema.principalAssetOverrides.inspectedAssetId,
        replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
        replacementInclusionState: schema.principalAssetOverrides.replacementInclusionState,
        actorId: schema.principalAssetOverrides.actorId,
        reason: schema.principalAssetOverrides.reason,
        supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
        createdAt: schema.principalAssetOverrides.createdAt,
      })
      .from(schema.principalAssetOverrides)
      .where(
        and(
          eq(schema.principalAssetOverrides.principalId, principalId),
          eq(schema.principalAssetOverrides.kind, kind),
          targetPredicate(target)
        )
      )
      .orderBy(
        asc(schema.principalAssetOverrides.createdAt),
        asc(schema.principalAssetOverrides.id)
      )
      .pipe(Effect.map((rows) => rows.map(rowHistoryEntry)))

  const loadRecomputationState = ({
    executor,
    sourceIds,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly sourceIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      if (sourceIds.length === 0) return "complete" as const
      const rows = yield* executor
        .select({ sourceId: schema.processingJobs.sourceId, status: schema.processingJobs.status })
        .from(schema.processingJobs)
        .where(inArray(schema.processingJobs.sourceId, sourceIds))
        .orderBy(desc(schema.processingJobs.createdAt), desc(schema.processingJobs.id))
      const latestBySource = new Map<string, (typeof rows)[number]>()
      for (const row of rows) {
        if (!latestBySource.has(row.sourceId)) latestBySource.set(row.sourceId, row)
      }
      const latest = Array.from(latestBySource.values())
      if (latest.some((row) => row.status === "pending" || row.status === "processing")) {
        return "updating" as const
      }
      return latest.some((row) => row.status === "failed")
        ? ("failed" as const)
        : ("complete" as const)
    })

  const buildProjection = ({
    executor,
    kind,
    principalId,
    target,
    sourceIds,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly kind: AssetOverrideKind
    readonly principalId: string
    readonly target: AssetOverrideTarget
    readonly sourceIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const system = yield* loadSystemConclusion({ executor, kind, target })
      const history = yield* loadHistory({ executor, kind, principalId, target })
      const latest = history.at(-1) ?? null
      const activeOverride = latest?.action === "set" ? latest : null
      const recomputationState = yield* loadRecomputationState({ executor, sourceIds })

      return {
        kind,
        target,
        systemRevision: system.revision,
        systemConclusion: system.conclusion,
        activeOverride,
        effectiveConclusion: effectiveConclusion({
          activeOverride,
          systemConclusion: system.conclusion,
        }),
        staleSystemRevision:
          activeOverride !== null && activeOverride.inspectedSystemRevision !== system.revision,
        history,
        recomputationState,
      } satisfies AssetOverrideProjection
    })

  const findProjection: AssetOverrideRepositoryShape["findProjection"] = ({
    principalId,
    kind,
    target,
  }) =>
    Effect.gen(function* () {
      const canonicalTarget = canonicalizeTarget(target)
      yield* validateTargetShape(canonicalTarget)
      const sourceIds = yield* loadOwnedSourceIds({
        executor: db,
        principalId,
        target: canonicalTarget,
      })
      if (sourceIds.length === 0) return Option.none<AssetOverrideProjection>()
      return Option.some(
        yield* buildProjection({
          executor: db,
          kind,
          principalId,
          target: canonicalTarget,
          sourceIds,
        })
      )
    }).pipe(
      Effect.catchTag("AssetOverrideTargetNotFoundError", () =>
        Effect.succeed(Option.none<AssetOverrideProjection>())
      ),
      wrapAssetOverrideError("assetOverrideRepository.findProjection")
    )

  const getProjection: AssetOverrideRepositoryShape["getProjection"] = (params) =>
    findProjection(params).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new AssetOverrideTargetNotFoundError()),
          onSome: Effect.succeed,
        })
      )
    )

  const validateReplacement = ({
    executor,
    kind,
    replacement,
    target,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly kind: AssetOverrideKind
    readonly replacement: AssetOverrideReplacement
    readonly target: AssetOverrideTarget
  }) =>
    Effect.gen(function* () {
      if (replacement._tag !== kind) {
        return yield* new AssetOverrideValidationError({
          code: "override_kind_mismatch",
          message: "Replacement conclusion does not match the override kind.",
        })
      }
      if (replacement._tag === "identity") {
        const [asset] = yield* executor
          .select({ type: schema.assets.type })
          .from(schema.assets)
          .where(eq(schema.assets.id, replacement.assetId))
          .limit(1)
        if (asset === undefined) {
          return yield* new AssetOverrideValidationError({
            code: "asset_not_found",
            message: "Identity override must select an existing economic asset.",
          })
        }
        if (
          target._tag === "representation" &&
          (target.representationType === "nft") !== (asset.type === "nft")
        ) {
          return yield* new AssetOverrideValidationError({
            code: "asset_type_mismatch",
            message: "Economic asset type is incompatible with the representation type.",
          })
        }
      }
      if (replacement._tag === "inclusion" && replacement.state === "included") {
        const system = yield* loadSystemConclusion({ executor, kind: "inclusion", target })
        if (
          system.conclusion._tag === "inclusion" &&
          (system.conclusion.reason === "missing_decimals" ||
            system.conclusion.reason === "unsupported_asset_type")
        ) {
          return yield* new AssetOverrideValidationError({
            code: system.conclusion.reason,
            message: "Inclusion cannot bypass missing technical asset facts.",
          })
        }
      }
    })

  const requestReplays = ({
    executor,
    principalId,
    sourceIds,
  }: {
    readonly executor: AssetOverrideExecutor
    readonly principalId: string
    readonly sourceIds: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const now = yield* currentDate
      yield* Effect.forEach(
        sourceIds,
        (sourceId) => {
          const requestReplay = (attemptsRemaining: number): Effect.Effect<void, unknown> =>
            Effect.gen(function* () {
              const [active] = yield* executor
                .update(schema.processingJobs)
                .set({ followUpMode: "replay", updatedAt: now })
                .where(
                  and(
                    eq(schema.processingJobs.sourceId, sourceId),
                    eq(schema.processingJobs.principalId, principalId),
                    inArray(schema.processingJobs.status, ["pending", "processing"])
                  )
                )
                .returning({ id: schema.processingJobs.id })
              if (active !== undefined) return

              const [created] = yield* executor
                .insert(schema.processingJobs)
                .values({
                  sourceId,
                  principalId,
                  mode: "replay",
                  status: "pending",
                  attemptCount: 0,
                  maxAttempts: 3,
                  progressDetails: { mode: "replay", reason: "principal_asset_override" },
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoNothing()
                .returning({ id: schema.processingJobs.id })

              if (created !== undefined) return
              if (attemptsRemaining > 1) {
                return yield* Effect.suspend(() => requestReplay(attemptsRemaining - 1))
              }

              return yield* new PersistenceError({
                operation: "assetOverrideRepository.requestReplays",
                cause: {
                  principalId,
                  sourceId,
                  message: "Active replay owner changed repeatedly.",
                },
              })
            })

          return requestReplay(3)
        },
        { discard: true }
      )
    })

  const validateOverride: AssetOverrideRepositoryShape["validateOverride"] = ({
    principalId,
    kind,
    target,
    replacement,
  }) =>
    Effect.gen(function* () {
      const canonicalTarget = canonicalizeTarget(target)
      yield* validateTargetShape(canonicalTarget)
      const sourceIds = yield* loadOwnedSourceIds({
        executor: db,
        principalId,
        target: canonicalTarget,
      })
      if (sourceIds.length === 0) return yield* new AssetOverrideTargetNotFoundError()
      yield* validateReplacement({ executor: db, kind, replacement, target: canonicalTarget })
      return yield* buildProjection({
        executor: db,
        kind,
        principalId,
        target: canonicalTarget,
        sourceIds,
      })
    }).pipe(wrapAssetOverrideError("assetOverrideRepository.validateOverride"))

  const writeOverride = ({
    action,
    actorId,
    expectedActiveOverrideId,
    expectedSystemRevision,
    kind,
    principalId,
    reason,
    replacement,
    target,
  }: {
    readonly action: "set" | "withdraw"
    readonly actorId: string
    readonly expectedActiveOverrideId: string | null
    readonly expectedSystemRevision: string
    readonly kind: AssetOverrideKind
    readonly principalId: string
    readonly reason: string
    readonly replacement: AssetOverrideReplacement | null
    readonly target: AssetOverrideTarget
  }): Effect.Effect<AssetOverrideWriteResult, unknown> =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const canonicalTarget = canonicalizeTarget(target)
        yield* validateTargetShape(canonicalTarget)
        if (reason.trim() === "") {
          return yield* new AssetOverrideValidationError({
            code: "reason_required",
            message: "A reason is required for every asset override change.",
          })
        }
        yield* tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${principalId}:${kind}:${JSON.stringify(canonicalTarget)}`}, 0))`
        )
        const sourceIds = yield* loadOwnedSourceIds({
          executor: tx,
          principalId,
          target: canonicalTarget,
        })
        if (sourceIds.length === 0) return yield* new AssetOverrideTargetNotFoundError()
        const before = yield* buildProjection({
          executor: tx,
          kind,
          principalId,
          target: canonicalTarget,
          sourceIds,
        })
        const currentActiveId = before.activeOverride?.id ?? null
        if (
          before.systemRevision !== expectedSystemRevision ||
          currentActiveId !== expectedActiveOverrideId
        ) {
          return { _tag: "conflict", projection: before } as const
        }
        if (action === "withdraw" && before.activeOverride === null) {
          return yield* new AssetOverrideValidationError({
            code: "no_active_override",
            message: "There is no active override to withdraw.",
          })
        }
        if (replacement !== null) {
          yield* validateReplacement({ executor: tx, kind, replacement, target: canonicalTarget })
        }

        const latest = before.history.at(-1) ?? null
        const inspectedIdentity =
          before.systemConclusion._tag === "identity" ? before.systemConclusion : null
        const inspectedInclusion =
          before.systemConclusion._tag === "inclusion" ? before.systemConclusion : null
        yield* tx.insert(schema.principalAssetOverrides).values({
          principalId,
          kind,
          ...targetValues(canonicalTarget),
          action,
          inspectedSystemRevision: before.systemRevision,
          inspectedIdentityState: inspectedIdentity?.state ?? null,
          inspectedInclusionState: inspectedInclusion?.state ?? null,
          inspectedInclusionReason: inspectedInclusion?.reason ?? null,
          inspectedAssetId: inspectedIdentity?.assetId ?? null,
          replacementAssetId: replacement?._tag === "identity" ? replacement.assetId : null,
          replacementInclusionState: replacement?._tag === "inclusion" ? replacement.state : null,
          actorId,
          reason: reason.trim(),
          supersedesOverrideId: latest?.id ?? null,
        })
        yield* requestReplays({ executor: tx, principalId, sourceIds })
        const projection = yield* buildProjection({
          executor: tx,
          kind,
          principalId,
          target: canonicalTarget,
          sourceIds,
        })
        return { _tag: "accepted", projection } as const
      })
    )

  const setOverride: AssetOverrideRepositoryShape["setOverride"] = (params) =>
    writeOverride({ ...params, action: "set" }).pipe(
      wrapAssetOverrideError("assetOverrideRepository.setOverride")
    )

  const withdrawOverride: AssetOverrideRepositoryShape["withdrawOverride"] = (params) =>
    writeOverride({ ...params, action: "withdraw", replacement: null }).pipe(
      wrapAssetOverrideError("assetOverrideRepository.withdrawOverride")
    )

  return AssetOverrideRepository.of({
    validateOverride,
    findProjection,
    getProjection,
    setOverride,
    withdrawOverride,
  } satisfies AssetOverrideRepositoryShape)
})

/** Live Drizzle implementation of principal-scoped asset overrides. */
export const AssetOverrideRepositoryLive = Layer.effect(AssetOverrideRepository, make)
