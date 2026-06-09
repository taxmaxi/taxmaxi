import { type AuthorizeRedirectResponse, type OAuthSessionResponse } from "@my/rest-api/contracts"
import { Effect } from "effect"
import {
  makeTaxMaxiEffectClient,
  toTaxMaxiError,
  type SourceAssetPnl,
  type SourceCreate,
  type SourceDisposalExplanation,
  type SourceFifoLots,
  type SourceList,
  type SourceOverview,
  type SourceSyncJob,
  type SourceSyncStart,
  type SourceTaxEvents,
  type SourceTransactions,
  type TaxCalculation,
  type TaxMaxiEffectClient,
} from "taxmaxi"
import { TAX_JURISDICTION } from "../config.ts"
import { CliCommandError } from "../errors.ts"

export type CompletedOAuthSession = Omit<
  OAuthSessionResponse,
  "status" | "sessionToken" | "userId"
> & {
  readonly status: "completed"
  readonly sessionToken: string
  readonly userId: string
}

export type SyncSummary = {
  readonly sourceId: string
  readonly jobId: string
  readonly importedRecords: number
  readonly normalizedRecords: number
  readonly failedRecords: number
}

export type SourceReportPageInput = {
  readonly cursor?: string | null
  readonly limit?: number
  readonly sourceId: string
}

export type SourceDisposalExplanationInput = {
  readonly legId: string
  readonly sourceId: string
}

export type CliApiClient = {
  readonly startOAuth: () => Effect.Effect<AuthorizeRedirectResponse, CliCommandError>
  readonly getOAuthSession: (id: string) => Effect.Effect<OAuthSessionResponse, CliCommandError>
  readonly validateSession: () => Effect.Effect<boolean, CliCommandError>
  readonly listSources: () => Effect.Effect<SourceList, CliCommandError>
  readonly createOnchainSource: (input: {
    readonly walletAddress: string
  }) => Effect.Effect<SourceCreate, CliCommandError>
  readonly startSourceSync: (input: {
    readonly sourceId: string
  }) => Effect.Effect<SourceSyncStart, CliCommandError>
  readonly replaySourceSync: (input: {
    readonly sourceId: string
  }) => Effect.Effect<SourceSyncStart, CliCommandError>
  readonly getSyncJob: (input: {
    readonly jobId: string
    readonly sourceId: string
  }) => Effect.Effect<SourceSyncJob, CliCommandError>
  readonly computeGermanTax: (input: {
    readonly sourceId: string
    readonly year: number
  }) => Effect.Effect<TaxCalculation, CliCommandError>
  readonly getSourceOverview: (input: {
    readonly sourceId: string
  }) => Effect.Effect<SourceOverview, CliCommandError>
  readonly listSourceAssetPnl: (input: {
    readonly sourceId: string
  }) => Effect.Effect<SourceAssetPnl, CliCommandError>
  readonly listSourceTransactions: (
    input: SourceReportPageInput
  ) => Effect.Effect<SourceTransactions, CliCommandError>
  readonly listSourceTaxEvents: (
    input: SourceReportPageInput
  ) => Effect.Effect<SourceTaxEvents, CliCommandError>
  readonly listSourceFifoLots: (
    input: SourceReportPageInput
  ) => Effect.Effect<SourceFifoLots, CliCommandError>
  readonly explainSourceDisposal: (
    input: SourceDisposalExplanationInput
  ) => Effect.Effect<SourceDisposalExplanation, CliCommandError>
}

const toCliApiError = (fallback: string) => (error: unknown) => {
  const taxMaxiError = toTaxMaxiError(error)
  return new CliCommandError({
    message: taxMaxiError.message === "" ? fallback : taxMaxiError.message,
  })
}

const callApi = <A>(
  effect: Effect.Effect<A, unknown>,
  fallback: string
): Effect.Effect<A, CliCommandError> => effect.pipe(Effect.mapError(toCliApiError(fallback)))

const getClient = (apiUrl: string, sessionToken?: string): Effect.Effect<TaxMaxiEffectClient> =>
  makeTaxMaxiEffectClient({
    apiKey: sessionToken ?? "",
    baseUrl: apiUrl,
  })

const validateSessionToken = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken: string | undefined
}) =>
  Effect.tryPromise({
    try: async () => {
      if (sessionToken === undefined || sessionToken === "") {
        return false
      }

      const response = await fetch(new URL("/auth/me", apiUrl), {
        headers: {
          authorization: `Bearer ${sessionToken}`,
        },
      })

      if (response.status >= 200 && response.status < 300) {
        return true
      }

      if (response.status === 401 || response.status === 403) {
        return false
      }

      const body = await response.text()
      return new CliCommandError({
        message: `Failed to validate existing session (${response.status}): ${body}`,
      })
    },
    catch: toCliApiError("Failed to validate existing session."),
  }).pipe(
    Effect.flatMap((result) =>
      result instanceof CliCommandError ? Effect.fail(result) : Effect.succeed(result)
    )
  )

export const makeApiClient = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken?: string
}): CliApiClient => {
  const client = getClient(apiUrl, sessionToken)

  return {
    startOAuth: () =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.auth.authorize({
            path: {
              provider: "coinbase",
            },
            urlParams: {},
          })
        ),
        "Failed to start OAuth connect flow."
      ),
    getOAuthSession: (id) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.auth.getOAuthSession({
            path: {
              id,
            },
          })
        ),
        "Failed to poll OAuth session status."
      ),
    validateSession: () => validateSessionToken({ apiUrl, sessionToken }),
    listSources: () =>
      callApi(
        Effect.flatMap(client, (resolved) => resolved.sources.listSources(undefined)),
        "Failed to list sources."
      ),
    createOnchainSource: ({ walletAddress }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
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
        "Failed to create onchain source."
      ),
    startSourceSync: ({ sourceId }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.sources.startSourceSyncJob({
            path: {
              sourceId,
            },
          })
        ),
        "Failed to start source sync."
      ),
    replaySourceSync: ({ sourceId }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.sources.replaySourceSyncJob({
            path: {
              sourceId,
            },
          })
        ),
        "Failed to replay source sync."
      ),
    getSyncJob: ({ jobId, sourceId }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.sources.getSourceSyncJobStatus({
            path: {
              jobId,
              sourceId,
            },
          })
        ),
        "Failed to poll sync job."
      ),
    computeGermanTax: ({ sourceId, year }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
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
        "Failed to calculate source tax."
      ),
    getSourceOverview: ({ sourceId }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.sources.getSourceOverview({
            path: {
              sourceId,
            },
          })
        ),
        "Failed to read source overview."
      ),
    listSourceAssetPnl: ({ sourceId }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.sources.listSourceAssetPnl({
            path: {
              sourceId,
            },
          })
        ),
        "Failed to list source asset P&L."
      ),
    listSourceTransactions: ({ cursor, limit, sourceId }) =>
      callApi(
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
        "Failed to list source transactions."
      ),
    listSourceTaxEvents: ({ cursor, limit, sourceId }) =>
      callApi(
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
        "Failed to list source tax events."
      ),
    listSourceFifoLots: ({ cursor, limit, sourceId }) =>
      callApi(
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
        "Failed to list source FIFO lots."
      ),
    explainSourceDisposal: ({ legId, sourceId }) =>
      callApi(
        Effect.flatMap(client, (resolved) =>
          resolved.sources.explainSourceDisposal({
            path: {
              legId,
              sourceId,
            },
          })
        ),
        "Failed to explain source disposal."
      ),
  }
}
