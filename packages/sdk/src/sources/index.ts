import type {
  SourceCreateRequest,
  SourceCreateResponse,
  SourceAssetPnlResponse,
  SourceDisposalExplanationResponse,
  SourceFifoLotsResponse,
  SourceListResponse,
  SourceOverviewResponse,
  SourceTaxEventsResponse,
  SourceTransactionsResponse,
  SourceSyncJobResponse,
  SourceSyncStartResponse,
  TaxCalculationRequest,
  TaxCalculationResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import type { TaxMaxiEffectClient } from "../client.ts"

export type Source = SourceListResponse["sources"][number]
export type SourceCreateInput = SourceCreateRequest
export type SourceCreate = SourceCreateResponse
export type SourceList = SourceListResponse
export type SourceSyncStart = SourceSyncStartResponse
export type SourceSyncJob = SourceSyncJobResponse
export type TaxCalculation = TaxCalculationResponse
export type SourceOverview = SourceOverviewResponse
export type SourceAssetPnl = SourceAssetPnlResponse
export type SourceTransactions = SourceTransactionsResponse
export type SourceTaxEvents = SourceTaxEventsResponse
export type SourceFifoLots = SourceFifoLotsResponse
export type SourceDisposalExplanation = SourceDisposalExplanationResponse

export type SourceIdInput = {
  readonly sourceId: string
}

export type SourceReportPageInput = SourceIdInput & {
  readonly cursor?: string | null
  readonly limit?: number
}

export type SourceSyncJobInput = SourceIdInput & {
  readonly jobId: string
}

export type SourceDisposalExplanationInput = SourceIdInput & {
  readonly legId: string
}

export type CalculateTaxInput = SourceIdInput & TaxCalculationRequest

export type SourcesEffectResource = {
  readonly list: () => Effect.Effect<SourceList, unknown, never>
  readonly create: (input: SourceCreateInput) => Effect.Effect<SourceCreate, unknown, never>
  readonly startSync: (input: SourceIdInput) => Effect.Effect<SourceSyncStart, unknown, never>
  readonly replaySync: (input: SourceIdInput) => Effect.Effect<SourceSyncStart, unknown, never>
  readonly getSyncJob: (input: SourceSyncJobInput) => Effect.Effect<SourceSyncJob, unknown, never>
  readonly calculateTax: (input: CalculateTaxInput) => Effect.Effect<TaxCalculation, unknown, never>
  readonly getOverview: (input: SourceIdInput) => Effect.Effect<SourceOverview, unknown, never>
  readonly listAssetPnl: (input: SourceIdInput) => Effect.Effect<SourceAssetPnl, unknown, never>
  readonly listTransactions: (
    input: SourceReportPageInput
  ) => Effect.Effect<SourceTransactions, unknown, never>
  readonly listTaxEvents: (
    input: SourceReportPageInput
  ) => Effect.Effect<SourceTaxEvents, unknown, never>
  readonly listFifoLots: (
    input: SourceReportPageInput
  ) => Effect.Effect<SourceFifoLots, unknown, never>
  readonly explainDisposal: (
    input: SourceDisposalExplanationInput
  ) => Effect.Effect<SourceDisposalExplanation, unknown, never>
}

export type SourcesPromiseResource = {
  readonly list: () => Promise<SourceList>
  readonly create: (input: SourceCreateInput) => Promise<SourceCreate>
  readonly startSync: (input: SourceIdInput) => Promise<SourceSyncStart>
  readonly replaySync: (input: SourceIdInput) => Promise<SourceSyncStart>
  readonly getSyncJob: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  readonly calculateTax: (input: CalculateTaxInput) => Promise<TaxCalculation>
  readonly getOverview: (input: SourceIdInput) => Promise<SourceOverview>
  readonly listAssetPnl: (input: SourceIdInput) => Promise<SourceAssetPnl>
  readonly listTransactions: (input: SourceReportPageInput) => Promise<SourceTransactions>
  readonly listTaxEvents: (input: SourceReportPageInput) => Promise<SourceTaxEvents>
  readonly listFifoLots: (input: SourceReportPageInput) => Promise<SourceFifoLots>
  readonly explainDisposal: (
    input: SourceDisposalExplanationInput
  ) => Promise<SourceDisposalExplanation>
}

export const makeSourcesEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): SourcesEffectResource => ({
  list: () => Effect.flatMap(client, (resolved) => resolved.sources.listSources(undefined)),
  create: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.createSource({
        payload: input,
      })
    ),
  startSync: ({ sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.startSourceSyncJob({
        path: {
          sourceId,
        },
      })
    ),
  replaySync: ({ sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.replaySourceSyncJob({
        path: {
          sourceId,
        },
      })
    ),
  getSyncJob: ({ jobId, sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.getSourceSyncJobStatus({
        path: {
          jobId,
          sourceId,
        },
      })
    ),
  calculateTax: ({ jurisdiction, sourceId, year }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.calculateTaxForSource({
        path: {
          sourceId,
        },
        payload: {
          jurisdiction,
          year,
        },
      })
    ),
  getOverview: ({ sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.getSourceOverview({
        path: {
          sourceId,
        },
      })
    ),
  listAssetPnl: ({ sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.listSourceAssetPnl({
        path: {
          sourceId,
        },
      })
    ),
  listTransactions: ({ cursor, limit, sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.listSourceTransactions({
        path: {
          sourceId,
        },
        urlParams: {
          cursor: cursor ?? undefined,
          limit,
        },
      })
    ),
  listTaxEvents: ({ cursor, limit, sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.listSourceTaxEvents({
        path: {
          sourceId,
        },
        urlParams: {
          cursor: cursor ?? undefined,
          limit,
        },
      })
    ),
  listFifoLots: ({ cursor, limit, sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.listSourceFifoLots({
        path: {
          sourceId,
        },
        urlParams: {
          cursor: cursor ?? undefined,
          limit,
        },
      })
    ),
  explainDisposal: ({ legId, sourceId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.sources.explainSourceDisposal({
        path: {
          legId,
          sourceId,
        },
      })
    ),
})

export const makeSourcesPromiseResource = (
  effect: SourcesEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): SourcesPromiseResource => ({
  list: () => run(effect.list()),
  create: (input) => run(effect.create(input)),
  startSync: (input) => run(effect.startSync(input)),
  replaySync: (input) => run(effect.replaySync(input)),
  getSyncJob: (input) => run(effect.getSyncJob(input)),
  calculateTax: (input) => run(effect.calculateTax(input)),
  getOverview: (input) => run(effect.getOverview(input)),
  listAssetPnl: (input) => run(effect.listAssetPnl(input)),
  listTransactions: (input) => run(effect.listTransactions(input)),
  listTaxEvents: (input) => run(effect.listTaxEvents(input)),
  listFifoLots: (input) => run(effect.listFifoLots(input)),
  explainDisposal: (input) => run(effect.explainDisposal(input)),
})
