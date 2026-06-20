import type {
  AnonSessionChallengeResponse,
  AnonSessionCreateRequest,
  AnonSessionDeleteResponse,
  AnonSessionResponse,
  AnonSource,
  AnonSourceListResponse,
  SourceSyncJobResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import type { TaxMaxiEffectClient } from "../client.ts"

export type AnonSourceList = AnonSourceListResponse
export type AnonSourceHandle = AnonSource
export type AnonSourceSyncJob = SourceSyncJobResponse
export type AnonSessionChallenge = AnonSessionChallengeResponse
export type AnonSessionCreateInput = AnonSessionCreateRequest
export type AnonSession = AnonSessionResponse
export type AnonSessionDelete = AnonSessionDeleteResponse

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

export const makeAnonEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): AnonEffectResource => ({
  sources: {
    list: () => Effect.flatMap(client, (resolved) => resolved.anon.listAnonSources(undefined)),
    get: ({ sourceId }) =>
      Effect.flatMap(client, (resolved) =>
        resolved.anon.getAnonSource({
          path: { sourceId },
        })
      ),
    listJobs: ({ sourceId }) =>
      Effect.flatMap(client, (resolved) =>
        resolved.anon.listAnonSourceJobs({
          path: { sourceId },
        })
      ),
    getJob: ({ sourceId, jobId }) =>
      Effect.flatMap(client, (resolved) =>
        resolved.anon.getAnonSourceJob({
          path: { sourceId, jobId },
        })
      ),
  },
  session: {
    challenge: () =>
      Effect.flatMap(client, (resolved) => resolved.anon.createAnonSessionChallenge(undefined)),
    create: (input) =>
      Effect.flatMap(client, (resolved) =>
        resolved.anon.createAnonSession({
          payload: input,
        })
      ),
    delete: () => Effect.flatMap(client, (resolved) => resolved.anon.deleteAnonSession(undefined)),
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
