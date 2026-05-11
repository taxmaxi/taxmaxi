import type {
  SourceListResponse,
  SourceSyncJobResponse,
  SourceSyncStartResponse,
  TaxCalculationRequest,
  TaxCalculationResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import type { TaxMaxiEffectClient } from "../client.ts"

export type Source = SourceListResponse["sources"][number]
export type SourceList = SourceListResponse
export type SourceSyncStart = SourceSyncStartResponse
export type SourceSyncJob = SourceSyncJobResponse
export type TaxCalculation = TaxCalculationResponse

export type SourceIdInput = {
  readonly sourceId: string
}

export type SourceSyncJobInput = SourceIdInput & {
  readonly jobId: string
}

export type CalculateTaxInput = SourceIdInput & TaxCalculationRequest

export type SourcesEffectResource = {
  readonly list: () => Effect.Effect<SourceList, unknown, never>
  readonly startSync: (input: SourceIdInput) => Effect.Effect<SourceSyncStart, unknown, never>
  readonly replaySync: (input: SourceIdInput) => Effect.Effect<SourceSyncStart, unknown, never>
  readonly getSyncJob: (input: SourceSyncJobInput) => Effect.Effect<SourceSyncJob, unknown, never>
  readonly calculateTax: (input: CalculateTaxInput) => Effect.Effect<TaxCalculation, unknown, never>
}

export type SourcesPromiseResource = {
  readonly list: () => Promise<SourceList>
  readonly startSync: (input: SourceIdInput) => Promise<SourceSyncStart>
  readonly replaySync: (input: SourceIdInput) => Promise<SourceSyncStart>
  readonly getSyncJob: (input: SourceSyncJobInput) => Promise<SourceSyncJob>
  readonly calculateTax: (input: CalculateTaxInput) => Promise<TaxCalculation>
}

export const makeSourcesEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): SourcesEffectResource => ({
  list: () => Effect.flatMap(client, (resolved) => resolved.sources.listSources(undefined)),
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
})

export const makeSourcesPromiseResource = (
  effect: SourcesEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): SourcesPromiseResource => ({
  list: () => run(effect.list()),
  startSync: (input) => run(effect.startSync(input)),
  replaySync: (input) => run(effect.replaySync(input)),
  getSyncJob: (input) => run(effect.getSyncJob(input)),
  calculateTax: (input) => run(effect.calculateTax(input)),
})
