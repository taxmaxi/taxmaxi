/**
 * AssetExceptionRepositoryLive - Ranked asset exceptions and atomic human decisions.
 *
 * @module AssetExceptionRepositoryLive
 */

import {
  assetExceptionSeverityForReason,
  AssetExceptionClaim,
  AssetExceptionReason,
  NO_ACTIVE_ASSET_DECISION,
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
  type AssetExceptionRankCursor,
  type AssetExceptionRematerializationSummary,
  type AssetExceptionRepositoryShape,
  SyncEngineStorageError,
} from "@my/sync-engine/services"
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { drizzle } from "./PgClientLive.ts"
import { nowDate } from "./SyncEngineRepositorySupport.ts"
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
] as const

const HUMAN_POLICY_REVISION = "2026-08-21.human-asset-exception.1"

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

type InputValidationResult =
  | { readonly _tag: "valid" }
  | { readonly _tag: "invalid_evidence" }
  | {
      readonly _tag: "stale_revision"
      readonly evidenceRevision: number
      readonly activeDecisionRevision: string
    }

type IdentityResolution =
  | { readonly _tag: "ambiguous_identity" }
  | { readonly _tag: "invalid_claim" }
  | {
      readonly _tag: "resolved"
      readonly assetId: string | null
      readonly assetOutcome: "reuse" | "create"
      readonly representationId: string | null
      readonly representationOutcome: "none" | "reuse" | "create"
      readonly blockchainId: string | null
    }

type SubmitTransactionResult =
  | Exclude<AssetExceptionDecisionResult, { readonly _tag: "accepted" }>
  | { readonly _tag: "accepted_pending_detail" }

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
      if (detail.provider === "helius-solana" || claim.representation === null) {
        return true
      }

      const representation = claim.representation
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

      return observations.some(
        (observation) =>
          observation.blockchain.toLowerCase() === representation.blockchain.toLowerCase() &&
          observation.type === representation.type &&
          observation.contractAddress?.toLowerCase() ===
            representation.contractAddress?.toLowerCase() &&
          observation.mintAddress === representation.mintAddress &&
          observation.decimals === representation.decimals
      )
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

  // Asset exceptions block the per-source report projection until every affected source is rebuilt.
  const blockedReportsSql = affectedSourcesSql

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
    select count(distinct ${schema.providerTransfers.transactionId})::int
    from ${schema.providerTransfers}
    where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
  )`

  const affectedValueEurSql = sql<string | null>`(
    select sum(abs((affected_transactions.metadata -> 'nativeAmount' ->> 'amount')::numeric))::text
    from (
      select distinct ${schema.transactions.id}, ${schema.transactions.metadata}
      from ${schema.providerTransfers}
      inner join ${schema.transactions}
        on ${schema.transactions.id} = ${schema.providerTransfers.transactionId}
      where ${schema.providerTransfers.providerAssetId} = ${schema.providerAssets.id}
        and upper(${schema.transactions.metadata} -> 'nativeAmount' ->> 'currency') = 'EUR'
        and (${schema.transactions.metadata} -> 'nativeAmount' ->> 'amount') ~ '^-?[0-9]+(\\.[0-9]+)?$'
    ) affected_transactions
  )`

  const severityRankSql = sql<number>`case ${schema.assetResolutionDecisions.reason}
    when 'ownership_conflict' then 0
    when 'conflicting_evidence' then 0
    when 'incompatible_decimals' then 1
    when 'incompatible_type' then 1
    when 'display_collision' then 2
    when 'non_exact_platform_match' then 2
    when 'spam_evidence' then 3
    when 'unsupported_representation_type' then 3
    else 4 end`

  const rankAfterCursor = (cursor: AssetExceptionRankCursor) => sql`row(
    -${blockedReportsSql},
    -${affectedPrincipalsSql},
    -${affectedTransactionsSql},
    case when ${affectedValueEurSql} is null then 1 else 0 end,
    -coalesce((${affectedValueEurSql})::numeric, 0),
    ${severityRankSql},
    ${schema.providerAssets.discoveredAt},
    ${schema.providerAssets.id}
  ) > row(
    -${cursor.blockedReports},
    -${cursor.affectedPrincipals},
    -${cursor.affectedTransactions},
    ${cursor.affectedTransactionValueEur === null ? 1 : 0},
    -${cursor.affectedTransactionValueEur ?? "0"}::numeric,
    ${severityRank(cursor.severity)},
    ${cursor.oldestAt},
    ${cursor.providerAssetRowId}::uuid
  )`

  const listExceptions: AssetExceptionRepositoryShape["listExceptions"] = ({ cursor, limit }) =>
    db
      .select({
        providerAssetRowId: schema.providerAssets.id,
        provider: schema.providerAssets.provider,
        providerAssetId: schema.providerAssets.providerAssetId,
        naturalKey: schema.providerAssets.naturalKey,
        currencyCode: schema.providerAssets.currencyCode,
        name: schema.providerAssets.name,
        providerType: schema.providerAssets.providerType,
        reason: schema.assetResolutionDecisions.reason,
        evidenceRevision: schema.providerAssets.evidenceRevision,
        policyRevision: schema.assetResolutionDecisions.policyRevision,
        activeDecisionRevision: schema.assetResolutionDecisions.id,
        blockedReports: blockedReportsSql,
        affectedPrincipals: affectedPrincipalsSql,
        affectedTransactions: affectedTransactionsSql,
        affectedSources: affectedSourcesSql,
        affectedTransactionValueEur: affectedValueEurSql,
        severityRank: severityRankSql,
        oldestAt: schema.providerAssets.discoveredAt,
      })
      .from(schema.providerAssets)
      .innerJoin(
        schema.assetResolutionJobs,
        and(
          eq(schema.assetResolutionJobs.providerAssetRowId, schema.providerAssets.id),
          eq(schema.assetResolutionJobs.evidenceRevision, schema.providerAssets.evidenceRevision),
          eq(schema.assetResolutionJobs.status, "completed")
        )
      )
      .innerJoin(
        schema.assetResolutionDecisions,
        and(
          eq(schema.assetResolutionDecisions.providerAssetRowId, schema.providerAssets.id),
          eq(
            schema.assetResolutionDecisions.evidenceRevision,
            schema.providerAssets.evidenceRevision
          ),
          eq(schema.assetResolutionDecisions.status, "active"),
          inArray(schema.assetResolutionDecisions.outcome, ["pending", "fail_closed"]),
          inArray(schema.assetResolutionDecisions.reason, [...ACTIONABLE_REASONS])
        )
      )
      .where(cursor === null ? undefined : rankAfterCursor(cursor))
      .orderBy(
        desc(blockedReportsSql),
        desc(affectedPrincipalsSql),
        desc(affectedTransactionsSql),
        asc(sql`case when ${affectedValueEurSql} is null then 1 else 0 end`),
        desc(sql`(${affectedValueEurSql})::numeric`),
        asc(severityRankSql),
        asc(schema.providerAssets.discoveredAt),
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
                activeDecisionRevision: row.activeDecisionRevision,
                blockedReports: row.blockedReports,
                affectedPrincipals: row.affectedPrincipals,
                affectedTransactions: row.affectedTransactions,
                affectedSources: row.affectedSources,
                affectedTransactionValueEur: row.affectedTransactionValueEur,
                oldestAt: row.oldestAt,
              }))
            )
          )
        ),
        Effect.mapError((cause) => toStorageError("assetExceptionRepository.listExceptions", cause))
      )

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
              affectedTransactionValueEur: null,
            }
        )
      )

  const loadDecisionHistory = (
    client: QueryClient,
    providerAssetRowId: string
  ): Effect.Effect<ReadonlyArray<AssetExceptionDecisionHistory>, unknown, never> =>
    Effect.gen(function* () {
      const rows = yield* client
        .select({
          id: schema.assetResolutionDecisions.id,
          status: schema.assetResolutionDecisions.status,
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

      const evidenceIdsByDecision = new Map<string, Array<string>>()
      for (const link of links) {
        const evidenceIds = evidenceIdsByDecision.get(link.decisionId) ?? []
        evidenceIds.push(link.evidenceId)
        evidenceIdsByDecision.set(link.decisionId, evidenceIds)
      }

      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const claim =
            row.humanClaim === null
              ? null
              : yield* Schema.decodeUnknownEffect(AssetExceptionClaim)(row.humanClaim)

          return {
            id: row.id,
            status: row.status,
            supersedesDecisionId: row.supersedesDecisionId,
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
          } satisfies AssetExceptionDecisionHistory
        })
      )
    })

  const loadRematerialization = (
    client: QueryClient,
    activeDecisionId: string | null
  ): Effect.Effect<AssetExceptionRematerializationSummary, unknown> => {
    if (activeDecisionId === null) {
      return Effect.succeed({
        status: "complete",
        affectedSourceCount: 0,
        failedSourceCount: 0,
        lastFailureAt: null,
        failureCode: null,
      })
    }

    return client
      .select({
        storedStatus: schema.assetDecisionRematerializations.status,
        failureCode: schema.assetDecisionRematerializations.failureCode,
        lastFailureAt: schema.assetDecisionRematerializations.lastFailureAt,
        jobStatus: schema.processingJobs.status,
        followUpMode: schema.processingJobs.followUpMode,
        followUpJobId: schema.processingJobs.followUpJobId,
        followUpStatus: sql<
          "pending" | "processing" | "completed" | "failed" | "credit_required" | null
        >`(
          select follow_up.status
          from ${schema.processingJobs} follow_up
          where follow_up.id = ${schema.processingJobs.followUpJobId}
        )`,
        followUpCompletedAt: sql<Date | null>`(
          select follow_up.completed_at
          from ${schema.processingJobs} follow_up
          where follow_up.id = ${schema.processingJobs.followUpJobId}
        )`,
        followUpCreditReasonCode: sql<string | null>`(
          select follow_up.credit_reason_code
          from ${schema.processingJobs} follow_up
          where follow_up.id = ${schema.processingJobs.followUpJobId}
        )`,
        jobStartedAt: schema.processingJobs.startedAt,
        jobCompletedAt: schema.processingJobs.completedAt,
        creditReasonCode: schema.processingJobs.creditReasonCode,
      })
      .from(schema.assetDecisionRematerializations)
      .leftJoin(
        schema.processingJobs,
        eq(schema.processingJobs.id, schema.assetDecisionRematerializations.processingJobId)
      )
      .where(eq(schema.assetDecisionRematerializations.decisionId, activeDecisionId))
      .pipe(
        Effect.map((rows): AssetExceptionRematerializationSummary => {
          if (rows.length === 0) {
            return {
              status: "complete",
              affectedSourceCount: 0,
              failedSourceCount: 0,
              lastFailureAt: null,
              failureCode: null,
            }
          }

          const effectiveStatus = (row: (typeof rows)[number]) => {
            if (row.storedStatus === "operator_attention") {
              return "operator_attention" as const
            }
            if (
              row.followUpMode === "replay" &&
              row.followUpJobId === null &&
              row.jobStatus === "completed"
            ) {
              return "pending" as const
            }
            switch (row.followUpStatus ?? row.jobStatus) {
              case "failed":
              case "credit_required":
                return "operator_attention" as const
              case "processing":
                return "running" as const
              case "pending":
                return "pending" as const
              case "completed":
                return "complete" as const
              case null:
                return row.storedStatus
            }
          }
          const failed = rows.filter((row) => effectiveStatus(row) === "operator_attention")
          const running = rows.some((row) => effectiveStatus(row) === "running")
          const pending = rows.some((row) => effectiveStatus(row) === "pending")
          const lastFailureAt =
            failed
              .flatMap((row) => {
                const failedAt =
                  row.lastFailureAt ??
                  (row.followUpStatus === "failed" || row.followUpStatus === "credit_required"
                    ? row.followUpCompletedAt
                    : row.jobCompletedAt)
                return failedAt === null ? [] : [failedAt]
              })
              .sort((left, right) => right.getTime() - left.getTime())[0] ?? null

          return {
            status:
              failed.length > 0
                ? "operator_attention"
                : running
                  ? "running"
                  : pending
                    ? "pending"
                    : "complete",
            affectedSourceCount: rows.length,
            failedSourceCount: failed.length,
            lastFailureAt,
            failureCode:
              failed[0]?.failureCode ??
              failed[0]?.followUpCreditReasonCode ??
              failed[0]?.creditReasonCode ??
              (failed.length > 0 ? "rematerialization_failed" : null),
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
      const activeHumanDecision =
        history.find((decision) => decision.status === "active" && decision.claim !== null) ?? null
      const policyDecision =
        [...history]
          .reverse()
          .find(
            (decision) =>
              decision.claim === null &&
              decision.evidenceRevision === providerAsset.evidenceRevision
          ) ?? null
      const activeDecision =
        activeHumanDecision ??
        history.find(
          (decision) =>
            decision.status === "active" &&
            decision.claim === null &&
            decision.evidenceRevision === providerAsset.evidenceRevision
        ) ??
        null
      const evidence =
        policyDecision === null
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
              .where(eq(schema.assetResolutionEvidence.decisionId, policyDecision.id))
              .orderBy(
                asc(schema.assetResolutionEvidence.authority),
                asc(schema.assetResolutionEvidence.claimKind)
              )
      const impact = yield* loadImpact(client, providerAsset.id)
      const rematerialization = yield* loadRematerialization(client, activeDecision?.id ?? null)

      const reviewStatus = (() => {
        if (activeDecision?.outcome === "excluded") {
          return "excluded" as const
        }
        if (
          activeDecision !== null &&
          !["pending", "fail_closed"].includes(activeDecision.outcome)
        ) {
          return "approved" as const
        }
        return "unresolved" as const
      })()

      const policyOutput = (() => {
        if (policyDecision === null) {
          return null
        }
        switch (policyDecision.outcome) {
          case "attach":
          case "create_standalone":
          case "excluded":
          case "pending":
          case "fail_closed":
            return { outcome: policyDecision.outcome, reason: policyDecision.reason }
          case "identity":
            return null
        }
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
        policyRevision: policyDecision?.policyRevision ?? HUMAN_POLICY_REVISION,
        activeDecisionRevision: activeDecision?.id ?? NO_ACTIVE_ASSET_DECISION,
        reviewStatus,
        policyOutput,
        activeDecision,
        decisionHistory: history,
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
        input.activeDecisionRevision !== detail.activeDecisionRevision
      ) {
        return {
          _tag: "stale_revision" as const,
          evidenceRevision: detail.evidenceRevision,
          activeDecisionRevision: detail.activeDecisionRevision,
        }
      }

      if (input.rationale.trim().length === 0 || input.evidenceSnapshotIds.length === 0) {
        return { _tag: "invalid_evidence" as const }
      }

      const uniqueEvidenceIds = [...new Set(input.evidenceSnapshotIds)]
      if (uniqueEvidenceIds.length !== input.evidenceSnapshotIds.length) {
        return { _tag: "invalid_evidence" as const }
      }

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
            eq(schema.assetResolutionEvidence.evidenceRevision, detail.evidenceRevision),
            eq(schema.assetResolutionDecisions.providerAssetRowId, detail.providerAssetRowId)
          )
        )

      if (evidenceRows.length !== uniqueEvidenceIds.length) {
        return { _tag: "invalid_evidence" as const }
      }

      return { _tag: "valid" as const }
    })

  const resolveIdentity = (
    client: QueryClient,
    claim: Extract<AssetExceptionDecisionInput["claim"], { readonly _tag: "identity" }>
  ): Effect.Effect<IdentityResolution, unknown, never> =>
    Effect.gen(function* () {
      const representation = claim.representation
      const blockchainRows =
        representation === null
          ? []
          : yield* client
              .select({ id: schema.blockchains.id })
              .from(schema.blockchains)
              .where(
                eq(sql`lower(${schema.blockchains.name})`, representation.blockchain.toLowerCase())
              )
              .limit(2)
      if (representation !== null && blockchainRows.length !== 1) {
        return { _tag: "invalid_claim" as const }
      }

      const blockchainId = blockchainRows[0]?.id ?? null
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
                    : eq(
                        sql`lower(${schema.assetRepresentations.contractAddress})`,
                        representation.contractAddress.toLowerCase()
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
        if (representationRows.some((row) => row.assetId !== claim.assetId)) {
          return { _tag: "ambiguous_identity" as const }
        }

        return {
          _tag: "resolved" as const,
          assetId: claim.assetId,
          assetOutcome: "reuse" as const,
          representationId: representationRows[0]?.id ?? null,
          representationOutcome:
            representation === null
              ? ("none" as const)
              : representationRows.length === 1
                ? ("reuse" as const)
                : ("create" as const),
          blockchainId,
        }
      }

      const newAsset = claim.newAsset
      if (newAsset === null) {
        return { _tag: "invalid_claim" as const }
      }

      const displayMatches = yield* client
        .select({ id: schema.assets.id })
        .from(schema.assets)
        .where(
          and(
            eq(sql`lower(${schema.assets.name})`, newAsset.name.toLowerCase()),
            eq(sql`lower(${schema.assets.symbol})`, newAsset.symbol.toLowerCase()),
            eq(schema.assets.type, newAsset.type)
          )
        )
        .limit(2)
      if (representationRows.length === 0 && displayMatches.length > 0) {
        return { _tag: "ambiguous_identity" as const }
      }

      const existingAssetId = representationRows[0]?.assetId ?? null
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
        assetId: existingAssetId,
        assetOutcome: existingAssetId === null ? ("create" as const) : ("reuse" as const),
        representationId: representationRows[0]?.id ?? null,
        representationOutcome:
          representation === null
            ? ("none" as const)
            : representationRows.length === 1
              ? ("reuse" as const)
              : ("create" as const),
        blockchainId,
      }
    })

  const lockIdentityResolution = ({
    claim,
    tx,
  }: {
    readonly claim: Extract<AssetExceptionDecisionInput["claim"], { readonly _tag: "identity" }>
    readonly tx: DbTransactionClient
  }): Effect.Effect<void, unknown> => {
    const representation = claim.representation
    const keys = [
      claim.assetId === null ? null : `asset:${claim.assetId}`,
      claim.newAsset === null
        ? null
        : `display:${claim.newAsset.name.toLowerCase()}:${claim.newAsset.symbol.toLowerCase()}:${claim.newAsset.type}`,
      representation === null
        ? null
        : `representation:${representation.blockchain.toLowerCase()}:${representation.contractAddress?.toLowerCase() ?? ""}:${representation.mintAddress ?? ""}`,
    ]
      .filter((key): key is string => key !== null)
      .sort((left, right) => left.localeCompare(right))

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
      const decisionAction =
        detail.activeDecision?.claim === null || detail.activeDecision?.claim === undefined
          ? ("initial" as const)
          : detail.activeDecision.claim._tag === input.claim._tag
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
            supersededDecision: detail.activeDecision,
            impact: detail.impact,
            rematerializationSourceCount: detail.impact.affectedSources,
            evidenceRevision: detail.evidenceRevision,
            activeDecisionRevision: detail.activeDecisionRevision,
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

      return {
        _tag: "ready" as const,
        preview: {
          claim: input.claim,
          decisionAction,
          resultingAssetId: resolution.assetId,
          assetOutcome: resolution.assetOutcome,
          representationOutcome: resolution.representationOutcome,
          supersededDecision: detail.activeDecision,
          impact: detail.impact,
          rematerializationSourceCount: detail.impact.affectedSources,
          evidenceRevision: detail.evidenceRevision,
          activeDecisionRevision: detail.activeDecisionRevision,
        },
      }
    }).pipe(
      Effect.mapError((cause) => toStorageError("assetExceptionRepository.previewDecision", cause))
    )

  const scheduleRematerialization = ({
    tx,
    providerAssetRowId,
    decisionId,
    now,
  }: {
    readonly tx: DbTransactionClient
    readonly providerAssetRowId: string
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
        .where(
          inArray(
            schema.sources.id,
            sql`(
              select ${schema.providerAssetSourceUses.sourceId}
              from ${schema.providerAssetSourceUses}
              where ${schema.providerAssetSourceUses.providerAssetRowId} = ${providerAssetRowId}::uuid
              union
              select ${schema.providerTransfers.sourceId}
              from ${schema.providerTransfers}
              where ${schema.providerTransfers.providerAssetId} = ${providerAssetRowId}::uuid
            )`
          )
        )
        .orderBy(asc(schema.sources.id))

      yield* Effect.forEach(sourceRows, ({ sourceId, principalId }) =>
        Effect.gen(function* () {
          const requestReplay = (attemptsRemaining: number): Effect.Effect<string, unknown> =>
            Effect.gen(function* () {
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
        cause instanceof SyncEngineStorageError
          ? cause
          : toStorageError("assetExceptionRepository.scheduleRematerialization", cause)
      )
    )

  const submitDecision: AssetExceptionRepositoryShape["submitDecision"] = ({ input, actorId }) => {
    const persisted: Effect.Effect<SubmitTransactionResult, SyncEngineStorageError, never> = db
      .transaction((tx) =>
        Effect.gen(function* () {
          const [lockedProviderAsset] = yield* tx
            .select({ id: schema.providerAssets.id })
            .from(schema.providerAssets)
            .where(eq(schema.providerAssets.id, input.providerAssetRowId))
            .for("update")
            .limit(1)
          if (lockedProviderAsset === undefined) {
            return { _tag: "not_found" as const }
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

          if (input.claim._tag === "identity") {
            if (
              !(yield* isClaimCompatibleWithObservedRepresentation({
                client: tx,
                detail,
                claim: input.claim,
              }))
            ) {
              return { _tag: "invalid_claim" as const }
            }
            yield* lockIdentityResolution({ claim: input.claim, tx })
          }
          const identityResolution =
            input.claim._tag === "identity" ? yield* resolveIdentity(tx, input.claim) : null
          if (identityResolution !== null && identityResolution._tag !== "resolved") {
            return identityResolution
          }
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

          if (input.claim._tag === "identity" && identityResolution?._tag === "resolved") {
            if (identityResolution.assetId === null) {
              const newAsset = input.claim.newAsset
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
              input.claim.representation !== null &&
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
                  type: input.claim.representation.type,
                  contractAddress: input.claim.representation.contractAddress,
                  mintAddress: input.claim.representation.mintAddress,
                  decimals: input.claim.representation.decimals,
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
          }

          const activeDecision = detail.activeDecision
          if (activeDecision !== null) {
            const superseded = yield* tx
              .update(schema.assetResolutionDecisions)
              .set({ status: "superseded" })
              .where(
                and(
                  eq(schema.assetResolutionDecisions.id, activeDecision.id),
                  eq(schema.assetResolutionDecisions.status, "active")
                )
              )
              .returning({ id: schema.assetResolutionDecisions.id })
            if (superseded.length !== 1) {
              return {
                _tag: "stale_revision" as const,
                evidenceRevision: detail.evidenceRevision,
                activeDecisionRevision: detail.activeDecisionRevision,
              }
            }
          }

          const [decision] = yield* tx
            .insert(schema.assetResolutionDecisions)
            .values({
              providerAssetRowId: detail.providerAssetRowId,
              evidenceRevision: detail.evidenceRevision,
              policyRevision: detail.policyRevision,
              outcome: input.claim._tag === "identity" ? "identity" : "excluded",
              status: "active",
              supersedesDecisionId: activeDecision?.id ?? null,
              assetId,
              assetRepresentationId: representationId,
              blockchain:
                input.claim._tag === "identity"
                  ? (input.claim.representation?.blockchain ?? null)
                  : null,
              representationType:
                input.claim._tag === "identity" ? (input.claim.representation?.type ?? null) : null,
              contractAddress:
                input.claim._tag === "identity"
                  ? (input.claim.representation?.contractAddress ?? null)
                  : null,
              mintAddress:
                input.claim._tag === "identity"
                  ? (input.claim.representation?.mintAddress ?? null)
                  : null,
              decimals:
                input.claim._tag === "identity"
                  ? (input.claim.representation?.decimals ?? null)
                  : null,
              reason: input.claim._tag === "exclusion" ? input.claim.reason : null,
              humanClaim: input.claim,
              rationale: input.rationale.trim(),
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

          yield* tx.insert(schema.assetResolutionDecisionEvidenceLinks).values(
            input.evidenceSnapshotIds.map((evidenceId) => ({
              decisionId: decision.id,
              evidenceId,
              createdAt: now,
            }))
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
              reviewerNotes: input.rationale.trim(),
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
                reviewerNotes: input.rationale.trim(),
                sourceNotes: `Human asset exception decision ${decision.id}.`,
                updatedAt: now,
              },
            })

          yield* scheduleRematerialization({
            tx,
            providerAssetRowId: detail.providerAssetRowId,
            decisionId: decision.id,
            now,
          })

          return { _tag: "accepted_pending_detail" as const }
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof SyncEngineStorageError
            ? cause
            : toStorageError("assetExceptionRepository.submitDecision", cause)
        )
      )

    return persisted.pipe(
      Effect.flatMap((result): Effect.Effect<AssetExceptionDecisionResult, unknown, never> => {
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
        cause instanceof SyncEngineStorageError
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
