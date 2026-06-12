/**
 * Bridge between the Solid TUI and the existing CLI effects.
 *
 * Each function runs an Effect program on a shared runtime and resolves
 * with a tagged result instead of rejecting, so screens can render
 * loading/error/empty states without try/catch.
 */
import { FileSystem } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Effect, ManagedRuntime } from "effect"
import * as Option from "effect/Option"
import type {
  Source,
  SourceAssetPnl,
  SourceDisposalExplanation,
  SourceFifoLots,
  SourceOverview,
  SourceTaxEvents,
  SourceTransactions,
} from "taxmaxi"
import {
  logoutSession,
  startCoinbaseOAuth,
  validateSessionToken,
  waitForOAuthCompletion,
} from "../api/auth.ts"
import {
  explainSourceDisposal,
  getSourceOverview,
  listSourceAssetPnl,
  listSourceFifoLots,
  listSources,
  listSourceTaxEvents,
  listSourceTransactions,
} from "../api/sources.ts"
import { openBrowser } from "../browser.ts"
import { writeClipboard } from "../clipboard.ts"
import { resolveApiUrl } from "../config.ts"
import {
  deleteSession,
  getSessionFilePath,
  readSession,
  saveSession,
  type CliSession,
} from "../session.ts"
import { nowIsoString } from "../time.ts"

const runtime = ManagedRuntime.make(NodeContext.layer)

export type SessionState =
  | { readonly _tag: "missing" }
  | { readonly _tag: "invalid"; readonly message: string }
  | { readonly _tag: "valid"; readonly session: CliSession }
  | { readonly _tag: "error"; readonly message: string }

export type SourcesResult =
  | { readonly _tag: "ok"; readonly sources: ReadonlyArray<Source> }
  | { readonly _tag: "error"; readonly message: string }

export type ConnectStart =
  | {
      readonly _tag: "started"
      readonly apiUrl: string
      readonly oauthSessionId: string
      readonly authorizationUrl: string
      readonly browserOpened: boolean
    }
  | { readonly _tag: "error"; readonly message: string }

export type ConnectResult =
  | { readonly _tag: "connected"; readonly session: CliSession }
  | { readonly _tag: "error"; readonly message: string }

export type LogoutResult =
  | { readonly _tag: "loggedOut" }
  | { readonly _tag: "error"; readonly message: string }

/**
 * Resolves the local session state: missing file, invalid file or token,
 * or a valid session. Network problems during token validation surface
 * as the "error" state so the TUI can offer a retry.
 */
export const loadSessionState = (): Promise<SessionState> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const sessionFilePath = yield* getSessionFilePath
      const exists = yield* fs.exists(sessionFilePath).pipe(Effect.orElseSucceed(() => false))
      if (!exists) {
        return { _tag: "missing" } as const
      }

      const session = yield* readSession().pipe(Effect.option)
      if (Option.isNone(session)) {
        return { _tag: "invalid", message: "The local session file could not be read." } as const
      }

      const isValid = yield* validateSessionToken({
        apiUrl: session.value.apiUrl,
        sessionToken: session.value.sessionToken,
      })
      if (!isValid) {
        return { _tag: "invalid", message: "The saved session is no longer valid." } as const
      }

      return { _tag: "valid", session: session.value } as const
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({ _tag: "error", message: error.message } as const))
    )
  )

/**
 * Loads the source list for the given session.
 */
export const fetchSources = (session: CliSession): Promise<SourcesResult> =>
  runtime.runPromise(
    listSources({ apiUrl: session.apiUrl, sessionToken: session.sessionToken }).pipe(
      Effect.map((sourceList) => ({ _tag: "ok", sources: sourceList.sources }) as const),
      Effect.catchAll((error) => Effect.succeed({ _tag: "error", message: error.message } as const))
    )
  )

export type ReportResult<A> =
  | { readonly _tag: "ok"; readonly data: A }
  | { readonly _tag: "error"; readonly message: string }

const runReport = <A>(
  effect: Effect.Effect<A, { readonly message: string }>
): Promise<ReportResult<A>> =>
  runtime.runPromise(
    effect.pipe(
      Effect.map((data) => ({ _tag: "ok", data }) as const),
      Effect.catchAll((error) => Effect.succeed({ _tag: "error", message: error.message } as const))
    )
  )

/**
 * Loads source metadata, latest sync status, and report totals.
 */
export const fetchSourceOverview = (
  session: CliSession,
  sourceId: string
): Promise<ReportResult<SourceOverview>> =>
  runReport(
    getSourceOverview({ apiUrl: session.apiUrl, sessionToken: session.sessionToken, sourceId })
  )

/**
 * Loads the per-asset P&L report rows for a source.
 */
export const fetchSourceAssetPnl = (
  session: CliSession,
  sourceId: string
): Promise<ReportResult<SourceAssetPnl>> =>
  runReport(
    listSourceAssetPnl({ apiUrl: session.apiUrl, sessionToken: session.sessionToken, sourceId })
  )

/**
 * Loads one cursor page of source transactions.
 */
export const fetchSourceTransactions = (
  session: CliSession,
  { cursor, sourceId }: { readonly sourceId: string; readonly cursor?: string | null }
): Promise<ReportResult<SourceTransactions>> =>
  runReport(
    listSourceTransactions({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId,
      cursor,
    })
  )

/**
 * Loads one cursor page of tax-visible event rows.
 */
export const fetchSourceTaxEvents = (
  session: CliSession,
  { cursor, sourceId }: { readonly sourceId: string; readonly cursor?: string | null }
): Promise<ReportResult<SourceTaxEvents>> =>
  runReport(
    listSourceTaxEvents({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId,
      cursor,
    })
  )

/**
 * Loads one cursor page of FIFO lots.
 */
export const fetchSourceFifoLots = (
  session: CliSession,
  { cursor, sourceId }: { readonly sourceId: string; readonly cursor?: string | null }
): Promise<ReportResult<SourceFifoLots>> =>
  runReport(
    listSourceFifoLots({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId,
      cursor,
    })
  )

/**
 * Loads the deterministic explanation for one disposal leg.
 */
export const fetchDisposalExplanation = (
  session: CliSession,
  { legId, sourceId }: { readonly sourceId: string; readonly legId: string }
): Promise<ReportResult<SourceDisposalExplanation>> =>
  runReport(
    explainSourceDisposal({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId,
      legId,
    })
  )

/**
 * Starts the Coinbase OAuth flow and tries to open the connect URL in a
 * browser. The returned OAuth session id is passed to
 * {@link completeCoinbaseConnect} for polling.
 */
export const startCoinbaseConnect = (options?: {
  readonly signal?: AbortSignal
}): Promise<ConnectStart> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const apiUrl = yield* resolveApiUrl
      const started = yield* startCoinbaseOAuth({ apiUrl })
      if (options?.signal?.aborted === true) {
        return yield* Effect.interrupt
      }
      const browserOpened = openBrowser(started.redirectUrl)
      return {
        _tag: "started",
        apiUrl,
        oauthSessionId: started.state,
        authorizationUrl: started.redirectUrl,
        browserOpened,
      } as const
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({ _tag: "error", message: error.message } as const))
    ),
    options?.signal !== undefined ? { signal: options.signal } : undefined
  )

/**
 * Polls the OAuth session until the browser authorization finishes, then
 * saves the CLI session. Pass an AbortSignal to cancel polling when the
 * user backs out of the connect screen.
 */
export const completeCoinbaseConnect = (
  {
    apiUrl,
    oauthSessionId,
  }: {
    readonly apiUrl: string
    readonly oauthSessionId: string
  },
  options?: { readonly signal?: AbortSignal }
): Promise<ConnectResult> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const completed = yield* waitForOAuthCompletion({ apiUrl, sessionId: oauthSessionId })
      const session: CliSession = {
        apiUrl,
        sessionToken: completed.sessionToken,
        userId: completed.userId,
        connectedAt: yield* nowIsoString,
      }
      yield* saveSession(session)
      return { _tag: "connected", session } as const
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({ _tag: "error", message: error.message } as const))
    ),
    options?.signal !== undefined ? { signal: options.signal } : undefined
  )

/**
 * Logs the user out: revokes the session on the server (best-effort, a
 * failed revoke does not block), then deletes the local session file.
 */
export const logout = (session: CliSession): Promise<LogoutResult> =>
  runtime.runPromise(
    Effect.gen(function* () {
      yield* logoutSession({
        apiUrl: session.apiUrl,
        sessionToken: session.sessionToken,
      }).pipe(Effect.catchAll(() => Effect.void))
      yield* deleteSession()
      return { _tag: "loggedOut" } as const
    }).pipe(
      Effect.catchAll((error) => Effect.succeed({ _tag: "error", message: error.message } as const))
    )
  )

/**
 * Copies text to the system clipboard. Best effort: failures are
 * swallowed inside the clipboard effect, so this never rejects.
 */
export const copyToClipboard = (text: string): Promise<void> =>
  runtime.runPromise(writeClipboard(text))

/**
 * Releases the controller runtime. Called once when the TUI exits.
 */
export const disposeController = (): Promise<void> => runtime.dispose()
