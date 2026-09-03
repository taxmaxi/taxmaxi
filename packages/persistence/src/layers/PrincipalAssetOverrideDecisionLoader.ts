/**
 * PrincipalAssetOverrideDecisionLoader - Effective fact-layer asset decisions.
 *
 * Loads one principal's current representation and provider-asset stream leaves, then returns
 * their effective fact decisions and stable revision material for calculation runs.
 *
 * @module PrincipalAssetOverrideDecisionLoader
 */

import {
  decidePrincipalAssetOverride,
  type PrincipalAssetEffectiveDecision,
  type PrincipalAssetTechnicalBlocker,
} from "@my/core/assets"
import { aliasedTable, and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
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
  readonly isSpam: boolean
}

interface ProviderMappingRow {
  readonly providerAssetRowId: string
  readonly mappingKind: "asset" | "fiat" | null
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
  readonly exponent: number | null
  readonly providerType: string | null
  readonly mappingAssetType: "fungible" | "nft" | null
  readonly conclusionAssetType: "fungible" | "nft" | null
}

interface ExactTargetObservationRow {
  readonly targetId: string
  readonly providerAssetRowId: string | null
  readonly observedDecimals: number | null
}

/** Effective decision for one exact stored representation. */
export interface PrincipalRepresentationDecision {
  readonly systemAssetId: string | null
  readonly systemInclusion: "included" | "excluded"
  readonly effectiveDecision: PrincipalAssetEffectiveDecision
}

/** Key an exact target decision to the provider row whose observation supplied its system facts. */
export const representationTargetDecisionKey = ({
  providerAssetRowId,
  targetId,
}: {
  readonly providerAssetRowId: string | null
  readonly targetId: string
}): string => `${targetId}\0${providerAssetRowId ?? ""}`

/** Effective decision for one exact chainless provider-asset row. */
export interface PrincipalProviderAssetDecision {
  readonly systemAssetId: string | null
  readonly systemInclusion: "included" | "excluded"
  readonly effectiveAssetId: string | null
  readonly inclusion: "included" | "excluded"
  readonly effectiveDecision: PrincipalAssetEffectiveDecision
}

/** Effective fact decisions plus the exact override snapshot that produced them. */
export interface PrincipalAssetOverrideDecisions {
  readonly assetIdByRepresentationId: ReadonlyMap<string, string>
  readonly systemAssetIdByRepresentationId: ReadonlyMap<string, string>
  readonly representationDecisionById: ReadonlyMap<string, PrincipalRepresentationDecision>
  readonly representationDecisionByTargetProviderKey: ReadonlyMap<
    string,
    PrincipalRepresentationDecision
  >
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
  leaves,
  representations,
}: {
  readonly leaves: ReadonlyArray<ExactTargetRow>
  readonly representations: ReadonlyArray<RepresentationRow>
}) => {
  const leavesByStream = new Map(
    leaves.map((leaf) => [`${targetKey(leaf)}\0${leaf.kind}`, leaf] as const)
  )
  const systemAssetIdByRepresentationId = new Map(
    representations.map((representation) => [representation.id, representation.assetId] as const)
  )
  const assetIdByRepresentationId = new Map(
    representations.map((representation) => {
      const leaf = leavesByStream.get(`${targetKey(representation)}\0identity`)
      const selectedAssetId =
        leaf === undefined || leaf.operation === "withdraw"
          ? representation.assetId
          : leaf.replacementAssetId

      return [representation.id, selectedAssetId ?? representation.assetId] as const
    })
  )

  const representationDecisionById = new Map(
    representations.map((representation) => {
      const key = targetKey(representation)
      const identityLeaf = leavesByStream.get(`${key}\0identity`)
      const inclusionLeaf = leavesByStream.get(`${key}\0inclusion`)
      const identityReplacement =
        identityLeaf === undefined || identityLeaf.operation === "withdraw"
          ? null
          : identityLeaf.replacementAssetId === null
            ? null
            : { _tag: "resolved" as const, assetId: identityLeaf.replacementAssetId }
      const inclusionReplacement =
        inclusionLeaf === undefined || inclusionLeaf.operation === "withdraw"
          ? null
          : inclusionLeaf.replacementInclusion
      const systemInclusion = representation.isSpam ? "excluded" : "included"

      return [
        representation.id,
        {
          systemAssetId: representation.assetId,
          systemInclusion,
          effectiveDecision: decidePrincipalAssetOverride({
            systemIdentity: { _tag: "resolved", assetId: representation.assetId },
            systemInclusion,
            identityReplacement,
            inclusionReplacement,
            technicalBlockers: [],
          }),
        },
      ] as const
    })
  )

  return {
    assetIdByRepresentationId,
    systemAssetIdByRepresentationId,
    representationDecisionById,
  }
}

/** Resolve a provider row's asset type and blockers for validation and fact reads. */
export const principalProviderAssetTechnicalState = ({
  catalogAssetId,
  conclusionAssetType,
  currentConclusionId,
  exponent,
  mappingAssetType,
  providerType,
}: {
  readonly catalogAssetId: string | null
  readonly conclusionAssetType: "fungible" | "nft" | null
  readonly currentConclusionId: string | null
  readonly exponent: number | null
  readonly mappingAssetType: "fungible" | "nft" | null
  readonly providerType: string | null
}): {
  readonly assetType: "fungible" | "nft" | null
  readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
} => {
  const blockers: PrincipalAssetTechnicalBlocker[] = []
  const normalizedType = providerType?.trim().toLowerCase() ?? null
  const providerAssetType =
    normalizedType === "nft"
      ? "nft"
      : normalizedType === "crypto" ||
          normalizedType === "native" ||
          normalizedType === "token" ||
          normalizedType === "spl-token" ||
          normalizedType === "spl-token-2022"
        ? "fungible"
        : null
  const assetType =
    catalogAssetId === null
      ? providerAssetType
      : currentConclusionId === null
        ? mappingAssetType
        : conclusionAssetType

  if (exponent === null) blockers.push("missing_decimals")
  if (assetType === null) blockers.push("unsupported_asset_type")
  return { assetType, technicalBlockers: blockers }
}

const providerMappingSystemAssetId = (row: ProviderMappingRow): string | null => {
  if (row.currentConclusionId === null) {
    return row.mappingStatus === "approved" ? row.canonicalAssetId : null
  }
  return row.currentConclusionOutcome === "attach" ||
    row.currentConclusionOutcome === "create_standalone" ||
    row.currentConclusionOutcome === "identity"
    ? row.currentConclusionAssetId
    : null
}

const providerMappingSystemInclusion = (row: ProviderMappingRow): "included" | "excluded" =>
  row.currentConclusionId === null
    ? row.mappingStatus === "excluded"
      ? "excluded"
      : "included"
    : row.currentConclusionOutcome === "excluded"
      ? "excluded"
      : "included"

const makeRepresentationTargetDecisionMap = ({
  leaves,
  observations,
  providerMappings,
  representationDecisionById,
  representations,
}: {
  readonly leaves: ReadonlyArray<ExactTargetRow>
  readonly observations: ReadonlyArray<ExactTargetObservationRow>
  readonly providerMappings: ReadonlyArray<ProviderMappingRow>
  readonly representationDecisionById: ReadonlyMap<string, PrincipalRepresentationDecision>
  readonly representations: ReadonlyArray<RepresentationRow>
}): ReadonlyMap<string, PrincipalRepresentationDecision> => {
  const leavesByStream = new Map(
    leaves.map((leaf) => [`${leaf.targetId}\0${leaf.kind}`, leaf] as const)
  )
  const representationByTargetKey = new Map(
    representations.map((representation) => [targetKey(representation), representation] as const)
  )
  const observationsByTargetId = new Map<string, ExactTargetObservationRow[]>()
  for (const observation of observations) {
    const targetObservations = observationsByTargetId.get(observation.targetId) ?? []
    targetObservations.push(observation)
    observationsByTargetId.set(observation.targetId, targetObservations)
  }
  const providerMappingById = new Map(
    providerMappings.map((row) => [row.providerAssetRowId, row] as const)
  )
  const targetById = new Map(leaves.map((leaf) => [leaf.targetId, leaf] as const))

  return new Map(
    [...targetById].flatMap(([targetId, target]) => {
      const representation = representationByTargetKey.get(targetKey(target))
      const catalogDecision =
        representation === undefined ? undefined : representationDecisionById.get(representation.id)
      const targetObservations = observationsByTargetId.get(targetId) ?? []
      const providerAssetRowIds = [
        ...new Set(targetObservations.map(({ providerAssetRowId }) => providerAssetRowId)),
      ]

      return providerAssetRowIds.map((providerAssetRowId) => {
        if (catalogDecision !== undefined) {
          return [
            representationTargetDecisionKey({ providerAssetRowId, targetId }),
            catalogDecision,
          ] as const
        }

        const mapping =
          providerAssetRowId === null ? undefined : providerMappingById.get(providerAssetRowId)
        const assetMapping = mapping?.mappingKind === "fiat" ? undefined : mapping
        const systemAssetId =
          assetMapping === undefined ? null : providerMappingSystemAssetId(assetMapping)
        const systemIdentity =
          systemAssetId === null
            ? ({ _tag: "unresolved" } as const)
            : ({ _tag: "resolved", assetId: systemAssetId } as const)
        const systemInclusion = "included" as const
        const identityLeaf = leavesByStream.get(`${targetId}\0identity`)
        const inclusionLeaf = leavesByStream.get(`${targetId}\0inclusion`)
        const identityReplacement =
          identityLeaf === undefined ||
          identityLeaf.operation === "withdraw" ||
          identityLeaf.replacementAssetId === null
            ? null
            : { _tag: "resolved" as const, assetId: identityLeaf.replacementAssetId }
        const inclusionReplacement =
          inclusionLeaf === undefined || inclusionLeaf.operation === "withdraw"
            ? null
            : inclusionLeaf.replacementInclusion
        const providerObservations = targetObservations.filter(
          (observation) => observation.providerAssetRowId === providerAssetRowId
        )
        const technicalBlockers = providerObservations.some(
          ({ observedDecimals }) => observedDecimals !== null
        )
          ? []
          : (["missing_decimals"] as const)

        return [
          representationTargetDecisionKey({ providerAssetRowId, targetId }),
          {
            systemAssetId,
            systemInclusion,
            effectiveDecision: decidePrincipalAssetOverride({
              systemIdentity,
              systemInclusion,
              identityReplacement,
              inclusionReplacement,
              technicalBlockers,
            }),
          },
        ] as const
      })
    })
  )
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

  return new Map(
    providerMappings.flatMap((providerMapping) => {
      if (providerMapping.mappingKind === "fiat") return []

      const { providerAssetRowId } = providerMapping
      const identityLeaf = leavesByStream.get(`${providerAssetRowId}\0identity`)
      const inclusionLeaf = leavesByStream.get(`${providerAssetRowId}\0inclusion`)
      const catalogAssetId = providerMappingSystemAssetId(providerMapping)
      const effectiveAssetId =
        identityLeaf === undefined || identityLeaf.operation === "withdraw"
          ? catalogAssetId
          : identityLeaf.replacementAssetId
      const catalogInclusion = providerMappingSystemInclusion(providerMapping)
      const inclusion =
        inclusionLeaf === undefined || inclusionLeaf.operation === "withdraw"
          ? catalogInclusion
          : (inclusionLeaf.replacementInclusion ?? "included")
      const inclusionReplacement =
        inclusionLeaf === undefined || inclusionLeaf.operation === "withdraw"
          ? null
          : inclusionLeaf.replacementInclusion
      const technicalBlockers = principalProviderAssetTechnicalState({
        ...providerMapping,
        catalogAssetId,
      }).technicalBlockers
      const effectiveDecision = decidePrincipalAssetOverride({
        systemIdentity:
          catalogAssetId === null
            ? { _tag: "unresolved" }
            : { _tag: "resolved", assetId: catalogAssetId },
        systemInclusion: catalogInclusion,
        identityReplacement:
          identityLeaf === undefined ||
          identityLeaf.operation === "withdraw" ||
          identityLeaf.replacementAssetId === null
            ? null
            : { _tag: "resolved", assetId: identityLeaf.replacementAssetId },
        inclusionReplacement,
        technicalBlockers,
      })

      return [
        [
          providerAssetRowId,
          {
            systemAssetId: catalogAssetId,
            systemInclusion: catalogInclusion,
            effectiveAssetId,
            inclusion,
            effectiveDecision,
          },
        ] as const,
      ]
    })
  )
}

const makeRevision = (
  leaves: ReadonlyArray<TypedTargetRow>
): ReadonlyArray<PrincipalAssetOverrideRevisionRecord> =>
  leaves.map((leaf): PrincipalAssetOverrideRevisionRecord => {
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
        kind: leaf.kind,
        overrideId: leaf.overrideId,
        operation: leaf.operation,
        supersedesOverrideId: leaf.supersedesOverrideId,
        replacementAssetId: leaf.replacementAssetId,
        replacementInclusion: leaf.replacementInclusion,
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
  const mappingAsset = aliasedTable(schema.assets, "override_loader_mapping_asset")
  const conclusionAsset = aliasedTable(schema.assets, "override_loader_conclusion_asset")

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
        (leaf): leaf is ExactTargetRow => leaf.targetKind === "representation"
      )
      const exactTargetIds = [...new Set(exactLeaves.map(({ targetId }) => targetId))].sort()
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
                isSpam: schema.assetRepresentations.isSpam,
              })
              .from(schema.assetRepresentations)
              .where(representationCondition)
              .orderBy(asc(schema.assetRepresentations.id))
              .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.load.representations"))
      const exactTargetObservations =
        exactTargetIds.length === 0
          ? []
          : yield* db
              .selectDistinct({
                targetId: schema.principalAssetOverrideTargets.id,
                providerAssetRowId: schema.providerTransfers.providerAssetId,
                observedDecimals: schema.providerTransfers.observedDecimals,
              })
              .from(schema.principalAssetOverrideTargets)
              .innerJoin(
                schema.providerTransfers,
                and(
                  eq(
                    schema.providerTransfers.observedBlockchainId,
                    schema.principalAssetOverrideTargets.blockchainId
                  ),
                  eq(
                    schema.providerTransfers.observedRepresentationType,
                    schema.principalAssetOverrideTargets.representationType
                  ),
                  sql`${schema.providerTransfers.observedContractAddress} is not distinct from
                    ${schema.principalAssetOverrideTargets.contractAddress}`,
                  sql`${schema.providerTransfers.observedMintAddress} is not distinct from
                    ${schema.principalAssetOverrideTargets.mintAddress}`
                )
              )
              .innerJoin(
                schema.sources,
                and(
                  eq(schema.providerTransfers.sourceId, schema.sources.id),
                  eq(schema.sources.principalId, principalId)
                )
              )
              .where(inArray(schema.principalAssetOverrideTargets.id, exactTargetIds))
              .orderBy(
                asc(schema.principalAssetOverrideTargets.id),
                asc(schema.providerTransfers.providerAssetId),
                asc(schema.providerTransfers.observedDecimals)
              )
              .pipe(
                wrapSqlError("principalAssetOverrideDecisionLoader.load.exactTargetObservations")
              )

      const {
        assetIdByRepresentationId,
        systemAssetIdByRepresentationId,
        representationDecisionById,
      } = makeRepresentationDecisionMaps({ leaves: exactLeaves, representations })
      const targetProviderAssetIds = typedRows.flatMap((row) =>
        row.targetKind === "provider_asset" ? [row.providerAssetRowId] : []
      )
      const observedProviderAssetIds = exactTargetObservations.flatMap(({ providerAssetRowId }) =>
        providerAssetRowId === null ? [] : [providerAssetRowId]
      )
      const requestedProviderAssetIds = [
        ...new Set([
          ...(providerAssetRowIds ?? targetProviderAssetIds),
          ...observedProviderAssetIds,
        ]),
      ].sort()
      const providerMappings =
        requestedProviderAssetIds.length === 0
          ? []
          : yield* db
              .select({
                providerAssetRowId: schema.providerAssets.id,
                mappingKind: schema.providerAssetMappings.mappingKind,
                canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
                mappingStatus: schema.providerAssetMappings.mappingStatus,
                currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
                currentConclusionOutcome: currentConclusion.outcome,
                currentConclusionAssetId: currentConclusion.assetId,
                exponent: schema.providerAssets.exponent,
                providerType: schema.providerAssets.providerType,
                mappingAssetType: mappingAsset.type,
                conclusionAssetType: conclusionAsset.type,
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
              .leftJoin(
                mappingAsset,
                eq(mappingAsset.id, schema.providerAssetMappings.canonicalAssetId)
              )
              .leftJoin(conclusionAsset, eq(conclusionAsset.id, currentConclusion.assetId))
              .where(inArray(schema.providerAssets.id, requestedProviderAssetIds))
              .orderBy(asc(schema.providerAssets.id))
              .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.load.providerAssets"))
      const providerAssetDecisionById = makeProviderAssetDecisionMap({
        leaves,
        providerMappings,
      })
      const representationDecisionByTargetProviderKey = makeRepresentationTargetDecisionMap({
        leaves: exactLeaves,
        observations: exactTargetObservations,
        providerMappings,
        representationDecisionById,
        representations,
      })
      const revision = makeRevision(leaves)

      return {
        assetIdByRepresentationId,
        systemAssetIdByRepresentationId,
        representationDecisionById,
        representationDecisionByTargetProviderKey,
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
          isSpam: schema.assetRepresentations.isSpam,
        })
        .from(schema.assetRepresentations)
        .where(inArray(schema.assetRepresentations.id, missingIds))
        .orderBy(asc(schema.assetRepresentations.id))
        .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.includeSystemRepresentations"))
      const catalogPairs = representations.map(({ id, assetId }) => [id, assetId] as const)
      const representationDecisions: ReadonlyArray<
        readonly [string, PrincipalRepresentationDecision]
      > = representations.map(({ id, assetId, isSpam }) => {
        const systemInclusion = isSpam ? "excluded" : "included"

        return [
          id,
          {
            systemAssetId: assetId,
            systemInclusion,
            effectiveDecision: decidePrincipalAssetOverride({
              systemIdentity: { _tag: "resolved", assetId },
              systemInclusion,
              identityReplacement: null,
              inclusionReplacement: null,
              technicalBlockers: [],
            }),
          },
        ]
      })

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
        representationDecisionById: new Map([
          ...decisions.representationDecisionById,
          ...representationDecisions,
        ]),
      }
    })

  return { includeSystemRepresentations, load }
})
