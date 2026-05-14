import { HttpApiBuilder, HttpServer } from "@effect/platform"
import {
  HashedPassword,
  LocalAuthConfig,
  PasswordHasher,
  SessionId,
  SessionTokenGenerator,
  localAuthDefaults,
} from "@my/core/authentication"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Scope from "effect/Scope"
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest"
import {
  SourceSyncRunService,
  type SourceSyncRunServiceShape,
  SourceSyncService,
  TransferReconciliationService,
  type SourceSyncServiceShape,
  type TransferReconciliationServiceShape,
} from "@my/sync-engine/services"
import { AuthServiceLive } from "../../persistence/src/layers/AuthServiceLive.ts"
import { LocalAuthProviderLive } from "../../persistence/src/layers/LocalAuthProviderLive.ts"
import { runSqlUnsafe } from "../../persistence/src/layers/PgClientLive.ts"
import { RepositoriesLive } from "../../persistence/src/layers/RepositoriesLive.ts"
import {
  AuthServiceConfig,
  SessionDurationConfig,
} from "../../persistence/src/services/AuthServiceConfig.ts"
import { EmailVerificationDeliveryService } from "../../persistence/src/services/EmailVerificationDeliveryService.ts"
import { LocalAuthProvider } from "../../persistence/src/services/LocalAuthProvider.ts"
import { makeIntegrationTestDatabaseContext } from "../../persistence/tests/support/integration-test-kit.ts"
import { TaxMaxiApiLive } from "../src/layers/TaxMaxiApiLive.ts"
import { SessionTokenValidatorLive } from "../src/layers/AuthMiddlewareLive.ts"
import { makeX402PaymentValidatorTestLive } from "./support/X402PaymentValidatorTestLive.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_rest_api_auth",
})
const TestPgClientLive = context.TestPgClientLive
const X402PaymentValidatorTestLive = makeX402PaymentValidatorTestLive({
  validPaymentHeader: "valid-test-x402-payment",
})

const runTestSql = ({ statement }: { readonly statement: string }) =>
  runSqlUnsafe({ statement }).pipe(Effect.provide(TestPgClientLive), Effect.asVoid, Effect.scoped)

const clearAuthTables = () =>
  runTestSql({
    statement: `
      TRUNCATE TABLE
        email_verification_requests,
        sessions,
        oauth_states,
        auth_identities,
        users
      RESTART IDENTITY CASCADE
    `,
  })

const SourceSyncServiceTestLive = Layer.succeed(SourceSyncService, {
  startSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: startSourceSyncJob not implemented"),
  replaySourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: replaySourceSyncJob not implemented"),
  getSourceSyncJob: () =>
    Effect.dieMessage("SourceSyncService test stub: getSourceSyncJob not implemented"),
} satisfies SourceSyncServiceShape)

const SourceSyncRunServiceTestLive = Layer.succeed(SourceSyncRunService, {
  startSyncRun: () =>
    Effect.dieMessage("SourceSyncRunService test stub: startSyncRun not implemented"),
  getSyncRun: () => Effect.dieMessage("SourceSyncRunService test stub: getSyncRun not implemented"),
} satisfies SourceSyncRunServiceShape)

const TransferReconciliationServiceTestLive = Layer.succeed(TransferReconciliationService, {
  reconcileTransferCandidates: () =>
    Effect.dieMessage(
      "TransferReconciliationService test stub: reconcileTransferCandidates not implemented"
    ),
  applyDeterministicInternalTransferCanonicalization: () =>
    Effect.dieMessage(
      "TransferReconciliationService test stub: applyDeterministicInternalTransferCanonicalization not implemented"
    ),
} satisfies TransferReconciliationServiceShape)

interface SentVerificationCode {
  readonly email: string
  readonly code: string
}

interface AuthHandlerRuntime {
  readonly handler: (request: Request) => Promise<Response>
  readonly dispose: () => Promise<void>
  readonly sentVerificationCodes: SentVerificationCode[]
}

const makeAuthHandler = () => {
  const sentVerificationCodes: SentVerificationCode[] = []
  let sessionCounter = 0

  const PasswordHasherTestLive = Layer.succeed(PasswordHasher, {
    hash: (password) => Effect.succeed(HashedPassword.make(`hash:${Redacted.value(password)}`)),
    verify: (password, hash) =>
      Effect.succeed(hash === HashedPassword.make(`hash:${Redacted.value(password)}`)),
  })

  const SessionTokenGeneratorTestLive = Layer.succeed(SessionTokenGenerator, {
    generate: () =>
      Effect.sync(() => {
        sessionCounter += 1
        return SessionId.make(`sess_${String(sessionCounter).padStart(40, "0")}`)
      }),
  })

  const EmailVerificationDeliveryServiceTestLive = Layer.succeed(EmailVerificationDeliveryService, {
    sendVerificationCode: ({ email, code }) =>
      Effect.sync(() => {
        sentVerificationCodes.push({ email, code })
      }),
  })

  const InfrastructureLive = Layer.mergeAll(
    RepositoriesLive,
    PasswordHasherTestLive,
    SessionTokenGeneratorTestLive,
    EmailVerificationDeliveryServiceTestLive,
    SourceSyncServiceTestLive,
    SourceSyncRunServiceTestLive,
    TransferReconciliationServiceTestLive
  ).pipe(Layer.provideMerge(TestPgClientLive))

  const LocalAuthProviderTestLive = LocalAuthProviderLive.pipe(
    Layer.provideMerge(InfrastructureLive)
  )

  const AuthServiceConfigTestLive = Layer.effect(
    AuthServiceConfig,
    Effect.gen(function* () {
      const localProvider = yield* LocalAuthProvider

      return {
        providers: Chunk.of(localProvider),
        sessionDurations: SessionDurationConfig.Default,
        localAuth: LocalAuthConfig.make({
          ...localAuthDefaults,
          requireEmailVerification: true,
        }),
        autoProvisionUsers: true,
        linkIdentitiesByEmail: true,
      }
    })
  ).pipe(Layer.provide(LocalAuthProviderTestLive))

  const AuthServiceTestLive = AuthServiceLive.pipe(
    Layer.provide(AuthServiceConfigTestLive),
    Layer.provideMerge(InfrastructureLive)
  )

  const { handler, dispose } = HttpApiBuilder.toWebHandler(
    TaxMaxiApiLive.pipe(
      Layer.provide(X402PaymentValidatorTestLive),
      Layer.provide(SessionTokenValidatorLive),
      Layer.provide(AuthServiceTestLive),
      Layer.provideMerge(InfrastructureLive),
      Layer.provideMerge(HttpServer.layerContext)
    )
  )

  return {
    handler,
    dispose,
    sentVerificationCodes,
  }
}

const makeAuthHandlerScoped: Effect.Effect<AuthHandlerRuntime, never, Scope.Scope> =
  Effect.acquireRelease(
    Effect.sync(() => makeAuthHandler()),
    ({ dispose }) =>
      Effect.tryPromise({
        try: () => dispose(),
        catch: (cause) => cause,
      }).pipe(Effect.orDie)
  )

const getSetCookies = (response: Response): ReadonlyArray<string> => {
  const headers = response.headers as Headers & {
    readonly getSetCookie?: () => ReadonlyArray<string>
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie()
  }

  const setCookie = response.headers.get("set-cookie")
  return setCookie === null ? [] : [setCookie]
}

const getCookieValue = ({
  setCookies,
  name,
}: {
  readonly setCookies: ReadonlyArray<string>
  readonly name: string
}): string => {
  const cookie = setCookies.find((value) => value.startsWith(`${name}=`))

  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`)
  }

  return cookie.slice(name.length + 1).split(";", 1)[0] ?? ""
}

const makeCookieHeader = (cookies: Readonly<Record<string, string>>): string =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ")

const postJson = ({
  handler,
  path,
  payload,
  cookie,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly path: string
  readonly payload: unknown
  readonly cookie?: string
}) =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers({
        "content-type": "application/json",
      })

      if (cookie !== undefined) {
        headers.set("cookie", cookie)
      }

      return handler(
        new Request(`http://taxmaxi.test${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        })
      )
    },
    catch: (cause) => cause,
  }).pipe(Effect.orDie)

const getRequest = ({
  handler,
  path,
  cookie,
}: {
  readonly handler: (request: Request) => Promise<Response>
  readonly path: string
  readonly cookie?: string
}) =>
  Effect.tryPromise({
    try: () => {
      const headers = new Headers()

      if (cookie !== undefined) {
        headers.set("cookie", cookie)
      }

      return handler(
        new Request(`http://taxmaxi.test${path}`, {
          method: "GET",
          headers,
        })
      )
    },
    catch: (cause) => cause,
  }).pipe(Effect.orDie)

const jsonBody = <A = unknown>(response: Response) =>
  Effect.tryPromise({
    try: () => response.json() as Promise<A>,
    catch: (cause) => cause,
  }).pipe(Effect.orDie)

await Effect.runPromise(context.recreateTestDatabase())

describe("AuthApiLive integration", () => {
  afterAll(() => Effect.runPromise(context.destroyTestDatabase()))

  beforeEach(() => Effect.runPromise(clearAuthTables()))

  it.effect(
    "registers, rotates the verification cookie on resend, rejects stale codes, and authenticates with the issued session cookie",
    () =>
      Effect.gen(function* () {
        const { handler, sentVerificationCodes } = yield* makeAuthHandlerScoped

        const email = `owner-${crypto.randomUUID()}@taxmaxi.test`
        const password = "password123"

        const registerResponse = yield* postJson({
          handler,
          path: "/auth/register",
          payload: {
            email,
            password,
            displayName: "Owner",
          },
        })

        expect(registerResponse.status).toBe(201)
        expect(yield* jsonBody(registerResponse)).toMatchObject({
          email,
          redirectTo: "/verify-email",
        })

        const firstSetCookies = getSetCookies(registerResponse)
        const firstVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: firstSetCookies,
            name: "taxmaxi_verification",
          })
        )
        const firstCode = sentVerificationCodes[0]?.code

        expect(firstCode).toBeDefined()

        const resendResponse = yield* postJson({
          handler,
          path: "/auth/resend-verification",
          payload: {},
          cookie: makeCookieHeader({
            taxmaxi_verification: firstVerificationRequestId,
          }),
        })

        expect(resendResponse.status).toBe(200)
        expect(yield* jsonBody(resendResponse)).toMatchObject({
          email,
          redirectTo: "/verify-email",
        })

        const resendSetCookies = getSetCookies(resendResponse)
        const secondVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: resendSetCookies,
            name: "taxmaxi_verification",
          })
        )
        const secondCode = sentVerificationCodes[1]?.code

        expect(secondVerificationRequestId).not.toBe(firstVerificationRequestId)
        expect(secondCode).toBeDefined()
        expect(secondCode).not.toBe(firstCode)

        const invalidVerifyResponse = yield* postJson({
          handler,
          path: "/auth/verify-email",
          payload: {
            code: firstCode,
          },
          cookie: makeCookieHeader({
            taxmaxi_verification: secondVerificationRequestId,
          }),
        })

        expect(invalidVerifyResponse.status).toBe(400)
        expect(yield* jsonBody(invalidVerifyResponse)).toMatchObject({
          message: "Verification code is invalid",
        })

        const verifyResponse = yield* postJson({
          handler,
          path: "/auth/verify-email",
          payload: {
            code: secondCode,
          },
          cookie: makeCookieHeader({
            taxmaxi_verification: secondVerificationRequestId,
          }),
        })

        expect(verifyResponse.status).toBe(200)
        expect(yield* jsonBody(verifyResponse)).toMatchObject({
          redirectTo: "/home",
        })

        const verifySetCookies = getSetCookies(verifyResponse)
        const sessionToken = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: verifySetCookies,
            name: "taxmaxi_session",
          })
        )
        const clearedVerificationCookie = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: verifySetCookies,
            name: "taxmaxi_verification",
          })
        )

        expect(sessionToken.length).toBeGreaterThanOrEqual(32)
        expect(clearedVerificationCookie).toBe("")

        const meResponse = yield* getRequest({
          handler,
          path: "/auth/me",
          cookie: makeCookieHeader({
            taxmaxi_session: sessionToken,
          }),
        })

        expect(meResponse.status).toBe(200)
        expect(yield* jsonBody(meResponse)).toMatchObject({
          user: {
            email,
            emailVerified: true,
          },
          identities: [
            expect.objectContaining({
              provider: "local",
            }),
          ],
        })
      }).pipe(Effect.scoped)
  )

  it.effect(
    "returns EmailVerificationRequiredError on local login for an unverified user and restores the verification cookie",
    () =>
      Effect.gen(function* () {
        const { handler, sentVerificationCodes } = yield* makeAuthHandlerScoped

        const email = `pending-${crypto.randomUUID()}@taxmaxi.test`
        const password = "password123"

        const registerResponse = yield* postJson({
          handler,
          path: "/auth/register",
          payload: {
            email,
            password,
            displayName: "Pending User",
          },
        })

        expect(registerResponse.status).toBe(201)

        const registerVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: getSetCookies(registerResponse),
            name: "taxmaxi_verification",
          })
        )
        const originalCode = sentVerificationCodes[0]?.code

        expect(originalCode).toBeDefined()

        sentVerificationCodes.length = 0

        const loginResponse = yield* postJson({
          handler,
          path: "/auth/login",
          payload: {
            provider: "local",
            credentials: {
              email,
              password,
            },
          },
        })

        expect(loginResponse.status).toBe(403)
        expect(yield* jsonBody(loginResponse)).toMatchObject({
          email,
          message: "Email verification is required before login",
        })

        const loginVerificationRequestId = yield* Effect.sync(() =>
          getCookieValue({
            setCookies: getSetCookies(loginResponse),
            name: "taxmaxi_verification",
          })
        )

        expect(loginVerificationRequestId).toBe(registerVerificationRequestId)
        expect(sentVerificationCodes).toHaveLength(1)
        expect(sentVerificationCodes[0]?.code).toBe(originalCode)
      }).pipe(Effect.scoped)
  )
})
