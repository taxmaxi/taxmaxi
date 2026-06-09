import { Command, Options } from "@effect/cli"
import { Console, DateTime, Duration, Effect } from "effect"
import * as Option from "effect/Option"
import type { TaxCalculation } from "taxmaxi"
import {
  getOAuthSession,
  startCoinbaseOAuth,
  validateSessionToken,
  type CompletedOAuthSession,
} from "../api/auth.ts"
import { computeGermanTax, listSources, replaySourceSync, startSourceSync } from "../api/sources.ts"
import { openBrowser } from "../browser.ts"
import { resolveApiUrl, WORKFLOW_PROVIDER } from "../config.ts"
import { CliCommandError, mapUnknownToCliCommandError } from "../errors.ts"
import { printJson } from "../io/json.ts"
import { readSession, readSessionOption, saveSession } from "../session.ts"
import { nowIsoString, nowMillis } from "../time.ts"
import { getNullableProviderKey, waitForSyncCompletion, type SyncSummary } from "./sourceSync.ts"

const CONNECT_TIMEOUT = Duration.minutes(5)
const CONNECT_POLL_INTERVAL = Duration.seconds(2)

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

const resolveCoinbaseSourceId = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
}) =>
  Effect.gen(function* () {
    const sourceList = yield* listSources({ apiUrl, sessionToken })

    const source = sourceList.sources.find((candidate) => {
      const providerKey = getNullableProviderKey(candidate)
      return providerKey !== null && providerKey.toLowerCase() === WORKFLOW_PROVIDER
    })

    if (source === undefined) {
      return yield* new CliCommandError({
        message: "No Coinbase source found. Run `tax coinbase connect --force` and try again.",
      })
    }

    return source.id
  })

const printWorkflowSummary = ({
  sync,
  tax,
}: {
  readonly sync: SyncSummary
  readonly tax: TaxCalculation
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

export const syncProgram = ({
  json,
  emitConsoleOutput = true,
}: {
  readonly json: boolean
  readonly emitConsoleOutput?: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const sourceId = yield* resolveCoinbaseSourceId({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
    })
    const started = yield* startSourceSync({
      apiUrl: session.apiUrl,
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

export const replayProgram = ({
  json,
  emitConsoleOutput = true,
}: {
  readonly json: boolean
  readonly emitConsoleOutput?: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const sourceId = yield* resolveCoinbaseSourceId({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
    })
    const started = yield* replaySourceSync({
      apiUrl: session.apiUrl,
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

export const calculateProgram = ({
  year,
  json,
  emitConsoleOutput = true,
}: {
  readonly year: number
  readonly json: boolean
  readonly emitConsoleOutput?: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const sourceId = yield* resolveCoinbaseSourceId({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
    })
    const taxSummary = yield* computeGermanTax({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId,
      year,
    })

    if (json) {
      yield* printJson({
        stage: "calculate_completed",
        year: taxSummary.year,
        currency: taxSummary.currency,
        taxableGains: taxSummary.taxableGains,
        taxableLosses: taxSummary.taxableLosses,
        taxFreeGains: taxSummary.taxFreeGains,
        incomeTotal: taxSummary.incomeTotal,
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

const waitForOAuthCompletion = ({
  apiUrl,
  sessionId,
}: {
  readonly apiUrl: string
  readonly sessionId: string
}) =>
  Effect.gen(function* () {
    const startedAt = yield* nowMillis

    const poll = (): Effect.Effect<CompletedOAuthSession, CliCommandError> =>
      Effect.gen(function* () {
        const status = yield* getOAuthSession({ apiUrl, sessionId }).pipe(
          Effect.mapError(mapUnknownToCliCommandError("Failed to poll OAuth session status."))
        )

        if (
          status.status === "completed" &&
          Option.isSome(status.sessionToken) &&
          Option.isSome(status.userId)
        ) {
          return {
            id: status.id,
            provider: status.provider,
            status: "completed" as const,
            authorizationUrl: status.authorizationUrl,
            sessionToken: status.sessionToken.value,
            userId: status.userId.value,
            message: status.message,
            expiresAt: status.expiresAt,
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

export const connectProgram = ({
  json,
  noBrowser,
  force,
}: {
  readonly json: boolean
  readonly noBrowser: boolean
  readonly force: boolean
}) =>
  Effect.gen(function* () {
    const apiUrl = yield* resolveApiUrl

    if (!force) {
      const maybeSession = yield* readSessionOption()

      if (Option.isSome(maybeSession) && maybeSession.value.apiUrl === apiUrl) {
        const isValidSession = yield* validateSessionToken({
          apiUrl,
          sessionToken: maybeSession.value.sessionToken,
        })
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

    const started = yield* startCoinbaseOAuth({ apiUrl })
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
        expiresAt: DateTime.formatIso(completed.expiresAt),
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

export const coinbaseCommand = Command.make(
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
