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
import type { AuthUserId } from "@my/core/authentication"
import type { PrincipalId } from "@my/core/ownership"
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { databaseErrorMetadata } from "../errors/DatabaseErrorMetadata.ts"
import { isPersistenceError, PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  PrincipalAssetOverrideInvalidTargetError,
  PrincipalAssetOverrideConflictError,
  PrincipalAssetOverrideReplacementValidationError,
  PrincipalAssetOverrideRepository,
  type PrincipalAssetOverrideCalculationRun,
  type PrincipalAssetOverrideHistoryRecord,
  type PrincipalAssetOverrideProjection,
  type PrincipalAssetOverrideRecomputation,
  type PrincipalAssetOverrideReplayJob,
  type PrincipalAssetOverrideRepositoryShape,
  type PrincipalAssetOverrideSelectedAsset,
  type PrincipalAssetOverrideSystemState,
  type PrincipalAssetOverrideValidationWarning,
} from "../services/PrincipalAssetOverrideRepository.ts"
import { drizzle } from "./PgClientLive.ts"
import { scheduleSourceReplays } from "./SourceReplayScheduling.ts"
import { nowDate } from "./SyncEngineRepositorySupport.ts"

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
const REQUESTED_REPLAY_JOB = alias(schema.processingJobs, "principal_override_requested_replay_job")
const FOLLOW_UP_REPLAY_JOB = alias(schema.processingJobs, "principal_override_follow_up_replay_job")
const CHECKED_TECHNICAL_BLOCKER_KINDS = [
  "malformed_movement",
  "missing_decimals",
  "unsupported_asset_type",
] as const satisfies ReadonlyArray<PrincipalAssetTechnicalBlocker>
const SUPERSEDES_UNIQUE_CONSTRAINT = "principal_asset_overrides_supersedes_unique"
const TARGET_UNIQUE_CONSTRAINTS = new Set([
  "principal_asset_override_targets_native_unique",
  "principal_asset_override_targets_contract_unique",
  "principal_asset_override_targets_mint_unique",
  "principal_asset_override_targets_provider_asset_unique",
])
const NO_ACTIVE_OVERRIDE_ID = ""

const isRetryableTransactionFailure = (cause: unknown): boolean => {
  const code = databaseErrorMetadata(cause)?.code
  return code === "40001" || code === "40P01"
}

const isSupersessionRace = (cause: unknown): boolean => {
  const metadata = databaseErrorMetadata(cause)
  return metadata?.code === "23505" && metadata.constraint === SUPERSEDES_UNIQUE_CONSTRAINT
}

const isTargetCreationRace = (cause: unknown): boolean => {
  const metadata = databaseErrorMetadata(cause)
  return (
    metadata?.code === "23505" &&
    metadata.constraint !== undefined &&
    TARGET_UNIQUE_CONSTRAINTS.has(metadata.constraint)
  )
}

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

const replayJobProjection = (row: {
  readonly overrideId: string
  readonly sourceId: string
  readonly requestedJobId: string | null
  readonly requestedStatus: (typeof schema.jobStatusEnum.enumValues)[number] | null
  readonly requestedCreditReasonCode: string | null
  readonly followUpJobId: string | null
  readonly followUpStatus: (typeof schema.jobStatusEnum.enumValues)[number] | null
  readonly followUpCreditReasonCode: string | null
}): PrincipalAssetOverrideReplayJob => {
  const jobId = row.followUpJobId ?? row.requestedJobId
  const status = row.followUpJobId === null ? row.requestedStatus : row.followUpStatus
  const creditReasonCode =
    row.followUpJobId === null ? row.requestedCreditReasonCode : row.followUpCreditReasonCode

  switch (status) {
    case "pending":
      return {
        overrideId: row.overrideId,
        sourceId: row.sourceId,
        requestedJobId: row.requestedJobId,
        jobId,
        status: "pending",
        failureCode: null,
      }
    case "processing":
      return {
        overrideId: row.overrideId,
        sourceId: row.sourceId,
        requestedJobId: row.requestedJobId,
        jobId,
        status: "running",
        failureCode: null,
      }
    case "completed":
      return {
        overrideId: row.overrideId,
        sourceId: row.sourceId,
        requestedJobId: row.requestedJobId,
        jobId,
        status: "complete",
        failureCode: null,
      }
    case "credit_required":
      return {
        overrideId: row.overrideId,
        sourceId: row.sourceId,
        requestedJobId: row.requestedJobId,
        jobId,
        status: "credit_required",
        failureCode: creditReasonCode ?? "source_replay_credit_required",
      }
    case "failed":
      return {
        overrideId: row.overrideId,
        sourceId: row.sourceId,
        requestedJobId: row.requestedJobId,
        jobId,
        status: "failed",
        failureCode: "source_replay_failed",
      }
    case null:
      return {
        overrideId: row.overrideId,
        sourceId: row.sourceId,
        requestedJobId: row.requestedJobId,
        jobId,
        status: "failed",
        failureCode: "source_replay_job_missing",
      }
  }
}

const calculationRunProjection = (row: {
  readonly runId: string
  readonly status: (typeof schema.calculationRunStatusEnum.enumValues)[number]
  readonly failureCode: string | null
}): PrincipalAssetOverrideCalculationRun | null => {
  switch (row.status) {
    case "running":
    case "complete":
    case "partial":
    case "failed":
      return { runId: row.runId, status: row.status, failureCode: row.failureCode }
    case "pending":
      return null
  }
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type PrincipalAssetOverrideExecutor = Pick<typeof db, "insert" | "select" | "selectDistinct">

  const canonicalizeTarget = (
    target: PrincipalAssetOverrideTarget,
    executor: PrincipalAssetOverrideExecutor = db
  ): Effect.Effect<
    CanonicalTarget,
    | PrincipalAssetOverrideInvalidTargetError
    | import("../errors/RepositoryError.ts").PersistenceError
  > =>
    Effect.gen(function* () {
      if (target._tag === "provider_asset") return target

      const blockchains = yield* executor
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
    executor = db,
    principalId,
    target,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly principalId: string
    readonly target: CanonicalTarget
  }) => {
    if (target._tag === "provider_asset") {
      return executor
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

    return executor
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
    providerAssetRowId: string,
    executor: PrincipalAssetOverrideExecutor = db
  ): Effect.Effect<
    LoadedTargetState | null,
    import("../errors/RepositoryError.ts").PersistenceError
  > =>
    executor
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

  const loadGlobalRepresentation = (
    target: CanonicalRepresentationTarget,
    executor: PrincipalAssetOverrideExecutor = db
  ) =>
    executor
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
    executor = db,
    principalId,
    target,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly principalId: string
    readonly target: CanonicalRepresentationTarget
  }) =>
    executor
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

  const loadRepresentationState = ({
    executor = db,
    principalId,
    target,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly principalId: string
    readonly target: CanonicalRepresentationTarget
  }): Effect.Effect<LoadedTargetState, import("../errors/RepositoryError.ts").PersistenceError> =>
    Effect.all({
      representation: loadGlobalRepresentation(target, executor),
      observations: loadOwnedRepresentationObservations({ executor, principalId, target }),
    }).pipe(
      Effect.map(({ observations, representation }) =>
        representationState({ target, representation, observations })
      )
    )

  const findStoredTargetId = ({
    executor = db,
    lock = false,
    principalId,
    target,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly lock?: boolean
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

    const query = executor
      .select({ id: schema.principalAssetOverrideTargets.id })
      .from(schema.principalAssetOverrideTargets)
      .where(
        and(eq(schema.principalAssetOverrideTargets.principalId, principalId), targetCondition)
      )
      .limit(1)

    return (lock ? query.for("update") : query).pipe(
      Effect.map((rows) => rows[0]?.id ?? null),
      wrapSqlError("principalAssetOverrideRepository.findStoredTargetId")
    )
  }

  const loadHistory = ({
    executor = db,
    principalId,
    targetId,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly principalId: string
    readonly targetId: string | null
  }): Effect.Effect<
    ReadonlyArray<PrincipalAssetOverrideHistoryRecord>,
    import("../errors/RepositoryError.ts").PersistenceError
  > =>
    targetId === null
      ? Effect.succeed([])
      : executor
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

  const overrideStreamLeaf = ({
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
    return stream.find((record) => !supersededIds.has(record.id)) ?? null
  }

  const loadCoveringCalculationRun = ({
    executor,
    overrideIds,
    principalId,
  }: {
    readonly executor: PrincipalAssetOverrideExecutor
    readonly overrideIds: ReadonlyArray<string>
    readonly principalId: string
  }): Effect.Effect<
    PrincipalAssetOverrideCalculationRun | null,
    import("../errors/RepositoryError.ts").PersistenceError
  > => {
    const runSnapshot = sql`replace(
      split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 3),
      '.',
      ':'
    )::pg_snapshot`

    return executor
      .select({
        runId: schema.calculationRuns.id,
        status: schema.calculationRuns.status,
        failureCode: schema.calculationRuns.failureCode,
      })
      .from(schema.calculationRuns)
      .where(
        and(
          eq(schema.calculationRuns.principalId, principalId),
          ne(schema.calculationRuns.status, "pending"),
          sql`split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 1) = 'v2'`,
          // A run covers the override only when its recorded snapshot can see
          // every selected history row. The override history is immutable, so
          // the row's insert transaction is the revision that matters.
          notExists(
            executor
              .select({ id: schema.principalAssetOverrides.id })
              .from(schema.principalAssetOverrides)
              .where(
                and(
                  inArray(schema.principalAssetOverrides.id, overrideIds),
                  sql`not pg_visible_in_snapshot(
                    ${schema.principalAssetOverrides}.xmin::text::xid8,
                    ${runSnapshot}
                  )`
                )
              )
          ),
          // Job status and follow-up changes create new row versions. The run
          // snapshot must see the current requested row and either its completed
          // state or the completed current row of its durable follow-up.
          notExists(
            executor
              .select({ overrideId: schema.principalAssetOverrideApplications.overrideId })
              .from(schema.principalAssetOverrideApplications)
              .leftJoin(
                REQUESTED_REPLAY_JOB,
                eq(
                  REQUESTED_REPLAY_JOB.id,
                  schema.principalAssetOverrideApplications.processingJobId
                )
              )
              .leftJoin(
                FOLLOW_UP_REPLAY_JOB,
                eq(FOLLOW_UP_REPLAY_JOB.id, REQUESTED_REPLAY_JOB.followUpJobId)
              )
              .where(
                and(
                  inArray(schema.principalAssetOverrideApplications.overrideId, overrideIds),
                  or(
                    isNull(REQUESTED_REPLAY_JOB.id),
                    sql`not pg_visible_in_snapshot(
                      ${REQUESTED_REPLAY_JOB}.xmin::text::xid8,
                      ${runSnapshot}
                    )`,
                    and(
                      isNull(REQUESTED_REPLAY_JOB.followUpJobId),
                      ne(REQUESTED_REPLAY_JOB.status, "completed")
                    ),
                    and(
                      isNotNull(REQUESTED_REPLAY_JOB.followUpJobId),
                      or(
                        isNull(FOLLOW_UP_REPLAY_JOB.id),
                        ne(FOLLOW_UP_REPLAY_JOB.status, "completed"),
                        sql`not pg_visible_in_snapshot(
                          ${FOLLOW_UP_REPLAY_JOB}.xmin::text::xid8,
                          ${runSnapshot}
                        )`
                      )
                    )
                  )
                )
              )
          )
        )
      )
      .orderBy(
        desc(
          sql<number>`split_part(${schema.calculationRuns.inputLedgerRevision}, ':', 2)::numeric`
        ),
        desc(schema.calculationRuns.id)
      )
      .limit(1)
      .pipe(
        Effect.map((rows) => {
          const row = rows[0]
          return row === undefined ? null : calculationRunProjection(row)
        }),
        wrapSqlError("principalAssetOverrideRepository.loadCoveringCalculationRun")
      )
  }

  const loadRecomputation = ({
    executor = db,
    history,
    overrideId,
    principalId,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly history: ReadonlyArray<PrincipalAssetOverrideHistoryRecord>
    /** Bind a mutation response to the record appended by that transaction. */
    readonly overrideId: string | undefined
    readonly principalId: string
  }): Effect.Effect<
    PrincipalAssetOverrideRecomputation,
    import("../errors/RepositoryError.ts").PersistenceError
  > => {
    // Mutation responses bind to the record they appended. Ordinary reads
    // expose work for both current stream leaves, without inventing a global
    // append order between independently mutable identity and inclusion.
    const selectedOverrideIds =
      overrideId === undefined
        ? (["identity", "inclusion"] as const).flatMap((kind) => {
            const leaf = overrideStreamLeaf({ history, kind })
            return leaf === null ? [] : [leaf.id]
          })
        : history.some((record) => record.id === overrideId)
          ? [overrideId]
          : []
    if (selectedOverrideIds.length === 0) {
      return Effect.succeed({ status: "not_scheduled" })
    }

    return Effect.gen(function* () {
      const rows = yield* executor
        .select({
          overrideId: schema.principalAssetOverrideApplications.overrideId,
          sourceId: schema.principalAssetOverrideApplications.sourceId,
          requestedJobId: REQUESTED_REPLAY_JOB.id,
          requestedStatus: REQUESTED_REPLAY_JOB.status,
          requestedCreditReasonCode: REQUESTED_REPLAY_JOB.creditReasonCode,
          followUpJobId: FOLLOW_UP_REPLAY_JOB.id,
          followUpStatus: FOLLOW_UP_REPLAY_JOB.status,
          followUpCreditReasonCode: FOLLOW_UP_REPLAY_JOB.creditReasonCode,
        })
        .from(schema.principalAssetOverrideApplications)
        .leftJoin(
          REQUESTED_REPLAY_JOB,
          eq(REQUESTED_REPLAY_JOB.id, schema.principalAssetOverrideApplications.processingJobId)
        )
        .leftJoin(
          FOLLOW_UP_REPLAY_JOB,
          eq(FOLLOW_UP_REPLAY_JOB.id, REQUESTED_REPLAY_JOB.followUpJobId)
        )
        .where(inArray(schema.principalAssetOverrideApplications.overrideId, selectedOverrideIds))
        .orderBy(
          asc(schema.principalAssetOverrideApplications.overrideId),
          asc(schema.principalAssetOverrideApplications.sourceId)
        )
        .pipe(wrapSqlError("principalAssetOverrideRepository.loadRecomputation.sourceJobs"))

      if (rows.length === 0) return { status: "not_scheduled" } as const

      const sourceJobs = rows.map(replayJobProjection)
      const overrideIds = [...new Set(sourceJobs.map(({ overrideId }) => overrideId))]
      if (sourceJobs.some(({ status }) => status === "failed" || status === "credit_required")) {
        return { status: "failed" as const, overrideIds, sourceJobs, calculationRun: null }
      }
      if (sourceJobs.some(({ status }) => status !== "complete")) {
        return { status: "updating" as const, overrideIds, sourceJobs, calculationRun: null }
      }

      const calculationRun = yield* loadCoveringCalculationRun({
        executor,
        overrideIds: selectedOverrideIds,
        principalId,
      })
      if (calculationRun === null) {
        return { status: "updating" as const, overrideIds, sourceJobs, calculationRun }
      }

      return {
        status: calculationRun.status === "running" ? ("updating" as const) : calculationRun.status,
        overrideIds,
        sourceJobs,
        calculationRun,
      }
    })
  }

  const activeOverride = ({
    history,
    kind,
  }: {
    readonly history: ReadonlyArray<PrincipalAssetOverrideHistoryRecord>
    readonly kind: "identity" | "inclusion"
  }): PrincipalAssetOverrideHistoryRecord | null => {
    const leaf = overrideStreamLeaf({ history, kind })
    return leaf === null || leaf.operation === "withdraw" ? null : leaf
  }

  const loadProjection = ({
    executor = db,
    principalId,
    recomputationOverrideId,
    target,
    targetId,
  }: {
    readonly executor?: PrincipalAssetOverrideExecutor
    readonly principalId: string
    readonly recomputationOverrideId?: string
    readonly target: CanonicalTarget
    readonly targetId: string | null
  }) =>
    Effect.gen(function* () {
      const state =
        target._tag === "provider_asset"
          ? yield* loadProviderAssetState(target.providerAssetRowId, executor)
          : yield* loadRepresentationState({ executor, principalId, target })
      if (state === null) return null

      const history = yield* loadHistory({ executor, principalId, targetId })
      const recomputation = yield* loadRecomputation({
        executor,
        history,
        overrideId: recomputationOverrideId,
        principalId,
      })
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
        recomputation,
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

  const loadSelectedAsset = (assetId: string, executor: PrincipalAssetOverrideExecutor = db) =>
    executor
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
      .pipe(
        Effect.map((rows) => rows[0]),
        wrapSqlError("principalAssetOverrideRepository.loadSelectedAsset")
      )

  const validateIdentityReplacement: PrincipalAssetOverrideRepositoryShape["validateIdentityReplacement"] =
    ({ assetId, principalId, target }) =>
      Effect.gen(function* () {
        const owned = yield* findOwnedProjection({ principalId, target })
        if (Option.isNone(owned)) return Option.none()

        const assetRow = yield* loadSelectedAsset(assetId)
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

  type MutationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

  const loadAffectedSources = ({
    principalId,
    target,
    tx,
  }: {
    readonly principalId: string
    readonly target: CanonicalTarget
    readonly tx: MutationTransaction
  }) => {
    if (target._tag === "provider_asset") {
      return tx
        .selectDistinct({
          sourceId: schema.providerAssetTransactionUses.sourceId,
          principalId: schema.sources.principalId,
        })
        .from(schema.providerAssetTransactionUses)
        .innerJoin(
          schema.sources,
          eq(schema.sources.id, schema.providerAssetTransactionUses.sourceId)
        )
        .where(
          and(
            eq(schema.sources.principalId, principalId),
            eq(schema.providerAssetTransactionUses.providerAssetRowId, target.providerAssetRowId),
            sql<boolean>`not exists (
              select 1
              from ${schema.providerTransfers} exact_transfer
              where exact_transfer.transaction_id = ${schema.providerAssetTransactionUses.transactionId}
                and exact_transfer.observed_blockchain_id is not null
            )`
          )
        )
        .orderBy(asc(schema.providerAssetTransactionUses.sourceId))
        .pipe(wrapSqlError("principalAssetOverrideRepository.loadAffectedSources.providerAsset"))
    }

    return tx
      .selectDistinct({
        sourceId: schema.sourceRepresentationUses.sourceId,
        principalId: schema.sources.principalId,
      })
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
      .orderBy(asc(schema.sourceRepresentationUses.sourceId))
      .pipe(wrapSqlError("principalAssetOverrideRepository.loadAffectedSources.representation"))
  }

  const insertTarget = ({
    principalId,
    target,
    tx,
  }: {
    readonly principalId: string
    readonly target: CanonicalTarget
    readonly tx: MutationTransaction
  }) =>
    tx
      .insert(schema.principalAssetOverrideTargets)
      .values(
        target._tag === "provider_asset"
          ? {
              principalId,
              targetKind: "provider_asset" as const,
              blockchainId: null,
              representationType: null,
              contractAddress: null,
              mintAddress: null,
              providerAssetRowId: target.providerAssetRowId,
            }
          : {
              principalId,
              targetKind: "representation" as const,
              blockchainId: target.blockchainId,
              representationType: target.type,
              contractAddress: target.contractAddress,
              mintAddress: target.mintAddress,
              providerAssetRowId: null,
            }
      )
      .returning({ id: schema.principalAssetOverrideTargets.id })
      .pipe(
        Effect.flatMap(([stored]) =>
          stored === undefined
            ? Effect.fail(
                new PersistenceError({
                  operation: "principalAssetOverrideRepository.insertTarget",
                  cause: "The override target insert returned no row.",
                })
              )
            : Effect.succeed(stored.id)
        ),
        wrapSqlError("principalAssetOverrideRepository.insertTarget")
      )

  const scheduleOverrideApplication = ({
    overrideId,
    principalId,
    sources,
    tx,
  }: {
    readonly overrideId: string
    readonly principalId: string
    readonly sources: ReadonlyArray<{ readonly sourceId: string; readonly principalId: string }>
    readonly tx: MutationTransaction
  }) =>
    Effect.gen(function* () {
      const now = nowDate()
      const replays = yield* scheduleSourceReplays({
        tx,
        sources,
        now,
        progressDetails: {
          mode: "replay",
          reason: "principal_asset_override",
          overrideId,
        },
        errorOperation: (step) =>
          `principalAssetOverrideRepository.scheduleOverrideApplication.${step}`,
        pendingReplayPolicy: "reuse",
      })

      if (replays.length === 0) {
        return yield* new PersistenceError({
          operation: "principalAssetOverrideRepository.scheduleOverrideApplication",
          cause: { principalId, overrideId, message: "No matching source replay was selected." },
        })
      }

      yield* tx
        .insert(schema.principalAssetOverrideApplications)
        .values(
          replays.map(({ processingJobId, sourceId }) => ({
            overrideId,
            sourceId,
            processingJobId,
            createdAt: now,
          }))
        )
        .pipe(
          Effect.asVoid,
          wrapSqlError("principalAssetOverrideRepository.scheduleOverrideApplication.link")
        )
    })

  const mutationConflict = ({
    expectedActiveOverrideId,
    expectedSystemRevision,
    kind,
    projection,
  }: {
    readonly expectedActiveOverrideId: string
    readonly expectedSystemRevision: string
    readonly kind: "identity" | "inclusion"
    readonly projection: PrincipalAssetOverrideProjection
  }): PrincipalAssetOverrideConflictError | null => {
    const activeOverride =
      kind === "identity" ? projection.activeIdentityOverride : projection.activeInclusionOverride
    const currentSystemRevision =
      kind === "identity" ? projection.system.identityRevision : projection.system.inclusionRevision
    const currentActiveOverrideId = activeOverride?.id ?? NO_ACTIVE_OVERRIDE_ID
    const conflictKinds = [
      ...(currentActiveOverrideId === expectedActiveOverrideId
        ? []
        : (["active_override"] as const)),
      ...(currentSystemRevision === expectedSystemRevision ? [] : (["system_revision"] as const)),
    ]

    return conflictKinds.length === 0
      ? null
      : new PrincipalAssetOverrideConflictError({
          conflictKinds,
          currentProjection: projection,
          currentActiveOverrideId: activeOverride?.id ?? null,
          currentSystemRevision,
          expectedActiveOverrideId,
          expectedSystemRevision,
        })
  }

  type MutationReplacement =
    | { readonly _tag: "identity"; readonly assetId: string }
    | { readonly _tag: "inclusion"; readonly inclusion: "included" | "excluded" }
    | { readonly _tag: "withdraw_identity" }
    | { readonly _tag: "withdraw_inclusion" }
  interface MutationRequest {
    readonly actorUserId: AuthUserId
    readonly expectedActiveOverrideId: string
    readonly expectedSystemRevision: string
    readonly operation: "create" | "replace" | "withdraw"
    readonly principalId: PrincipalId
    readonly reason: string
    readonly replacement: MutationReplacement
    readonly target: PrincipalAssetOverrideTarget
  }

  const mutationKind = (replacement: MutationReplacement): "identity" | "inclusion" =>
    replacement._tag === "identity" || replacement._tag === "withdraw_identity"
      ? "identity"
      : "inclusion"

  const runMutationTransaction = ({
    request,
    tx,
  }: {
    readonly request: MutationRequest
    readonly tx: MutationTransaction
  }) =>
    Effect.gen(function* () {
      const canonicalTarget = yield* canonicalizeTarget(request.target, tx)
      yield* tx
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(eq(schema.principals.id, request.principalId))
        .for("update")
        .pipe(wrapSqlError("principalAssetOverrideRepository.mutate.lockPrincipal"))

      let targetId = yield* findStoredTargetId({
        executor: tx,
        lock: true,
        principalId: request.principalId,
        target: canonicalTarget,
      })
      if (targetId === null && request.operation !== "create") {
        return Option.none<PrincipalAssetOverrideProjection>()
      }
      if (
        targetId === null &&
        !(yield* principalOwnsTarget({
          executor: tx,
          principalId: request.principalId,
          target: canonicalTarget,
        }))
      ) {
        return Option.none<PrincipalAssetOverrideProjection>()
      }

      const loaded = yield* loadProjection({
        executor: tx,
        principalId: request.principalId,
        target: canonicalTarget,
        targetId,
      })
      if (loaded === null) return Option.none<PrincipalAssetOverrideProjection>()

      const kind = mutationKind(request.replacement)
      const conflict = mutationConflict({
        expectedActiveOverrideId: request.expectedActiveOverrideId,
        expectedSystemRevision: request.expectedSystemRevision,
        kind,
        projection: loaded.projection,
      })
      if (conflict !== null) return yield* conflict

      if (request.replacement._tag === "identity") {
        const assetRow = yield* loadSelectedAsset(request.replacement.assetId, tx)
        if (assetRow === undefined) {
          return yield* new PrincipalAssetOverrideReplacementValidationError({
            validation: {
              _tag: "asset_not_found",
              assetId: request.replacement.assetId,
              checkedTechnicalBlockerKinds: loaded.state.checkedTechnicalBlockerKinds,
              technicalBlockers: loaded.state.technicalBlockers,
            },
            currentProjection: loaded.projection,
          })
        }
        const asset = selectedAsset(assetRow)
        if (loaded.state.targetAssetType !== null && loaded.state.targetAssetType !== asset.type) {
          return yield* new PrincipalAssetOverrideReplacementValidationError({
            validation: {
              _tag: "incompatible_asset_type",
              asset,
              targetAssetType: loaded.state.targetAssetType,
              checkedTechnicalBlockerKinds: loaded.state.checkedTechnicalBlockerKinds,
              technicalBlockers: loaded.state.technicalBlockers,
            },
            currentProjection: loaded.projection,
          })
        }
      }

      const affectedSources = yield* loadAffectedSources({
        principalId: request.principalId,
        target: canonicalTarget,
        tx,
      })
      if (affectedSources.length === 0 && targetId === null) {
        return Option.none<PrincipalAssetOverrideProjection>()
      }

      if (targetId === null) {
        targetId = yield* insertTarget({
          principalId: request.principalId,
          target: canonicalTarget,
          tx,
        })
      }

      const inspectedIdentity = loaded.projection.system.identity
      const currentSystemRevision =
        kind === "identity"
          ? loaded.projection.system.identityRevision
          : loaded.projection.system.inclusionRevision
      const [override] = yield* tx
        .insert(schema.principalAssetOverrides)
        .values({
          principalId: request.principalId,
          targetId,
          kind,
          operation: request.operation,
          inspectedSystemRevision: currentSystemRevision,
          inspectedSystemIdentity: kind === "identity" ? inspectedIdentity._tag : null,
          inspectedSystemAssetId:
            kind === "identity" && inspectedIdentity._tag === "resolved"
              ? inspectedIdentity.assetId
              : null,
          inspectedSystemInclusion:
            kind === "inclusion" ? loaded.projection.system.inclusion : null,
          replacementAssetId:
            request.replacement._tag === "identity" ? request.replacement.assetId : null,
          replacementInclusion:
            request.replacement._tag === "inclusion" ? request.replacement.inclusion : null,
          actorUserId: request.actorUserId,
          reason: request.reason,
          supersedesOverrideId:
            request.operation === "create"
              ? (overrideStreamLeaf({ history: loaded.projection.history, kind })?.id ?? null)
              : request.expectedActiveOverrideId,
        })
        .returning({ id: schema.principalAssetOverrides.id })
        .pipe(wrapSqlError("principalAssetOverrideRepository.mutate.insert"))
      if (override === undefined) {
        return yield* new PersistenceError({
          operation: "principalAssetOverrideRepository.mutate.insert",
          cause: "The override insert returned no row.",
        })
      }

      if (affectedSources.length > 0) {
        yield* scheduleOverrideApplication({
          overrideId: override.id,
          principalId: request.principalId,
          sources: affectedSources,
          tx,
        })
      }

      const updated = yield* loadProjection({
        executor: tx,
        principalId: request.principalId,
        recomputationOverrideId: override.id,
        target: canonicalTarget,
        targetId,
      })
      if (updated === null) {
        return yield* new PersistenceError({
          operation: "principalAssetOverrideRepository.mutate.reload",
          cause: "The target stopped producing a projection inside the mutation transaction.",
        })
      }
      return Option.some(updated.projection)
    })

  const recoverSupersessionRace = (request: MutationRequest) =>
    findOwnedProjection({ principalId: request.principalId, target: request.target }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PersistenceError({
                operation: "principalAssetOverrideRepository.mutate.race",
                cause: "The raced target no longer has a projection.",
              })
            ),
          onSome: ({ projection }) =>
            Effect.fail(
              mutationConflict({
                expectedActiveOverrideId: request.expectedActiveOverrideId,
                expectedSystemRevision: request.expectedSystemRevision,
                kind: mutationKind(request.replacement),
                projection,
              }) ??
                new PersistenceError({
                  operation: "principalAssetOverrideRepository.mutate.race",
                  cause: "A supersession conflict occurred without a changed CAS value.",
                })
            ),
        })
      )
    )

  const mutate = (request: MutationRequest) =>
    db
      .transaction((tx) => runMutationTransaction({ request, tx }), {
        isolationLevel: "serializable",
      })
      .pipe(
        Effect.retry({
          times: 2,
          while: (cause) => isRetryableTransactionFailure(cause) || isTargetCreationRace(cause),
        }),
        Effect.catchIf(isSupersessionRace, () => recoverSupersessionRace(request)),
        Effect.mapError((cause) =>
          Schema.is(PrincipalAssetOverrideInvalidTargetError)(cause) ||
          cause instanceof PrincipalAssetOverrideConflictError ||
          cause instanceof PrincipalAssetOverrideReplacementValidationError ||
          isPersistenceError(cause)
            ? cause
            : new PersistenceError({
                operation: "principalAssetOverrideRepository.mutate.transaction",
                cause,
              })
        )
      )

  const create: PrincipalAssetOverrideRepositoryShape["create"] = (params) =>
    mutate({
      ...params,
      expectedActiveOverrideId: NO_ACTIVE_OVERRIDE_ID,
      operation: "create",
    })

  const replace: PrincipalAssetOverrideRepositoryShape["replace"] = (params) =>
    mutate({ ...params, operation: "replace" })

  const withdraw: PrincipalAssetOverrideRepositoryShape["withdraw"] = ({ kind, ...params }) =>
    mutate({
      ...params,
      operation: "withdraw",
      replacement:
        kind === "identity" ? { _tag: "withdraw_identity" } : { _tag: "withdraw_inclusion" },
    })

  return PrincipalAssetOverrideRepository.of({
    create,
    findProjection,
    replace,
    validateIdentityReplacement,
    withdraw,
  } satisfies PrincipalAssetOverrideRepositoryShape)
})

/** Live layer for principal-scoped asset override reads and validation. */
export const PrincipalAssetOverrideRepositoryLive = Layer.effect(
  PrincipalAssetOverrideRepository,
  make
)
