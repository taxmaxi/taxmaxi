import type { AuthUserResponse, LogoutResponse } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import type { TaxMaxiEffectClient } from "../client.ts"

export type CurrentUserResponse = AuthUserResponse
export type AuthLogoutResponse = LogoutResponse

export type AuthEffectResource = {
  readonly me: () => Effect.Effect<CurrentUserResponse, unknown, never>
  readonly logout: () => Effect.Effect<AuthLogoutResponse, unknown, never>
}

export type AuthPromiseResource = {
  readonly me: () => Promise<CurrentUserResponse>
  readonly logout: () => Promise<AuthLogoutResponse>
}

export const makeAuthEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): AuthEffectResource => ({
  me: () => Effect.flatMap(client, (resolved) => resolved.authSession.me(undefined)),
  logout: () => Effect.flatMap(client, (resolved) => resolved.authSession.logout(undefined)),
})

export const makeAuthPromiseResource = (
  effect: AuthEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): AuthPromiseResource => ({
  me: () => run(effect.me()),
  logout: () => run(effect.logout()),
})
