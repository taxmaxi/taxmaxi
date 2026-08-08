import {
  SourceCreateRequest,
  SourceCreateResponse,
  SourceAssetPnlResponse,
  SourceDisposalExplanationResponse,
  SourceFifoLotsResponse,
  SourceListResponse,
  SourceOverviewResponse,
  SourceTaxEventsResponse,
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
export type SourceCreate = Schema.Schema.Encoded<typeof SourceCreateResponse>
export type SourceList = Schema.Schema.Encoded<typeof SourceListResponse>
export type SourceSyncStart = Schema.Schema.Encoded<typeof SourceSyncStartResponse>
export type SourceSyncJob = Schema.Schema.Encoded<typeof SourceSyncJobResponse>
export type TaxCalculation = Schema.Schema.Encoded<typeof TaxCalculationResponse>
export type SourceOverview = Schema.Schema.Encoded<typeof SourceOverviewResponse>
export type SourceAssetPnl = Schema.Schema.Encoded<typeof SourceAssetPnlResponse>
export type SourceTaxEvents = Schema.Schema.Encoded<typeof SourceTaxEventsResponse>
export type SourceFifoLots = Schema.Schema.Encoded<typeof SourceFifoLotsResponse>
export type SourceDisposalExplanation = Schema.Schema.Encoded<
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
          path: {
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
          path: {
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
          path: {
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
          path: {
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
          path: {
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
          path: {
            sourceId,
          },
        })
      ),
      encodeSourceAssetPnl
    ),
  listTaxEvents: ({ cursor, limit, sourceId }) =>
    Effect.map(
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
      encodeSourceTaxEvents
    ),
  listFifoLots: ({ cursor, limit, sourceId }) =>
    Effect.map(
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
      encodeSourceFifoLots
    ),
  explainDisposal: ({ legId, sourceId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.sources.explainSourceDisposal({
          path: {
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
  listTaxEvents: (input) => run(effect.listTaxEvents(input)),
  listFifoLots: (input) => run(effect.listFifoLots(input)),
  explainDisposal: (input) => run(effect.explainDisposal(input)),
})
