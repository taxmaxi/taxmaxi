/**
 * PrincipalAssetOverrideRepositoryLive - Drizzle-backed override reads and validation.
 *
 * @module PrincipalAssetOverrideRepositoryLive
 */

import {
  decidePrincipalAssetOverride,
  type PrincipalAssetIdentity,
  type PrincipalAssetOverrideTarget,
  type PrincipalAssetTechnicalBlocker,
} from "@my/core/assets"
import { and, asc, eq, isNull, or, sql, type SQLWrapper } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  PrincipalAssetOverrideInvalidTargetError,
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideHistoryRecord,
  type PrincipalAssetOverrideProjection,
  type PrincipalAssetOverrideRepositoryShape,
  type PrincipalAssetOverrideSelectedAsset,
  type PrincipalAssetOverrideSystemState,
  type PrincipalAssetOverrideValidationWarning,
} from "../services/PrincipalAssetOverrideRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/
const CURRENT_POLICY_EVALUATION = alias(
  schema.assetResolutionDecisions,
  "principal_override_current_policy_evaluation"
)
const CURRENT_CONCLUSION = alias(
  schema.assetResolutionDecisions,
  "principal_override_current_conclusion"
)
const CURRENT_CONCLUSION_ASSET = alias(schema.assets, "principal_override_current_conclusion_asset")
const MAPPING_ASSET = alias(schema.assets, "principal_override_mapping_asset")
const CHECKED_TECHNICAL_BLOCKER_KINDS = [
  "missing_decimals",
  "unsupported_asset_type",
] as const satisfies ReadonlyArray<PrincipalAssetTechnicalBlocker>

type CanonicalRepresentationTarget = Extract<
  PrincipalAssetOverrideTarget,
  { readonly _tag: "representation" }
> & {
  readonly blockchainId: string
  readonly chainType: string
}

type CanonicalTarget =
  | CanonicalRepresentationTarget
  | Extract<PrincipalAssetOverrideTarget, { readonly _tag: "provider_asset" }>

interface LoadedTargetState {
  readonly system: PrincipalAssetOverrideSystemState
  readonly checkedTechnicalBlockerKinds: ReadonlyArray<PrincipalAssetTechnicalBlocker>
  readonly technicalBlockers: ReadonlyArray<PrincipalAssetTechnicalBlocker>
  readonly confidenceWarnings: ReadonlyArray<PrincipalAssetOverrideValidationWarning>
  readonly targetAssetType: "fungible" | "nft" | null
  readonly evidence: {
    readonly names: ReadonlyArray<string>
    readonly symbols: ReadonlyArray<string>
    readonly marketDataIds: ReadonlyArray<string>
  }
}

interface ProviderConclusionObservation {
  readonly canonicalAssetId: string | null
  readonly currentConclusionAssetId: string | null
  readonly currentConclusionId: string | null
  readonly currentConclusionOutcome:
    | (typeof schema.assetResolutionOutcomeEnum.enumValues)[number]
    | null
  readonly mappingStatus: "approved" | "pending_review" | "rejected" | "excluded" | null
}

interface GlobalRepresentationRow {
  readonly assetId: string
  readonly isSpam: boolean
  readonly name: string
  readonly symbol: string
  readonly marketDataId: string | null
}

interface RepresentationObservation extends ProviderConclusionObservation {
  readonly decimals: number | null
  readonly providerAssetName: string | null
  readonly providerAssetSymbol: string | null
  readonly policyEvaluationOutcome:
    | (typeof schema.assetResolutionOutcomeEnum.enumValues)[number]
    | null
  readonly systemMarketDataId: string | null
}

interface ProviderAssetStateRow extends ProviderConclusionObservation {
  readonly providerAssetRowId: string
  readonly name: string | null
  readonly symbol: string
  readonly exponent: number | null
  readonly providerType: string | null
  readonly mappingKind: (typeof schema.providerAssetMappingKindEnum.enumValues)[number] | null
  readonly policyEvaluationOutcome: RepresentationObservation["policyEvaluationOutcome"]
  readonly mappingAssetType: "fungible" | "nft" | null
  readonly mappingMarketDataId: string | null
  readonly conclusionAssetType: "fungible" | "nft" | null
  readonly conclusionMarketDataId: string | null
}

const providerConclusionAssetId = (observation: ProviderConclusionObservation): string | null => {
  if (observation.currentConclusionId !== null) {
    return observation.currentConclusionOutcome === "attach" ||
      observation.currentConclusionOutcome === "create_standalone" ||
      observation.currentConclusionOutcome === "identity"
      ? observation.currentConclusionAssetId
      : null
  }

  return observation.mappingStatus === "approved" ? observation.canonicalAssetId : null
}

const providerConclusionIsExcluded = (observation: ProviderConclusionObservation): boolean =>
  observation.currentConclusionId !== null
    ? observation.currentConclusionOutcome === "excluded"
    : observation.mappingStatus === "excluded"

const identityRevisionValue = (identity: PrincipalAssetIdentity): string =>
  identity._tag === "resolved" ? `resolved:${identity.assetId}` : "unresolved"

const systemRevisions = ({
  identity,
  inclusion,
  targetKey,
}: {
  readonly identity: PrincipalAssetIdentity
  readonly inclusion: "included" | "excluded"
  readonly targetKey: string
}) => ({
  identityRevision: `${targetKey}:identity:${identityRevisionValue(identity)}`,
  inclusionRevision: `${targetKey}:inclusion:${inclusion}`,
})

const distinctEvidence = (
  values: ReadonlyArray<string | null | undefined>
): ReadonlyArray<string> =>
  [
    ...new Set(values.filter((value): value is string => value !== null && value !== undefined)),
  ].sort()

const confidenceWarningsFor = ({
  hasIdentityConflict,
  policyOutcomes,
}: {
  readonly hasIdentityConflict: boolean
  readonly policyOutcomes: ReadonlyArray<RepresentationObservation["policyEvaluationOutcome"]>
}): ReadonlyArray<PrincipalAssetOverrideValidationWarning> => {
  const warnings: Array<PrincipalAssetOverrideValidationWarning> = []
  if (hasIdentityConflict) {
    warnings.push({ code: "system_confidence_conflict", current: "conflicting", selected: null })
  }
  if (policyOutcomes.some((outcome) => outcome === "fail_closed")) {
    warnings.push({ code: "system_confidence_fail_closed", current: "fail_closed", selected: null })
  } else if (policyOutcomes.some((outcome) => outcome === "pending")) {
    warnings.push({ code: "system_confidence_pending", current: "pending", selected: null })
  }
  return warnings
}

const canonicalTargetForProjection = (target: CanonicalTarget): PrincipalAssetOverrideTarget =>
  target._tag === "provider_asset"
    ? target
    : {
        _tag: "representation",
        blockchain: target.blockchain,
        type: target.type,
        contractAddress: target.contractAddress,
        mintAddress: target.mintAddress,
      }

const representationAddressCondition = ({
  chainType,
  contractAddress,
  contractColumn,
  mintAddress,
  mintColumn,
}: {
  readonly chainType: string
  readonly contractAddress: string | null
  readonly contractColumn: SQLWrapper
  readonly mintAddress: string | null
  readonly mintColumn: SQLWrapper
}) =>
  and(
    contractAddress === null
      ? isNull(contractColumn)
      : chainType === "evm"
        ? eq(sql<string>`lower(${contractColumn})`, contractAddress)
        : eq(contractColumn, contractAddress),
    mintAddress === null
      ? isNull(mintColumn)
      : chainType === "evm"
        ? eq(sql<string>`lower(${mintColumn})`, mintAddress)
        : eq(mintColumn, mintAddress)
  )

const providerAssetType = (providerType: string | null): "fungible" | "nft" | null => {
  const canonical = providerType?.trim().toLowerCase() ?? null
  if (canonical === "nft") return "nft"
  if (
    canonical === "crypto" ||
    canonical === "native" ||
    canonical === "token" ||
    canonical === "spl-token" ||
    canonical === "spl-token-2022"
  ) {
    return "fungible"
  }
  return null
}

const providerAssetState = (row: ProviderAssetStateRow): LoadedTargetState | null => {
  if (row.mappingKind === "fiat") return null

  const resolvedAssetId = providerConclusionAssetId(row)
  const identity: PrincipalAssetIdentity =
    resolvedAssetId === null
      ? { _tag: "unresolved" }
      : { _tag: "resolved", assetId: resolvedAssetId }
  const inclusion = providerConclusionIsExcluded(row) ? "excluded" : "included"
  const revisions = systemRevisions({
    identity,
    inclusion,
    targetKey: `provider-asset:${row.providerAssetRowId}`,
  })
  const type =
    resolvedAssetId === null
      ? providerAssetType(row.providerType)
      : row.currentConclusionId === null
        ? row.mappingAssetType
        : row.conclusionAssetType
  const technicalBlockers: Array<PrincipalAssetTechnicalBlocker> = []
  if (row.exponent === null) technicalBlockers.push("missing_decimals")
  if (type === null) technicalBlockers.push("unsupported_asset_type")

  return {
    system: {
      identity,
      identityRevision: revisions.identityRevision,
      inclusion,
      inclusionRevision: revisions.inclusionRevision,
    },
    checkedTechnicalBlockerKinds: CHECKED_TECHNICAL_BLOCKER_KINDS,
    technicalBlockers,
    confidenceWarnings: confidenceWarningsFor({
      hasIdentityConflict: false,
      policyOutcomes: [row.policyEvaluationOutcome],
    }),
    targetAssetType: type,
    evidence: {
      names: distinctEvidence([row.name]),
      symbols: distinctEvidence([row.symbol]),
      marketDataIds: distinctEvidence([
        resolvedAssetId === null
          ? null
          : row.currentConclusionId === null
            ? row.mappingMarketDataId
            : row.conclusionMarketDataId,
      ]),
    },
  }
}

const representationState = ({
  observations,
  representation,
  target,
}: {
  readonly observations: ReadonlyArray<RepresentationObservation>
  readonly representation: GlobalRepresentationRow | undefined
  readonly target: CanonicalRepresentationTarget
}): LoadedTargetState => {
  const providerAssetIds = [
    ...new Set(
      observations.flatMap((observation) => {
        const assetId = providerConclusionAssetId(observation)
        return assetId === null ? [] : [assetId]
      })
    ),
  ]
  const providerAssetId = providerAssetIds.length === 1 ? providerAssetIds[0] : undefined
  const identity: PrincipalAssetIdentity =
    representation !== undefined
      ? { _tag: "resolved", assetId: representation.assetId }
      : providerAssetId !== undefined
        ? { _tag: "resolved", assetId: providerAssetId }
        : { _tag: "unresolved" }
  const targetKey = `representation:${target.blockchainId}:${target.type}:${target.contractAddress ?? target.mintAddress ?? "native"}`
  const isSystemExcluded =
    representation?.isSpam === true ||
    (representation === undefined &&
      observations.some((observation) => providerConclusionIsExcluded(observation)))
  const inclusion = isSystemExcluded ? "excluded" : "included"
  const revisions = systemRevisions({ identity, inclusion, targetKey })
  const technicalBlockers: Array<PrincipalAssetTechnicalBlocker> = []
  if (representation === undefined && !observations.some(({ decimals }) => decimals !== null)) {
    technicalBlockers.push("missing_decimals")
  }
  const hasResolvedConclusion = providerAssetIds.length > 0
  const hasExcludedConclusion = observations.some(providerConclusionIsExcluded)

  return {
    system: {
      identity,
      identityRevision: revisions.identityRevision,
      inclusion,
      inclusionRevision: revisions.inclusionRevision,
    },
    checkedTechnicalBlockerKinds: CHECKED_TECHNICAL_BLOCKER_KINDS,
    technicalBlockers,
    confidenceWarnings: confidenceWarningsFor({
      hasIdentityConflict:
        representation === undefined &&
        (providerAssetIds.length > 1 || (hasResolvedConclusion && hasExcludedConclusion)),
      policyOutcomes: observations.map(({ policyEvaluationOutcome }) => policyEvaluationOutcome),
    }),
    targetAssetType: target.type === "nft" ? "nft" : "fungible",
    evidence: {
      names: distinctEvidence([
        representation?.name,
        ...observations.map(({ providerAssetName }) => providerAssetName),
      ]),
      symbols: distinctEvidence([
        representation?.symbol,
        ...observations.map(({ providerAssetSymbol }) => providerAssetSymbol),
      ]),
      marketDataIds: distinctEvidence([
        representation?.marketDataId,
        ...observations.map(({ systemMarketDataId }) => systemMarketDataId),
      ]),
    },
  }
}

const selectedAsset = (asset: {
  readonly id: string
  readonly type: "fungible" | "nft"
  readonly name: string
  readonly symbol: string
  readonly coingeckoCoinId: string | null
}): PrincipalAssetOverrideSelectedAsset => ({
  id: asset.id,
  type: asset.type,
  name: asset.name,
  symbol: asset.symbol,
  marketDataId: asset.coingeckoCoinId,
})

const makeWarnings = ({
  asset,
  confidenceWarnings,
  evidence,
  systemIdentity,
}: {
  readonly asset: PrincipalAssetOverrideSelectedAsset
  readonly confidenceWarnings: ReadonlyArray<PrincipalAssetOverrideValidationWarning>
  readonly evidence: LoadedTargetState["evidence"]
  readonly systemIdentity: PrincipalAssetIdentity
}): ReadonlyArray<PrincipalAssetOverrideValidationWarning> => {
  const warnings: Array<PrincipalAssetOverrideValidationWarning> = [...confidenceWarnings]
  const comparable = (value: string) => value.normalize("NFKC").trim().toLowerCase()
  const symbolMismatch = evidence.symbols.find(
    (symbol) => comparable(symbol) !== comparable(asset.symbol)
  )
  const nameMismatch = evidence.names.find((name) => comparable(name) !== comparable(asset.name))
  const marketDataMismatch = evidence.marketDataIds.find(
    (marketDataId) => marketDataId !== asset.marketDataId
  )

  if (symbolMismatch !== undefined) {
    warnings.push({ code: "symbol_mismatch", current: symbolMismatch, selected: asset.symbol })
  }
  if (nameMismatch !== undefined) {
    warnings.push({ code: "name_mismatch", current: nameMismatch, selected: asset.name })
  }
  if (marketDataMismatch !== undefined) {
    warnings.push({
      code: "market_data_identity_mismatch",
      current: marketDataMismatch,
      selected: asset.marketDataId,
    })
  }
  if (systemIdentity._tag === "resolved" && systemIdentity.assetId !== asset.id) {
    warnings.push({
      code: "system_identity_mismatch",
      current: systemIdentity.assetId,
      selected: asset.id,
    })
  }

  return warnings
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const canonicalizeTarget = (
    target: PrincipalAssetOverrideTarget
  ): Effect.Effect<
    CanonicalTarget,
    | PrincipalAssetOverrideInvalidTargetError
    | import("../errors/RepositoryError.ts").PersistenceError
  > =>
    Effect.gen(function* () {
      if (target._tag === "provider_asset") return target

      const blockchains = yield* db
        .select({
          id: schema.blockchains.id,
          name: schema.blockchains.name,
          chainType: schema.blockchains.chainType,
        })
        .from(schema.blockchains)
        .where(eq(sql<string>`lower(${schema.blockchains.name})`, target.blockchain.toLowerCase()))
        .limit(2)
        .pipe(wrapSqlError("principalAssetOverrideRepository.canonicalizeTarget.blockchain"))

      const blockchain = blockchains.length === 1 ? blockchains[0] : undefined
      if (blockchain === undefined) {
        return yield* new PrincipalAssetOverrideInvalidTargetError({
          reason: "unknown_blockchain",
        })
      }

      const addresses = [target.contractAddress, target.mintAddress].filter(
        (address): address is string => address !== null
      )
      if (
        blockchain.chainType === "evm" &&
        addresses.some((address) => !EVM_ADDRESS.test(address))
      ) {
        return yield* new PrincipalAssetOverrideInvalidTargetError({
          reason: "invalid_evm_address",
        })
      }

      return {
        ...target,
        blockchain: blockchain.name,
        blockchainId: blockchain.id,
        chainType: blockchain.chainType,
        contractAddress:
          blockchain.chainType === "evm"
            ? (target.contractAddress?.toLowerCase() ?? null)
            : target.contractAddress,
        mintAddress:
          blockchain.chainType === "evm"
            ? (target.mintAddress?.toLowerCase() ?? null)
            : target.mintAddress,
      }
    })

  const principalOwnsTarget = ({
    principalId,
    target,
  }: {
    readonly principalId: string
    readonly target: CanonicalTarget
  }) => {
    if (target._tag === "provider_asset") {
      return db
        .select({ id: schema.providerAssetSourceUses.providerAssetRowId })
        .from(schema.providerAssetSourceUses)
        .innerJoin(schema.sources, eq(schema.sources.id, schema.providerAssetSourceUses.sourceId))
        .where(
          and(
            eq(schema.providerAssetSourceUses.providerAssetRowId, target.providerAssetRowId),
            eq(schema.sources.principalId, principalId),
            or(
              sql<boolean>`not exists (
                select 1
                from ${schema.providerTransfers} exact_transfer
                where exact_transfer.provider_asset_id = ${target.providerAssetRowId}
                  and exact_transfer.source_id = ${schema.providerAssetSourceUses.sourceId}
                  and exact_transfer.observed_blockchain_id is not null
              )`,
              sql<boolean>`exists (
                select 1
                from ${schema.providerAssetTransactionUses} chainless_use
                where chainless_use.provider_asset_row_id = ${target.providerAssetRowId}
                  and chainless_use.source_id = ${schema.providerAssetSourceUses.sourceId}
                  and not exists (
                    select 1
                    from ${schema.providerTransfers} exact_transfer
                    where exact_transfer.provider_asset_id = ${target.providerAssetRowId}
                      and exact_transfer.transaction_id = chainless_use.transaction_id
                      and exact_transfer.observed_blockchain_id is not null
                  )
              )`
            )
          )
        )
        .limit(1)
        .pipe(
          Effect.map((rows) => rows.length === 1),
          wrapSqlError("principalAssetOverrideRepository.principalOwnsTarget.providerAsset")
        )
    }

    return db
      .select({ id: schema.sourceRepresentationUses.id })
      .from(schema.sourceRepresentationUses)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.sourceRepresentationUses.sourceId))
      .where(
        and(
          eq(schema.sources.principalId, principalId),
          eq(schema.sourceRepresentationUses.blockchainId, target.blockchainId),
          eq(schema.sourceRepresentationUses.representationType, target.type),
          representationAddressCondition({
            chainType: target.chainType,
            contractAddress: target.contractAddress,
            contractColumn: schema.sourceRepresentationUses.contractAddress,
            mintAddress: target.mintAddress,
            mintColumn: schema.sourceRepresentationUses.mintAddress,
          })
        )
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => rows.length === 1),
        wrapSqlError("principalAssetOverrideRepository.principalOwnsTarget.representation")
      )
  }

  const loadProviderAssetState = (
    providerAssetRowId: string
  ): Effect.Effect<
    LoadedTargetState | null,
    import("../errors/RepositoryError.ts").PersistenceError
  > =>
    db
      .select({
        providerAssetRowId: schema.providerAssets.id,
        name: schema.providerAssets.name,
        symbol: schema.providerAssets.currencyCode,
        exponent: schema.providerAssets.exponent,
        providerType: schema.providerAssets.providerType,
        mappingKind: schema.providerAssetMappings.mappingKind,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
        currentConclusionOutcome: CURRENT_CONCLUSION.outcome,
        currentConclusionAssetId: CURRENT_CONCLUSION.assetId,
        policyEvaluationOutcome: CURRENT_POLICY_EVALUATION.outcome,
        mappingAssetType: MAPPING_ASSET.type,
        mappingMarketDataId: MAPPING_ASSET.coingeckoCoinId,
        conclusionAssetType: CURRENT_CONCLUSION_ASSET.type,
        conclusionMarketDataId: CURRENT_CONCLUSION_ASSET.coingeckoCoinId,
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
        CURRENT_CONCLUSION,
        eq(CURRENT_CONCLUSION.id, schema.assetResolutionCurrentState.currentConclusionId)
      )
      .leftJoin(
        CURRENT_POLICY_EVALUATION,
        eq(
          CURRENT_POLICY_EVALUATION.id,
          schema.assetResolutionCurrentState.currentPolicyEvaluationId
        )
      )
      .leftJoin(MAPPING_ASSET, eq(MAPPING_ASSET.id, schema.providerAssetMappings.canonicalAssetId))
      .leftJoin(
        CURRENT_CONCLUSION_ASSET,
        eq(CURRENT_CONCLUSION_ASSET.id, CURRENT_CONCLUSION.assetId)
      )
      .where(eq(schema.providerAssets.id, providerAssetRowId))
      .limit(1)
      .pipe(
        Effect.map((rows) => {
          const row = rows[0]
          return row === undefined ? null : providerAssetState(row)
        }),
        wrapSqlError("principalAssetOverrideRepository.loadProviderAssetState")
      )

  const loadGlobalRepresentation = (target: CanonicalRepresentationTarget) =>
    db
      .select({
        assetId: schema.assetRepresentations.assetId,
        isSpam: schema.assetRepresentations.isSpam,
        name: schema.assets.name,
        symbol: schema.assets.symbol,
        marketDataId: schema.assets.coingeckoCoinId,
      })
      .from(schema.assetRepresentations)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.assetRepresentations.assetId))
      .where(
        and(
          eq(schema.assetRepresentations.blockchainId, target.blockchainId),
          eq(schema.assetRepresentations.type, target.type),
          representationAddressCondition({
            chainType: target.chainType,
            contractAddress: target.contractAddress,
            contractColumn: schema.assetRepresentations.contractAddress,
            mintAddress: target.mintAddress,
            mintColumn: schema.assetRepresentations.mintAddress,
          })
        )
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]),
        wrapSqlError("principalAssetOverrideRepository.loadGlobalRepresentation")
      )

  const loadOwnedRepresentationObservations = ({
    principalId,
    target,
  }: {
    readonly principalId: string
    readonly target: CanonicalRepresentationTarget
  }) =>
    db
      .selectDistinct({
        decimals: schema.providerTransfers.observedDecimals,
        providerAssetName: schema.providerAssets.name,
        providerAssetSymbol: schema.providerAssets.currencyCode,
        mappingStatus: schema.providerAssetMappings.mappingStatus,
        canonicalAssetId: schema.providerAssetMappings.canonicalAssetId,
        currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
        currentConclusionOutcome: CURRENT_CONCLUSION.outcome,
        currentConclusionAssetId: CURRENT_CONCLUSION.assetId,
        policyEvaluationOutcome: CURRENT_POLICY_EVALUATION.outcome,
        systemMarketDataId: sql<string | null>`case
          when ${CURRENT_CONCLUSION.id} is not null then ${CURRENT_CONCLUSION_ASSET.coingeckoCoinId}
          else ${MAPPING_ASSET.coingeckoCoinId}
        end`,
      })
      .from(schema.providerTransfers)
      .innerJoin(schema.sources, eq(schema.sources.id, schema.providerTransfers.sourceId))
      .leftJoin(
        schema.providerAssets,
        eq(schema.providerAssets.id, schema.providerTransfers.providerAssetId)
      )
      .leftJoin(
        schema.providerAssetMappings,
        eq(schema.providerAssetMappings.providerAssetRowId, schema.providerAssets.id)
      )
      .leftJoin(
        schema.assetResolutionCurrentState,
        eq(schema.assetResolutionCurrentState.providerAssetRowId, schema.providerAssets.id)
      )
      .leftJoin(
        CURRENT_CONCLUSION,
        eq(CURRENT_CONCLUSION.id, schema.assetResolutionCurrentState.currentConclusionId)
      )
      .leftJoin(
        CURRENT_POLICY_EVALUATION,
        eq(
          CURRENT_POLICY_EVALUATION.id,
          schema.assetResolutionCurrentState.currentPolicyEvaluationId
        )
      )
      .leftJoin(MAPPING_ASSET, eq(MAPPING_ASSET.id, schema.providerAssetMappings.canonicalAssetId))
      .leftJoin(
        CURRENT_CONCLUSION_ASSET,
        eq(CURRENT_CONCLUSION_ASSET.id, CURRENT_CONCLUSION.assetId)
      )
      .where(
        and(
          eq(schema.sources.principalId, principalId),
          eq(schema.providerTransfers.observedBlockchainId, target.blockchainId),
          eq(schema.providerTransfers.observedRepresentationType, target.type),
          representationAddressCondition({
            chainType: target.chainType,
            contractAddress: target.contractAddress,
            contractColumn: schema.providerTransfers.observedContractAddress,
            mintAddress: target.mintAddress,
            mintColumn: schema.providerTransfers.observedMintAddress,
          })
        )
      )
      .pipe(wrapSqlError("principalAssetOverrideRepository.loadOwnedRepresentationObservations"))

  const loadRepresentationState = (
    target: CanonicalRepresentationTarget,
    principalId: string
  ): Effect.Effect<LoadedTargetState, import("../errors/RepositoryError.ts").PersistenceError> =>
    Effect.all({
      representation: loadGlobalRepresentation(target),
      observations: loadOwnedRepresentationObservations({ principalId, target }),
    }).pipe(
      Effect.map(({ observations, representation }) =>
        representationState({ target, representation, observations })
      )
    )

  const findStoredTargetId = ({
    principalId,
    target,
  }: {
    readonly principalId: string
    readonly target: CanonicalTarget
  }) => {
    const targetCondition =
      target._tag === "provider_asset"
        ? and(
            eq(schema.principalAssetOverrideTargets.targetKind, "provider_asset"),
            eq(schema.principalAssetOverrideTargets.providerAssetRowId, target.providerAssetRowId)
          )
        : and(
            eq(schema.principalAssetOverrideTargets.targetKind, "representation"),
            eq(schema.principalAssetOverrideTargets.blockchainId, target.blockchainId),
            eq(schema.principalAssetOverrideTargets.representationType, target.type),
            representationAddressCondition({
              chainType: target.chainType,
              contractAddress: target.contractAddress,
              contractColumn: schema.principalAssetOverrideTargets.contractAddress,
              mintAddress: target.mintAddress,
              mintColumn: schema.principalAssetOverrideTargets.mintAddress,
            })
          )

    return db
      .select({ id: schema.principalAssetOverrideTargets.id })
      .from(schema.principalAssetOverrideTargets)
      .where(
        and(eq(schema.principalAssetOverrideTargets.principalId, principalId), targetCondition)
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.id ?? null),
        wrapSqlError("principalAssetOverrideRepository.findStoredTargetId")
      )
  }

  const loadHistory = ({
    principalId,
    targetId,
  }: {
    readonly principalId: string
    readonly targetId: string | null
  }): Effect.Effect<
    ReadonlyArray<PrincipalAssetOverrideHistoryRecord>,
    import("../errors/RepositoryError.ts").PersistenceError
  > =>
    targetId === null
      ? Effect.succeed([])
      : db
          .select({
            id: schema.principalAssetOverrides.id,
            kind: schema.principalAssetOverrides.kind,
            operation: schema.principalAssetOverrides.operation,
            inspectedSystemRevision: schema.principalAssetOverrides.inspectedSystemRevision,
            inspectedSystemIdentity: schema.principalAssetOverrides.inspectedSystemIdentity,
            inspectedSystemAssetId: schema.principalAssetOverrides.inspectedSystemAssetId,
            inspectedSystemInclusion: schema.principalAssetOverrides.inspectedSystemInclusion,
            replacementAssetId: schema.principalAssetOverrides.replacementAssetId,
            replacementInclusion: schema.principalAssetOverrides.replacementInclusion,
            actorUserId: schema.principalAssetOverrides.actorUserId,
            reason: schema.principalAssetOverrides.reason,
            supersedesOverrideId: schema.principalAssetOverrides.supersedesOverrideId,
            recordedAt: schema.principalAssetOverrides.recordedAt,
          })
          .from(schema.principalAssetOverrides)
          .where(
            and(
              eq(schema.principalAssetOverrides.principalId, principalId),
              eq(schema.principalAssetOverrides.targetId, targetId)
            )
          )
          .orderBy(
            asc(schema.principalAssetOverrides.recordedAt),
            asc(schema.principalAssetOverrides.id)
          )
          .pipe(
            Effect.map((rows) =>
              rows.map(
                (row): PrincipalAssetOverrideHistoryRecord => ({
                  id: row.id,
                  kind: row.kind,
                  operation: row.operation,
                  inspectedSystemRevision: row.inspectedSystemRevision,
                  inspectedSystemIdentity:
                    row.inspectedSystemIdentity === "resolved" &&
                    row.inspectedSystemAssetId !== null
                      ? { _tag: "resolved", assetId: row.inspectedSystemAssetId }
                      : row.inspectedSystemIdentity === "unresolved"
                        ? { _tag: "unresolved" }
                        : null,
                  inspectedSystemInclusion: row.inspectedSystemInclusion,
                  replacementIdentity:
                    row.replacementAssetId === null
                      ? null
                      : { _tag: "resolved", assetId: row.replacementAssetId },
                  replacementInclusion: row.replacementInclusion,
                  actorUserId: row.actorUserId,
                  reason: row.reason,
                  supersedesOverrideId: row.supersedesOverrideId,
                  recordedAt: row.recordedAt,
                })
              )
            ),
            wrapSqlError("principalAssetOverrideRepository.loadHistory")
          )

  const activeOverride = ({
    history,
    kind,
  }: {
    readonly history: ReadonlyArray<PrincipalAssetOverrideHistoryRecord>
    readonly kind: "identity" | "inclusion"
  }): PrincipalAssetOverrideHistoryRecord | null => {
    const stream = history.filter((record) => record.kind === kind)
    const supersededIds = new Set(
      stream.flatMap((record) =>
        record.supersedesOverrideId === null ? [] : [record.supersedesOverrideId]
      )
    )
    const leaf = stream.find((record) => !supersededIds.has(record.id))
    return leaf === undefined || leaf.operation === "withdraw" ? null : leaf
  }

  const loadProjection = ({
    principalId,
    target,
    targetId,
  }: {
    readonly principalId: string
    readonly target: CanonicalTarget
    readonly targetId: string | null
  }) =>
    Effect.gen(function* () {
      const state =
        target._tag === "provider_asset"
          ? yield* loadProviderAssetState(target.providerAssetRowId)
          : yield* loadRepresentationState(target, principalId)
      if (state === null) return null

      const history = yield* loadHistory({ principalId, targetId })
      const activeIdentityOverride = activeOverride({ history, kind: "identity" })
      const activeInclusionOverride = activeOverride({ history, kind: "inclusion" })
      const effectiveDecision = decidePrincipalAssetOverride({
        systemIdentity: state.system.identity,
        systemInclusion: state.system.inclusion,
        identityReplacement: activeIdentityOverride?.replacementIdentity ?? null,
        inclusionReplacement: activeInclusionOverride?.replacementInclusion ?? null,
        technicalBlockers: state.technicalBlockers,
      })
      const projection: PrincipalAssetOverrideProjection = {
        target: canonicalTargetForProjection(target),
        system: state.system,
        activeIdentityOverride,
        activeInclusionOverride,
        effectiveDecision,
        checkedTechnicalBlockerKinds: state.checkedTechnicalBlockerKinds,
        technicalBlockers: state.technicalBlockers,
        identityOverrideUsesStaleSystemRevision:
          activeIdentityOverride !== null &&
          activeIdentityOverride.inspectedSystemRevision !== state.system.identityRevision,
        inclusionOverrideUsesStaleSystemRevision:
          activeInclusionOverride !== null &&
          activeInclusionOverride.inspectedSystemRevision !== state.system.inclusionRevision,
        history,
      }

      return { projection, state }
    })

  const findOwnedProjection = ({
    principalId,
    target,
  }: {
    readonly principalId: string
    readonly target: PrincipalAssetOverrideTarget
  }) =>
    Effect.gen(function* () {
      const canonicalTarget = yield* canonicalizeTarget(target)
      const targetId = yield* findStoredTargetId({ principalId, target: canonicalTarget })
      const authorized =
        targetId !== null || (yield* principalOwnsTarget({ principalId, target: canonicalTarget }))
      if (!authorized) {
        return Option.none<{
          readonly projection: PrincipalAssetOverrideProjection
          readonly state: LoadedTargetState
        }>()
      }
      const loaded = yield* loadProjection({ principalId, target: canonicalTarget, targetId })
      return loaded === null ? Option.none() : Option.some(loaded)
    })

  const findProjection: PrincipalAssetOverrideRepositoryShape["findProjection"] = (params) =>
    findOwnedProjection(params).pipe(Effect.map(Option.map(({ projection }) => projection)))

  const validateIdentityReplacement: PrincipalAssetOverrideRepositoryShape["validateIdentityReplacement"] =
    ({ assetId, principalId, target }) =>
      Effect.gen(function* () {
        const owned = yield* findOwnedProjection({ principalId, target })
        if (Option.isNone(owned)) return Option.none()

        const [assetRow] = yield* db
          .select({
            id: schema.assets.id,
            type: schema.assets.type,
            name: schema.assets.name,
            symbol: schema.assets.symbol,
            coingeckoCoinId: schema.assets.coingeckoCoinId,
          })
          .from(schema.assets)
          .where(eq(schema.assets.id, assetId))
          .limit(1)
          .pipe(wrapSqlError("principalAssetOverrideRepository.validateIdentityReplacement.asset"))
        if (assetRow === undefined) {
          return Option.some({
            _tag: "asset_not_found" as const,
            assetId,
            checkedTechnicalBlockerKinds: owned.value.state.checkedTechnicalBlockerKinds,
            technicalBlockers: owned.value.state.technicalBlockers,
          })
        }

        const asset = selectedAsset(assetRow)
        const { projection, state } = owned.value
        if (state.targetAssetType !== null && state.targetAssetType !== asset.type) {
          return Option.some({
            _tag: "incompatible_asset_type" as const,
            asset,
            targetAssetType: state.targetAssetType,
            checkedTechnicalBlockerKinds: state.checkedTechnicalBlockerKinds,
            technicalBlockers: state.technicalBlockers,
          })
        }

        return Option.some({
          _tag: "ready" as const,
          asset,
          projection,
          checkedTechnicalBlockerKinds: state.checkedTechnicalBlockerKinds,
          technicalBlockers: state.technicalBlockers,
          warnings: makeWarnings({
            asset,
            confidenceWarnings: state.confidenceWarnings,
            evidence: state.evidence,
            systemIdentity: state.system.identity,
          }),
        })
      })

  return PrincipalAssetOverrideRepository.of({
    findProjection,
    validateIdentityReplacement,
  } satisfies PrincipalAssetOverrideRepositoryShape)
})

/** Live layer for principal-scoped asset override reads and validation. */
export const PrincipalAssetOverrideRepositoryLive = Layer.effect(
  PrincipalAssetOverrideRepository,
  make
)
