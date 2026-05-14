/**
 * PrincipalsApiLive - Live implementation of ownership principal handlers.
 *
 * @module PrincipalsApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import { PrincipalClaimRepository } from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import {
  PrincipalClaimBadRequestError,
  PrincipalClaimNotFoundError,
  PrincipalClaimResponse,
} from "../definitions/PrincipalsApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import { claimTokenPepperConfig, hashCliClaimToken } from "../helpers/ClaimTokenHash.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const toInternalServerError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const loadClaimTokenPepper = Effect.gen(function* () {
  const pepper = yield* Effect.configProviderWith((provider) =>
    provider
      .load(claimTokenPepperConfig)
      .pipe(Effect.mapError(() => toInternalServerError("Missing claim token pepper.")))
  )

  if (Redacted.value(pepper).trim() === "") {
    return yield* Effect.fail(toInternalServerError("Missing claim token pepper."))
  }

  return pepper
})

/**
 * PrincipalsApiLive - Group implementation for principal endpoints.
 */
export const PrincipalsApiLive = HttpApiBuilder.group(TaxMaxiApi, "principals", (handlers) =>
  Effect.gen(function* () {
    const principalClaimRepository = yield* PrincipalClaimRepository
    const principalResolutionService = yield* PrincipalResolutionService

    return handlers.handle("claimPrincipal", ({ payload }) =>
      Effect.gen(function* () {
        yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
          Effect.mapError((error) => toInternalServerError(error.message))
        )

        const pepper = yield* loadClaimTokenPepper
        const claimValueHash = hashCliClaimToken({
          claimToken: payload.claimToken,
          pepper,
        })

        const maybeClaim = yield* principalClaimRepository
          .findValidCliSourceClaim({
            requestId: payload.requestId,
            claimValueHash,
          })
          .pipe(Effect.mapError(() => toInternalServerError("Failed to validate claim token.")))

        if (Option.isNone(maybeClaim)) {
          return yield* Effect.fail(
            new PrincipalClaimNotFoundError({ message: "Valid claim token not found." })
          )
        }

        if (maybeClaim.value.sourceId === null) {
          return yield* Effect.fail(
            new PrincipalClaimBadRequestError({ message: "Claim token is not source-bound." })
          )
        }

        return PrincipalClaimResponse.make({
          sourceId: maybeClaim.value.sourceId,
        })
      })
    )
  })
)
