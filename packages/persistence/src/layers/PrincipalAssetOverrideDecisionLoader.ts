/**
 * PrincipalAssetOverrideDecisionLoader - Effective fact-layer asset decisions.
 *
 * Loads one principal's current representation and provider-asset stream leaves, then returns
 * their effective fact decisions and stable revision material for calculation runs.
 *
 * @module PrincipalAssetOverrideDecisionLoader
 */

import { aliasedTable, and, asc, eq, inArray, isNull, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type { PrincipalAssetOverrideRevisionRecord } from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type RepresentationType = "native" | "token" | "nft"

interface OverrideTargetRow {
  readonly targetId: string
  readonly targetKind: "representation" | "provider_asset"
  readonly blockchainId: string | null
  readonly representationType: RepresentationType | null
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly providerAssetRowId: string | null
  readonly kind: "identity" | "inclusion"
  readonly overrideId: string
  readonly operation: "create" | "replace" | "withdraw"
  readonly supersedesOverrideId: string | null
  readonly replacementAssetId: string | null
  readonly replacementInclusion: "included" | "excluded" | null
}

interface ExactTargetRow extends OverrideTargetRow {
  readonly targetKind: "representation"
  readonly blockchainId: string
  readonly representationType: RepresentationType
  readonly providerAssetRowId: null
}

interface ProviderAssetTargetRow extends OverrideTargetRow {
  readonly targetKind: "provider_asset"
  readonly blockchainId: null
  readonly representationType: null
  readonly contractAddress: null
  readonly mintAddress: null
  readonly providerAssetRowId: string
}

type TypedTargetRow = ExactTargetRow | ProviderAssetTargetRow

interface RepresentationRow {
  readonly id: string
  readonly assetId: string
  readonly blockchainId: string
  readonly representationType: RepresentationType
  readonly contractAddress: string | null
  readonly mintAddress: string | null
}

interface ProviderMappingRow {
  readonly providerAssetRowId: string
  readonly canonicalAssetId: string | null
  readonly mappingStatus: "approved" | "pending_review" | "rejected" | "excluded" | null
  readonly currentConclusionId: string | null
  readonly currentConclusionOutcome:
    | "attach"
    | "create_standalone"
    | "identity"
    | "excluded"
    | "pending"
    | "fail_closed"
    | null
  readonly currentConclusionAssetId: string | null
}

/** Effective decision for one exact chainless provider-asset row. */
export interface PrincipalProviderAssetDecision {
  readonly systemAssetId: string | null
  readonly effectiveAssetId: string | null
  readonly inclusion: "included" | "excluded"
}

/** Effective fact decisions plus the exact override snapshot that produced them. */
export interface PrincipalAssetOverrideDecisions {
  readonly assetIdByRepresentationId: ReadonlyMap<string, string>
  readonly systemAssetIdByRepresentationId: ReadonlyMap<string, string>
  readonly providerAssetDecisionById: ReadonlyMap<string, PrincipalProviderAssetDecision>
  readonly revision: ReadonlyArray<PrincipalAssetOverrideRevisionRecord>
}

/** Select the effective economic asset while preserving the stored representation identity. */
export const resolvePrincipalAssetId = ({
  decisions,
  systemAssetId,
  assetRepresentationId,
  providerAssetRowId,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly systemAssetId: string
  readonly assetRepresentationId: string | null | undefined
  readonly providerAssetRowId?: string | null | undefined
}): string =>
  assetRepresentationId === null || assetRepresentationId === undefined
    ? providerAssetRowId === null || providerAssetRowId === undefined
      ? systemAssetId
      : (decisions.providerAssetDecisionById.get(providerAssetRowId)?.effectiveAssetId ??
        systemAssetId)
    : (decisions.assetIdByRepresentationId.get(assetRepresentationId) ?? systemAssetId)

/** Restore the catalog economic asset for a stored representation. */
export const resolveSystemAssetId = ({
  decisions,
  assetId,
  assetRepresentationId,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly assetId: string
  readonly assetRepresentationId: string | null | undefined
}): string =>
  assetRepresentationId === null || assetRepresentationId === undefined
    ? assetId
    : (decisions.systemAssetIdByRepresentationId.get(assetRepresentationId) ?? assetId)

const targetKey = ({
  blockchainId,
  representationType,
  contractAddress,
  mintAddress,
}: Pick<
  ExactTargetRow,
  "blockchainId" | "representationType" | "contractAddress" | "mintAddress"
>): string =>
  [blockchainId, representationType, contractAddress ?? "", mintAddress ?? ""].join("\0")

const streamLeaves = <T extends OverrideTargetRow>(rows: ReadonlyArray<T>): ReadonlyArray<T> => {
  const supersededIds = new Set(
    rows.flatMap(({ supersedesOverrideId }) =>
      supersedesOverrideId === null ? [] : [supersedesOverrideId]
    )
  )

  return rows.filter(({ overrideId }) => !supersededIds.has(overrideId))
}

const validateTargetRows = (
  rows: ReadonlyArray<OverrideTargetRow>
): Effect.Effect<ReadonlyArray<TypedTargetRow>, PersistenceError> =>
  Effect.gen(function* () {
    const typedRows: TypedTargetRow[] = []
    for (const row of rows) {
      if (row.targetKind === "representation") {
        if (row.blockchainId === null || row.representationType === null) {
          return yield* new PersistenceError({
            operation: "principalAssetOverrideDecisionLoader.load.history",
            cause: `Exact target ${row.targetId} is missing its representation identity`,
          })
        }
        typedRows.push({
          ...row,
          targetKind: "representation",
          blockchainId: row.blockchainId,
          representationType: row.representationType,
          providerAssetRowId: null,
        })
        continue
      }
      if (row.providerAssetRowId === null) {
        return yield* new PersistenceError({
          operation: "principalAssetOverrideDecisionLoader.load.history",
          cause: `Provider-asset target ${row.targetId} is missing its provider asset row`,
        })
      }
      typedRows.push({
        ...row,
        targetKind: "provider_asset",
        blockchainId: null,
        representationType: null,
        contractAddress: null,
        mintAddress: null,
        providerAssetRowId: row.providerAssetRowId,
      })
    }
    return typedRows
  })

const makeRepresentationDecisionMaps = ({
  exactLeaves,
  representations,
}: {
  readonly exactLeaves: ReadonlyArray<ExactTargetRow>
  readonly representations: ReadonlyArray<RepresentationRow>
}) => {
  const leafByTarget = new Map(exactLeaves.map((leaf) => [targetKey(leaf), leaf]))
  const systemAssetIdByRepresentationId = new Map(
    representations.map((representation) => [representation.id, representation.assetId] as const)
  )
  const assetIdByRepresentationId = new Map(
    representations.map((representation) => {
      const leaf = leafByTarget.get(targetKey(representation))
      const selectedAssetId =
        leaf === undefined || leaf.operation === "withdraw"
          ? representation.assetId
          : leaf.replacementAssetId

      return [representation.id, selectedAssetId ?? representation.assetId] as const
    })
  )

  return { assetIdByRepresentationId, systemAssetIdByRepresentationId }
}

const makeProviderAssetDecisionMap = ({
  leaves,
  providerMappings,
}: {
  readonly leaves: ReadonlyArray<TypedTargetRow>
  readonly providerMappings: ReadonlyArray<ProviderMappingRow>
}) => {
  const leavesByStream = new Map(
    leaves.flatMap((leaf) =>
      leaf.targetKind === "provider_asset"
        ? [[`${leaf.providerAssetRowId}\0${leaf.kind}`, leaf] as const]
        : []
    )
  )

  const systemAssetId = (row: ProviderMappingRow): string | null => {
    if (row.currentConclusionId === null) {
      return row.mappingStatus === "approved" ? row.canonicalAssetId : null
    }
    return row.currentConclusionOutcome === "attach" ||
      row.currentConclusionOutcome === "create_standalone" ||
      row.currentConclusionOutcome === "identity"
      ? row.currentConclusionAssetId
      : null
  }

  const systemInclusion = (row: ProviderMappingRow): "included" | "excluded" =>
    row.currentConclusionId === null
      ? row.mappingStatus === "excluded"
        ? "excluded"
        : "included"
      : row.currentConclusionOutcome === "excluded"
        ? "excluded"
        : "included"

  return new Map(
    providerMappings.map((providerMapping) => {
      const { providerAssetRowId } = providerMapping
      const identityLeaf = leavesByStream.get(`${providerAssetRowId}\0identity`)
      const inclusionLeaf = leavesByStream.get(`${providerAssetRowId}\0inclusion`)
      const catalogAssetId = systemAssetId(providerMapping)
      const effectiveAssetId =
        identityLeaf === undefined || identityLeaf.operation === "withdraw"
          ? catalogAssetId
          : identityLeaf.replacementAssetId
      const inclusion =
        inclusionLeaf === undefined || inclusionLeaf.operation === "withdraw"
          ? systemInclusion(providerMapping)
          : (inclusionLeaf.replacementInclusion ?? "included")

      return [
        providerAssetRowId,
        { systemAssetId: catalogAssetId, effectiveAssetId, inclusion },
      ] as const
    })
  )
}

const makeRevision = (
  leaves: ReadonlyArray<TypedTargetRow>
): ReadonlyArray<PrincipalAssetOverrideRevisionRecord> =>
  leaves
    .filter((leaf) => leaf.targetKind === "provider_asset" || leaf.kind === "identity")
    .map((leaf): PrincipalAssetOverrideRevisionRecord => {
      if (leaf.targetKind === "representation") {
        return {
          target: {
            _tag: "representation",
            targetId: leaf.targetId,
            blockchainId: leaf.blockchainId,
            representationType: leaf.representationType,
            contractAddress: leaf.contractAddress,
            mintAddress: leaf.mintAddress,
          },
          kind: "identity",
          overrideId: leaf.overrideId,
          operation: leaf.operation,
          supersedesOverrideId: leaf.supersedesOverrideId,
          replacementAssetId: leaf.replacementAssetId,
          replacementInclusion: null,
        }
      }
      return {
        target: {
          _tag: "provider_asset",
          targetId: leaf.targetId,
          providerAssetRowId: leaf.providerAssetRowId,
        },
        kind: leaf.kind,
        overrideId: leaf.overrideId,
        operation: leaf.operation,
        supersedesOverrideId: leaf.supersedesOverrideId,
        replacementAssetId: leaf.replacementAssetId,
        replacementInclusion: leaf.replacementInclusion,
      }
    })

/** Build the principal-scoped loader against the current SQL transaction context. */
export const makePrincipalAssetOverrideDecisionLoader = Effect.gen(function* () {
  const db = yield* drizzle
  const currentConclusion = aliasedTable(
    schema.assetResolutionDecisions,
    "override_loader_current_conclusion"
  )

  const load = ({
    principalId,
    assetRepresentationIds = [],
    providerAssetRowIds,
  }: {
    readonly principalId: string
    readonly assetRepresentationIds?: ReadonlyArray<string>
    readonly providerAssetRowIds?: ReadonlyArray<string>
  }): Effect.Effect<PrincipalAssetOverrideDecisions, PersistenceError> =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          targetId: schema.principalAssetOverrideTargets.id,
          targetKind: schema.principalAssetOverrideTargets.targetKind,
          blockchainId: schema.principalAssetOverrideTargets.blockchainId,
          representationType: schema.principalAssetOverrideTargets.representationType,
          contractAddress: schema.principalAssetOverrideTargets.contractAddress,
          mintAddress: schema.principalAssetOverrideTargets.mintAddress,
          providerAssetRowId: schema.principalAssetOverrideTargets.providerAssetRowId,
          kind: schema.principalAssetOverrides.kind,
          overrideId: schema.principalAssetOverrides.id,
          operation: schema.principalAssetOverrides.operation,
          supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
          replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
          replacementInclusion: schema.principalAssetOverrides.replacementInclusion,
        })
        .from(schema.principalAssetOverrideTargets)
        .innerJoin(
          schema.principalAssetOverrides,
          and(
            eq(schema.principalAssetOverrides.targetId, schema.principalAssetOverrideTargets.id),
            eq(
              schema.principalAssetOverrides.principalId,
              schema.principalAssetOverrideTargets.principalId
            )
          )
        )
        .where(eq(schema.principalAssetOverrideTargets.principalId, principalId))
        .orderBy(
          asc(schema.principalAssetOverrideTargets.targetKind),
          asc(schema.principalAssetOverrideTargets.blockchainId),
          asc(schema.principalAssetOverrideTargets.representationType),
          asc(schema.principalAssetOverrideTargets.contractAddress),
          asc(schema.principalAssetOverrideTargets.mintAddress),
          asc(schema.principalAssetOverrideTargets.providerAssetRowId),
          asc(schema.principalAssetOverrideTargets.id),
          asc(schema.principalAssetOverrides.kind),
          asc(schema.principalAssetOverrides.recordedAt),
          asc(schema.principalAssetOverrides.id)
        )
        .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.load.history"))

      const typedRows = yield* validateTargetRows(rows)
      const leaves = streamLeaves(typedRows)
      const exactLeaves = leaves.filter(
        (leaf): leaf is ExactTargetRow =>
          leaf.targetKind === "representation" && leaf.kind === "identity"
      )
      const requestedRepresentationIds = [...new Set(assetRepresentationIds)].sort()
      const targetConditions = exactLeaves.map((target) =>
        and(
          eq(schema.assetRepresentations.blockchainId, target.blockchainId),
          eq(schema.assetRepresentations.type, target.representationType),
          target.contractAddress === null
            ? isNull(schema.assetRepresentations.contractAddress)
            : eq(schema.assetRepresentations.contractAddress, target.contractAddress),
          target.mintAddress === null
            ? isNull(schema.assetRepresentations.mintAddress)
            : eq(schema.assetRepresentations.mintAddress, target.mintAddress)
        )
      )
      const representationCondition = or(
        requestedRepresentationIds.length === 0
          ? undefined
          : inArray(schema.assetRepresentations.id, requestedRepresentationIds),
        ...targetConditions
      )
      const representations =
        representationCondition === undefined
          ? []
          : yield* db
              .select({
                id: schema.assetRepresentations.id,
                assetId: schema.assetRepresentations.assetId,
                blockchainId: schema.assetRepresentations.blockchainId,
                representationType: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(representationCondition)
              .orderBy(asc(schema.assetRepresentations.id))
              .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.load.representations"))

      const { assetIdByRepresentationId, systemAssetIdByRepresentationId } =
        makeRepresentationDecisionMaps({ exactLeaves, representations })
      const targetProviderAssetIds = typedRows.flatMap((row) =>
        row.targetKind === "provider_asset" ? [row.providerAssetRowId] : []
      )
      const requestedProviderAssetIds = [
        ...new Set(providerAssetRowIds ?? targetProviderAssetIds),
      ].sort()
      const providerMappings =
        requestedProviderAssetIds.length === 0
          ? []
          : yield* db
              .select({
                providerAssetRowId: schema.providerAssets.id,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
                mappingStatus: schema.providerAssetMappings.mappingStatus,
                currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
                currentConclusionOutcome: currentConclusion.outcome,
                currentConclusionAssetId: currentConclusion.assetId,
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
                currentConclusion,
                eq(currentConclusion.id, schema.assetResolutionCurrentState.currentConclusionId)
              )
              .where(inArray(schema.providerAssets.id, requestedProviderAssetIds))
              .orderBy(asc(schema.providerAssets.id))
              .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.load.providerAssets"))
      const providerAssetDecisionById = makeProviderAssetDecisionMap({
        leaves,
        providerMappings,
      })
      const revision = makeRevision(leaves)

      return {
        assetIdByRepresentationId,
        systemAssetIdByRepresentationId,
        providerAssetDecisionById,
        revision,
      }
    })

  const includeSystemRepresentations = ({
    decisions,
    assetRepresentationIds,
  }: {
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly assetRepresentationIds: ReadonlyArray<string>
  }): Effect.Effect<PrincipalAssetOverrideDecisions, PersistenceError> =>
    Effect.gen(function* () {
      const missingIds = [
        ...new Set(
          assetRepresentationIds.filter(
            (assetRepresentationId) =>
              !decisions.systemAssetIdByRepresentationId.has(assetRepresentationId)
          )
        ),
      ]
      if (missingIds.length === 0) return decisions

      const representations = yield* db
        .select({
          id: schema.assetRepresentations.id,
          assetId: schema.assetRepresentations.assetId,
        })
        .from(schema.assetRepresentations)
        .where(inArray(schema.assetRepresentations.id, missingIds))
        .orderBy(asc(schema.assetRepresentations.id))
        .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.includeSystemRepresentations"))
      const catalogPairs = representations.map(({ id, assetId }) => [id, assetId] as const)

      return {
        ...decisions,
        assetIdByRepresentationId: new Map([
          ...decisions.assetIdByRepresentationId,
          ...catalogPairs,
        ]),
        systemAssetIdByRepresentationId: new Map([
          ...decisions.systemAssetIdByRepresentationId,
          ...catalogPairs,
        ]),
      }
    })

  return { includeSystemRepresentations, load }
})
