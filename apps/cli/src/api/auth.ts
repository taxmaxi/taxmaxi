import { Effect } from "effect"
import { type AuthAuthorizeRedirectResponse, type AuthOAuthSessionResponse } from "taxmaxi"
import { CliCommandError } from "../errors.ts"
import { toCliApiError } from "./errors.ts"
import { makeCliTaxMaxiClient } from "./taxmaxi.ts"

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
