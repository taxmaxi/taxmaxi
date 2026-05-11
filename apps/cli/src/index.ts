#!/usr/bin/env node

import { Command, Options } from "@effect/cli"
import {
  FileSystem,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  Path,
} from "@effect/platform"
import { NodeContext, NodeHttpClient, NodeRuntime } from "@effect/platform-node"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { Console, Duration, Effect, Layer, Schema } from "effect"
import * as Config from "effect/Config"
import * as Option from "effect/Option"
import packageJson from "../package.json" with { type: "json" }

const DEFAULT_API_URL = "https://api.taxmaxi.com"
const API_URL_ENV_VAR = "TAXMAXI_API_URL"
const WORKFLOW_PROVIDER = "coinbase"
const TAX_JURISDICTION = "germany"
const CONNECT_TIMEOUT = Duration.minutes(5)
const CONNECT_POLL_INTERVAL = Duration.seconds(2)
const JOB_TIMEOUT = Duration.minutes(10)
const JOB_POLL_INTERVAL = Duration.seconds(2)
const SESSION_FILE_RELATIVE_PATH = ".config/tax/session.json"

const jsonOption = Options.boolean("json").pipe(
  Options.withDescription("Output machine-readable JSON")
)
const noBrowserOption = Options.boolean("no-browser").pipe(
  Options.withDescription("Do not attempt to open the connect URL in a browser")
)
const forceOption = Options.boolean("force").pipe(
  Options.withDescription("Force re-authentication even when local session is valid")
)
const yearOption = Options.integer("year").pipe(Options.withDescription("Tax year (YYYY)"))
const yearWithDefaultOption = Options.integer("year").pipe(
  Options.withDefault(new Date().getUTCFullYear()),
  Options.withDescription("Tax year (YYYY)")
)

class CliCommandError extends Schema.TaggedError<CliCommandError>()("CliCommandError", {
  message: Schema.String,
}) {}

const CliSession = Schema.Struct({
  apiUrl: Schema.String,
  sessionToken: Schema.String,
  userId: Schema.String,
  connectedAt: Schema.String,
})
type CliSession = typeof CliSession.Type

const CliSessionJson = Schema.parseJson(CliSession)
const JsonOutput = Schema.parseJson(Schema.Unknown)
const ApiErrorResponse = Schema.parseJson(
  Schema.Struct({
    message: Schema.String,
  })
)

const AuthorizeRedirectResponse = Schema.Struct({
  redirectUrl: Schema.String,
  state: Schema.String,
})

const OAuthSessionResponse = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literal("coinbase", "google"),
  status: Schema.Literal("pending", "completed", "failed", "expired"),
  authorizationUrl: Schema.OptionFromNullOr(Schema.String),
  sessionToken: Schema.OptionFromNullOr(Schema.String),
  userId: Schema.OptionFromNullOr(Schema.String),
  message: Schema.OptionFromNullOr(Schema.String),
  expiresAt: Schema.String,
})
type OAuthSessionResponse = typeof OAuthSessionResponse.Type

const CoinbaseSyncStartResponse = Schema.Struct({
  sourceId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed"),
  message: Schema.OptionFromNullOr(Schema.String),
})
type CoinbaseSyncStartResponse = typeof CoinbaseSyncStartResponse.Type

const CoinbaseSyncJobResponse = Schema.Struct({
  sourceId: Schema.String,
  jobId: Schema.String,
  status: Schema.Literal("queued", "running", "completed", "failed"),
  importedRecords: Schema.OptionFromNullOr(Schema.Number),
  normalizedRecords: Schema.OptionFromNullOr(Schema.Number),
  failedRecords: Schema.OptionFromNullOr(Schema.Number),
  message: Schema.OptionFromNullOr(Schema.String),
})
type CoinbaseSyncJobResponse = typeof CoinbaseSyncJobResponse.Type

const SourceListItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  providerKey: Schema.OptionFromNullOr(Schema.String),
})

const SourceListResponse = Schema.Struct({
  sources: Schema.Array(SourceListItem),
})

const GermanTaxComputeResponse = Schema.Struct({
  year: Schema.Number,
  currency: Schema.String,
  taxableGains: Schema.Number,
  taxableLosses: Schema.Number,
  taxFreeGains: Schema.Number,
  incomeTotal: Schema.Number,
})
type GermanTaxComputeResponse = typeof GermanTaxComputeResponse.Type
type CompletedOAuthSession = Omit<OAuthSessionResponse, "status" | "sessionToken" | "userId"> & {
  readonly status: "completed"
  readonly sessionToken: string
  readonly userId: string
}

type SyncSummary = {
  sourceId: string
  jobId: string
  importedRecords: number
  normalizedRecords: number
  failedRecords: number
}

const getSessionFilePath = Effect.gen(function* () {
  const path = yield* Path.Path
  return path.join(homedir(), SESSION_FILE_RELATIVE_PATH)
})

const saveSession = (session: CliSession) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const sessionFilePath = yield* getSessionFilePath
    const sessionDir = path.dirname(sessionFilePath)
    const encoded = yield* Schema.encode(CliSessionJson)(session).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to encode CLI session",
          })
      )
    )

    yield* fs.makeDirectory(sessionDir, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to create CLI config directory",
          })
      )
    )

    yield* fs.writeFileString(sessionFilePath, encoded).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "Failed to persist CLI session",
          })
      )
    )
  })

const readSession = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const sessionFilePath = yield* getSessionFilePath
    const raw = yield* fs.readFileString(sessionFilePath).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "No local CLI session found. Run `tax coinbase connect` first.",
          })
      )
    )

    return yield* Schema.decodeUnknown(CliSessionJson)(raw).pipe(
      Effect.mapError(
        () =>
          new CliCommandError({
            message: "CLI session file is invalid. Run `tax coinbase connect` again.",
          })
      )
    )
  })

const readSessionOption = () => readSession().pipe(Effect.option)

const nowIsoString = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => new Date(Number(currentTimeMillis)).toISOString()
)

const nowMillis = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => Number(currentTimeMillis)
)

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message
    if (typeof message === "string") {
      return message
    }
  }
  return fallback
}

const resolveApiUrl = Config.string(API_URL_ENV_VAR).pipe(
  Config.map((configuredUrl) => {
    const trimmed = configuredUrl.trim()
    return trimmed.length > 0 ? trimmed : DEFAULT_API_URL
  }),
  Config.orElse(() => Config.succeed(DEFAULT_API_URL))
)

const printJson = (value: unknown) =>
  Schema.encode(JsonOutput)(value).pipe(
    Effect.mapError(
      () =>
        new CliCommandError({
          message: "Failed to encode JSON output",
        })
    ),
    Effect.flatMap(Console.log)
  )

const decodeApiErrorMessage = (body: string) =>
  Schema.decodeUnknown(ApiErrorResponse)(body).pipe(
    Effect.map((response) => response.message),
    Effect.orElseSucceed(() => {
      const trimmed = body.trim()
      return trimmed.length > 0 ? trimmed : "No response body"
    })
  )

const mapTransportErrorToCliCommandError = (fallback: string) => (error: unknown) =>
  error instanceof CliCommandError
    ? error
    : new CliCommandError({
        message: getErrorMessage(error, fallback),
      })

const openBrowser = (url: string): boolean => {
  const command =
    process.platform === "darwin"
      ? { cmd: "open", args: [url] }
      : process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] }

  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

const makeApiClient = (apiUrl: string) =>
  Effect.gen(function* () {
    const defaultClient = yield* HttpClient.HttpClient
    const client = defaultClient.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(apiUrl)))
    const decodeAuthorizeResponse = HttpClientResponse.schemaBodyJson(AuthorizeRedirectResponse)
    const decodeOAuthSession = HttpClientResponse.schemaBodyJson(OAuthSessionResponse)
    const decodeSyncStart = HttpClientResponse.schemaBodyJson(CoinbaseSyncStartResponse)
    const decodeSyncJob = HttpClientResponse.schemaBodyJson(CoinbaseSyncJobResponse)
    const decodeSourceList = HttpClientResponse.schemaBodyJson(SourceListResponse)
    const decodeGermanTax = HttpClientResponse.schemaBodyJson(GermanTaxComputeResponse)

    const executeAndDecode = <A>(
      request: HttpClientRequest.HttpClientRequest,
      decode: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, unknown>
    ) =>
      Effect.gen(function* () {
        const response = yield* client.execute(request)
        if (response.status < 200 || response.status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          const message = yield* decodeApiErrorMessage(body)
          return yield* new CliCommandError({
            message: `API request failed (${response.status}): ${message}`,
          })
        }

        return yield* decode(response).pipe(
          Effect.mapError(
            () =>
              new CliCommandError({
                message: "Failed to decode API response",
              })
          )
        )
      }).pipe(Effect.scoped)

    return {
      startOAuth: () =>
        executeAndDecode(
          HttpClientRequest.get("/auth/authorize/coinbase"),
          decodeAuthorizeResponse
        ),
      getOAuthSession: (id: string) =>
        executeAndDecode(HttpClientRequest.get(`/auth/oauth/${id}`), decodeOAuthSession),
      validateSession: (sessionToken: string) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.get("/auth/me").pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${sessionToken}`)
          )
          const response = yield* client.execute(request).pipe(Effect.scoped)

          if (response.status >= 200 && response.status < 300) {
            return true
          }

          if (response.status === 401 || response.status === 403) {
            return false
          }

          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return yield* new CliCommandError({
            message: `Failed to validate existing session (${response.status}): ${body}`,
          })
        }),
      listSources: (sessionToken: string) =>
        executeAndDecode(
          HttpClientRequest.get("/v1/sources").pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${sessionToken}`)
          ),
          decodeSourceList
        ),
      startCoinbaseSync: ({ sessionToken, sourceId }: { sessionToken: string; sourceId: string }) =>
        executeAndDecode(
          HttpClientRequest.post(`/v1/sources/${sourceId}/sync`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${sessionToken}`)
          ),
          decodeSyncStart
        ),
      replayCoinbaseSync: ({
        sessionToken,
        sourceId,
      }: {
        sessionToken: string
        sourceId: string
      }) =>
        executeAndDecode(
          HttpClientRequest.post(`/v1/sources/${sourceId}/replay`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${sessionToken}`)
          ),
          decodeSyncStart
        ),
      getSyncJob: ({
        sourceId,
        jobId,
        sessionToken,
      }: {
        sourceId: string
        jobId: string
        sessionToken: string
      }) =>
        executeAndDecode(
          HttpClientRequest.get(`/v1/sources/${sourceId}/jobs/${jobId}`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${sessionToken}`)
          ),
          decodeSyncJob
        ),
      computeGermanTax: ({
        sessionToken,
        sourceId,
        year,
      }: {
        sessionToken: string
        sourceId: string
        year: number
      }) =>
        executeAndDecode(
          HttpClientRequest.post(`/v1/sources/${sourceId}/tax`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${sessionToken}`),
            HttpClientRequest.bodyUnsafeJson({
              year,
              jurisdiction: TAX_JURISDICTION,
            })
          ),
          decodeGermanTax
        ),
    }
  })

const resolveCoinbaseSourceId = ({
  apiUrl,
  sessionToken,
}: {
  apiUrl: string
  sessionToken: string
}) =>
  Effect.gen(function* () {
    const api = yield* makeApiClient(apiUrl)
    const sourceList = yield* api.listSources(sessionToken)

    const source = sourceList.sources.find((candidate) => {
      const providerKey = Option.getOrNull(candidate.providerKey)
      return providerKey !== null && providerKey.toLowerCase() === WORKFLOW_PROVIDER
    })

    if (source === undefined) {
      return yield* new CliCommandError({
        message: "No Coinbase source found. Run `tax coinbase connect --force` and try again.",
      })
    }

    return source.id
  })

const waitForSyncCompletion = ({
  apiUrl,
  sessionToken,
  sourceId,
  jobId,
}: {
  apiUrl: string
  sessionToken: string
  sourceId: string
  jobId: string
}) =>
  Effect.gen(function* () {
    const api = yield* makeApiClient(apiUrl)
    const startedAt = yield* nowMillis

    const poll = (): Effect.Effect<SyncSummary, CliCommandError> =>
      Effect.gen(function* () {
        const job = yield* api
          .getSyncJob({ sourceId, jobId, sessionToken })
          .pipe(Effect.mapError(mapTransportErrorToCliCommandError("Failed to poll sync job.")))

        if (job.status === "completed") {
          return {
            sourceId: job.sourceId,
            jobId: job.jobId,
            importedRecords: Option.getOrElse(job.importedRecords, () => 0),
            normalizedRecords: Option.getOrElse(job.normalizedRecords, () => 0),
            failedRecords: Option.getOrElse(job.failedRecords, () => 0),
          } satisfies SyncSummary
        }

        if (job.status === "failed") {
          const message = Option.getOrElse(job.message, () => "Coinbase sync failed.")
          return yield* new CliCommandError({ message })
        }

        const currentTime = yield* nowMillis
        if (currentTime - startedAt > Duration.toMillis(JOB_TIMEOUT)) {
          return yield* new CliCommandError({
            message: "Timed out waiting for Coinbase sync job to finish.",
          })
        }

        yield* Effect.sleep(JOB_POLL_INTERVAL)
        return yield* poll()
      })

    return yield* poll()
  })

const printWorkflowSummary = ({
  sync,
  tax,
}: {
  sync: SyncSummary
  tax: GermanTaxComputeResponse
}) =>
  Effect.gen(function* () {
    yield* Console.log(`Coinbase tax summary for ${tax.year} (${tax.currency})`)
    yield* Console.log(`Imported records: ${sync.importedRecords}`)
    yield* Console.log(`Failed records: ${sync.failedRecords}`)
    yield* Console.log(`Taxable gains: ${tax.taxableGains}`)
    yield* Console.log(`Taxable losses: ${tax.taxableLosses}`)
    yield* Console.log(`Tax-free gains: ${tax.taxFreeGains}`)
    yield* Console.log(`Income total: ${tax.incomeTotal}`)
  })

const syncProgram = ({
  json,
  emitConsoleOutput = true,
}: {
  json: boolean
  emitConsoleOutput?: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const sourceId = yield* resolveCoinbaseSourceId({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
    })
    const api = yield* makeApiClient(session.apiUrl)
    const started = yield* api.startCoinbaseSync({
      sessionToken: session.sessionToken,
      sourceId,
    })

    const summary = yield* waitForSyncCompletion({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId: started.sourceId,
      jobId: started.jobId,
    })

    if (json) {
      yield* printJson({
        stage: "sync_completed",
        ...summary,
      })
      return summary
    }

    if (emitConsoleOutput) {
      yield* Console.log("Coinbase sync completed.")
      yield* Console.log(`Imported: ${summary.importedRecords}`)
      yield* Console.log(`Normalized: ${summary.normalizedRecords}`)
      yield* Console.log(`Failed: ${summary.failedRecords}`)
    }
    return summary
  })

const replayProgram = ({
  json,
  emitConsoleOutput = true,
}: {
  json: boolean
  emitConsoleOutput?: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const sourceId = yield* resolveCoinbaseSourceId({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
    })
    const api = yield* makeApiClient(session.apiUrl)
    const started = yield* api.replayCoinbaseSync({
      sessionToken: session.sessionToken,
      sourceId,
    })

    const summary = yield* waitForSyncCompletion({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId: started.sourceId,
      jobId: started.jobId,
    })

    if (json) {
      yield* printJson({
        stage: "replay_completed",
        ...summary,
      })
      return summary
    }

    if (emitConsoleOutput) {
      yield* Console.log("Coinbase replay completed.")
      yield* Console.log(`Imported: ${summary.importedRecords}`)
      yield* Console.log(`Normalized: ${summary.normalizedRecords}`)
      yield* Console.log(`Failed: ${summary.failedRecords}`)
    }
    return summary
  })

const calculateProgram = ({
  year,
  json,
  emitConsoleOutput = true,
}: {
  year: number
  json: boolean
  emitConsoleOutput?: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const sourceId = yield* resolveCoinbaseSourceId({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
    })
    const api = yield* makeApiClient(session.apiUrl)
    const taxSummary = yield* api.computeGermanTax({
      sessionToken: session.sessionToken,
      sourceId,
      year,
    })

    if (json) {
      yield* printJson({
        stage: "calculate_completed",
        ...taxSummary,
      })
      return taxSummary
    }

    if (emitConsoleOutput) {
      yield* Console.log(`German tax summary for ${taxSummary.year} (${taxSummary.currency})`)
      yield* Console.log(`Taxable gains: ${taxSummary.taxableGains}`)
      yield* Console.log(`Taxable losses: ${taxSummary.taxableLosses}`)
      yield* Console.log(`Tax-free gains: ${taxSummary.taxFreeGains}`)
      yield* Console.log(`Income total: ${taxSummary.incomeTotal}`)
    }
    return taxSummary
  })

const waitForOAuthCompletion = ({ apiUrl, sessionId }: { apiUrl: string; sessionId: string }) =>
  Effect.gen(function* () {
    const api = yield* makeApiClient(apiUrl)
    const startedAt = yield* nowMillis

    const poll = (): Effect.Effect<CompletedOAuthSession, CliCommandError> =>
      Effect.gen(function* () {
        const status = yield* api
          .getOAuthSession(sessionId)
          .pipe(
            Effect.mapError(
              mapTransportErrorToCliCommandError("Failed to poll OAuth session status.")
            )
          )

        if (
          status.status === "completed" &&
          Option.isSome(status.sessionToken) &&
          Option.isSome(status.userId)
        ) {
          return {
            ...status,
            status: "completed" as const,
            sessionToken: status.sessionToken.value,
            userId: status.userId.value,
          }
        }

        if (status.status === "failed") {
          const message = Option.getOrElse(status.message, () => "OAuth connect failed.")
          return yield* new CliCommandError({ message })
        }

        if (status.status === "expired") {
          return yield* new CliCommandError({
            message: "OAuth session expired. Please run `tax coinbase connect` again.",
          })
        }

        const currentTime = yield* nowMillis
        if (currentTime - startedAt > Duration.toMillis(CONNECT_TIMEOUT)) {
          return yield* new CliCommandError({
            message: "Timed out waiting for browser authorization.",
          })
        }

        yield* Effect.sleep(CONNECT_POLL_INTERVAL)
        return yield* poll()
      })

    return yield* poll()
  })

const connectProgram = ({
  json,
  noBrowser,
  force,
}: {
  json: boolean
  noBrowser: boolean
  force: boolean
}) =>
  Effect.gen(function* () {
    const apiUrl = yield* resolveApiUrl
    const api = yield* makeApiClient(apiUrl)

    if (!force) {
      const maybeSession = yield* readSessionOption()

      if (Option.isSome(maybeSession) && maybeSession.value.apiUrl === apiUrl) {
        const isValidSession = yield* api.validateSession(maybeSession.value.sessionToken)
        if (isValidSession) {
          if (json) {
            yield* printJson({
              stage: "connect_skipped",
              reason: "existing_session_valid",
              userId: maybeSession.value.userId,
            })
          } else {
            yield* Console.log("Existing CLI session is valid. Skipping OAuth connect.")
            yield* Console.log("Use `--force` to re-authenticate.")
          }
          return
        }
      }
    }

    const started = yield* api.startOAuth()
    const authorizationUrl = started.redirectUrl

    if (json) {
      yield* printJson({
        stage: "connect_started",
        sessionId: started.state,
        connectUrl: authorizationUrl,
        expiresAt: null,
      })
    } else {
      yield* Console.log("Starting Coinbase connect flow...")
      yield* Console.log(`Open this URL to continue: ${authorizationUrl}`)
    }

    const didOpenBrowser = noBrowser ? false : openBrowser(authorizationUrl)
    if (!json && !noBrowser && !didOpenBrowser) {
      yield* Console.log("Could not open browser automatically. Please open the URL manually.")
    }

    const completed = yield* waitForOAuthCompletion({
      apiUrl,
      sessionId: started.state,
    })

    yield* saveSession({
      apiUrl,
      sessionToken: completed.sessionToken,
      userId: completed.userId,
      connectedAt: yield* nowIsoString,
    })

    if (json) {
      yield* printJson({
        stage: "connect_completed",
        userId: completed.userId,
        expiresAt: completed.expiresAt,
        message: Option.getOrNull(completed.message),
      })
    } else {
      yield* Console.log("Coinbase connected and CLI session saved.")
    }
  })

const connectCommand = Command.make(
  "connect",
  {
    json: jsonOption,
    noBrowser: noBrowserOption,
    force: forceOption,
  },
  ({ json, noBrowser, force }) => connectProgram({ json, noBrowser, force })
).pipe(Command.withDescription("Connect Coinbase account via OAuth"))

const syncCommand = Command.make("sync", { json: jsonOption }, ({ json }) =>
  syncProgram({ json })
).pipe(Command.withDescription("Sync Coinbase records"))

const replayCommand = Command.make("replay", { json: jsonOption }, ({ json }) =>
  replayProgram({ json })
).pipe(Command.withDescription("Reset and replay Coinbase records from cached raw data"))

const calculateCommand = Command.make(
  "calculate",
  { year: yearOption, json: jsonOption },
  ({ year, json }) => calculateProgram({ year, json })
).pipe(Command.withDescription("Calculate tax summary for a year"))

const coinbaseCommand = Command.make(
  "coinbase",
  {
    year: yearWithDefaultOption,
    json: jsonOption,
    noBrowser: noBrowserOption,
    force: forceOption,
  },
  ({ year, json, noBrowser, force }) =>
    Effect.gen(function* () {
      yield* connectProgram({ json, noBrowser, force })
      const syncSummary = yield* syncProgram({
        json,
        emitConsoleOutput: json,
      })
      const taxSummary = yield* calculateProgram({
        year,
        json,
        emitConsoleOutput: json,
      })

      if (json) {
        yield* printJson({
          stage: "workflow_completed",
          year: taxSummary.year,
          currency: taxSummary.currency,
          importedRecords: syncSummary.importedRecords,
          failedRecords: syncSummary.failedRecords,
          taxableGains: taxSummary.taxableGains,
          taxableLosses: taxSummary.taxableLosses,
          taxFreeGains: taxSummary.taxFreeGains,
          incomeTotal: taxSummary.incomeTotal,
        })
        return
      }

      yield* printWorkflowSummary({
        sync: syncSummary,
        tax: taxSummary,
      })
      yield* Console.log("Done.")
    })
).pipe(
  Command.withDescription("Coinbase workflow commands"),
  Command.withSubcommands([connectCommand, syncCommand, replayCommand, calculateCommand])
)

const command = Command.make("tax", {}).pipe(Command.withSubcommands([coinbaseCommand]))

const cli = Command.run(command, { name: "TaxMaxi CLI", version: packageJson.version })

const runtimeLayer = Layer.mergeAll(NodeContext.layer, NodeHttpClient.layer)

cli(process.argv).pipe(
  Effect.catchAll((error) => {
    const markFailedExit = Effect.sync(() => {
      process.exitCode = 1
    })

    if (error instanceof CliCommandError) {
      return Console.error(`Error: ${error.message}`).pipe(Effect.zipRight(markFailedExit))
    }

    return Console.error(`Unexpected error: ${getErrorMessage(error, "unknown")}`).pipe(
      Effect.zipRight(markFailedExit)
    )
  }),
  Effect.provide(runtimeLayer),
  NodeRuntime.runMain
)
