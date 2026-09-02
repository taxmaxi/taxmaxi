/**
 * AssetExceptionRepositoryLive - Ranked asset exceptions and atomic human decisions.
 *
 * @module AssetExceptionRepositoryLive
 */

import {
  assetExceptionSeverityForReason,
  canonicalizeDisplayText,
  AssetExceptionClaim,
  AssetExceptionReason,
  NO_CURRENT_ASSET_CONCLUSION,
  NO_CURRENT_ASSET_POLICY_EVALUATION,
  type AssetExceptionSeverity,
} from "@my/core/assets"
import {
  AssetExceptionRepository,
  type AssetExceptionDecisionHistory,
  type AssetExceptionDecisionInput,
  type AssetExceptionDecisionPreview,
  type AssetExceptionDecisionResult,
  type AssetExceptionDetail,
  type AssetExceptionImpact,
  type AssetExceptionLookup,
  type AssetExceptionObservationRevision,
  type AssetExceptionRankCursor,
  type AssetExceptionRematerializationSummary,
  type AssetExceptionRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQLWrapper } from "drizzle-orm"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { drizzle } from "./PgClientLive.ts"
import { nowDate } from "./SyncEngineRepositorySupport.ts"
import { getAssetCatalogSearchPatterns } from "../query/AssetCatalogSearch.ts"
import { schema } from "../schema/index.ts"

const ACTIONABLE_REASONS = [
  "ownership_conflict",
  "conflicting_evidence",
  "incompatible_decimals",
  "incompatible_type",
  "display_collision",
  "non_exact_platform_match",
  "spam_evidence",
  "unsupported_representation_type",
  "unverified_asset",
] as const

const HUMAN_POLICY_REVISION = "2026-08-21.human-asset-exception.1"

class StaleAssetDecisionTransaction extends Data.TaggedError("StaleAssetDecisionTransaction")<{
  readonly providerAssetRowId: string
}> {}

const severityRank = (severity: AssetExceptionSeverity): number => {
  switch (severity) {
    case "critical":
      return 0
    case "high":
      return 1
    case "medium":
      return 2
    case "low":
      return 3
  }
}

const toStorageError = (operation: string, cause: unknown) =>
  new SyncEngineStorageError({ operation, cause })

const toObservationRevision = (
  detail: AssetExceptionDetail
): AssetExceptionObservationRevision => ({
  providerAssetRowId: detail.providerAssetRowId,
  evidenceRevision: detail.evidenceRevision,
  currentConclusionRevision: detail.currentConclusionRevision,
  currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
})

const observationRevisionsMatch = ({
  actual,
  expected,
}: {
  readonly actual: ReadonlyArray<AssetExceptionObservationRevision>
  readonly expected: ReadonlyArray<AssetExceptionObservationRevision>
}) =>
  actual.length === expected.length &&
  actual.every((revision, index) => {
    const expectedRevision = expected[index]
    return (
      expectedRevision !== undefined &&
      revision.providerAssetRowId === expectedRevision.providerAssetRowId &&
      revision.evidenceRevision === expectedRevision.evidenceRevision &&
      revision.currentConclusionRevision === expectedRevision.currentConclusionRevision &&
      revision.currentPolicyEvaluationRevision === expectedRevision.currentPolicyEvaluationRevision
    )
  })

type InputValidationResult =
  | { readonly _tag: "valid" }
  | { readonly _tag: "invalid_evidence" }
  | {
      readonly _tag: "stale_revision"
      readonly evidenceRevision: number
      readonly currentConclusionRevision: string
      readonly currentPolicyEvaluationRevision: string
    }

type IdentityResolution =
  | { readonly _tag: "ambiguous_identity" }
  | { readonly _tag: "invalid_claim" }
  | {
      readonly _tag: "resolved"
      readonly assetId: string | null
      readonly assetOutcome: "reuse" | "create"
      readonly representationId: string | null
      readonly representationOutcome: "none" | "reuse" | "create" | "reassign"
      readonly blockchainId: string | null
    }

type IdentityClaim = Extract<AssetExceptionDecisionInput["claim"], { readonly _tag: "identity" }>

type PreparedIdentityClaim = {
  readonly _tag: "prepared"
  readonly claim: IdentityClaim
  readonly blockchainId: string | null
  readonly isEvm: boolean
}

type PrepareIdentityClaimResult = { readonly _tag: "invalid_claim" } | PreparedIdentityClaim

type SubmitTransactionResult =
  | Exclude<AssetExceptionDecisionResult, { readonly _tag: "accepted" }>
  | { readonly _tag: "accepted_pending_detail" }
  | { readonly _tag: "stale_after_cas"; readonly providerAssetRowId: string }

type LoadedDecisionHistory = Omit<
  AssetExceptionDecisionHistory,
  "isCurrentConclusion" | "isCurrentPolicyEvaluation"
>

const isRepresentationCompatibleWithAssetType = ({
  assetType,
  representationType,
}: {
  readonly assetType: "fungible" | "nft"
  readonly representationType: "native" | "token" | "nft"
}): boolean => (assetType === "nft" ? representationType === "nft" : representationType !== "nft")

const isClaimCompatibleWithHeliusObservation = ({
  detail,
  claim,
}: {
  readonly detail: AssetExceptionDetail
  readonly claim: Extract<AssetExceptionDecisionInput["claim"], { readonly _tag: "identity" }>
}): boolean => {
  if (detail.provider !== "helius-solana") {
    return true
  }

  const representation = claim.representation
  const providerType = detail.providerType?.trim().toLowerCase() ?? null
  const expectedType =
    providerType === "native"
      ? "native"
      : providerType === "nft"
        ? "nft"
        : providerType === "spl-token" || providerType === "spl-token-2022"
          ? "token"
          : null

  if (representation === null || expectedType === null || detail.exponent === null) {
    return false
  }

  return (
    representation.blockchain.toLowerCase() === "solana" &&
    representation.type === expectedType &&
    representation.decimals === detail.exponent &&
    (expectedType === "native"
      ? representation.contractAddress === null && representation.mintAddress === null
      : representation.contractAddress === null &&
        representation.mintAddress === detail.providerAssetId)
  )
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  type DbTransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0]
  type QueryClient = typeof db | DbTransactionClient

  const isClaimCompatibleWithObservedRepresentation = ({
    client,
    detail,
    claim,
  }: {
    readonly client: QueryClient
    readonly detail: AssetExceptionDetail
    readonly claim: Extract<AssetExceptionDecisionInput["claim"], { readonly _tag: "identity" }>
  }): Effect.Effect<boolean, unknown, never> =>
    Effect.gen(function* () {
      if (!isClaimCompatibleWithHeliusObservation({ detail, claim })) {
        return false
      }

      const observations = yield* client
        .select({
          blockchain: schema.blockchains.name,
          type: schema.providerTransfers.observedRepresentationType,
          contractAddress: schema.providerTransfers.observedContractAddress,
          mintAddress: schema.providerTransfers.observedMintAddress,
          decimals: schema.providerTransfers.observedDecimals,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.blockchains,
          eq(schema.blockchains.id, schema.providerTransfers.observedBlockchainId)
        )
        .where(eq(schema.providerTransfers.providerAssetId, detail.providerAssetRowId))

      const representation = claim.representation
      if (representation === null) {
        if (detail.provider !== "coinbase") {
          return true
        }
        // A stored chain observation contradicts a chainless claim: replay
        // re-validates every observed row against the approved mapping, and
        // a mapping without a representation cannot satisfy any of them.
        if (observations.length > 0) {
          return false
        }

        const claimedAssetType =
          claim.newAsset?.type ??
          (claim.assetId === null
            ? null
            : ((yield* client
                .select({ type: schema.assets.type })
                .from(schema.assets)
                .where(eq(schema.assets.id, claim.assetId))
                .limit(1))[0]?.type ?? null))
        return (
          detail.providerType?.trim().toLowerCase() === "crypto" && claimedAssetType === "fungible"
        )
      }

      // Replay re-validates each stored row's observed values against the
      // approved mapping and fails on any non-null mismatch, so every stored
      // observation must be compatible with the claim; a partial match would
      // guarantee a failed rebuild. The latest Helius provider metadata is
      // overwritten on every sync, so it alone cannot vouch for older stored
      // rows either.
      const compatible = observations.every(
        (observation) =>
          observation.blockchain.toLowerCase() === representation.blockchain.toLowerCase() &&
          (observation.type === null || observation.type === representation.type) &&
          (observation.contractAddress === null ||
            observation.contractAddress.trim().toLowerCase() ===
              representation.contractAddress?.trim().toLowerCase()) &&
          (observation.mintAddress === null ||
            observation.mintAddress === representation.mintAddress) &&
          (observation.decimals === null || observation.decimals === representation.decimals)
      )
      if (detail.provider === "helius-solana") {
        return compatible
      }
      // A chainless observation history cannot vouch for an on-chain
      // representation claim.
      return observations.length > 0 && compatible
    })

  const affectedSourcesSql = sql<number>`(
    select count(distinct affected_sources.source_id)::int
    from (
      select ${schema.providerAssetSourceUses.sourceId} as source_id
      from ${schema.providerAssetSourceUses}
      where ${schema.providerAssetSourceUses.providerAssetRowId} = ${schema.providerAssets.id}
      union
      select ${schema.providerTransfers.sourceId} as source_id
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
    ) affected_sources
  )`

  const isCalculationBlockingSql = ({
    providerAssetRowId,
    sourceId,
  }: {
    readonly providerAssetRowId: SQLWrapper
    readonly sourceId: SQLWrapper
  }) => sql`(
    not exists (
      select 1
      from ${schema.providerAssetMappings} mapping
      where mapping.provider_asset_row_id = ${providerAssetRowId}
        and mapping.mapping_status in ('approved', 'excluded')
    )
    or exists (
      select 1
      from ${schema.assetDecisionRematerializations} rematerialization
      inner join ${schema.assetResolutionDecisions} decision
        on decision.id = rematerialization.decision_id
      inner join ${schema.assetResolutionCurrentState} current_state
        on current_state.provider_asset_row_id = decision.provider_asset_row_id
       and (
         current_state.current_conclusion_id = decision.id
         or (
           current_state.current_conclusion_id is null
           and decision.human_claim is null
           and decision.outcome in ('pending', 'fail_closed')
         )
       )
      where rematerialization.source_id = ${sourceId}
        and decision.provider_asset_row_id = ${providerAssetRowId}
        and rematerialization.status <> 'complete'
    )
  )`

  const blockedReportsSql = sql<number>`(
    select count(distinct affected_sources.source_id)::int
    from (
      select ${schema.providerAssetSourceUses.sourceId} as source_id
      from ${schema.providerAssetSourceUses}
      where ${schema.providerAssetSourceUses.providerAssetRowId} = ${schema.providerAssets.id}
      union
      select ${schema.providerTransfers.sourceId} as source_id
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
    ) affected_sources
    where ${isCalculationBlockingSql({
      providerAssetRowId: schema.providerAssets.id,
      sourceId: sql`affected_sources.source_id`,
    })}
  )`

  const affectedPrincipalsSql = sql<number>`(
    select count(distinct ${schema.sources.principalId})::int
    from ${schema.sources}
    where ${schema.sources.id} in (
      select ${schema.providerAssetSourceUses.sourceId}
      from ${schema.providerAssetSourceUses}
      where ${schema.providerAssetSourceUses.providerAssetRowId} = ${schema.providerAssets.id}
      union
      select ${schema.providerTransfers.sourceId}
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
    )
  )`

  const affectedTransactionsSql = sql<number>`(
    select count(distinct affected_transaction_ids.transaction_id)::int
    from (
      select ${schema.providerTransfers.transactionId} as transaction_id
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
      union
      select ${schema.providerAssetTransactionUses.transactionId} as transaction_id
      from ${schema.providerAssetTransactionUses}
      where ${schema.providerAssetTransactionUses.providerAssetRowId} = ${schema.providerAssets.id}
    ) affected_transaction_ids
  )`

  const affectedValueEurSql = sql<string | null>`(
    select sum(abs(${schema.transactions.providerFiatAmount}))::text
    from (
      select ${schema.providerTransfers.transactionId} as transaction_id
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
      union
      select ${schema.providerAssetTransactionUses.transactionId} as transaction_id
      from ${schema.providerAssetTransactionUses}
      where ${schema.providerAssetTransactionUses.providerAssetRowId} = ${schema.providerAssets.id}
    ) affected_transaction_ids
    inner join ${schema.transactions}
      on ${schema.transactions.id} = affected_transaction_ids.transaction_id
    where ${schema.transactions.providerFiatCurrency} = 'EUR'
  )`

  // The queue reason for a pending or fail-closed evaluation is the policy
  // reason itself. A conclusive evaluation only enters the queue when it
  // disagrees with the current conclusion, and its policy decision carries no
  // actionable reason, so the queue synthesizes one.
  const queueReasonSql = sql<string>`case
    when ${schema.assetResolutionDecisions.outcome} in ('pending', 'fail_closed')
      then ${schema.assetResolutionDecisions.reason}
    else 'conclusion_disagreement'
  end`

  // The reasons are compile-time literals, so raw interpolation is safe and
  // the ranking numbers stay single-sourced in the core severity mapping.
  const severityRankCases = sql.raw(
    [...ACTIONABLE_REASONS, "conclusion_disagreement" as const]
      .map(
        (reason) => `when '${reason}' then ${severityRank(assetExceptionSeverityForReason(reason))}`
      )
      .join(" ")
  )
  const severityRankSql = sql<number>`case ${queueReasonSql} ${severityRankCases} else 4 end`

  // "Oldest case first" ranks by the age of the current actionable
  // evaluation, not the provider observation: a later actionable evidence
  // revision creates a new case with a fresh age.
  const oldestAtSql =
    sql`date_trunc('milliseconds', ${schema.assetResolutionDecisions.createdAt})`.mapWith(
      schema.assetResolutionDecisions.createdAt
    )
  const oldestAtRankSql = sql<number>`floor(
    extract(epoch from ${schema.assetResolutionDecisions.createdAt}) * 1000
  )::bigint`

  const rankAfterCursor = (cursor: AssetExceptionRankCursor) => sql`row(
    -${blockedReportsSql},
    -${affectedPrincipalsSql},
    -${affectedTransactionsSql},
    case when ${affectedValueEurSql} is null then 1 else 0 end,
    -coalesce((${affectedValueEurSql})::numeric, 0),
    ${severityRankSql},
    ${oldestAtRankSql},
    ${schema.providerAssets.id}
  ) > row(
    -(${cursor.blockedReports}::int),
    -(${cursor.affectedPrincipals}::int),
    -(${cursor.affectedTransactions}::int),
    ${cursor.affectedTransactionValueEur === null ? 1 : 0}::int,
    -${cursor.affectedTransactionValueEur ?? "0"}::numeric,
    ${severityRank(cursor.severity)}::int,
    ${cursor.oldestAt.getTime()}::bigint,
    ${cursor.providerAssetRowId}::uuid
  )`

  const listExceptions: AssetExceptionRepositoryShape["listExceptions"] = ({
    cursor,
    limit,
    query,
  }) => {
    const searchFilters = getAssetCatalogSearchPatterns(query ?? "").map((pattern) =>
      or(
        ilike(schema.providerAssets.provider, pattern),
        ilike(schema.providerAssets.providerAssetId, pattern),
        ilike(schema.providerAssets.naturalKey, pattern),
        ilike(schema.providerAssets.currencyCode, pattern),
        ilike(schema.providerAssets.name, pattern),
        ilike(queueReasonSql, pattern)
      )
    )

    return db
      .select({
        providerAssetRowId: schema.providerAssets.id,
        provider: schema.providerAssets.provider,
        providerAssetId: schema.providerAssets.providerAssetId,
        naturalKey: schema.providerAssets.naturalKey,
        currencyCode: schema.providerAssets.currencyCode,
        name: schema.providerAssets.name,
        providerType: schema.providerAssets.providerType,
        reason: queueReasonSql,
        evidenceRevision: schema.providerAssets.evidenceRevision,
        policyRevision: schema.assetResolutionDecisions.policyRevision,
        currentConclusionRevision: sql<string>`coalesce(
          ${schema.assetResolutionCurrentState.currentConclusionId}::text,
          ${NO_CURRENT_ASSET_CONCLUSION}
        )`,
        currentPolicyEvaluationRevision: schema.assetResolutionDecisions.id,
        blockedReports: blockedReportsSql,
        affectedPrincipals: affectedPrincipalsSql,
        affectedTransactions: affectedTransactionsSql,
        affectedSources: affectedSourcesSql,
        affectedCalculations: affectedSourcesSql,
        // Reports are calculated on demand; there is no persisted report
        // snapshot surface to invalidate in the current product.
        existingGeneratedReportSnapshots: sql<number>`0`,
        affectedTransactionValueEur: affectedValueEurSql,
        severityRank: severityRankSql,
        oldestAt: oldestAtSql,
      })
      .from(schema.providerAssets)
      .leftJoin(
        schema.assetResolutionCurrentState,
        eq(schema.assetResolutionCurrentState.providerAssetRowId, schema.providerAssets.id)
      )
      .innerJoin(
        schema.assetResolutionDecisions,
        and(
          eq(schema.assetResolutionDecisions.providerAssetRowId, schema.providerAssets.id),
          eq(
            schema.assetResolutionDecisions.evidenceRevision,
            schema.providerAssets.evidenceRevision
          ),
          eq(
            schema.assetResolutionCurrentState.currentPolicyEvaluationId,
            schema.assetResolutionDecisions.id
          ),
          or(
            and(
              inArray(schema.assetResolutionDecisions.outcome, ["pending", "fail_closed"]),
              inArray(schema.assetResolutionDecisions.reason, [...ACTIONABLE_REASONS]),
              or(
                isNull(schema.assetResolutionCurrentState.currentConclusionId),
                sql`not exists (
                  select 1
                  from ${schema.assetResolutionDecisions} current_conclusion
                  where current_conclusion.id = ${schema.assetResolutionCurrentState.currentConclusionId}
                    and current_conclusion.human_claim is not null
                    and current_conclusion.evidence_revision >= ${schema.assetResolutionDecisions.evidenceRevision}
                )`
              )
            ),
            // A conclusive evaluation that answers differently than the
            // current conclusion stays discoverable: an excluded observation
            // the policy now wants to attach must not vanish from the queue.
            // The answer includes the representation: an attach that keeps
            // the asset but declares different chain facts than the
            // conclusion's representation blocks sync and needs review too.
            // A human conclusion at the evaluation's evidence revision or
            // later already answered this evidence, so it stays hidden.
            // No conclusion at all is also a disagreement: a settled trusted
            // mapping has none, and its conclusive reevaluation is recorded
            // as a policy evaluation only, so nothing else surfaces it.
            and(
              inArray(schema.assetResolutionDecisions.outcome, [
                "attach",
                "create_standalone",
                "excluded",
              ]),
              or(
                isNull(schema.assetResolutionCurrentState.currentConclusionId),
                sql`exists (
                select 1
                from ${schema.assetResolutionDecisions} current_conclusion
                where current_conclusion.id = ${schema.assetResolutionCurrentState.currentConclusionId}
                  and not (
                    current_conclusion.human_claim is not null
                    and current_conclusion.evidence_revision >= ${schema.assetResolutionDecisions.evidenceRevision}
                  )
                  and (
                    (current_conclusion.outcome = 'excluded')
                      <> (${schema.assetResolutionDecisions.outcome} = 'excluded')
                    or current_conclusion.asset_id is distinct from ${schema.assetResolutionDecisions.assetId}
                    or (
                      ${schema.assetResolutionDecisions.blockchain} is not null
                      and not exists (
                        select 1
                        from ${schema.assetRepresentations} conclusion_representation
                        inner join ${schema.blockchains} conclusion_blockchain
                          on conclusion_blockchain.id = conclusion_representation.blockchain_id
                        where conclusion_representation.id = current_conclusion.asset_representation_id
                          and lower(conclusion_blockchain.name)
                            = lower(${schema.assetResolutionDecisions.blockchain})
                          and conclusion_representation.type::text
                            is not distinct from ${schema.assetResolutionDecisions.representationType}
                          and (
                            (
                              conclusion_representation.contract_address is null
                              and ${schema.assetResolutionDecisions.contractAddress} is null
                            )
                            or lower(trim(conclusion_representation.contract_address))
                              = lower(trim(${schema.assetResolutionDecisions.contractAddress}))
                          )
                          and conclusion_representation.mint_address
                            is not distinct from ${schema.assetResolutionDecisions.mintAddress}
                          and conclusion_representation.decimals
                            is not distinct from ${schema.assetResolutionDecisions.decimals}
                      )
                    )
                  )
              )`
              )
            )
          )
        )
      )
      .where(
        and(
          sql`exists (
            select 1
            from ${schema.assetResolutionJobs} completed_job
            where completed_job.provider_asset_row_id = ${schema.providerAssets.id}
              and completed_job.evidence_revision = ${schema.providerAssets.evidenceRevision}
              and completed_job.status = 'completed'
          )`,
          ...searchFilters,
          cursor === null ? undefined : rankAfterCursor(cursor)
        )
      )
      .orderBy(
        desc(blockedReportsSql),
        desc(affectedPrincipalsSql),
        desc(affectedTransactionsSql),
        asc(sql`case when ${affectedValueEurSql} is null then 1 else 0 end`),
        desc(sql`(${affectedValueEurSql})::numeric`),
        asc(severityRankSql),
        asc(oldestAtRankSql),
        asc(schema.providerAssets.id)
      )
      .limit(limit)
      .pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(AssetExceptionReason)(row.reason).pipe(
              Effect.map((reason) => ({
                providerAssetRowId: row.providerAssetRowId,
                provider: row.provider,
                providerAssetId: row.providerAssetId,
                naturalKey: row.naturalKey,
                currencyCode: row.currencyCode,
                name: row.name,
                providerType: row.providerType,
                reason,
                severity: assetExceptionSeverityForReason(reason),
                evidenceRevision: row.evidenceRevision,
                policyRevision: row.policyRevision,
                currentConclusionRevision: row.currentConclusionRevision,
                currentPolicyEvaluationRevision: row.currentPolicyEvaluationRevision,
                blockedReports: row.blockedReports,
                affectedPrincipals: row.affectedPrincipals,
                affectedTransactions: row.affectedTransactions,
                affectedSources: row.affectedSources,
                affectedCalculations: row.affectedCalculations,
                existingGeneratedReportSnapshots: row.existingGeneratedReportSnapshots,
                affectedTransactionValueEur: row.affectedTransactionValueEur,
                oldestAt: row.oldestAt,
              }))
            )
          )
        ),
        Effect.mapError((cause) => toStorageError("assetExceptionRepository.listExceptions", cause))
      )
  }

  const findProviderAsset = (client: QueryClient, lookup: AssetExceptionLookup) => {
    const condition = (() => {
      switch (lookup._tag) {
        case "row_id":
          return eq(schema.providerAssets.id, lookup.providerAssetRowId)
        case "provider_asset_id":
          return and(
            eq(schema.providerAssets.provider, lookup.provider),
            eq(schema.providerAssets.providerAssetId, lookup.providerAssetId)
          )
        case "natural_key":
          return and(
            eq(schema.providerAssets.provider, lookup.provider),
            eq(schema.providerAssets.naturalKey, lookup.naturalKey)
          )
      }
    })()

    return client
      .select({
        id: schema.providerAssets.id,
        provider: schema.providerAssets.provider,
        providerAssetId: schema.providerAssets.providerAssetId,
        naturalKey: schema.providerAssets.naturalKey,
        currencyCode: schema.providerAssets.currencyCode,
        name: schema.providerAssets.name,
        exponent: schema.providerAssets.exponent,
        providerType: schema.providerAssets.providerType,
        rawProviderPayload: schema.providerAssets.rawProviderPayload,
        evidenceRevision: schema.providerAssets.evidenceRevision,
      })
      .from(schema.providerAssets)
      .where(condition)
      .limit(1)
  }

  const loadImpact = (client: QueryClient, providerAssetRowId: string) =>
    client
      .select({
        blockedReports: blockedReportsSql,
        affectedPrincipals: affectedPrincipalsSql,
        affectedTransactions: affectedTransactionsSql,
        affectedSources: affectedSourcesSql,
        // Tax calculations are source-scoped and computed on demand, so each
        // affected source represents one current calculation result.
        affectedCalculations: affectedSourcesSql,
        existingGeneratedReportSnapshots: sql<number>`0`,
        affectedTransactionValueEur: affectedValueEurSql,
      })
      .from(schema.providerAssets)
      .where(eq(schema.providerAssets.id, providerAssetRowId))
      .limit(1)
      .pipe(
        Effect.map(
          (rows): AssetExceptionImpact =>
            rows[0] ?? {
              blockedReports: 0,
              affectedPrincipals: 0,
              affectedTransactions: 0,
              affectedSources: 0,
              affectedCalculations: 0,
              existingGeneratedReportSnapshots: 0,
              affectedTransactionValueEur: null,
            }
        )
      )

  const loadAffectedProviderAssetIds = ({
    client,
    providerAssetRowId,
    representationId,
    representationOutcome,
  }: {
    readonly client: QueryClient
    readonly providerAssetRowId: string
    readonly representationId: string | null
    readonly representationOutcome: "none" | "reuse" | "create" | "reassign"
  }) =>
    representationOutcome !== "reassign" || representationId === null
      ? Effect.succeed([providerAssetRowId] as ReadonlyArray<string>)
      : client
          .select({ providerAssetRowId: schema.providerAssetMappings.providerAssetRowId })
          .from(schema.providerAssetMappings)
          .where(eq(schema.providerAssetMappings.assetRepresentationId, representationId))
          .pipe(
            Effect.map((rows) =>
              [
                ...new Set([providerAssetRowId, ...rows.map(({ providerAssetRowId: id }) => id)]),
              ].sort((left, right) => left.localeCompare(right))
            )
          )

  const loadImpactForProviderAssets = (
    client: QueryClient,
    providerAssetRowIds: ReadonlyArray<string>
  ): Effect.Effect<AssetExceptionImpact, unknown> => {
    const providerAssetIds = sql.join(
      providerAssetRowIds.map((providerAssetRowId) => sql`${providerAssetRowId}::uuid`),
      sql`, `
    )
    const affectedSourceIds = sql`(
      select ${schema.providerAssetSourceUses.sourceId}
      from ${schema.providerAssetSourceUses}
      where ${schema.providerAssetSourceUses.providerAssetRowId} in (${providerAssetIds})
      union
      select ${schema.providerTransfers.sourceId}
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} in (${providerAssetIds})
    )`
    const affectedSourceUses = sql`(
      select
        ${schema.providerAssetSourceUses.providerAssetRowId} as provider_asset_row_id,
        ${schema.providerAssetSourceUses.sourceId} as source_id
      from ${schema.providerAssetSourceUses}
      where ${schema.providerAssetSourceUses.providerAssetRowId} in (${providerAssetIds})
      union
      select
        ${schema.providerTransfers.providerAssetId} as provider_asset_row_id,
        ${schema.providerTransfers.sourceId} as source_id
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} in (${providerAssetIds})
    )`
    const affectedTransactionIds = sql`(
      select ${schema.providerTransfers.transactionId}
      from ${schema.providerTransfers}
      where ${schema.providerTransfers.providerAssetId} in (${providerAssetIds})
      union
      select ${schema.providerAssetTransactionUses.transactionId}
      from ${schema.providerAssetTransactionUses}
      where ${schema.providerAssetTransactionUses.providerAssetRowId} in (${providerAssetIds})
    )`

    return client
      .select({
        blockedReports: sql<number>`(
          select count(distinct affected_source_uses.source_id)::int
          from ${affectedSourceUses} affected_source_uses
          where ${isCalculationBlockingSql({
            providerAssetRowId: sql`affected_source_uses.provider_asset_row_id`,
            sourceId: sql`affected_source_uses.source_id`,
          })}
        )`,
        affectedPrincipals: sql<number>`(
          select count(distinct ${schema.sources.principalId})::int
          from ${schema.sources}
          where ${schema.sources.id} in ${affectedSourceIds}
        )`,
        affectedTransactions: sql<number>`(
          select count(distinct affected_transactions.transaction_id)::int
          from ${affectedTransactionIds} affected_transactions
        )`,
        affectedSources: sql<number>`(
          select count(distinct affected_sources.source_id)::int
          from ${affectedSourceIds} affected_sources
        )`,
        affectedCalculations: sql<number>`(
          select count(distinct affected_sources.source_id)::int
          from ${affectedSourceIds} affected_sources
        )`,
        existingGeneratedReportSnapshots: sql<number>`0`,
        affectedTransactionValueEur: sql<string | null>`(
          select sum(abs(${schema.transactions.providerFiatAmount}))::text
          from ${schema.transactions}
          where ${schema.transactions.id} in ${affectedTransactionIds}
            and ${schema.transactions.providerFiatCurrency} = 'EUR'
        )`,
      })
      .from(schema.providerAssets)
      .where(
        eq(
          schema.providerAssets.id,
          providerAssetRowIds[0] ?? "00000000-0000-0000-0000-000000000000"
        )
      )
      .limit(1)
      .pipe(
        Effect.map(
          (rows): AssetExceptionImpact =>
            rows[0] ?? {
              blockedReports: 0,
              affectedPrincipals: 0,
              affectedTransactions: 0,
              affectedSources: 0,
              affectedCalculations: 0,
              existingGeneratedReportSnapshots: 0,
              affectedTransactionValueEur: null,
            }
        )
      )
  }

  const loadDecisionHistory = (
    client: QueryClient,
    providerAssetRowId: string
  ): Effect.Effect<ReadonlyArray<LoadedDecisionHistory>, unknown, never> =>
    Effect.gen(function* () {
      const rows = yield* client
        .select({
          id: schema.assetResolutionDecisions.id,
          supersedesDecisionId: schema.assetResolutionDecisions.supersedesDecisionId,
          outcome: schema.assetResolutionDecisions.outcome,
          humanClaim: schema.assetResolutionDecisions.humanClaim,
          rationale: schema.assetResolutionDecisions.rationale,
          reason: schema.assetResolutionDecisions.reason,
          assetId: schema.assetResolutionDecisions.assetId,
          assetRepresentationId: schema.assetResolutionDecisions.assetRepresentationId,
          actor: schema.assetResolutionDecisions.actor,
          policyRevision: schema.assetResolutionDecisions.policyRevision,
          evidenceRevision: schema.assetResolutionDecisions.evidenceRevision,
          createdAt: schema.assetResolutionDecisions.createdAt,
        })
        .from(schema.assetResolutionDecisions)
        .where(eq(schema.assetResolutionDecisions.providerAssetRowId, providerAssetRowId))
        .orderBy(
          asc(schema.assetResolutionDecisions.createdAt),
          asc(schema.assetResolutionDecisions.id)
        )

      const decisionIds = rows.map((row) => row.id)
      // Human decisions reference evidence through link rows while automatic
      // policy decisions own their evidence directly, so history must union
      // both, like the detail and validation queries do.
      const links =
        decisionIds.length === 0
          ? []
          : yield* client
              .select({
                decisionId: schema.assetResolutionDecisionEvidenceLinks.decisionId,
                evidenceId: schema.assetResolutionDecisionEvidenceLinks.evidenceId,
              })
              .from(schema.assetResolutionDecisionEvidenceLinks)
              .where(inArray(schema.assetResolutionDecisionEvidenceLinks.decisionId, decisionIds))
              .orderBy(asc(schema.assetResolutionDecisionEvidenceLinks.evidenceId))
      const ownedEvidence =
        decisionIds.length === 0
          ? []
          : yield* client
              .select({
                decisionId: schema.assetResolutionEvidence.decisionId,
                evidenceId: schema.assetResolutionEvidence.id,
              })
              .from(schema.assetResolutionEvidence)
              .where(inArray(schema.assetResolutionEvidence.decisionId, decisionIds))
              .orderBy(asc(schema.assetResolutionEvidence.id))

      const evidenceIdsByDecision = new Map<string, Array<string>>()
      for (const { decisionId, evidenceId } of [...links, ...ownedEvidence]) {
        const evidenceIds = evidenceIdsByDecision.get(decisionId) ?? []
        if (!evidenceIds.includes(evidenceId)) {
          evidenceIds.push(evidenceId)
        }
        evidenceIdsByDecision.set(decisionId, evidenceIds)
      }

      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const claim =
            row.humanClaim === null
              ? null
              : yield* Schema.decodeUnknownEffect(AssetExceptionClaim)(row.humanClaim)

          return {
            id: row.id,
            supersedesConclusionId: row.supersedesDecisionId,
            outcome: row.outcome,
            claim,
            rationale: row.rationale,
            reason: row.reason,
            assetId: row.assetId,
            assetRepresentationId: row.assetRepresentationId,
            actorId: row.actor,
            policyRevision: row.policyRevision,
            evidenceRevision: row.evidenceRevision,
            evidenceSnapshotIds: evidenceIdsByDecision.get(row.id) ?? [],
            createdAt: row.createdAt,
          } satisfies LoadedDecisionHistory
        })
      )
    })

  const loadRematerialization = (
    client: QueryClient,
    {
      providerAssetRowId,
      currentConclusionId,
    }: {
      readonly providerAssetRowId: string
      readonly currentConclusionId: string | null
    }
  ): Effect.Effect<AssetExceptionRematerializationSummary, unknown> => {
    const decisionCondition =
      currentConclusionId === null
        ? and(
            eq(schema.assetResolutionDecisions.providerAssetRowId, providerAssetRowId),
            isNull(schema.assetResolutionDecisions.humanClaim),
            inArray(schema.assetResolutionDecisions.outcome, ["pending", "fail_closed"])
          )
        : eq(schema.assetResolutionDecisions.id, currentConclusionId)

    return client
      .select({
        sourceId: schema.assetDecisionRematerializations.sourceId,
        storedStatus: schema.assetDecisionRematerializations.status,
        failureCode: schema.assetDecisionRematerializations.failureCode,
        lastFailureAt: schema.assetDecisionRematerializations.lastFailureAt,
        jobStatus: schema.processingJobs.status,
        jobAttemptCount: schema.processingJobs.attemptCount,
      })
      .from(schema.assetDecisionRematerializations)
      .innerJoin(
        schema.assetResolutionDecisions,
        eq(schema.assetResolutionDecisions.id, schema.assetDecisionRematerializations.decisionId)
      )
      .leftJoin(
        schema.processingJobs,
        eq(schema.processingJobs.id, schema.assetDecisionRematerializations.processingJobId)
      )
      .where(decisionCondition)
      .pipe(
        Effect.map((rows): AssetExceptionRematerializationSummary => {
          if (rows.length === 0) {
            return {
              status: "complete",
              affectedSourceCount: 0,
              pendingSourceCount: 0,
              runningSourceCount: 0,
              completedSourceCount: 0,
              failedSourceCount: 0,
              retryingSourceCount: 0,
              remainingSourceCount: 0,
              lastFailureAt: null,
              failureCode: null,
            }
          }

          // The stored status is settled by the job lifecycle when replays
          // finish; the job join only refines an unfinished row into
          // "running" while its replay is actively processing.
          const effectiveStatus = (row: (typeof rows)[number]) =>
            row.storedStatus === "pending" && row.jobStatus === "processing"
              ? ("running" as const)
              : row.storedStatus
          const statusRank = {
            complete: 0,
            pending: 1,
            running: 2,
            operator_attention: 3,
          } as const
          const sources = new Map<
            string,
            {
              readonly status: keyof typeof statusRank
              readonly retrying: boolean
              readonly failureCode: string | null
              readonly lastFailureAt: Date | null
            }
          >()
          for (const row of rows) {
            const status = effectiveStatus(row)
            const existing = sources.get(row.sourceId)
            const candidate = {
              status,
              retrying:
                status !== "complete" &&
                status !== "operator_attention" &&
                (row.jobAttemptCount ?? 0) > 0,
              failureCode: row.failureCode,
              lastFailureAt: row.lastFailureAt,
            }
            if (
              existing === undefined ||
              statusRank[candidate.status] > statusRank[existing.status]
            ) {
              sources.set(row.sourceId, candidate)
            } else if (statusRank[candidate.status] === statusRank[existing.status]) {
              const failureDates = [existing.lastFailureAt, candidate.lastFailureAt].filter(
                (date): date is Date => date !== null
              )
              sources.set(row.sourceId, {
                ...existing,
                retrying: existing.retrying || candidate.retrying,
                failureCode: candidate.failureCode ?? existing.failureCode,
                lastFailureAt:
                  failureDates.sort((left, right) => right.getTime() - left.getTime())[0] ?? null,
              })
            }
          }
          const sourceStates = [...sources.values()]
          const affectedSourceCount = sourceStates.length
          const pendingSourceCount = sourceStates.filter(
            ({ status }) => status === "pending"
          ).length
          const runningSourceCount = sourceStates.filter(
            ({ status }) => status === "running"
          ).length
          const completedSourceCount = sourceStates.filter(
            ({ status }) => status === "complete"
          ).length
          const failed = sourceStates.filter(({ status }) => status === "operator_attention")
          const failedSourceCount = failed.length
          const retryingSourceCount = sourceStates.filter(({ retrying }) => retrying).length
          const remainingSourceCount = affectedSourceCount - completedSourceCount
          const lastFailureAt =
            failed
              .flatMap((row) => (row.lastFailureAt === null ? [] : [row.lastFailureAt]))
              .sort((left, right) => right.getTime() - left.getTime())[0] ?? null

          return {
            status:
              failedSourceCount > 0
                ? "operator_attention"
                : runningSourceCount > 0
                  ? "running"
                  : pendingSourceCount > 0
                    ? "pending"
                    : "complete",
            affectedSourceCount,
            pendingSourceCount,
            runningSourceCount,
            completedSourceCount,
            failedSourceCount,
            retryingSourceCount,
            remainingSourceCount,
            lastFailureAt,
            failureCode:
              failed[0]?.failureCode ?? (failedSourceCount > 0 ? "rematerialization_failed" : null),
          }
        })
      )
  }

  const loadDetail = (
    client: QueryClient,
    lookup: AssetExceptionLookup
  ): Effect.Effect<Option.Option<AssetExceptionDetail>, unknown, never> =>
    Effect.gen(function* () {
      const [providerAsset] = yield* findProviderAsset(client, lookup)
      if (providerAsset === undefined) {
        return Option.none<AssetExceptionDetail>()
      }

      const history = yield* loadDecisionHistory(client, providerAsset.id)
      const [persistedCurrentState] = yield* client
        .select({
          currentConclusionId: schema.assetResolutionCurrentState.currentConclusionId,
          currentPolicyEvaluationId: schema.assetResolutionCurrentState.currentPolicyEvaluationId,
        })
        .from(schema.assetResolutionCurrentState)
        .where(eq(schema.assetResolutionCurrentState.providerAssetRowId, providerAsset.id))
        .limit(1)
      const currentPolicyEvaluation =
        history.find(
          (decision) => decision.id === persistedCurrentState?.currentPolicyEvaluationId
        ) ?? null
      const currentConclusion =
        history.find((decision) => decision.id === persistedCurrentState?.currentConclusionId) ??
        null
      const publicHistory = history.map(
        (decision): AssetExceptionDecisionHistory => ({
          ...decision,
          isCurrentConclusion: decision.id === currentConclusion?.id,
          isCurrentPolicyEvaluation: decision.id === currentPolicyEvaluation?.id,
        })
      )
      const publicCurrentConclusion =
        publicHistory.find((decision) => decision.id === currentConclusion?.id) ?? null
      const publicCurrentPolicyEvaluation =
        publicHistory.find((decision) => decision.id === currentPolicyEvaluation?.id) ?? null
      const settledEvidenceIds =
        currentPolicyEvaluation === null ? (currentConclusion?.evidenceSnapshotIds ?? []) : []
      const evidenceCondition =
        currentPolicyEvaluation !== null
          ? or(
              eq(schema.assetResolutionEvidence.decisionId, currentPolicyEvaluation.id),
              sql<boolean>`exists (
                select 1
                from ${schema.assetResolutionDecisionEvidenceLinks} evidence_link
                where evidence_link.evidence_id = ${schema.assetResolutionEvidence.id}
                  and evidence_link.decision_id = ${currentPolicyEvaluation.id}
              )`
            )
          : settledEvidenceIds.length > 0
            ? inArray(schema.assetResolutionEvidence.id, settledEvidenceIds)
            : null
      const evidence =
        evidenceCondition === null
          ? []
          : yield* client
              .select({
                id: schema.assetResolutionEvidence.id,
                authority: schema.assetResolutionEvidence.authority,
                claimKind: schema.assetResolutionEvidence.claimKind,
                sourceLocator: schema.assetResolutionEvidence.sourceLocator,
                retrievedAt: schema.assetResolutionEvidence.retrievedAt,
                evidenceRevision: schema.assetResolutionEvidence.evidenceRevision,
                decodedClaim: schema.assetResolutionEvidence.decodedClaim,
                rawPayload: schema.assetResolutionEvidence.rawPayload,
              })
              .from(schema.assetResolutionEvidence)
              .where(evidenceCondition)
              .orderBy(
                asc(schema.assetResolutionEvidence.authority),
                asc(schema.assetResolutionEvidence.claimKind)
              )
      const impact = yield* loadImpact(client, providerAsset.id)
      const rematerialization = yield* loadRematerialization(client, {
        providerAssetRowId: providerAsset.id,
        currentConclusionId: currentConclusion?.id ?? null,
      })

      const reviewStatus = (() => {
        if (
          currentPolicyEvaluation !== null &&
          ["pending", "fail_closed"].includes(currentPolicyEvaluation.outcome) &&
          (currentConclusion === null ||
            currentConclusion.claim === null ||
            currentConclusion.evidenceRevision < currentPolicyEvaluation.evidenceRevision)
        ) {
          return "unresolved" as const
        }
        if (currentConclusion?.outcome === "excluded") {
          return "excluded" as const
        }
        if (
          currentConclusion !== null &&
          !["pending", "fail_closed"].includes(currentConclusion.outcome)
        ) {
          return "approved" as const
        }
        return "unresolved" as const
      })()

      const detail: AssetExceptionDetail = {
        providerAssetRowId: providerAsset.id,
        provider: providerAsset.provider,
        providerAssetId: providerAsset.providerAssetId,
        naturalKey: providerAsset.naturalKey,
        currencyCode: providerAsset.currencyCode,
        name: providerAsset.name,
        exponent: providerAsset.exponent,
        providerType: providerAsset.providerType,
        rawProviderPayload: providerAsset.rawProviderPayload,
        evidenceRevision: providerAsset.evidenceRevision,
        currentConclusionRevision: currentConclusion?.id ?? NO_CURRENT_ASSET_CONCLUSION,
        currentPolicyEvaluationRevision:
          currentPolicyEvaluation?.id ?? NO_CURRENT_ASSET_POLICY_EVALUATION,
        reviewStatus,
        currentConclusion: publicCurrentConclusion,
        currentPolicyEvaluation: publicCurrentPolicyEvaluation,
        decisionHistory: publicHistory,
        evidence,
        impact,
        rematerialization,
      }

      return Option.some(detail)
    })

  const validateInput = ({
    client,
    detail,
    input,
  }: {
    readonly client: QueryClient
    readonly detail: AssetExceptionDetail
    readonly input: AssetExceptionDecisionInput
  }): Effect.Effect<InputValidationResult, unknown, never> =>
    Effect.gen(function* () {
      if (
        input.evidenceRevision !== detail.evidenceRevision ||
        input.currentConclusionRevision !== detail.currentConclusionRevision ||
        input.currentPolicyEvaluationRevision !== detail.currentPolicyEvaluationRevision
      ) {
        return {
          _tag: "stale_revision" as const,
          evidenceRevision: detail.evidenceRevision,
          currentConclusionRevision: detail.currentConclusionRevision,
          currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
        }
      }

      const rationale = input.rationale?.trim() ?? ""
      if (
        (input.claim._tag === "identity" && rationale.length === 0) ||
        input.evidenceSnapshotIds.length === 0
      ) {
        return { _tag: "invalid_evidence" as const }
      }

      const uniqueEvidenceIds = [...new Set(input.evidenceSnapshotIds)]
      if (uniqueEvidenceIds.length !== input.evidenceSnapshotIds.length) {
        return { _tag: "invalid_evidence" as const }
      }

      const evidenceRevisionCondition =
        detail.currentConclusion === null
          ? eq(schema.assetResolutionEvidence.evidenceRevision, detail.evidenceRevision)
          : or(
              eq(schema.assetResolutionEvidence.evidenceRevision, detail.evidenceRevision),
              sql<boolean>`exists (
                select 1
                from ${schema.assetResolutionDecisionEvidenceLinks} evidence_link
                where evidence_link.evidence_id = ${schema.assetResolutionEvidence.id}
                  and evidence_link.decision_id = ${detail.currentConclusion.id}
              )`
            )
      const evidenceRows = yield* client
        .select({ id: schema.assetResolutionEvidence.id })
        .from(schema.assetResolutionEvidence)
        .innerJoin(
          schema.assetResolutionDecisions,
          eq(schema.assetResolutionDecisions.id, schema.assetResolutionEvidence.decisionId)
        )
        .where(
          and(
            inArray(schema.assetResolutionEvidence.id, uniqueEvidenceIds),
            evidenceRevisionCondition,
            eq(schema.assetResolutionDecisions.providerAssetRowId, detail.providerAssetRowId)
          )
        )

      if (evidenceRows.length !== uniqueEvidenceIds.length) {
        return { _tag: "invalid_evidence" as const }
      }

      return { _tag: "valid" as const }
    })

  const prepareIdentityClaim = (
    client: QueryClient,
    claim: IdentityClaim
  ): Effect.Effect<PrepareIdentityClaimResult, unknown, never> =>
    Effect.gen(function* () {
      const representation = claim.representation
      const blockchainRows =
        representation === null
          ? []
          : yield* client
              .select({ id: schema.blockchains.id, chainType: schema.blockchains.chainType })
              .from(schema.blockchains)
              .where(
                eq(sql`lower(${schema.blockchains.name})`, representation.blockchain.toLowerCase())
              )
              .limit(2)
      if (representation !== null && blockchainRows.length !== 1) {
        return { _tag: "invalid_claim" as const }
      }

      const blockchain = blockchainRows[0]
      const normalizedRepresentation =
        representation !== null && blockchain?.chainType === "evm"
          ? {
              ...representation,
              contractAddress: representation.contractAddress?.toLowerCase() ?? null,
            }
          : representation

      return {
        _tag: "prepared" as const,
        claim:
          normalizedRepresentation === representation
            ? claim
            : { ...claim, representation: normalizedRepresentation },
        blockchainId: blockchain?.id ?? null,
        isEvm: blockchain?.chainType === "evm",
      }
    })

  const resolvePreparedIdentity = (
    client: QueryClient,
    prepared: PreparedIdentityClaim
  ): Effect.Effect<IdentityResolution, unknown, never> =>
    Effect.gen(function* () {
      const { claim, blockchainId, isEvm } = prepared
      const representation = claim.representation
      const representationRows =
        representation === null || blockchainId === null
          ? []
          : yield* client
              .select({
                id: schema.assetRepresentations.id,
                assetId: schema.assetRepresentations.assetId,
                type: schema.assetRepresentations.type,
                decimals: schema.assetRepresentations.decimals,
              })
              .from(schema.assetRepresentations)
              .where(
                and(
                  eq(schema.assetRepresentations.blockchainId, blockchainId),
                  representation.contractAddress === null
                    ? isNull(schema.assetRepresentations.contractAddress)
                    : isEvm
                      ? eq(
                          sql`lower(${schema.assetRepresentations.contractAddress})`,
                          representation.contractAddress
                        )
                      : eq(
                          schema.assetRepresentations.contractAddress,
                          representation.contractAddress
                        ),
                  representation.mintAddress === null
                    ? isNull(schema.assetRepresentations.mintAddress)
                    : eq(schema.assetRepresentations.mintAddress, representation.mintAddress)
                )
              )
              .limit(2)

      if (
        representationRows.some(
          (row) => row.type !== representation?.type || row.decimals !== representation.decimals
        )
      ) {
        return { _tag: "ambiguous_identity" as const }
      }

      if (claim.assetId !== null) {
        const assets = yield* client
          .select({ id: schema.assets.id, type: schema.assets.type })
          .from(schema.assets)
          .where(eq(schema.assets.id, claim.assetId))
          .limit(1)
        const asset = assets[0]
        if (asset === undefined || assets.length !== 1) {
          return { _tag: "invalid_claim" as const }
        }
        if (
          representation !== null &&
          !isRepresentationCompatibleWithAssetType({
            assetType: asset.type,
            representationType: representation.type,
          })
        ) {
          return { _tag: "ambiguous_identity" as const }
        }
        if (representationRows.length > 1) {
          return { _tag: "ambiguous_identity" as const }
        }

        const existingRepresentation = representationRows[0]

        return {
          _tag: "resolved" as const,
          assetId: claim.assetId,
          assetOutcome: "reuse" as const,
          representationId: existingRepresentation?.id ?? null,
          representationOutcome:
            representation === null
              ? ("none" as const)
              : existingRepresentation !== undefined
                ? existingRepresentation.assetId === claim.assetId
                  ? ("reuse" as const)
                  : ("reassign" as const)
                : ("create" as const),
          blockchainId,
        }
      }

      const newAsset = claim.newAsset
      if (newAsset === null) {
        return { _tag: "invalid_claim" as const }
      }

      // A representation that already belongs to an asset contradicts a
      // claim that the identity does not exist yet. The reviewer must pick
      // the owning asset explicitly instead of having their new-asset claim
      // silently rewritten into a reuse of it.
      if (representationRows.length > 0) {
        return { _tag: "ambiguous_identity" as const }
      }

      // Same canonical form and cross-match rule as the automatic resolver's
      // duplicate brake: either display value colliding with either stored
      // display value blocks the new asset, so NFKC lookalikes and reused
      // names or symbols collide here too instead of creating a duplicate.
      const displayKeys = [
        ...new Set(
          [canonicalizeDisplayText(newAsset.name), canonicalizeDisplayText(newAsset.symbol)].filter(
            (key) => key !== ""
          )
        ),
      ]
      const displayMatches =
        displayKeys.length === 0
          ? []
          : yield* client
              .select({ id: schema.assets.id })
              .from(schema.assets)
              .where(
                or(
                  inArray(
                    sql<string>`btrim(lower(normalize(${schema.assets.name}, NFKC)))`,
                    displayKeys
                  ),
                  inArray(
                    sql<string>`btrim(lower(normalize(${schema.assets.symbol}, NFKC)))`,
                    displayKeys
                  )
                )
              )
              .limit(1)
      if (displayMatches.length > 0) {
        return { _tag: "ambiguous_identity" as const }
      }

      if (
        representation !== null &&
        !isRepresentationCompatibleWithAssetType({
          assetType: newAsset.type,
          representationType: representation.type,
        })
      ) {
        return { _tag: "ambiguous_identity" as const }
      }
      return {
        _tag: "resolved" as const,
        assetId: null,
        assetOutcome: "create" as const,
        representationId: null,
        representationOutcome: representation === null ? ("none" as const) : ("create" as const),
        blockchainId,
      }
    })

  const resolveIdentity = (
    client: QueryClient,
    claim: IdentityClaim
  ): Effect.Effect<IdentityResolution, unknown, never> =>
    Effect.gen(function* () {
      const prepared = yield* prepareIdentityClaim(client, claim)
      if (prepared._tag === "invalid_claim") {
        return prepared
      }
      return yield* resolvePreparedIdentity(client, prepared)
    })

  const lockIdentityResolution = ({
    claim,
    tx,
  }: {
    readonly claim: IdentityClaim
    readonly tx: DbTransactionClient
  }): Effect.Effect<void, unknown> => {
    const representation = claim.representation
    // The name and symbol keys are locked independently to mirror the
    // cross-match duplicate brake: two claims sharing either display value
    // must serialize, not just claims sharing the full pair.
    const keys = [
      ...new Set(
        [
          claim.assetId === null ? null : `asset:${claim.assetId}`,
          claim.newAsset === null
            ? null
            : `display:${canonicalizeDisplayText(claim.newAsset.name)}`,
          claim.newAsset === null
            ? null
            : `display:${canonicalizeDisplayText(claim.newAsset.symbol)}`,
          representation === null
            ? null
            : `representation:${representation.blockchain.toLowerCase()}:${representation.contractAddress ?? ""}:${representation.mintAddress ?? ""}`,
        ].filter((key): key is string => key !== null)
      ),
    ].sort((left, right) => left.localeCompare(right))

    return Effect.forEach(
      keys,
      (key) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`),
      { discard: true }
    )
  }

  const previewDecision: AssetExceptionRepositoryShape["previewDecision"] = (input) =>
    Effect.gen(function* () {
      const maybeDetail = yield* loadDetail(db, {
        _tag: "row_id",
        providerAssetRowId: input.providerAssetRowId,
      })
      if (Option.isNone(maybeDetail)) {
        return { _tag: "not_found" as const }
      }
      const detail = maybeDetail.value
      const currentConclusionClaimKind =
        detail.currentConclusion === null
          ? null
          : (detail.currentConclusion.claim?._tag ??
            (detail.currentConclusion.outcome === "excluded" ? "exclusion" : "identity"))
      const decisionAction =
        detail.currentConclusion === null
          ? ("initial" as const)
          : currentConclusionClaimKind === input.claim._tag
            ? ("supersession" as const)
            : ("reversal" as const)
      const validation = yield* validateInput({ client: db, detail, input })
      if (validation._tag !== "valid") {
        return validation
      }

      if (input.claim._tag === "exclusion") {
        return {
          _tag: "ready" as const,
          preview: {
            claim: input.claim,
            decisionAction,
            resultingAssetId: null,
            assetOutcome: "none",
            representationOutcome: "none",
            supersededConclusion: detail.currentConclusion,
            impact: detail.impact,
            rematerializationSourceCount: detail.impact.affectedSources,
            evidenceRevision: detail.evidenceRevision,
            currentConclusionRevision: detail.currentConclusionRevision,
            currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
            affectedObservationRevisions: [toObservationRevision(detail)],
          } satisfies AssetExceptionDecisionPreview,
        }
      }

      if (
        !(yield* isClaimCompatibleWithObservedRepresentation({
          client: db,
          detail,
          claim: input.claim,
        }))
      ) {
        return { _tag: "invalid_claim" as const }
      }

      const resolution = yield* resolveIdentity(db, input.claim)
      if (resolution._tag !== "resolved") {
        return resolution
      }
      const affectedProviderAssetRowIds = yield* loadAffectedProviderAssetIds({
        client: db,
        providerAssetRowId: detail.providerAssetRowId,
        representationId: resolution.representationId,
        representationOutcome: resolution.representationOutcome,
      })
      const impact =
        affectedProviderAssetRowIds.length === 1
          ? detail.impact
          : yield* loadImpactForProviderAssets(db, affectedProviderAssetRowIds)
      const affectedDetails = yield* Effect.forEach(
        affectedProviderAssetRowIds,
        (providerAssetRowId) =>
          loadDetail(db, { _tag: "row_id", providerAssetRowId }).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    toStorageError("assetExceptionRepository.previewDecision.affectedDetail", {
                      providerAssetRowId,
                    })
                  ),
                onSome: Effect.succeed,
              })
            )
          )
      )

      return {
        _tag: "ready" as const,
        preview: {
          claim: input.claim,
          decisionAction,
          resultingAssetId: resolution.assetId,
          assetOutcome: resolution.assetOutcome,
          representationOutcome: resolution.representationOutcome,
          supersededConclusion: detail.currentConclusion,
          impact,
          rematerializationSourceCount: impact.affectedSources,
          evidenceRevision: detail.evidenceRevision,
          currentConclusionRevision: detail.currentConclusionRevision,
          currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
          affectedObservationRevisions: affectedDetails.map(toObservationRevision),
        },
      }
    }).pipe(
      Effect.mapError((cause) => toStorageError("assetExceptionRepository.previewDecision", cause))
    )

  const affectedSourceIdsSubquerySql = (providerAssetRowIds: ReadonlyArray<string>) => sql`(
    select ${schema.providerAssetSourceUses.sourceId}
    from ${schema.providerAssetSourceUses}
    where ${schema.providerAssetSourceUses.providerAssetRowId} in (${sql.join(
      providerAssetRowIds.map((providerAssetRowId) => sql`${providerAssetRowId}::uuid`),
      sql`, `
    )})
    union
    select ${schema.providerTransfers.sourceId}
    from ${schema.providerTransfers}
    where ${schema.providerTransfers.providerAssetId} in (${sql.join(
      providerAssetRowIds.map((providerAssetRowId) => sql`${providerAssetRowId}::uuid`),
      sql`, `
    )})
  )`

  const scheduleRematerialization = ({
    tx,
    providerAssetRowIds,
    decisionId,
    now,
  }: {
    readonly tx: DbTransactionClient
    readonly providerAssetRowIds: ReadonlyArray<string>
    readonly decisionId: string
    readonly now: Date
  }): Effect.Effect<void, SyncEngineStorageError, never> =>
    Effect.gen(function* () {
      const sourceRows = yield* tx
        .select({
          sourceId: schema.sources.id,
          principalId: schema.sources.principalId,
        })
        .from(schema.sources)
        .where(inArray(schema.sources.id, affectedSourceIdsSubquerySql(providerAssetRowIds)))
        .orderBy(asc(schema.sources.id))

      yield* Effect.forEach(sourceRows, ({ sourceId, principalId }) =>
        Effect.gen(function* () {
          const requestReplay = (attemptsRemaining: number): Effect.Effect<string, unknown> =>
            Effect.gen(function* () {
              // A pending replay has not started, so it already rebuilds
              // everything this decision changed once it runs; reuse it
              // directly. Marking it for a follow-up instead would skip
              // settling its rebuild rows on completion and park them on a
              // redundant second replay. The row update locks it against a
              // concurrent worker claim inside this transaction.
              const [pendingReplay] = yield* tx
                .update(schema.processingJobs)
                .set({ updatedAt: now })
                .where(
                  and(
                    eq(schema.processingJobs.sourceId, sourceId),
                    eq(schema.processingJobs.principalId, principalId),
                    eq(schema.processingJobs.mode, "replay"),
                    eq(schema.processingJobs.status, "pending")
                  )
                )
                .returning({ id: schema.processingJobs.id })
              if (pendingReplay !== undefined) {
                return pendingReplay.id
              }

              // Any other active job either already runs (its replay may have
              // passed this decision's data) or is a pending sync, so a
              // follow-up replay after it is required.
              const [activeJob] = yield* tx
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
              if (activeJob !== undefined) {
                return activeJob.id
              }

              const [createdJob] = yield* tx
                .insert(schema.processingJobs)
                .values({
                  sourceId,
                  principalId,
                  mode: "replay",
                  status: "pending",
                  progressDetails: {
                    mode: "replay",
                    reason: "asset_exception_decision",
                    decisionId,
                  },
                  createdAt: now,
                  updatedAt: now,
                })
                .onConflictDoNothing()
                .returning({ id: schema.processingJobs.id })
              if (createdJob !== undefined) {
                return createdJob.id
              }
              if (attemptsRemaining > 1) {
                return yield* Effect.suspend(() => requestReplay(attemptsRemaining - 1))
              }

              return yield* toStorageError("assetExceptionRepository.scheduleRematerialization", {
                sourceId,
                message: "Active replay owner changed repeatedly.",
              })
            })

          const processingJobId = yield* requestReplay(3)

          yield* tx.insert(schema.assetDecisionRematerializations).values({
            decisionId,
            sourceId,
            processingJobId,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          })
        })
      )
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(SyncEngineStorageError)(cause)
          ? cause
          : toStorageError("assetExceptionRepository.scheduleRematerialization", cause)
      )
    )

  const submitDecision: AssetExceptionRepositoryShape["submitDecision"] = ({ input, actorId }) => {
    const persisted: Effect.Effect<SubmitTransactionResult, SyncEngineStorageError, never> = db
      .transaction((tx) =>
        Effect.gen(function* () {
          const maybeInitialDetail = yield* loadDetail(tx, {
            _tag: "row_id",
            providerAssetRowId: input.providerAssetRowId,
          })
          if (Option.isNone(maybeInitialDetail)) {
            return { _tag: "not_found" as const }
          }
          const initialDetail = maybeInitialDetail.value
          const initialValidation = yield* validateInput({
            client: tx,
            detail: initialDetail,
            input,
          })
          if (initialValidation._tag !== "valid") {
            return initialValidation
          }

          const preparedIdentityClaim =
            input.claim._tag === "identity" ? yield* prepareIdentityClaim(tx, input.claim) : null
          if (preparedIdentityClaim?._tag === "invalid_claim") {
            return preparedIdentityClaim
          }

          if (input.claim._tag === "identity" && preparedIdentityClaim?._tag === "prepared") {
            if (
              !(yield* isClaimCompatibleWithObservedRepresentation({
                client: tx,
                detail: initialDetail,
                claim: input.claim,
              }))
            ) {
              return { _tag: "invalid_claim" as const }
            }
          }
          const identityResolutionBeforeLocks =
            preparedIdentityClaim?._tag === "prepared"
              ? yield* resolvePreparedIdentity(tx, preparedIdentityClaim)
              : null
          if (
            identityResolutionBeforeLocks !== null &&
            identityResolutionBeforeLocks._tag !== "resolved"
          ) {
            return identityResolutionBeforeLocks
          }
          const lockedProviderAssetRowIds =
            identityResolutionBeforeLocks?._tag === "resolved"
              ? yield* loadAffectedProviderAssetIds({
                  client: tx,
                  providerAssetRowId: initialDetail.providerAssetRowId,
                  representationId: identityResolutionBeforeLocks.representationId,
                  representationOutcome: identityResolutionBeforeLocks.representationOutcome,
                })
              : [initialDetail.providerAssetRowId]
          // Lock sources before provider assets, matching the automatic
          // approval path in lockProviderAssetApprovalSnapshotInTransaction.
          // The replay upsert later takes a key-share lock on its source
          // through the processing-jobs foreign key; mixed ordering can
          // deadlock the two flows against each other.
          yield* tx
            .select({ id: schema.sources.id })
            .from(schema.sources)
            .where(
              inArray(schema.sources.id, affectedSourceIdsSubquerySql(lockedProviderAssetRowIds))
            )
            .orderBy(asc(schema.sources.id))
            .for("update")
          yield* tx
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(inArray(schema.providerAssets.id, lockedProviderAssetRowIds))
            .orderBy(asc(schema.providerAssets.id))
            .for("no key update")

          if (input.claim._tag === "identity" && preparedIdentityClaim?._tag === "prepared") {
            yield* lockIdentityResolution({ claim: preparedIdentityClaim.claim, tx })
          }

          if (
            identityResolutionBeforeLocks?._tag === "resolved" &&
            identityResolutionBeforeLocks.representationOutcome === "reassign" &&
            identityResolutionBeforeLocks.representationId !== null
          ) {
            const [lockedRepresentation] = yield* tx
              .select({ id: schema.assetRepresentations.id })
              .from(schema.assetRepresentations)
              .where(
                eq(schema.assetRepresentations.id, identityResolutionBeforeLocks.representationId)
              )
              .for("update")
              .limit(1)
            if (lockedRepresentation === undefined) {
              return { _tag: "identity_changed" as const }
            }
          }

          const maybeDetail = yield* loadDetail(tx, {
            _tag: "row_id",
            providerAssetRowId: input.providerAssetRowId,
          })
          if (Option.isNone(maybeDetail)) {
            return { _tag: "not_found" as const }
          }
          const detail = maybeDetail.value
          const validation = yield* validateInput({ client: tx, detail, input })
          if (validation._tag !== "valid") {
            return validation
          }
          if (
            input.claim._tag === "identity" &&
            !(yield* isClaimCompatibleWithObservedRepresentation({
              client: tx,
              detail,
              claim: input.claim,
            }))
          ) {
            return { _tag: "invalid_claim" as const }
          }
          const identityResolution =
            preparedIdentityClaim?._tag === "prepared"
              ? yield* resolvePreparedIdentity(tx, preparedIdentityClaim)
              : null
          if (identityResolution !== null && identityResolution._tag !== "resolved") {
            return identityResolution
          }
          const affectedProviderAssetRowIds =
            identityResolution?._tag === "resolved"
              ? yield* loadAffectedProviderAssetIds({
                  client: tx,
                  providerAssetRowId: detail.providerAssetRowId,
                  representationId: identityResolution.representationId,
                  representationOutcome: identityResolution.representationOutcome,
                })
              : [detail.providerAssetRowId]
          if (
            affectedProviderAssetRowIds.length !== lockedProviderAssetRowIds.length ||
            affectedProviderAssetRowIds.some(
              (providerAssetRowId, index) => providerAssetRowId !== lockedProviderAssetRowIds[index]
            )
          ) {
            return { _tag: "identity_changed" as const }
          }
          const affectedDetails = yield* Effect.forEach(
            affectedProviderAssetRowIds,
            (providerAssetRowId) =>
              loadDetail(tx, { _tag: "row_id", providerAssetRowId }).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        toStorageError("assetExceptionRepository.submitDecision.affectedDetail", {
                          providerAssetRowId,
                        })
                      ),
                    onSome: Effect.succeed,
                  })
                )
              )
          )
          const affectedObservationRevisions = affectedDetails.map(toObservationRevision)
          const expectedAffectedObservationRevisions =
            input.expectedAffectedObservationRevisions ??
            (affectedObservationRevisions.length === 1 ? affectedObservationRevisions : [])
          if (
            !observationRevisionsMatch({
              actual: affectedObservationRevisions,
              expected: expectedAffectedObservationRevisions,
            })
          ) {
            return yield* new StaleAssetDecisionTransaction({
              providerAssetRowId: detail.providerAssetRowId,
            })
          }
          const affectedDetailsByProviderAssetRowId = new Map(
            affectedDetails.map((affectedDetail) => [
              affectedDetail.providerAssetRowId,
              affectedDetail,
            ])
          )
          const actualResultingAssetId = identityResolution?.assetId ?? null
          const actualAssetOutcome = identityResolution?.assetOutcome ?? "none"
          const actualRepresentationOutcome = identityResolution?.representationOutcome ?? "none"
          if (
            input.expectedResultingAssetId !== actualResultingAssetId ||
            input.expectedAssetOutcome !== actualAssetOutcome ||
            input.expectedRepresentationOutcome !== actualRepresentationOutcome
          ) {
            return { _tag: "identity_changed" as const }
          }

          const now = nowDate()
          let assetId: string | null = null
          let representationId: string | null = null

          if (
            input.claim._tag === "identity" &&
            preparedIdentityClaim?._tag === "prepared" &&
            identityResolution?._tag === "resolved"
          ) {
            const preparedClaim = preparedIdentityClaim.claim
            if (identityResolution.assetId === null) {
              const newAsset = preparedClaim.newAsset
              if (newAsset === null) {
                return { _tag: "invalid_claim" as const }
              }
              const [insertedAsset] = yield* tx
                .insert(schema.assets)
                .values({
                  name: newAsset.name,
                  symbol: newAsset.symbol,
                  type: newAsset.type,
                  createdAt: now,
                  updatedAt: now,
                })
                .returning({ id: schema.assets.id })
              if (insertedAsset === undefined) {
                return yield* toStorageError(
                  "assetExceptionRepository.submitDecision.createAsset",
                  input
                )
              }
              assetId = insertedAsset.id
            } else {
              assetId = identityResolution.assetId
            }

            representationId = identityResolution.representationId
            if (
              preparedClaim.representation !== null &&
              identityResolution.representationOutcome === "create"
            ) {
              if (identityResolution.blockchainId === null || assetId === null) {
                return { _tag: "invalid_claim" as const }
              }
              const [insertedRepresentation] = yield* tx
                .insert(schema.assetRepresentations)
                .values({
                  assetId,
                  blockchainId: identityResolution.blockchainId,
                  type: preparedClaim.representation.type,
                  contractAddress: preparedClaim.representation.contractAddress,
                  mintAddress: preparedClaim.representation.mintAddress,
                  decimals: preparedClaim.representation.decimals,
                  metadata: { authority: "human_asset_exception" },
                  createdAt: now,
                  updatedAt: now,
                })
                .returning({ id: schema.assetRepresentations.id })
              if (insertedRepresentation === undefined) {
                return yield* toStorageError(
                  "assetExceptionRepository.submitDecision.createRepresentation",
                  input
                )
              }
              representationId = insertedRepresentation.id
            }

            if (
              identityResolution.representationOutcome === "reassign" &&
              representationId !== null &&
              assetId !== null
            ) {
              const [currentRepresentation] = yield* tx
                .select({ assetId: schema.assetRepresentations.assetId })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, representationId))
                .for("update")
                .limit(1)
              if (currentRepresentation === undefined) {
                return { _tag: "invalid_claim" as const }
              }

              const [currentOwnership] = yield* tx
                .select({ id: schema.assetRepresentationOwnershipDecisions.id })
                .from(schema.assetRepresentationOwnershipDecisions)
                .where(
                  and(
                    eq(
                      schema.assetRepresentationOwnershipDecisions.assetRepresentationId,
                      representationId
                    ),
                    sql`not exists (
                      select 1
                      from ${schema.assetRepresentationOwnershipDecisions} next_ownership
                      where next_ownership.supersedes_decision_id = ${schema.assetRepresentationOwnershipDecisions.id}
                    )`
                  )
                )
                .orderBy(
                  desc(schema.assetRepresentationOwnershipDecisions.createdAt),
                  desc(schema.assetRepresentationOwnershipDecisions.id)
                )
                .for("update")
                .limit(1)

              const currentOwnershipId =
                currentOwnership?.id ??
                (yield* tx
                  .insert(schema.assetRepresentationOwnershipDecisions)
                  .values({
                    assetRepresentationId: representationId,
                    assetId: currentRepresentation.assetId,
                    policyRevision: HUMAN_POLICY_REVISION,
                    reason: "ownership_projection_baseline",
                    actor: "system:ownership-history-backfill",
                    createdAt: now,
                  })
                  .returning({ id: schema.assetRepresentationOwnershipDecisions.id })
                  .pipe(
                    Effect.flatMap(([baseline]) =>
                      baseline === undefined
                        ? toStorageError(
                            "assetExceptionRepository.submitDecision.ownershipBaseline",
                            { representationId }
                          )
                        : Effect.succeed(baseline.id)
                    )
                  ))

              yield* tx
                .update(schema.transfers)
                .set({ assetId, updatedAt: now })
                .where(eq(schema.transfers.assetRepresentationId, representationId))

              yield* tx
                .update(schema.transactionLegs)
                .set({ assetId, updatedAt: now })
                .where(eq(schema.transactionLegs.assetRepresentationId, representationId))

              yield* tx
                .update(schema.inventoryMovements)
                .set({ assetId, updatedAt: now })
                .where(eq(schema.inventoryMovements.assetRepresentationId, representationId))

              yield* tx
                .update(schema.providerAssetMappings)
                .set({ canonicalAssetId: assetId, updatedAt: now })
                .where(eq(schema.providerAssetMappings.assetRepresentationId, representationId))

              yield* tx
                .update(schema.assetRepresentations)
                .set({ assetId, updatedAt: now })
                .where(eq(schema.assetRepresentations.id, representationId))

              yield* tx.insert(schema.assetRepresentationOwnershipDecisions).values({
                assetRepresentationId: representationId,
                assetId,
                supersedesDecisionId: currentOwnershipId,
                policyRevision: HUMAN_POLICY_REVISION,
                reason: "human_ownership_correction",
                actor: actorId,
                createdAt: now,
              })
            }
          }

          const persistedClaim =
            preparedIdentityClaim?._tag === "prepared" ? preparedIdentityClaim.claim : input.claim

          const currentConclusion = detail.currentConclusion

          const [decision] = yield* tx
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: detail.providerAssetRowId,
              evidenceRevision: detail.evidenceRevision,
              policyRevision:
                detail.currentPolicyEvaluation?.policyRevision ?? HUMAN_POLICY_REVISION,
              outcome: input.claim._tag === "identity" ? "identity" : "excluded",
              supersedesDecisionId: currentConclusion?.id ?? null,
              assetId,
              assetRepresentationId: representationId,
              blockchain:
                persistedClaim._tag === "identity"
                  ? (persistedClaim.representation?.blockchain ?? null)
                  : null,
              representationType:
                persistedClaim._tag === "identity"
                  ? (persistedClaim.representation?.type ?? null)
                  : null,
              contractAddress:
                persistedClaim._tag === "identity"
                  ? (persistedClaim.representation?.contractAddress ?? null)
                  : null,
              mintAddress:
                persistedClaim._tag === "identity"
                  ? (persistedClaim.representation?.mintAddress ?? null)
                  : null,
              decimals:
                persistedClaim._tag === "identity"
                  ? (persistedClaim.representation?.decimals ?? null)
                  : null,
              reason: persistedClaim._tag === "exclusion" ? persistedClaim.reason : null,
              humanClaim: persistedClaim,
              rationale: input.rationale?.trim() || null,
              actor: actorId,
              createdAt: now,
            })
            .returning({ id: schema.assetResolutionDecisions.id })
          if (decision === undefined) {
            return yield* toStorageError(
              "assetExceptionRepository.submitDecision.insertDecision",
              input
            )
          }

          yield* tx
            .insert(schema.assetResolutionCurrentState)
            .values({
              providerAssetRowId: detail.providerAssetRowId,
              currentConclusionId: currentConclusion?.id ?? null,
              currentPolicyEvaluationId: detail.currentPolicyEvaluation?.id ?? null,
              updatedAt: now,
            })
            .onConflictDoNothing({
              target: schema.assetResolutionCurrentState.providerAssetRowId,
            })

          const conclusionCondition =
            currentConclusion === null
              ? isNull(schema.assetResolutionCurrentState.currentConclusionId)
              : eq(schema.assetResolutionCurrentState.currentConclusionId, currentConclusion.id)
          const policyEvaluationCondition =
            detail.currentPolicyEvaluation === null
              ? isNull(schema.assetResolutionCurrentState.currentPolicyEvaluationId)
              : eq(
                  schema.assetResolutionCurrentState.currentPolicyEvaluationId,
                  detail.currentPolicyEvaluation.id
                )
          const [updatedCurrentState] = yield* tx
            .update(schema.assetResolutionCurrentState)
            .set({ currentConclusionId: decision.id, updatedAt: now })
            .where(
              and(
                eq(
                  schema.assetResolutionCurrentState.providerAssetRowId,
                  detail.providerAssetRowId
                ),
                conclusionCondition,
                policyEvaluationCondition
              )
            )
            .returning({
              providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId,
            })
          if (updatedCurrentState === undefined) {
            return yield* new StaleAssetDecisionTransaction({
              providerAssetRowId: detail.providerAssetRowId,
            })
          }

          yield* tx.insert(schema.assetResolutionDecisionEvidenceLinks).values(
            input.evidenceSnapshotIds.map((evidenceId) => ({
              decisionId: decision.id,
              evidenceId,
              createdAt: now,
            }))
          )

          const relatedConclusions = yield* Effect.forEach(
            affectedProviderAssetRowIds.filter(
              (providerAssetRowId) => providerAssetRowId !== detail.providerAssetRowId
            ),
            (providerAssetRowId) =>
              Effect.gen(function* () {
                const relatedDetail = affectedDetailsByProviderAssetRowId.get(providerAssetRowId)
                if (relatedDetail === undefined) {
                  return yield* toStorageError(
                    "assetExceptionRepository.submitDecision.relatedDetail",
                    { providerAssetRowId }
                  )
                }
                const [relatedDecision] = yield* tx
                  .insert(schema.assetResolutionDecisions)
                  .values({
                    providerAssetRowId,
                    evidenceRevision: relatedDetail.evidenceRevision,
                    policyRevision:
                      relatedDetail.currentPolicyEvaluation?.policyRevision ??
                      HUMAN_POLICY_REVISION,
                    outcome: "identity",
                    supersedesDecisionId: relatedDetail.currentConclusion?.id ?? null,
                    assetId,
                    assetRepresentationId: representationId,
                    blockchain:
                      persistedClaim._tag === "identity"
                        ? (persistedClaim.representation?.blockchain ?? null)
                        : null,
                    representationType:
                      persistedClaim._tag === "identity"
                        ? (persistedClaim.representation?.type ?? null)
                        : null,
                    contractAddress:
                      persistedClaim._tag === "identity"
                        ? (persistedClaim.representation?.contractAddress ?? null)
                        : null,
                    mintAddress:
                      persistedClaim._tag === "identity"
                        ? (persistedClaim.representation?.mintAddress ?? null)
                        : null,
                    decimals:
                      persistedClaim._tag === "identity"
                        ? (persistedClaim.representation?.decimals ?? null)
                        : null,
                    humanClaim: persistedClaim,
                    rationale: input.rationale?.trim() || null,
                    actor: actorId,
                    createdAt: now,
                  })
                  .returning({ id: schema.assetResolutionDecisions.id })
                if (relatedDecision === undefined) {
                  return yield* toStorageError(
                    "assetExceptionRepository.submitDecision.relatedConclusion",
                    { providerAssetRowId }
                  )
                }

                if (relatedDetail.evidence.length > 0) {
                  yield* tx.insert(schema.assetResolutionDecisionEvidenceLinks).values(
                    relatedDetail.evidence.map(({ id: evidenceId }) => ({
                      decisionId: relatedDecision.id,
                      evidenceId,
                      createdAt: now,
                    }))
                  )
                }
                const [insertedCurrentState] = yield* tx
                  .insert(schema.assetResolutionCurrentState)
                  .values({
                    providerAssetRowId,
                    currentConclusionId: relatedDecision.id,
                    currentPolicyEvaluationId: relatedDetail.currentPolicyEvaluation?.id ?? null,
                    updatedAt: now,
                  })
                  .onConflictDoNothing({
                    target: schema.assetResolutionCurrentState.providerAssetRowId,
                  })
                  .returning({
                    providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId,
                  })
                if (insertedCurrentState === undefined) {
                  const relatedConclusionCondition =
                    relatedDetail.currentConclusion === null
                      ? isNull(schema.assetResolutionCurrentState.currentConclusionId)
                      : eq(
                          schema.assetResolutionCurrentState.currentConclusionId,
                          relatedDetail.currentConclusion.id
                        )
                  const relatedPolicyEvaluationCondition =
                    relatedDetail.currentPolicyEvaluation === null
                      ? isNull(schema.assetResolutionCurrentState.currentPolicyEvaluationId)
                      : eq(
                          schema.assetResolutionCurrentState.currentPolicyEvaluationId,
                          relatedDetail.currentPolicyEvaluation.id
                        )
                  const [updatedRelatedCurrentState] = yield* tx
                    .update(schema.assetResolutionCurrentState)
                    .set({ currentConclusionId: relatedDecision.id, updatedAt: now })
                    .where(
                      and(
                        eq(
                          schema.assetResolutionCurrentState.providerAssetRowId,
                          providerAssetRowId
                        ),
                        relatedConclusionCondition,
                        relatedPolicyEvaluationCondition
                      )
                    )
                    .returning({
                      providerAssetRowId: schema.assetResolutionCurrentState.providerAssetRowId,
                    })
                  if (updatedRelatedCurrentState === undefined) {
                    return yield* new StaleAssetDecisionTransaction({ providerAssetRowId })
                  }
                }

                return { decisionId: relatedDecision.id, providerAssetRowId }
              })
          )

          yield* tx
            .insert(schema.providerAssetMappings)
            .values({
              providerAssetRowId: detail.providerAssetRowId,
              mappingKind: "asset",
              canonicalAssetId: assetId,
              assetRepresentationId: representationId,
              canonicalFiatCurrency: null,
              mappingStatus: input.claim._tag === "identity" ? "approved" : "excluded",
              reviewerNotes: input.rationale?.trim() || null,
              sourceNotes: `Human asset exception decision ${decision.id}.`,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: schema.providerAssetMappings.providerAssetRowId,
              set: {
                mappingKind: "asset",
                canonicalAssetId: assetId,
                assetRepresentationId: representationId,
                canonicalFiatCurrency: null,
                mappingStatus: input.claim._tag === "identity" ? "approved" : "excluded",
                reviewerNotes: input.rationale?.trim() || null,
                sourceNotes: `Human asset exception decision ${decision.id}.`,
                updatedAt: now,
              },
            })

          yield* scheduleRematerialization({
            tx,
            providerAssetRowIds: affectedProviderAssetRowIds,
            decisionId: decision.id,
            now,
          })
          yield* Effect.forEach(
            relatedConclusions,
            ({ decisionId: relatedDecisionId }) =>
              scheduleRematerialization({
                tx,
                providerAssetRowIds: affectedProviderAssetRowIds,
                decisionId: relatedDecisionId,
                now,
              }),
            { discard: true }
          )

          return { _tag: "accepted_pending_detail" as const }
        })
      )
      .pipe(
        Effect.catch((cause) =>
          cause instanceof StaleAssetDecisionTransaction
            ? Effect.succeed({
                _tag: "stale_after_cas" as const,
                providerAssetRowId: cause.providerAssetRowId,
              })
            : Effect.fail(cause)
        ),
        Effect.mapError((cause) =>
          Schema.is(SyncEngineStorageError)(cause)
            ? cause
            : toStorageError("assetExceptionRepository.submitDecision", cause)
        )
      )

    return persisted.pipe(
      Effect.flatMap((result): Effect.Effect<AssetExceptionDecisionResult, unknown, never> => {
        if (result._tag === "stale_after_cas") {
          return loadDetail(db, {
            _tag: "row_id",
            providerAssetRowId: result.providerAssetRowId,
          }).pipe(
            Effect.map((latest) =>
              Option.match(latest, {
                onNone: () => ({ _tag: "not_found" as const }),
                onSome: (detail) => ({
                  _tag: "stale_revision" as const,
                  evidenceRevision: detail.evidenceRevision,
                  currentConclusionRevision: detail.currentConclusionRevision,
                  currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
                }),
              })
            )
          )
        }
        if (result._tag !== "accepted_pending_detail") {
          return Effect.succeed(result)
        }
        return loadDetail(db, {
          _tag: "row_id",
          providerAssetRowId: input.providerAssetRowId,
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  toStorageError("assetExceptionRepository.submitDecision.reload", input)
                ),
              onSome: (detail) => Effect.succeed({ _tag: "accepted" as const, detail }),
            })
          )
        )
      }),
      Effect.mapError((cause) =>
        Schema.is(SyncEngineStorageError)(cause)
          ? cause
          : toStorageError("assetExceptionRepository.submitDecision", cause)
      )
    )
  }

  const findDetail: AssetExceptionRepositoryShape["findDetail"] = (lookup) =>
    loadDetail(db, lookup).pipe(
      Effect.mapError((cause) => toStorageError("assetExceptionRepository.findDetail", cause))
    )

  return AssetExceptionRepository.of({
    listExceptions,
    findDetail,
    previewDecision,
    submitDecision,
  })
})

/** Live PostgreSQL implementation of the asset exception review contract. */
export const AssetExceptionRepositoryLive = Layer.effect(AssetExceptionRepository, make)
