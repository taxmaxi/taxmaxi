import {
  AnonSessionChallengeResponse,
  AnonSessionCreateRequest,
  AnonSessionDeleteResponse,
  AnonSessionResponse,
  AnonSource,
  AnonSourceListResponse,
  SourceSyncJobResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

const AnonSourceJobsResponse = Schema.Struct({
  jobs: Schema.Array(SourceSyncJobResponse),
})

export type AnonSourceList = Schema.Schema.Encoded<typeof AnonSourceListResponse>
export type AnonSourceHandle = Schema.Schema.Encoded<typeof AnonSource>
export type AnonSourceSyncJob = Schema.Schema.Encoded<typeof SourceSyncJobResponse>
export type AnonSessionChallenge = Schema.Schema.Encoded<typeof AnonSessionChallengeResponse>
export type AnonSessionCreateInput = AnonSessionCreateRequest
export type AnonSession = Schema.Schema.Encoded<typeof AnonSessionResponse>
export type AnonSessionDelete = Schema.Schema.Encoded<typeof AnonSessionDeleteResponse>

export type AnonSourceInput = {
  readonly sourceId: string
}

export type AnonSourceJobInput = AnonSourceInput & {
  readonly jobId: string
}

export type AnonEffectResource = {
  readonly sources: {
    readonly list: () => Effect.Effect<AnonSourceList, unknown, never>
    readonly get: (input: AnonSourceInput) => Effect.Effect<AnonSourceHandle, unknown, never>
    readonly listJobs: (
      input: AnonSourceInput
    ) => Effect.Effect<{ readonly jobs: ReadonlyArray<AnonSourceSyncJob> }, unknown, never>
    readonly getJob: (input: AnonSourceJobInput) => Effect.Effect<AnonSourceSyncJob, unknown, never>
  }
  readonly session: {
    readonly challenge: () => Effect.Effect<AnonSessionChallenge, unknown, never>
    readonly create: (input: AnonSessionCreateInput) => Effect.Effect<AnonSession, unknown, never>
    readonly delete: () => Effect.Effect<AnonSessionDelete, unknown, never>
  }
}

export type AnonPromiseResource = {
  readonly sources: {
    readonly list: () => Promise<AnonSourceList>
    readonly get: (input: AnonSourceInput) => Promise<AnonSourceHandle>
    readonly listJobs: (
      input: AnonSourceInput
    ) => Promise<{ readonly jobs: ReadonlyArray<AnonSourceSyncJob> }>
    readonly getJob: (input: AnonSourceJobInput) => Promise<AnonSourceSyncJob>
  }
  readonly session: {
    readonly challenge: () => Promise<AnonSessionChallenge>
    readonly create: (input: AnonSessionCreateInput) => Promise<AnonSession>
    readonly delete: () => Promise<AnonSessionDelete>
  }
}

const encodeAnonSourceList = Schema.encodeSync(AnonSourceListResponse)
const encodeAnonSource = Schema.encodeSync(AnonSource)
const encodeAnonSourceJobs = Schema.encodeSync(AnonSourceJobsResponse)
const encodeSourceSyncJob = Schema.encodeSync(SourceSyncJobResponse)
const encodeAnonSessionChallenge = Schema.encodeSync(AnonSessionChallengeResponse)
const encodeAnonSession = Schema.encodeSync(AnonSessionResponse)
const encodeAnonSessionDelete = Schema.encodeSync(AnonSessionDeleteResponse)

export const makeAnonEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): AnonEffectResource => ({
  sources: {
    list: () =>
      Effect.map(
        Effect.flatMap(client, (resolved) => resolved.anon.listAnonSources(undefined)),
        encodeAnonSourceList
      ),
    get: ({ sourceId }) =>
      Effect.map(
        Effect.flatMap(client, (resolved) =>
          resolved.anon.getAnonSource({
            path: { sourceId },
          })
        ),
        encodeAnonSource
      ),
    listJobs: ({ sourceId }) =>
      Effect.map(
        Effect.flatMap(client, (resolved) =>
          resolved.anon.listAnonSourceJobs({
            path: { sourceId },
          })
        ),
        encodeAnonSourceJobs
      ),
    getJob: ({ sourceId, jobId }) =>
      Effect.map(
        Effect.flatMap(client, (resolved) =>
          resolved.anon.getAnonSourceJob({
            path: { sourceId, jobId },
          })
        ),
        encodeSourceSyncJob
      ),
  },
  session: {
    challenge: () =>
      Effect.map(
        Effect.flatMap(client, (resolved) => resolved.anon.createAnonSessionChallenge(undefined)),
        encodeAnonSessionChallenge
      ),
    create: (input) =>
      Effect.map(
        Effect.flatMap(client, (resolved) =>
          resolved.anon.createAnonSession({
            payload: input,
          })
        ),
        encodeAnonSession
      ),
    delete: () =>
      Effect.map(
        Effect.flatMap(client, (resolved) => resolved.anon.deleteAnonSession(undefined)),
        encodeAnonSessionDelete
      ),
  },
})

export const makeAnonPromiseResource = (
  effect: AnonEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): AnonPromiseResource => ({
  sources: {
    list: () => run(effect.sources.list()),
    get: (input) => run(effect.sources.get(input)),
    listJobs: (input) => run(effect.sources.listJobs(input)),
    getJob: (input) => run(effect.sources.getJob(input)),
  },
  session: {
    challenge: () => run(effect.session.challenge()),
    create: (input) => run(effect.session.create(input)),
    delete: () => run(effect.session.delete()),
  },
})
