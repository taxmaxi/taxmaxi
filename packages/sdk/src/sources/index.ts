import {
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
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

export type Source = SourceList["sources"][number]
export type SourceCreateInput = SourceCreateRequest
export type SourceCreate = Schema.Codec.Encoded<typeof SourceCreateResponse>
export type SourceList = Schema.Codec.Encoded<typeof SourceListResponse>
export type SourceSyncStart = Schema.Codec.Encoded<typeof SourceSyncStartResponse>
export type SourceSyncJob = Schema.Codec.Encoded<typeof SourceSyncJobResponse>
export type TaxCalculation = Schema.Codec.Encoded<typeof TaxCalculationResponse>
export type SourceOverview = Schema.Codec.Encoded<typeof SourceOverviewResponse>
export type SourceAssetPnl = Schema.Codec.Encoded<typeof SourceAssetPnlResponse>
export type SourceTransactions = Schema.Codec.Encoded<typeof SourceTransactionsResponse>
export type SourceTaxEvents = Schema.Codec.Encoded<typeof SourceTaxEventsResponse>
export type SourceFifoLots = Schema.Codec.Encoded<typeof SourceFifoLotsResponse>
export type SourceDisposalExplanation = Schema.Codec.Encoded<
  typeof SourceDisposalExplanationResponse
>

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

const encodeSourceList = Schema.encodeSync(SourceListResponse)
const encodeSourceCreate = Schema.encodeSync(SourceCreateResponse)
const encodeSourceSyncStart = Schema.encodeSync(SourceSyncStartResponse)
const encodeSourceSyncJob = Schema.encodeSync(SourceSyncJobResponse)
const encodeTaxCalculation = Schema.encodeSync(TaxCalculationResponse)
const encodeSourceOverview = Schema.encodeSync(SourceOverviewResponse)
const encodeSourceAssetPnl = Schema.encodeSync(SourceAssetPnlResponse)
const encodeSourceTransactions = Schema.encodeSync(SourceTransactionsResponse)
const encodeSourceTaxEvents = Schema.encodeSync(SourceTaxEventsResponse)
const encodeSourceFifoLots = Schema.encodeSync(SourceFifoLotsResponse)
const encodeSourceDisposalExplanation = Schema.encodeSync(SourceDisposalExplanationResponse)

export const makeSourcesEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): SourcesEffectResource => ({
  list: () =>
    Effect.map(
      Effect.flatMap(client, (resolved) => resolved.sources.listSources(undefined)),
      encodeSourceList
    ),
  create: (input) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.createSource({
          payload: input,
        })
      ),
      encodeSourceCreate
    ),
  startSync: ({ sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.startSourceSyncJob({
          params: {
            sourceId,
          },
        })
      ),
      encodeSourceSyncStart
    ),
  replaySync: ({ sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.replaySourceSyncJob({
          params: {
            sourceId,
          },
        })
      ),
      encodeSourceSyncStart
    ),
  getSyncJob: ({ jobId, sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.getSourceSyncJobStatus({
          params: {
            jobId,
            sourceId,
          },
        })
      ),
      encodeSourceSyncJob
    ),
  calculateTax: ({ jurisdiction, sourceId, year }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.calculateTaxForSource({
          params: {
            sourceId,
          },
          payload: {
            jurisdiction,
            year,
          },
        })
      ),
      encodeTaxCalculation
    ),
  getOverview: ({ sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.getSourceOverview({
          params: {
            sourceId,
          },
        })
      ),
      encodeSourceOverview
    ),
  listAssetPnl: ({ sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.listSourceAssetPnl({
          params: {
            sourceId,
          },
        })
      ),
      encodeSourceAssetPnl
    ),
  listTransactions: ({ cursor, limit, sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.listSourceTransactions({
          params: {
            sourceId,
          },
          query: {
            cursor: cursor ?? undefined,
            limit,
          },
        })
      ),
      encodeSourceTransactions
    ),
  listTaxEvents: ({ cursor, limit, sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.listSourceTaxEvents({
          params: {
            sourceId,
          },
          query: {
            cursor: cursor ?? undefined,
            limit,
          },
        })
      ),
      encodeSourceTaxEvents
    ),
  listFifoLots: ({ cursor, limit, sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.listSourceFifoLots({
          params: {
            sourceId,
          },
          query: {
            cursor: cursor ?? undefined,
            limit,
          },
        })
      ),
      encodeSourceFifoLots
    ),
  explainDisposal: ({ legId, sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.explainSourceDisposal({
          params: {
            legId,
            sourceId,
          },
        })
      ),
      encodeSourceDisposalExplanation
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
