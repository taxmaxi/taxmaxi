/**
 * TaxCalculationServiceLive - Drizzle-backed tax summary aggregation.
 *
 * Validates that source-scoped tax inputs are complete and consistently valued
 * in the reporting currency before producing a deterministic yearly summary.
 *
 * @module TaxCalculationServiceLive
 */

import {
  and,
  count,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm"
import { EUR } from "@my/core/currency"
import { withObservedOperation } from "@my/core/shared/observability/ObservedOperation"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import { SourceNotFoundError } from "@my/sync-engine/services"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  TaxCalculationIncompleteDataError,
  TaxCalculationPendingObservationsError,
  TaxCalculationService,
  TaxCalculationUnsupportedCurrencyError,
  UnsupportedJurisdictionError,
  type TaxCalculationServiceError,
  type TaxCalculationServiceShape,
} from "../services/TaxCalculationService.ts"
import { drizzle } from "./PgClientLive.ts"

const HOLDING_PERIOD_YEARS = 1
const SUPPORTED_JURISDICTION = "germany"
const REPORTING_CURRENCY = EUR
const BLOCKING_OBSERVATION_LIST_LIMIT = 50
const taxCalculationOutcomeMetric = Metric.frequency("taxmaxi_tax_calculation_outcomes", {
  description: "Outcome frequencies for source-scoped tax calculations.",
})
const taxCalculationDurationMetric = Metric.timer("taxmaxi_tax_calculation_duration", {
  description: "Duration of successful source-scoped tax calculations.",
})

interface DisposalMatchRow {
  readonly disposalLegId: string
  readonly fifoLotId: string
  readonly gainLoss: unknown
  readonly acquiredAt: Date
  readonly disposedAt: Date
  readonly disposalCurrency: string | null
  readonly costBasisCurrency: string
}

interface IncomeLegRow {
  readonly legId: string
  readonly fiatAmount: unknown
  readonly fiatCurrency: string | null
}

interface TaxSummaryTotals {
  readonly taxableGains: BigDecimal.BigDecimal
  readonly taxableLosses: BigDecimal.BigDecimal
  readonly taxFreeGains: BigDecimal.BigDecimal
}

const zeroAmount = (): BigDecimal.BigDecimal => BigDecimal.fromBigInt(0n)

const emptyTotals = (): TaxSummaryTotals => ({
  taxableGains: zeroAmount(),
  taxableLosses: zeroAmount(),
  taxFreeGains: zeroAmount(),
})

const startOfYearUtc = (year: number): Date => new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0))

const endOfYearUtc = (year: number): Date => new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0))

const holdingPeriodEnd = (acquiredAt: Date): Date => {
  const end = new Date(acquiredAt.getTime())
  end.setUTCFullYear(end.getUTCFullYear() + HOLDING_PERIOD_YEARS)
  return end
}

const isTaxFreeDisposal = ({
  acquiredAt,
  disposedAt,
}: Pick<DisposalMatchRow, "acquiredAt" | "disposedAt">): boolean =>
  disposedAt.getTime() >= holdingPeriodEnd(acquiredAt).getTime()

const normalizeTaxCalculationError = (error: unknown): TaxCalculationServiceError =>
  error instanceof SourceNotFoundError ||
  error instanceof UnsupportedJurisdictionError ||
  error instanceof TaxCalculationIncompleteDataError ||
  error instanceof TaxCalculationPendingObservationsError ||
  error instanceof TaxCalculationUnsupportedCurrencyError ||
  error instanceof PersistenceError
    ? error
    : new PersistenceError({
        operation: "taxCalculationService.calculateTax",
        cause: error,
      })

const recordTaxCalculationOutcome = ({
  jurisdiction,
  outcome,
}: {
  readonly jurisdiction: string
  readonly outcome: string
}) =>
  Metric.update(taxCalculationOutcomeMetric.pipe(Metric.withAttributes({ jurisdiction })), outcome)

const trackTaxCalculationDuration = ({ jurisdiction }: { readonly jurisdiction: string }) =>
  Effect.trackDuration(taxCalculationDurationMetric.pipe(Metric.withAttributes({ jurisdiction })))

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectSourceFields = {
    id: schema.sources.id,
  } as const

  const selectDisposalMatchFields = {
    disposalLegId: schema.disposalMatches.disposalLegId,
    fifoLotId: schema.disposalMatches.fifoLotId,
    gainLoss: schema.disposalMatches.gainLoss,
    acquiredAt: schema.fifoLots.acquiredAt,
    disposedAt: schema.transactionLegs.timestamp,
    disposalCurrency: schema.transactionLegs.fiatCurrency,
    costBasisCurrency: schema.fifoLots.costBasisCurrency,
  } as const

  const selectIncomeLegFields = {
    legId: schema.transactionLegs.id,
    fiatAmount: schema.transactionLegs.fiatAmount,
    fiatCurrency: schema.transactionLegs.fiatCurrency,
  } as const

  /**
   * Decode a database numeric value into a BigDecimal.
   *
   * @param value - Raw database value
   * @param operation - Error context for persistence failures
   * @returns Parsed decimal value
   */
  const decodeDecimal = ({
    value,
    operation,
  }: {
    readonly value: unknown
    readonly operation: string
  }): Effect.Effect<BigDecimal.BigDecimal, PersistenceError> =>
    Schema.decodeUnknownEffect(Schema.BigDecimalFromString)(value).pipe(
      Effect.mapError(
        () =>
          new PersistenceError({
            operation,
            cause: `Invalid decimal value: ${String(value)}`,
          })
      )
    )

  /**
   * Convert an exact decimal total into the public numeric API shape.
   *
   * @param amount - Exact decimal total
   * @returns Numeric response value
   */
  const toResponseNumber = (amount: BigDecimal.BigDecimal): number =>
    Number(BigDecimal.format(amount))

  /**
   * Validate that a tax-visible amount is valued in the reporting currency.
   *
   * @param sourceId - Owning source identifier
   * @param field - Field description for actionable error messages
   * @param currency - Currency to validate
   * @returns The validated reporting currency
   */
  const ensureReportingCurrency = ({
    sourceId,
    field,
    currency,
  }: {
    readonly sourceId: string
    readonly field: string
    readonly currency: string | null
  }) =>
    Effect.gen(function* () {
      if (currency === null) {
        return yield* new TaxCalculationIncompleteDataError({
          sourceId,
          field,
          reason: "missing fiat currency",
        })
      }

      if (currency !== REPORTING_CURRENCY) {
        return yield* new TaxCalculationUnsupportedCurrencyError({
          sourceId,
          field,
          expectedCurrency: REPORTING_CURRENCY,
          actualCurrency: currency,
        })
      }

      return REPORTING_CURRENCY
    })

  /**
   * Load the source row to enforce the source-scoped contract.
   *
   * @param sourceId - Source identifier from the API path
   * @returns The matched source row
   */
  const loadSource = (sourceId: string) =>
    Effect.gen(function* () {
      const [source] = yield* db
        .select(selectSourceFields)
        .from(schema.sources)
        .where(eq(schema.sources.id, sourceId))
        .limit(1)
        .pipe(wrapSqlError("taxCalculationService.loadSource.select"))

      if (source === undefined) {
        return yield* new SourceNotFoundError({ sourceId })
      }

      return source
    }).pipe(
      withObservedOperation({
        name: "persistence.tax-calculation.load-source",
        attributes: { sourceId },
        kind: "client",
      })
    )

  /**
   * Filter for observations used by the source whose transactions stay
   * outside derived accounting AND make the calculation incomplete: no
   * mapping row yet, or a mapping that is still an open question
   * (pending_review or rejected). An excluded observation, or an approval
   * produced by asset resolution, stops blocking only after a replay requested
   * after both the mapping decision and source-use discovery has completed.
   * Principal overrides may settle an otherwise blocking observation once
   * their own replay has completed. Shared by the count and the list so they
   * cannot disagree.
   *
   * @param sourceId - Source identifier
   * @returns Drizzle where condition over source uses joined with mappings
   */
  const blockingObservationFilter = (sourceId: string) =>
    and(
      eq(schema.providerAssetSourceUses.sourceId, sourceId),
      or(
        isNull(schema.providerAssetMappings.id),
        notInArray(schema.providerAssetMappings.mappingStatus, ["approved", "excluded"]),
        and(
          or(
            eq(schema.providerAssetMappings.mappingStatus, "excluded"),
            and(
              eq(schema.providerAssetMappings.mappingStatus, "approved"),
              exists(
                db
                  .select({ id: schema.assetResolutionDecisions.id })
                  .from(schema.assetResolutionDecisions)
                  .where(
                    and(
                      eq(
                        schema.assetResolutionDecisions.providerAssetRowId,
                        schema.providerAssetSourceUses.providerAssetRowId
                      ),
                      eq(schema.assetResolutionDecisions.status, "active"),
                      inArray(schema.assetResolutionDecisions.outcome, [
                        "attach",
                        "create_standalone",
                      ])
                    )
                  )
              )
            )
          ),
          notExists(
            db
              .select({ id: schema.processingJobs.id })
              .from(schema.processingJobs)
              .where(
                and(
                  eq(schema.processingJobs.sourceId, schema.providerAssetSourceUses.sourceId),
                  eq(schema.processingJobs.mode, "replay"),
                  eq(schema.processingJobs.status, "completed"),
                  gte(schema.processingJobs.createdAt, schema.providerAssetMappings.updatedAt),
                  gte(schema.processingJobs.createdAt, schema.providerAssetSourceUses.updatedAt)
                )
              )
          )
        )
      ),
      sql`not (
        not exists (
          select 1
          from ${schema.providerTransfers} exact_transfer
          where exact_transfer.source_id = ${sourceId}
            and exact_transfer.provider_asset_id = ${schema.providerAssetSourceUses.providerAssetRowId}
            and exact_transfer.observed_blockchain_id is not null
            and exact_transfer.observed_representation_type is not null
            and not (
              exists (
                select 1
                from principal_asset_overrides inclusion_override
                where inclusion_override.principal_id = (
                    select ${schema.sources.principalId}
                    from ${schema.sources}
                    where ${schema.sources.id} = ${sourceId}
                  )
                  and inclusion_override.kind = 'inclusion'
                  and inclusion_override.target_kind = 'representation'
                  and inclusion_override.blockchain_id = exact_transfer.observed_blockchain_id
                  and inclusion_override.representation_type = exact_transfer.observed_representation_type
                  and lower(inclusion_override.contract_address) is not distinct from lower(exact_transfer.observed_contract_address)
                  and inclusion_override.mint_address is not distinct from exact_transfer.observed_mint_address
                  and inclusion_override.action = 'set'
                  and inclusion_override.replacement_inclusion_state = 'excluded'
                  and inclusion_override.id = (
                    select latest_override.id
                    from principal_asset_overrides latest_override
                    where latest_override.principal_id = inclusion_override.principal_id
                      and latest_override.kind = inclusion_override.kind
                      and latest_override.target_kind = inclusion_override.target_kind
                      and latest_override.blockchain_id = inclusion_override.blockchain_id
                      and latest_override.representation_type = inclusion_override.representation_type
                      and lower(latest_override.contract_address) is not distinct from lower(inclusion_override.contract_address)
                      and latest_override.mint_address is not distinct from inclusion_override.mint_address
                    order by latest_override.created_at desc, latest_override.id desc
                    limit 1
                  )
              )
              or (
                (
                  exists (
                    select 1
                    from principal_asset_overrides inclusion_override
                    where inclusion_override.principal_id = (
                        select ${schema.sources.principalId}
                        from ${schema.sources}
                        where ${schema.sources.id} = ${sourceId}
                      )
                      and inclusion_override.kind = 'inclusion'
                      and inclusion_override.target_kind = 'representation'
                      and inclusion_override.blockchain_id = exact_transfer.observed_blockchain_id
                      and inclusion_override.representation_type = exact_transfer.observed_representation_type
                      and lower(inclusion_override.contract_address) is not distinct from lower(exact_transfer.observed_contract_address)
                      and inclusion_override.mint_address is not distinct from exact_transfer.observed_mint_address
                      and inclusion_override.action = 'set'
                      and inclusion_override.replacement_inclusion_state = 'included'
                      and inclusion_override.id = (
                        select latest_override.id
                        from principal_asset_overrides latest_override
                        where latest_override.principal_id = inclusion_override.principal_id
                          and latest_override.kind = inclusion_override.kind
                          and latest_override.target_kind = inclusion_override.target_kind
                          and latest_override.blockchain_id = inclusion_override.blockchain_id
                          and latest_override.representation_type = inclusion_override.representation_type
                          and lower(latest_override.contract_address) is not distinct from lower(inclusion_override.contract_address)
                          and latest_override.mint_address is not distinct from inclusion_override.mint_address
                        order by latest_override.created_at desc, latest_override.id desc
                        limit 1
                      )
                  )
                  and (
                    exists (
                      select 1
                      from ${schema.assetRepresentations} representation
                      where representation.blockchain_id = exact_transfer.observed_blockchain_id
                        and representation.type = exact_transfer.observed_representation_type
                        and lower(representation.contract_address) is not distinct from lower(exact_transfer.observed_contract_address)
                        and representation.mint_address is not distinct from exact_transfer.observed_mint_address
                        and representation.decimals is not null
                    )
                    or not exists (
                      select 1
                      from ${schema.providerTransfers} target_transfer
                      where target_transfer.source_id = exact_transfer.source_id
                        and target_transfer.provider_asset_id = exact_transfer.provider_asset_id
                        and target_transfer.observed_blockchain_id = exact_transfer.observed_blockchain_id
                        and target_transfer.observed_representation_type is not distinct from exact_transfer.observed_representation_type
                        and lower(target_transfer.observed_contract_address) is not distinct from lower(exact_transfer.observed_contract_address)
                        and target_transfer.observed_mint_address is not distinct from exact_transfer.observed_mint_address
                        and target_transfer.observed_decimals is null
                    )
                  )
                )
                and (
                  ${schema.providerAssetMappings.canonicalAssetId} is not null
                  or exists (
                    select 1
                    from ${schema.assetRepresentations} representation
                    where representation.blockchain_id = exact_transfer.observed_blockchain_id
                      and representation.type = exact_transfer.observed_representation_type
                      and lower(representation.contract_address) is not distinct from lower(exact_transfer.observed_contract_address)
                      and representation.mint_address is not distinct from exact_transfer.observed_mint_address
                  )
                  or exists (
                    select 1
                    from principal_asset_overrides identity_override
                    where identity_override.principal_id = (
                        select ${schema.sources.principalId}
                        from ${schema.sources}
                        where ${schema.sources.id} = ${sourceId}
                      )
                      and identity_override.kind = 'identity'
                      and identity_override.target_kind = 'representation'
                      and identity_override.blockchain_id = exact_transfer.observed_blockchain_id
                      and identity_override.representation_type = exact_transfer.observed_representation_type
                      and lower(identity_override.contract_address) is not distinct from lower(exact_transfer.observed_contract_address)
                      and identity_override.mint_address is not distinct from exact_transfer.observed_mint_address
                      and identity_override.action = 'set'
                      and identity_override.replacement_asset_id is not null
                      and identity_override.id = (
                        select latest_override.id
                        from principal_asset_overrides latest_override
                        where latest_override.principal_id = identity_override.principal_id
                          and latest_override.kind = identity_override.kind
                          and latest_override.target_kind = identity_override.target_kind
                          and latest_override.blockchain_id = identity_override.blockchain_id
                          and latest_override.representation_type = identity_override.representation_type
                          and lower(latest_override.contract_address) is not distinct from lower(identity_override.contract_address)
                          and latest_override.mint_address is not distinct from identity_override.mint_address
                        order by latest_override.created_at desc, latest_override.id desc
                        limit 1
                      )
                  )
                )
              )
            )
        )
        and (
          (
            exists (
              select 1
              from ${schema.providerTransfers} provider_transfer
              where provider_transfer.source_id = ${sourceId}
                and provider_transfer.provider_asset_id = ${schema.providerAssetSourceUses.providerAssetRowId}
            )
            and not exists (
              select 1
              from ${schema.providerTransfers} provider_target_transfer
              where provider_target_transfer.source_id = ${sourceId}
                and provider_target_transfer.provider_asset_id = ${schema.providerAssetSourceUses.providerAssetRowId}
                and (
                  provider_target_transfer.observed_blockchain_id is null
                  or provider_target_transfer.observed_representation_type is null
                )
            )
          )
          or exists (
            select 1
            from principal_asset_overrides inclusion_override
            inner join ${schema.providerAssets} provider_asset
              on provider_asset.id = ${schema.providerAssetSourceUses.providerAssetRowId}
            where inclusion_override.principal_id = (
                select ${schema.sources.principalId}
                from ${schema.sources}
                where ${schema.sources.id} = ${sourceId}
              )
              and inclusion_override.kind = 'inclusion'
              and inclusion_override.target_kind = 'provider_asset'
              and inclusion_override.provider_asset_row_id = ${schema.providerAssetSourceUses.providerAssetRowId}
              and inclusion_override.action = 'set'
              and (
                inclusion_override.replacement_inclusion_state = 'excluded'
                or (
                  inclusion_override.replacement_inclusion_state = 'included'
                  and provider_asset.exponent is not null
                  and provider_asset.provider_type is distinct from 'unsupported'
                  and (
                    ${schema.providerAssetMappings.canonicalAssetId} is not null
                    or exists (
                      select 1
                      from principal_asset_overrides identity_override
                      where identity_override.principal_id = inclusion_override.principal_id
                        and identity_override.kind = 'identity'
                        and identity_override.target_kind = 'provider_asset'
                        and identity_override.provider_asset_row_id = inclusion_override.provider_asset_row_id
                        and identity_override.action = 'set'
                        and identity_override.replacement_asset_id is not null
                        and identity_override.id = (
                          select latest_identity.id
                          from principal_asset_overrides latest_identity
                          where latest_identity.principal_id = identity_override.principal_id
                            and latest_identity.kind = identity_override.kind
                            and latest_identity.target_kind = identity_override.target_kind
                            and latest_identity.provider_asset_row_id = identity_override.provider_asset_row_id
                          order by latest_identity.created_at desc, latest_identity.id desc
                          limit 1
                        )
                    )
                  )
                )
              )
              and inclusion_override.id = (
                select latest_override.id
                from principal_asset_overrides latest_override
                where latest_override.principal_id = inclusion_override.principal_id
                  and latest_override.kind = inclusion_override.kind
                  and latest_override.target_kind = inclusion_override.target_kind
                  and latest_override.provider_asset_row_id = inclusion_override.provider_asset_row_id
                order by latest_override.created_at desc, latest_override.id desc
                limit 1
              )
          )
        )
      )`
    )

  /**
   * Count provider asset observations used by the source whose transactions
   * are still outside derived accounting. Any unapproved mapping keeps its
   * transactions out of legs and FIFO, so the calculation must report pending
   * instead of a silently short total.
   *
   * @param sourceId - Source identifier
   * @returns Number of observations blocking the calculation
   */
  const countPendingObservations = (sourceId: string) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select({ pendingObservations: count() })
        .from(schema.providerAssetSourceUses)
        .leftJoin(
          schema.providerAssetMappings,
          eq(
            schema.providerAssetMappings.providerAssetRowId,
            schema.providerAssetSourceUses.providerAssetRowId
          )
        )
        .where(blockingObservationFilter(sourceId))
        .pipe(wrapSqlError("taxCalculationService.countPendingObservations"))

      return row?.pendingObservations ?? 0
    }).pipe(
      withObservedOperation({
        name: "persistence.tax-calculation.count-pending-observations",
        attributes: { sourceId },
        kind: "client",
      })
    )

  /** Non-asset transaction reviews keep the whole source outside accounting readiness. */
  const hasPendingTransactionReview = (sourceId: string) =>
    db
      .select({ pendingReviews: count() })
      .from(schema.transactionReviews)
      .innerJoin(
        schema.transactions,
        eq(schema.transactions.id, schema.transactionReviews.transactionId)
      )
      .where(
        and(
          eq(schema.transactions.sourceId, sourceId),
          eq(schema.transactionReviews.needsReview, true),
          notInArray(schema.transactionReviews.reviewStatus, ["approved", "changed"]),
          or(
            isNull(schema.transactionReviews.matchedLayer),
            notInArray(schema.transactionReviews.matchedLayer, [
              "provider_asset_mapping",
              "solana_asset_mapping",
            ])
          ),
          sql`not exists (
            select 1
            from ${schema.transactionLegs} accounting_leg
            where accounting_leg.transaction_id = ${schema.transactionReviews.transactionId}
          )`
        )
      )
      .pipe(
        Effect.map((rows) => (rows[0]?.pendingReviews ?? 0) > 0),
        wrapSqlError("taxCalculationService.hasPendingTransactionReview")
      )

  /** Tax inputs stay stale until a later job has applied every source-affecting override. */
  const hasPendingOverrideReplay = (sourceId: string) =>
    db
      .select({
        pending: sql<boolean>`(
        exists (
          select 1
          from ${schema.principalAssetOverrideApplications} application
          left join ${schema.processingJobs} application_job
            on application_job.id = application.replay_job_id
          where application.source_id = ${sourceId}
            and application.superseded_at is null
            and (
              application.replay_job_id is null
              or application_job.status <> 'completed'
              or application_job.progress_details ->> 'failedRecords' is distinct from '0'
            )
        )
        or exists (
          select 1
          from ${schema.principalAssetOverrides} affecting_override
          where not exists (
            select 1
            from ${schema.principalAssetOverrides} superseding_override
            where superseding_override.supersedes_override_id = affecting_override.id
          )
            and not exists (
              select 1
              from ${schema.principalAssetOverrideApplications} existing_application
              where existing_application.override_id = affecting_override.id
                and existing_application.source_id = ${sourceId}
                and existing_application.superseded_at is null
            )
            and exists (
              select 1
              from (
                select source_use.created_at
                from ${schema.providerAssetSourceUses} source_use
                where affecting_override.target_kind = 'provider_asset'
                  and source_use.source_id = ${sourceId}
                  and source_use.provider_asset_row_id = affecting_override.provider_asset_row_id

                union all

                select representation_use.created_at
                from ${schema.sourceRepresentationUses} representation_use
                where affecting_override.target_kind = 'representation'
                  and representation_use.source_id = ${sourceId}
                  and representation_use.blockchain_id = affecting_override.blockchain_id
                  and representation_use.representation_type = affecting_override.representation_type
                  and lower(representation_use.contract_address) is not distinct from lower(affecting_override.contract_address)
                  and representation_use.mint_address is not distinct from affecting_override.mint_address
              ) target_evidence
              where not exists (
                select 1
                from ${schema.processingJobs} completed_job
                where completed_job.source_id = ${sourceId}
                  and completed_job.status = 'completed'
                  and completed_job.progress_details ->> 'failedRecords' = '0'
                  and coalesce(completed_job.completed_at, completed_job.updated_at) >= target_evidence.created_at
                  and (
                    (
                      completed_job.mode = 'replay'
                      and completed_job.created_at >= affecting_override.created_at
                    )
                    or (
                      target_evidence.created_at > affecting_override.created_at
                      and completed_job.created_at <= target_evidence.created_at
                    )
                  )
              )
            )
        )
        )`,
      })
      .from(schema.sources)
      .where(eq(schema.sources.id, sourceId))
      .limit(1)
      .pipe(
        Effect.map((rows) => rows[0]?.pending ?? false),
        wrapSqlError("taxCalculationService.hasPendingOverrideReplay")
      )

  /**
   * Load a bounded list of provider asset observations that block a source's
   * tax calculation, named by provider and currency code so a user can act on
   * them without guessing from missing IDs.
   *
   * @param sourceId - Source identifier
   * @returns Blocking observations, capped at BLOCKING_OBSERVATION_LIST_LIMIT
   */
  const loadBlockingObservations = (sourceId: string) =>
    db
      .select({
        provider: schema.providerAssets.provider,
        currencyCode: schema.providerAssets.currencyCode,
      })
      .from(schema.providerAssetSourceUses)
      .innerJoin(
        schema.providerAssets,
        eq(schema.providerAssets.id, schema.providerAssetSourceUses.providerAssetRowId)
      )
      .leftJoin(
        schema.providerAssetMappings,
        eq(
          schema.providerAssetMappings.providerAssetRowId,
          schema.providerAssetSourceUses.providerAssetRowId
        )
      )
      .where(blockingObservationFilter(sourceId))
      .limit(BLOCKING_OBSERVATION_LIST_LIMIT)
      .pipe(
        wrapSqlError("taxCalculationService.loadBlockingObservations"),
        withObservedOperation({
          name: "persistence.tax-calculation.load-blocking-observations",
          attributes: { sourceId },
          kind: "client",
        })
      )

  /**
   * Load disposal matches that fall within the selected tax year.
   *
   * @param sourceId - Source identifier
   * @param yearStart - Inclusive UTC year start
   * @param yearEnd - Exclusive UTC year end
   * @returns Disposal matches with valuation metadata
   */
  const loadDisposalMatches = ({
    sourceId,
    yearStart,
    yearEnd,
  }: {
    readonly sourceId: string
    readonly yearStart: Date
    readonly yearEnd: Date
  }) =>
    db
      .select(selectDisposalMatchFields)
      .from(schema.disposalMatches)
      .innerJoin(
        schema.transactionLegs,
        eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
      )
      .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
      .where(
        and(
          eq(schema.transactionLegs.sourceId, sourceId),
          gte(schema.transactionLegs.timestamp, yearStart),
          lt(schema.transactionLegs.timestamp, yearEnd)
        )
      )
      .pipe(
        wrapSqlError("taxCalculationService.loadDisposalMatches"),
        withObservedOperation({
          name: "persistence.tax-calculation.load-disposal-matches",
          attributes: {
            sourceId,
            yearStart: yearStart.toISOString(),
            yearEnd: yearEnd.toISOString(),
          },
          kind: "client",
        })
      )

  /**
   * Load income legs that contribute to the selected tax year.
   *
   * @param sourceId - Source identifier
   * @param yearStart - Inclusive UTC year start
   * @param yearEnd - Exclusive UTC year end
   * @returns Income legs with fiat valuation fields
   */
  const loadIncomeLegs = ({
    sourceId,
    yearStart,
    yearEnd,
  }: {
    readonly sourceId: string
    readonly yearStart: Date
    readonly yearEnd: Date
  }) =>
    db
      .select(selectIncomeLegFields)
      .from(schema.transactionLegs)
      .where(
        and(
          eq(schema.transactionLegs.sourceId, sourceId),
          eq(schema.transactionLegs.kind, "income"),
          gte(schema.transactionLegs.timestamp, yearStart),
          lt(schema.transactionLegs.timestamp, yearEnd)
        )
      )
      .pipe(
        wrapSqlError("taxCalculationService.loadIncomeLegs"),
        withObservedOperation({
          name: "persistence.tax-calculation.load-income-legs",
          attributes: {
            sourceId,
            yearStart: yearStart.toISOString(),
            yearEnd: yearEnd.toISOString(),
          },
          kind: "client",
        })
      )

  /**
   * Aggregate disposal gain/loss rows into taxable and tax-free totals.
   *
   * @param sourceId - Source identifier for error reporting
   * @param rows - Disposal match rows for the selected year
   * @returns Running tax summary totals
   */
  const summarizeDisposals = ({
    sourceId,
    rows,
  }: {
    readonly sourceId: string
    readonly rows: ReadonlyArray<DisposalMatchRow>
  }) =>
    Effect.reduce(rows, emptyTotals, (totals, row) =>
      Effect.gen(function* () {
        yield* ensureReportingCurrency({
          sourceId,
          field: `disposal leg ${row.disposalLegId} fiat currency`,
          currency: row.disposalCurrency,
        })
        yield* ensureReportingCurrency({
          sourceId,
          field: `FIFO lot ${row.fifoLotId} cost basis currency`,
          currency: row.costBasisCurrency,
        })

        const gainLoss = yield* decodeDecimal({
          value: row.gainLoss,
          operation: "taxCalculationService.summarizeDisposals.gainLoss",
        })

        if (!BigDecimal.isNegative(gainLoss)) {
          return isTaxFreeDisposal(row)
            ? {
                ...totals,
                taxFreeGains: BigDecimal.sum(totals.taxFreeGains, gainLoss),
              }
            : {
                ...totals,
                taxableGains: BigDecimal.sum(totals.taxableGains, gainLoss),
              }
        }

        if (isTaxFreeDisposal(row)) {
          return totals
        }

        return {
          ...totals,
          taxableLosses: BigDecimal.sum(totals.taxableLosses, BigDecimal.abs(gainLoss)),
        }
      })
    )

  /**
   * Aggregate income legs after validating complete fiat valuation metadata.
   *
   * @param sourceId - Source identifier for error reporting
   * @param rows - Income rows for the selected year
   * @returns Exact income total in the reporting currency
   */
  const summarizeIncome = ({
    sourceId,
    rows,
  }: {
    readonly sourceId: string
    readonly rows: ReadonlyArray<IncomeLegRow>
  }) =>
    Effect.reduce(rows, zeroAmount, (incomeTotal, row) =>
      Effect.gen(function* () {
        yield* ensureReportingCurrency({
          sourceId,
          field: `income leg ${row.legId} fiat currency`,
          currency: row.fiatCurrency,
        })

        if (row.fiatAmount === null) {
          return yield* new TaxCalculationIncompleteDataError({
            sourceId,
            field: `income leg ${row.legId} fiat amount`,
            reason: "missing fiat valuation",
          })
        }

        const fiatAmount = yield* decodeDecimal({
          value: row.fiatAmount,
          operation: "taxCalculationService.summarizeIncome.fiatAmount",
        })

        return BigDecimal.sum(incomeTotal, fiatAmount)
      })
    )

  const calculateTax: TaxCalculationServiceShape["calculateTax"] = ({
    sourceId,
    jurisdiction,
    year,
  }) =>
    Effect.gen(function* () {
      if (jurisdiction !== SUPPORTED_JURISDICTION) {
        return yield* new UnsupportedJurisdictionError({ jurisdiction })
      }

      yield* loadSource(sourceId)

      const [pendingObservationCount, pendingOverrideReplay, pendingTransactionReview] =
        yield* Effect.all([
          countPendingObservations(sourceId),
          hasPendingOverrideReplay(sourceId),
          hasPendingTransactionReview(sourceId),
        ])

      if (pendingObservationCount > 0 || pendingOverrideReplay || pendingTransactionReview) {
        const blockingObservations = yield* loadBlockingObservations(sourceId)

        return yield* new TaxCalculationPendingObservationsError({
          sourceId,
          pendingObservationCount: Math.max(pendingObservationCount, 1),
          blockingObservations,
        })
      }

      const yearStart = startOfYearUtc(year)
      const yearEnd = endOfYearUtc(year)

      const disposalRows = yield* loadDisposalMatches({
        sourceId,
        yearStart,
        yearEnd,
      })
      const incomeRows = yield* loadIncomeLegs({
        sourceId,
        yearStart,
        yearEnd,
      })

      yield* Effect.annotateCurrentSpan({
        sourceId,
        jurisdiction,
        year,
        disposalRowCount: disposalRows.length,
        incomeRowCount: incomeRows.length,
      })

      const disposalTotals = yield* summarizeDisposals({
        sourceId,
        rows: disposalRows,
      })
      const incomeTotal = yield* summarizeIncome({
        sourceId,
        rows: incomeRows,
      })

      const summary = {
        year,
        currency: REPORTING_CURRENCY,
        taxableGains: toResponseNumber(disposalTotals.taxableGains),
        taxableLosses: toResponseNumber(disposalTotals.taxableLosses),
        taxFreeGains: toResponseNumber(disposalTotals.taxFreeGains),
        incomeTotal: toResponseNumber(incomeTotal),
      } as const

      yield* recordTaxCalculationOutcome({
        jurisdiction,
        outcome: "completed",
      })

      yield* Effect.logInfo(
        {
          sourceId,
          jurisdiction,
          year,
          disposalRowCount: disposalRows.length,
          incomeRowCount: incomeRows.length,
        },
        "tax-calculation:completed"
      )

      return summary
    }).pipe(
      withObservedOperation({
        name: "persistence.tax-calculation.calculate-tax",
        attributes: { sourceId, jurisdiction, year },
      }),
      trackTaxCalculationDuration({ jurisdiction }),
      Effect.mapError(normalizeTaxCalculationError),
      Effect.tapError((error) =>
        Effect.all(
          [
            recordTaxCalculationOutcome({
              jurisdiction,
              outcome: error._tag,
            }),
            Effect.logError(
              {
                sourceId,
                jurisdiction,
                year,
                error,
              },
              "tax-calculation:failed"
            ),
          ],
          { discard: true }
        )
      )
    )

  return {
    calculateTax,
  } satisfies TaxCalculationServiceShape
})

/**
 * TaxCalculationServiceLive - Live layer for source tax calculation.
 */
export const TaxCalculationServiceLive = Layer.effect(TaxCalculationService, make)
