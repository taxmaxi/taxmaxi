import { Effect } from "effect"
import {
  type SourceCreate,
  type SourceList,
  type SourceSyncJob,
  type SourceSyncStart,
  type TaxCalculation,
} from "taxmaxi"
import { TAX_JURISDICTION } from "../config.ts"
import { CliCommandError } from "../errors.ts"
import { toCliApiError } from "./errors.ts"
import { makeCliTaxMaxiClient } from "./taxmaxi.ts"

export const listSources = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
}): Effect.Effect<SourceList, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) => resolved.sources.listSources(undefined)),
    Effect.mapError(toCliApiError("Failed to list sources."))
  )

export const createOnchainSource = ({
  apiUrl,
  sessionToken,
  walletAddress,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
  readonly walletAddress: string
}): Effect.Effect<SourceCreate, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.sources.createSource({
        payload: {
          type: "onchain",
          walletAddress,
          sync: true,
          jurisdiction: TAX_JURISDICTION,
          year: new Date().getUTCFullYear(),
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to create onchain source."))
  )

export const startSourceSync = ({
  apiUrl,
  sessionToken,
  sourceId,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
  readonly sourceId: string
}): Effect.Effect<SourceSyncStart, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.sources.startSourceSyncJob({
        path: {
          sourceId,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to start source sync."))
  )

export const replaySourceSync = ({
  apiUrl,
  sessionToken,
  sourceId,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
  readonly sourceId: string
}): Effect.Effect<SourceSyncStart, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.sources.replaySourceSyncJob({
        path: {
          sourceId,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to replay source sync."))
  )

export const getSyncJob = ({
  apiUrl,
  sessionToken,
  jobId,
  sourceId,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
  readonly jobId: string
  readonly sourceId: string
}): Effect.Effect<SourceSyncJob, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.sources.getSourceSyncJobStatus({
        path: {
          jobId,
          sourceId,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to poll sync job."))
  )

export const computeGermanTax = ({
  apiUrl,
  sessionToken,
  sourceId,
  year,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
  readonly sourceId: string
  readonly year: number
}): Effect.Effect<TaxCalculation, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.sources.calculateTaxForSource({
        path: {
          sourceId,
        },
        payload: {
          jurisdiction: TAX_JURISDICTION,
          year,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to calculate source tax."))
  )
