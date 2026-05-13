import { describe, expect, it } from "vitest"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import { Principal, PrincipalId } from "@my/core/ownership"
import {
  AuthResult,
  AuthService,
  AuthUser,
  Email,
  EmailVerificationRequestId,
  EmailVerificationRequest,
  HashedPassword,
  PasswordHasher,
  ProviderId,
  Session,
  SessionId,
  SessionTokenGenerator,
  UserIdentity,
  LocalAuthRequest,
  isLocalAuthRequest,
  localAuthDefaults,
  type AuthProvider,
  type AuthServiceShape,
} from "@my/core/authentication"
import { AuthServiceLive } from "../../src/layers/AuthServiceLive.ts"
import { AuthServiceConfig, SessionDurationConfig } from "../../src/services/AuthServiceConfig.ts"
import {
  EmailVerificationDeliveryService,
  type EmailVerificationDeliveryServiceShape,
} from "../../src/services/EmailVerificationDeliveryService.ts"
import {
  EmailVerificationRequestRepository,
  type EmailVerificationRequestRepositoryService,
} from "../../src/services/EmailVerificationRequestRepository.ts"
import {
  IdentityRepository,
  type IdentityRepositoryService,
} from "../../src/services/IdentityRepository.ts"
import { OAuthStateStore, type OAuthStateStoreService } from "../../src/services/OAuthStateStore.ts"
import {
  PrincipalRepository,
  type PrincipalRepositoryService,
} from "../../src/services/PrincipalRepository.ts"
import {
  SessionRepository,
  type SessionRepositoryService,
} from "../../src/services/SessionRepository.ts"
import { UserRepository, type UserRepositoryService } from "../../src/services/UserRepository.ts"
import {
  EmailVerificationCodeMismatchError,
  EmailVerificationRequestExpiredError,
  EmailVerificationRequestNotFoundError,
  ProviderAuthFailedError,
} from "@my/core/authentication/errors"

interface HarnessState {
  readonly users: Map<string, AuthUser>
  readonly identities: Map<string, UserIdentity>
  readonly principals: Map<string, Principal>
  readonly verificationRequests: Map<string, EmailVerificationRequest>
}

interface Harness {
  readonly state: HarnessState
  readonly runWithAuth: <A, E>(f: (auth: AuthServiceShape) => Effect.Effect<A, E>) => Promise<A>
  // Effect's Either is typed as Either<Right, Left>, so this is Either<Success, Error>
  readonly runWithAuthEither: <A, E>(
    f: (auth: AuthServiceShape) => Effect.Effect<A, E>
  ) => Promise<Either.Either<A, E>>
}

const unsupported = <A>(): Effect.Effect<A> => Effect.dieMessage("unsupported in test")

const makeOAuthProvider = (type: "google" | "coinbase"): AuthProvider => ({
  type,
  supportsRegistration: false,
  authenticate: () => unsupported(),
  getAuthorizationUrl: (state, redirectUri) => {
    const authUrl =
      type === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "https://www.coinbase.com/oauth/authorize"

    const defaultRedirectUri =
      type === "google"
        ? "http://localhost:3000/auth/callback/google"
        : "http://localhost:3000/auth/callback/coinbase"

    const url = new URL(authUrl)
    url.searchParams.set("state", state)
    url.searchParams.set("redirect_uri", redirectUri ?? defaultRedirectUri)
    return Option.some(url.toString())
  },
  handleCallback: (code) =>
    Effect.succeed(
      AuthResult.make({
        provider: type,
        providerId: ProviderId.make(`${type}-${code}`),
        email: Email.make(`${code}@example.com`),
        displayName: `${code} User`,
        emailVerified: true,
        providerData: Option.none(),
        oauthCredentials: Option.none(),
      })
    ),
})

const makeGoogleProvider = (): AuthProvider => makeOAuthProvider("google")
const makeCoinbaseProvider = (): AuthProvider => makeOAuthProvider("coinbase")

const makeLocalProvider = ({
  emailVerified,
}: {
  readonly emailVerified: boolean
}): AuthProvider => ({
  type: "local",
  supportsRegistration: true,
  authenticate: (request) => {
    if (!isLocalAuthRequest(request)) {
      return Effect.fail(
        new ProviderAuthFailedError({
          provider: "local",
          reason: "Invalid request type for local authentication test provider",
        })
      )
    }

    return Effect.succeed(
      AuthResult.make({
        provider: "local",
        providerId: ProviderId.make(request.email),
        email: request.email,
        displayName: request.email.split("@")[0] ?? "user",
        emailVerified,
        providerData: Option.none(),
        oauthCredentials: Option.none(),
      })
    )
  },
  getAuthorizationUrl: () => Option.none(),
  handleCallback: () => unsupported(),
})

const makeUserRepo = (state: HarnessState): UserRepositoryService => ({
  findById: (id) => Effect.succeed(Option.fromNullable(state.users.get(id))),
  findByEmail: (email) =>
    Effect.succeed(
      Option.fromNullable(Array.from(state.users.values()).find((user) => user.email === email))
    ),
  create: (insert) => {
    const timestamp = Timestamp.now()
    const user = AuthUser.make({
      ...insert,
      createdAt: timestamp,
      emailVerified: insert.emailVerified,
      updatedAt: timestamp,
    })
    state.users.set(user.id, user)
    return Effect.succeed(user)
  },
  update: (id, patch) => {
    const existing = state.users.get(id)
    if (existing === undefined) {
      return unsupported()
    }

    const updated = AuthUser.make({
      ...existing,
      ...patch,
      updatedAt: Timestamp.now(),
    })
    state.users.set(id, updated)
    return Effect.succeed(updated)
  },
  delete: (id) => {
    state.users.delete(id)
    return Effect.succeed(undefined)
  },
  findPlatformAdmins: () =>
    Effect.succeed(Array.from(state.users.values()).filter((user) => user.role === "admin")),
  isPlatformAdmin: (id) => Effect.succeed(state.users.get(id)?.role === "admin"),
})

const makeEmailVerificationRequestRepo = (
  state: HarnessState
): EmailVerificationRequestRepositoryService => ({
  create: (request) => {
    for (const [existingId, existingRequest] of state.verificationRequests) {
      if (existingRequest.userId === request.userId) {
        state.verificationRequests.delete(existingId)
      }
    }

    const now = Timestamp.now()
    const verificationRequest = EmailVerificationRequest.make({
      ...request,
      createdAt: now,
      updatedAt: now,
    })

    state.verificationRequests.set(verificationRequest.id, verificationRequest)
    return Effect.succeed(verificationRequest)
  },
  findById: (id) => Effect.succeed(Option.fromNullable(state.verificationRequests.get(id))),
  findByUserId: (userId) =>
    Effect.succeed(
      Option.fromNullable(
        Array.from(state.verificationRequests.values())
          .filter((request) => request.userId === userId)
          .sort((left, right) => right.createdAt.epochMillis - left.createdAt.epochMillis)[0]
      )
    ),
  consume: (id) => {
    const existing = state.verificationRequests.get(id)
    if (existing === undefined) {
      return Effect.succeed(Option.none())
    }

    state.verificationRequests.delete(id)
    return Effect.succeed(Option.some(existing))
  },
  deleteExpired: (now) => {
    let deleted = 0
    for (const [id, request] of state.verificationRequests) {
      if (request.expiresAt.epochMillis <= now.epochMillis) {
        state.verificationRequests.delete(id)
        deleted += 1
      }
    }
    return Effect.succeed(deleted)
  },
})

const makeEmailVerificationDeliveryService = (): EmailVerificationDeliveryServiceShape => ({
  sendVerificationCode: () => Effect.succeed(undefined),
})

const makeIdentityRepo = (state: HarnessState): IdentityRepositoryService => {
  const passwordHashes = new Map<string, HashedPassword>()
  const passwordKey = (provider: string, providerId: string) => `${provider}:${providerId}`

  return {
    findById: (id) => Effect.succeed(Option.fromNullable(state.identities.get(id))),
    findByUserId: (userId) =>
      Effect.succeed(
        Chunk.fromIterable(
          Array.from(state.identities.values()).filter((identity) => identity.userId === userId)
        )
      ),
    findByProvider: (provider, providerId) =>
      Effect.succeed(
        Option.fromNullable(
          Array.from(state.identities.values()).find(
            (identity) => identity.provider === provider && identity.providerId === providerId
          )
        )
      ),
    findByUserAndProvider: (userId, provider) =>
      Effect.succeed(
        Option.fromNullable(
          Array.from(state.identities.values()).find(
            (identity) => identity.userId === userId && identity.provider === provider
          )
        )
      ),
    create: (insert) => {
      const identity = UserIdentity.make({
        id: insert.id,
        userId: insert.userId,
        provider: insert.provider,
        providerId: insert.providerId,
        providerData: insert.providerData,
        createdAt: Timestamp.now(),
      })

      state.identities.set(identity.id, identity)
      if (insert.passwordHash !== undefined) {
        passwordHashes.set(passwordKey(insert.provider, insert.providerId), insert.passwordHash)
      }

      return Effect.succeed(identity)
    },
    update: (id, patch) => {
      const existing = state.identities.get(id)
      if (existing === undefined) {
        return unsupported()
      }

      const updated = UserIdentity.make({
        ...existing,
        providerData: patch.providerData ?? existing.providerData,
      })
      state.identities.set(id, updated)
      return Effect.succeed(updated)
    },
    delete: (id) => {
      state.identities.delete(id)
      return Effect.succeed(undefined)
    },
    deleteByUserId: (userId) => {
      const userIdentityIds = Array.from(state.identities.values())
        .filter((identity) => identity.userId === userId)
        .map((identity) => identity.id)
      for (const identityId of userIdentityIds) {
        state.identities.delete(identityId)
      }
      return Effect.succeed(userIdentityIds.length)
    },
    getPasswordHash: (provider, providerId) =>
      Effect.succeed(Option.fromNullable(passwordHashes.get(passwordKey(provider, providerId)))),
    updatePasswordHash: (provider, providerId, newPasswordHash) => {
      passwordHashes.set(passwordKey(provider, providerId), newPasswordHash)
      return Effect.succeed(undefined)
    },
  }
}

const makePrincipalRepository = (state: HarnessState): PrincipalRepositoryService => ({
  findUserPrincipal: (userId) =>
    Effect.succeed(
      Option.fromNullable(
        Array.from(state.principals.values()).find((principal) => principal.userId === userId)
      )
    ),
  createUserPrincipal: (userId) => {
    const existing = Array.from(state.principals.values()).find(
      (principal) => principal.userId === userId
    )
    if (existing !== undefined) {
      return Effect.succeed(existing)
    }

    const principal = Principal.make({
      id: PrincipalId.make(crypto.randomUUID()),
      kind: "user",
      userId,
    })
    state.principals.set(principal.id, principal)
    return Effect.succeed(principal)
  },
  createAnonymousWalletPrincipal: () => {
    const principal = Principal.make({
      id: PrincipalId.make(crypto.randomUUID()),
      kind: "anonymous_wallet",
      userId: null,
    })
    state.principals.set(principal.id, principal)
    return Effect.succeed(principal)
  },
})

const makeSessionRepo = (): SessionRepositoryService => {
  const sessions = new Map<string, Session>()

  return {
    findById: (id) => Effect.succeed(Option.fromNullable(sessions.get(id))),
    findByUserId: (userId) =>
      Effect.succeed(
        Chunk.fromIterable(
          Array.from(sessions.values()).filter((session) => session.userId === userId)
        )
      ),
    create: (insert) => {
      const session = Session.make({
        ...insert,
        createdAt: Timestamp.now(),
      })
      sessions.set(session.id, session)
      return Effect.succeed(session)
    },
    delete: (id) => {
      sessions.delete(id)
      return Effect.succeed(undefined)
    },
    deleteExpired: () => {
      const current = Timestamp.now().epochMillis
      let deleted = 0
      for (const [id, session] of sessions) {
        if (session.expiresAt.epochMillis <= current) {
          sessions.delete(id)
          deleted += 1
        }
      }
      return Effect.succeed(deleted)
    },
    deleteByUserId: (userId) => {
      let deleted = 0
      for (const [id, session] of sessions) {
        if (session.userId === userId) {
          sessions.delete(id)
          deleted += 1
        }
      }
      return Effect.succeed(deleted)
    },
    updateExpiry: (id, expiresAt) => {
      const existing = sessions.get(id)
      if (existing === undefined) {
        return unsupported()
      }

      const updated = Session.make({
        ...existing,
        expiresAt,
      })
      sessions.set(id, updated)
      return Effect.succeed(updated)
    },
  }
}

const makeOAuthStateStore = (): OAuthStateStoreService => {
  const states = new Map<string, Parameters<OAuthStateStoreService["create"]>[0]>()

  return {
    create: (record) => {
      states.set(record.state, record)
      return Effect.succeed(undefined)
    },
    consume: (state) => {
      const record = states.get(state)
      if (record === undefined) {
        return Effect.succeed(Option.none())
      }

      if (Option.isSome(record.consumedAt)) {
        return Effect.succeed(Option.none())
      }

      if (record.expiresAt.epochMillis <= Timestamp.now().epochMillis) {
        return Effect.succeed(Option.none())
      }

      const consumedAt = Timestamp.now()

      states.set(state, {
        ...record,
        consumedAt: Option.some(consumedAt),
      })

      return Effect.succeed(
        Option.some({
          ...record,
          consumedAt: Option.some(consumedAt),
        })
      )
    },
    get: (state) => Effect.succeed(Option.fromNullable(states.get(state))),
    markCompleted: ({ state, sessionToken, userId, statusMessage, completedAt }) => {
      const existing = states.get(state)
      if (existing === undefined) {
        return Effect.succeed(undefined)
      }

      states.set(state, {
        ...existing,
        status: "completed",
        sessionToken: Option.some(sessionToken),
        userId: Option.some(userId),
        statusMessage,
        completedAt: Option.some(completedAt),
      })
      return Effect.succeed(undefined)
    },
    markFailed: ({ state, statusMessage, completedAt }) => {
      const existing = states.get(state)
      if (existing === undefined) {
        return Effect.succeed(undefined)
      }

      states.set(state, {
        ...existing,
        status: "failed",
        statusMessage: Option.some(statusMessage),
        completedAt: Option.some(completedAt),
      })
      return Effect.succeed(undefined)
    },
    deleteExpired: () => {
      let deleted = 0
      for (const [state, record] of states) {
        if (record.expiresAt.epochMillis <= Timestamp.now().epochMillis) {
          states.delete(state)
          deleted += 1
        }
      }
      return Effect.succeed(deleted)
    },
  }
}

const makeHarness = (providers: ReadonlyArray<AuthProvider>): Harness => {
  const state: HarnessState = {
    users: new Map(),
    identities: new Map(),
    principals: new Map(),
    verificationRequests: new Map(),
  }

  let sessionCounter = 0

  const deps = Layer.mergeAll(
    Layer.succeed(AuthServiceConfig, {
      providers: Chunk.fromIterable(providers),
      sessionDurations: SessionDurationConfig.Default,
      localAuth: localAuthDefaults,
      autoProvisionUsers: true,
      linkIdentitiesByEmail: true,
    }),
    Layer.succeed(UserRepository, makeUserRepo(state)),
    Layer.succeed(EmailVerificationDeliveryService, makeEmailVerificationDeliveryService()),
    Layer.succeed(EmailVerificationRequestRepository, makeEmailVerificationRequestRepo(state)),
    Layer.succeed(IdentityRepository, makeIdentityRepo(state)),
    Layer.succeed(PrincipalRepository, makePrincipalRepository(state)),
    Layer.succeed(SessionRepository, makeSessionRepo()),
    Layer.succeed(OAuthStateStore, makeOAuthStateStore()),
    Layer.succeed(SessionTokenGenerator, {
      generate: () => {
        sessionCounter += 1
        const token = `sess_${String(sessionCounter).padStart(40, "0")}`
        return Effect.succeed(SessionId.make(token))
      },
    }),
    Layer.succeed(PasswordHasher, {
      hash: (plaintext) => Effect.succeed(HashedPassword.make(`hash:${Redacted.value(plaintext)}`)),
      verify: (plaintext, hash) =>
        Effect.succeed(hash === HashedPassword.make(`hash:${Redacted.value(plaintext)}`)),
    })
  )

  const run = <A, E>(effect: Effect.Effect<A, E, AuthService>) =>
    Effect.runPromise(effect.pipe(Effect.provide(AuthServiceLive), Effect.provide(deps)))

  return {
    state,
    runWithAuth: (f) =>
      run(
        Effect.gen(function* () {
          const auth = yield* AuthService
          return yield* f(auth)
        })
      ),
    runWithAuthEither: (f) =>
      run(
        Effect.gen(function* () {
          const auth = yield* AuthService
          return yield* f(auth)
        }).pipe(Effect.either)
      ),
  }
}

describe("AuthServiceLive OAuth orchestration", () => {
  it("authorize -> callback creates user and session", async () => {
    const harness = makeHarness([makeGoogleProvider()])

    const started = await harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
    const authorizationUrl = new URL(started.authorizationUrl)
    expect(authorizationUrl.searchParams.get("state")).toBe(started.state)
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/auth/callback/google"
    )

    const login = await harness.runWithAuth((auth) =>
      auth.completeOAuthLogin("google", "alice", started.state)
    )

    expect(login.user.email).toBe(Email.make("alice@example.com"))
    expect(login.user.emailVerified).toBe(true)
    expect(login.session.id.startsWith("sess_")).toBe(true)
    expect(harness.state.users.size).toBe(1)
    expect(harness.state.principals.size).toBe(1)
    expect(Array.from(harness.state.principals.values())[0]?.userId).toBe(login.user.id)
    const createdGoogleIdentities = Array.from(harness.state.identities.values()).filter(
      (identity) => identity.provider === "google"
    )
    expect(createdGoogleIdentities.length).toBe(1)
    expect(createdGoogleIdentities[0]?.userId).toBe(login.user.id)

    const reusedState = await harness.runWithAuthEither((auth) =>
      auth.completeOAuthLogin("google", "alice", started.state)
    )

    expect(Either.isLeft(reusedState)).toBe(true)
    if (Either.isLeft(reusedState)) {
      expect(reusedState.left._tag).toBe("OAuthStateError")
    }
  })

  it("link -> callback links identity and does not create a new user", async () => {
    const harness = makeHarness([makeGoogleProvider()])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const started = await harness.runWithAuth((auth) => auth.startLink(user.id, "google"))
    await harness.runWithAuth((auth) =>
      auth.completeLink(user.id, "google", "owner-google", started.state)
    )

    expect(harness.state.users.size).toBe(1)
    expect(harness.state.principals.size).toBe(1)
    const linkedIdentityCount = Array.from(harness.state.identities.values()).filter(
      (identity) => identity.userId === user.id && identity.provider === "google"
    ).length
    expect(linkedIdentityCount).toBe(1)
  })

  it("register preserves an explicitly provided display name", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("max.mustermann@example.com"), "password123", "Provided Name")
    )

    expect(user.displayName).toBe("Provided Name")
    expect(user.emailVerified).toBe(false)
    expect(harness.state.principals.size).toBe(1)
    expect(Array.from(harness.state.principals.values())[0]?.userId).toBe(user.id)
  })

  it("register infers the display name from the email local part when none is provided", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("max.mustermann@example.com"), "password123")
    )

    expect(user.displayName).toBe("max.mustermann")
    expect(user.emailVerified).toBe(false)
  })

  it("startEmailVerification reuses the latest active verification request", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const firstRequest = await harness.runWithAuth((auth) => auth.startEmailVerification(user))
    const secondRequest = await harness.runWithAuth((auth) => auth.startEmailVerification(user))

    expect(firstRequest.id).toBe(secondRequest.id)
    expect(firstRequest.code).toBe(secondRequest.code)
    expect(harness.state.verificationRequests.size).toBe(1)
  })

  it("resendEmailVerification replaces the active request with a fresh code", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const originalRequest = await harness.runWithAuth((auth) => auth.startEmailVerification(user))
    const refreshedRequest = await harness.runWithAuth((auth) =>
      auth.resendEmailVerification(originalRequest.id)
    )

    expect(refreshedRequest.id).not.toBe(originalRequest.id)
    expect(refreshedRequest.code).not.toBe(originalRequest.code)
    expect(harness.state.verificationRequests.has(originalRequest.id)).toBe(false)
    expect(harness.state.verificationRequests.has(refreshedRequest.id)).toBe(true)
  })

  it("verifyEmail marks the user verified, consumes the request, and creates a session", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const verificationRequest = await harness.runWithAuth((auth) =>
      auth.startEmailVerification(user)
    )

    const verified = await harness.runWithAuth((auth) =>
      auth.verifyEmail(verificationRequest.id, verificationRequest.code)
    )

    expect(verified.user.emailVerified).toBe(true)
    expect(harness.state.users.get(user.id)?.emailVerified).toBe(true)
    expect(harness.state.verificationRequests.size).toBe(0)
    expect(verified.session.id.startsWith("sess_")).toBe(true)
  })

  it("verifyEmail rejects an incorrect verification code", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const verificationRequest = await harness.runWithAuth((auth) =>
      auth.startEmailVerification(user)
    )

    const result = await harness.runWithAuthEither((auth) =>
      auth.verifyEmail(verificationRequest.id, "ZZZZZZZZ")
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(EmailVerificationCodeMismatchError)
    }
    expect(harness.state.verificationRequests.has(verificationRequest.id)).toBe(true)
  })

  it("verifyEmail rejects an expired verification request", async () => {
    const harness = makeHarness([])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const verificationRequest = await harness.runWithAuth((auth) =>
      auth.startEmailVerification(user)
    )

    harness.state.verificationRequests.set(
      verificationRequest.id,
      EmailVerificationRequest.make({
        ...verificationRequest,
        expiresAt: Timestamp.Timestamp.make({ epochMillis: 0 }),
      })
    )

    const result = await harness.runWithAuthEither((auth) =>
      auth.verifyEmail(verificationRequest.id, verificationRequest.code)
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(EmailVerificationRequestExpiredError)
    }
    expect(harness.state.verificationRequests.has(verificationRequest.id)).toBe(false)
  })

  it("resendEmailVerification rejects a missing request id", async () => {
    const harness = makeHarness([])

    const result = await harness.runWithAuthEither((auth) =>
      auth.resendEmailVerification(
        EmailVerificationRequestId.make("00000000-0000-0000-0000-000000000999")
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(EmailVerificationRequestNotFoundError)
    }
  })

  it("rejects local login when the email is still unverified", async () => {
    const harness = makeHarness([makeLocalProvider({ emailVerified: false })])

    await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const result = await harness.runWithAuthEither((auth) =>
      auth.login(
        "local",
        LocalAuthRequest.make({
          email: Email.make("owner@example.com"),
          password: Redacted.make("password123"),
        })
      )
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("UnverifiedEmailError")
    }
  })

  it("fails callback when state is invalid", async () => {
    const harness = makeHarness([makeGoogleProvider()])

    const result = await harness.runWithAuthEither((auth) =>
      auth.completeOAuthLogin("google", "alice", "missing-state")
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("OAuthStateError")
    }
  })

  it("fails callback when oauth state intent does not match callback flow", async () => {
    const harness = makeHarness([makeGoogleProvider()])

    const user = await harness.runWithAuth((auth) =>
      auth.register(Email.make("owner@example.com"), "password123", "Owner")
    )

    const loginState = await harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
    const linkWithLoginState = await harness.runWithAuthEither((auth) =>
      auth.completeLink(user.id, "google", "owner-google", loginState.state)
    )

    expect(Either.isLeft(linkWithLoginState)).toBe(true)
    if (Either.isLeft(linkWithLoginState)) {
      expect(linkWithLoginState.left._tag).toBe("OAuthStateError")
    }

    const linkState = await harness.runWithAuth((auth) => auth.startLink(user.id, "google"))
    const loginWithLinkState = await harness.runWithAuthEither((auth) =>
      auth.completeOAuthLogin("google", "owner-google", linkState.state)
    )

    expect(Either.isLeft(loginWithLinkState)).toBe(true)
    if (Either.isLeft(loginWithLinkState)) {
      expect(loginWithLinkState.left._tag).toBe("OAuthStateError")
    }
  })

  it("fails link callback when state belongs to a different user", async () => {
    const harness = makeHarness([makeGoogleProvider()])

    const firstUser = await harness.runWithAuth((auth) =>
      auth.register(Email.make("first@example.com"), "password123", "First")
    )
    const secondUser = await harness.runWithAuth((auth) =>
      auth.register(Email.make("second@example.com"), "password123", "Second")
    )

    const started = await harness.runWithAuth((auth) => auth.startLink(firstUser.id, "google"))
    const result = await harness.runWithAuthEither((auth) =>
      auth.completeLink(secondUser.id, "google", "shared-google", started.state)
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("OAuthStateError")
    }
  })

  it("returns ProviderNotEnabledError when provider is disabled", async () => {
    const harness = makeHarness([])

    const result = await harness.runWithAuthEither((auth) => auth.startOAuthLogin("google"))

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("ProviderNotEnabledError")
    }
  })

  it("fails callback when oauth state provider does not match callback provider", async () => {
    const harness = makeHarness([makeGoogleProvider(), makeCoinbaseProvider()])

    const started = await harness.runWithAuth((auth) => auth.startOAuthLogin("google"))
    const result = await harness.runWithAuthEither((auth) =>
      auth.completeOAuthLogin("coinbase", "alice", started.state)
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("OAuthStateError")
    }
  })

  it("returns IdentityAlreadyLinkedError when identity is already linked", async () => {
    const harness = makeHarness([makeGoogleProvider()])

    const firstUser = await harness.runWithAuth((auth) =>
      auth.register(Email.make("first@example.com"), "password123", "First")
    )
    const secondUser = await harness.runWithAuth((auth) =>
      auth.register(Email.make("second@example.com"), "password123", "Second")
    )

    const firstLink = await harness.runWithAuth((auth) => auth.startLink(firstUser.id, "google"))
    await harness.runWithAuth((auth) =>
      auth.completeLink(firstUser.id, "google", "shared-google", firstLink.state)
    )

    const secondLink = await harness.runWithAuth((auth) => auth.startLink(secondUser.id, "google"))
    const result = await harness.runWithAuthEither((auth) =>
      auth.completeLink(secondUser.id, "google", "shared-google", secondLink.state)
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("IdentityAlreadyLinkedError")
    }
  })
})
