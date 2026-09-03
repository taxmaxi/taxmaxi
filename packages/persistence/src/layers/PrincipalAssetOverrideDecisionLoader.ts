/**
 * PrincipalAssetOverrideDecisionLoader - Effective exact-representation identity decisions.
 *
 * Loads one principal's identity stream leaves and returns both the selected economic
 * asset for matching stored representations and stable revision material for calculation runs.
 *
 * @module PrincipalAssetOverrideDecisionLoader
 */

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type { PrincipalAssetOverrideRevisionRecord } from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"

type RepresentationType = "native" | "token" | "nft"

interface ExactTargetRow {
  readonly targetId: string
  readonly blockchainId: string
  readonly representationType: RepresentationType
  readonly contractAddress: string | null
  readonly mintAddress: string | null
  readonly overrideId: string
  readonly operation: "create" | "replace" | "withdraw"
  readonly supersedesOverrideId: string | null
  readonly replacementAssetId: string | null
}

/** Effective representation decisions plus the exact override snapshot that produced them. */
export interface PrincipalAssetOverrideDecisions {
  readonly assetIdByRepresentationId: ReadonlyMap<string, string>
  readonly systemAssetIdByRepresentationId: ReadonlyMap<string, string>
  readonly revision: ReadonlyArray<PrincipalAssetOverrideRevisionRecord>
}

/** Select the effective economic asset while preserving the stored representation identity. */
export const resolvePrincipalAssetId = ({
  decisions,
  systemAssetId,
  assetRepresentationId,
}: {
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly systemAssetId: string
  readonly assetRepresentationId: string | null | undefined
}): string =>
  assetRepresentationId === null || assetRepresentationId === undefined
    ? systemAssetId
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

const streamLeaves = (rows: ReadonlyArray<ExactTargetRow>): ReadonlyArray<ExactTargetRow> => {
  const supersededIds = new Set(
    rows.flatMap(({ supersedesOverrideId }) =>
      supersedesOverrideId === null ? [] : [supersedesOverrideId]
    )
  )

  return rows.filter(({ overrideId }) => !supersededIds.has(overrideId))
}

/** Build the principal-scoped loader against the current SQL transaction context. */
export const makePrincipalAssetOverrideDecisionLoader = Effect.gen(function* () {
  const db = yield* drizzle

  const load = ({
    principalId,
    assetRepresentationIds = [],
  }: {
    readonly principalId: string
    readonly assetRepresentationIds?: ReadonlyArray<string>
  }): Effect.Effect<PrincipalAssetOverrideDecisions, PersistenceError> =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          targetId: schema.principalAssetOverrideTargets.id,
          blockchainId: schema.principalAssetOverrideTargets.blockchainId,
          representationType: schema.principalAssetOverrideTargets.representationType,
          contractAddress: schema.principalAssetOverrideTargets.contractAddress,
          mintAddress: schema.principalAssetOverrideTargets.mintAddress,
          overrideId: schema.principalAssetOverrides.id,
          operation: schema.principalAssetOverrides.operation,
          supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
          replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
        })
        .from(schema.principalAssetOverrideTargets)
        .innerJoin(
          schema.principalAssetOverrides,
          and(
            eq(schema.principalAssetOverrides.targetId, schema.principalAssetOverrideTargets.id),
            eq(
              schema.principalAssetOverrides.principalId,
              schema.principalAssetOverrideTargets.principalId
            ),
            eq(schema.principalAssetOverrides.kind, "identity")
          )
        )
        .where(
          and(
            eq(schema.principalAssetOverrideTargets.principalId, principalId),
            eq(schema.principalAssetOverrideTargets.targetKind, "representation")
          )
        )
        .orderBy(
          asc(schema.principalAssetOverrideTargets.blockchainId),
          asc(schema.principalAssetOverrideTargets.representationType),
          asc(schema.principalAssetOverrideTargets.contractAddress),
          asc(schema.principalAssetOverrideTargets.mintAddress),
          asc(schema.principalAssetOverrideTargets.id),
          asc(schema.principalAssetOverrides.recordedAt),
          asc(schema.principalAssetOverrides.id)
        )
        .pipe(wrapSqlError("principalAssetOverrideDecisionLoader.load.history"))

      const exactRows: ExactTargetRow[] = []
      for (const row of rows) {
        if (row.blockchainId === null || row.representationType === null) {
          return yield* new PersistenceError({
            operation: "principalAssetOverrideDecisionLoader.load.history",
            cause: `Exact target ${row.targetId} is missing its representation identity`,
          })
        }
        exactRows.push({
          ...row,
          blockchainId: row.blockchainId,
          representationType: row.representationType,
        })
      }

      const leaves = streamLeaves(exactRows)
      const requestedRepresentationIds = [...new Set(assetRepresentationIds)].sort()
      const targetConditions = leaves.map((target) =>
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

      const leafByTarget = new Map(leaves.map((leaf) => [targetKey(leaf), leaf]))
      const assetIdByRepresentationId = new Map(
        representations.map((representation) => {
          const leaf = leafByTarget.get(
            targetKey({
              blockchainId: representation.blockchainId,
              representationType: representation.representationType,
              contractAddress: representation.contractAddress,
              mintAddress: representation.mintAddress,
            })
          )
          const selectedAssetId =
            leaf === undefined || leaf.operation === "withdraw"
              ? representation.assetId
              : leaf.replacementAssetId

          return [representation.id, selectedAssetId ?? representation.assetId] as const
        })
      )
      const systemAssetIdByRepresentationId = new Map(
        representations.map(
          (representation) => [representation.id, representation.assetId] as const
        )
      )
      const revision = leaves.map(
        (leaf): PrincipalAssetOverrideRevisionRecord => [
          leaf.targetId,
          leaf.blockchainId,
          leaf.representationType,
          leaf.contractAddress,
          leaf.mintAddress,
          leaf.overrideId,
          leaf.operation,
          leaf.supersedesOverrideId,
          leaf.replacementAssetId,
        ]
      )

      return { assetIdByRepresentationId, systemAssetIdByRepresentationId, revision }
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
