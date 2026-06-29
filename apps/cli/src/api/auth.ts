import { Duration, Effect } from "effect"
import * as Option from "effect/Option"
import {
  type AuthAuthorizeRedirectResponse,
  type AuthOAuthSessionResponse,
  type CurrentUserResponse,
} from "taxmaxi"
import { CliCommandError, mapUnknownToCliCommandError } from "../errors.ts"
import { nowMillis } from "../time.ts"
import { toCliApiError } from "./errors.ts"
import { makeCliTaxMaxiClient } from "./taxmaxi.ts"

const CONNECT_TIMEOUT = Duration.minutes(5)
const CONNECT_POLL_INTERVAL = Duration.seconds(2)

export type CompletedOAuthSession = Omit<
  AuthOAuthSessionResponse,
  "status" | "sessionToken" | "userId"
> & {
  readonly status: "completed"
  readonly sessionToken: string
  readonly userId: string
}

export const startCoinbaseOAuth = ({
  apiUrl,
}: {
  readonly apiUrl: string
}): Effect.Effect<AuthAuthorizeRedirectResponse, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl }).pipe(
    Effect.flatMap((resolved) =>
      resolved.auth.authorize({
        path: {
          provider: "coinbase",
        },
        urlParams: {},
      })
    ),
    Effect.mapError(toCliApiError("Failed to start OAuth connect flow."))
  )

export const getOAuthSession = ({
  apiUrl,
  sessionId,
}: {
  readonly apiUrl: string
  readonly sessionId: string
}): Effect.Effect<AuthOAuthSessionResponse, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl }).pipe(
    Effect.flatMap((resolved) =>
      resolved.auth.getOAuthSession({
        path: {
          id: sessionId,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to poll OAuth session status."))
  )

/**
 * Polls an OAuth session until it completes, fails, expires, or times out.
 *
 * Resolves with the completed session (including session token and user id)
 * or fails with a `CliCommandError` describing why the connect flow ended.
 */
export const waitForOAuthCompletion = ({
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
            message: "OAuth session expired. Start the connect flow again.",
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

/**
 * Invalidates the session on the server. Callers that log out should treat
 * this as best-effort and still delete the local session file on failure.
 */
export const logoutSession = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
}): Effect.Effect<void, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) => resolved.authSession.logout(undefined)),
    Effect.mapError(toCliApiError("Failed to log out on the server.")),
    Effect.asVoid
  )

export const validateSessionToken = ({
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

export const getCurrentUser = ({
  apiUrl,
  sessionToken,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
}): Effect.Effect<CurrentUserResponse, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) => resolved.authSession.me(undefined)),
    Effect.mapError(toCliApiError("Failed to load current user."))
  )
