/**
 * PrincipalResolutionServiceLive - Live ownership principal resolution.
 *
 * @module PrincipalResolutionServiceLive
 */

import { PrincipalRepository } from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { CurrentUser } from "../definitions/AuthMiddleware.ts"
import {
  PrincipalResolutionError,
  PrincipalResolutionService,
  type PrincipalResolutionServiceShape,
} from "../services/PrincipalResolutionService.ts"

const toResolutionError = (message: string) => new PrincipalResolutionError({ message })

/**
 * PrincipalResolutionServiceLive - Principal resolution service backed by persistence.
 */
export const PrincipalResolutionServiceLive = Layer.effect(
  PrincipalResolutionService,
  Effect.gen(function* () {
    const principalRepository = yield* PrincipalRepository

    const resolveUserPrincipal: PrincipalResolutionServiceShape["resolveUserPrincipal"] = (
      currentUser
    ) =>
      Effect.gen(function* () {
        const maybePrincipal = yield* principalRepository
          .findUserPrincipal(currentUser.userId)
          .pipe(Effect.mapError(() => toResolutionError("Failed to resolve principal.")))

        if (Option.isNone(maybePrincipal)) {
          return yield* Effect.fail(toResolutionError("Missing user principal."))
        }

        return maybePrincipal.value
      })

    const resolveCurrentUserPrincipal: PrincipalResolutionServiceShape["resolveCurrentUserPrincipal"] =
      Effect.gen(function* () {
        const currentUser = yield* CurrentUser
        const principal = yield* resolveUserPrincipal(currentUser)
        return { currentUser, principal }
      })

    return PrincipalResolutionService.of({
      resolveUserPrincipal,
      resolveCurrentUserPrincipal,
    } satisfies PrincipalResolutionServiceShape)
  })
)
