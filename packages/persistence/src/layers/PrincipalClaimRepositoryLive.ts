/**
 * PrincipalClaimRepositoryLive - Postgres-backed ownership claim repository.
 *
 * @module PrincipalClaimRepositoryLive
 */

import { PrincipalId } from "@my/core/ownership"
import type { ChainType } from "@my/core/source"
import { SourceId } from "@my/core/source"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import type { PrincipalClaimRow } from "../schema/PrincipalClaimsTable.ts"
import {
  PrincipalClaimRepository,
  type PrincipalClaim,
  type PrincipalClaimRepositoryService,
} from "../services/PrincipalClaimRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const selectPrincipalClaimFields = {
  id: schema.principalClaims.id,
  principalId: schema.principalClaims.principalId,
  sourceId: schema.principalClaims.sourceId,
  requestId: schema.principalClaims.requestId,
  claimType: schema.principalClaims.claimType,
  claimValueHash: schema.principalClaims.claimValueHash,
  chainType: schema.principalClaims.chainType,
  walletAddress: schema.principalClaims.walletAddress,
  year: schema.principalClaims.year,
  jurisdiction: schema.principalClaims.jurisdiction,
  expiresAt: schema.principalClaims.expiresAt,
  consumedAt: schema.principalClaims.consumedAt,
} as const

type SelectedPrincipalClaimRow = Pick<
  PrincipalClaimRow,
  | "id"
  | "principalId"
  | "sourceId"
  | "requestId"
  | "claimType"
  | "claimValueHash"
  | "chainType"
  | "walletAddress"
  | "year"
  | "jurisdiction"
  | "expiresAt"
  | "consumedAt"
>

const rowToPrincipalClaim = (row: SelectedPrincipalClaimRow): Effect.Effect<PrincipalClaim> =>
  Effect.gen(function* () {
    const chainType: ChainType | null =
      row.chainType === null
        ? null
        : row.chainType === "evm" || row.chainType === "solana" || row.chainType === "bitcoin"
          ? row.chainType
          : yield* Effect.dieMessage(`Invalid principal claim chain type: ${row.chainType}`)
    return {
      id: row.id,
      principalId: PrincipalId.make(row.principalId),
      sourceId: row.sourceId === null ? null : SourceId.make(row.sourceId),
      requestId: row.requestId,
      claimType: row.claimType,
      claimValueHash: row.claimValueHash,
      chainType,
      walletAddress: row.walletAddress,
      year: row.year,
      jurisdiction: row.jurisdiction,
      expiresAt: row.expiresAt,
      consumedAt: row.consumedAt,
    }
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const create: PrincipalClaimRepositoryService["create"] = (params) =>
    Effect.gen(function* () {
      const now = new Date()
      const [row] = yield* db
        .insert(schema.principalClaims)
        .values({
          principalId: params.principalId,
          sourceId: params.sourceId,
          requestId: params.requestId,
          claimType: params.claimType,
          claimValueHash: params.claimValueHash,
          chainType: params.chainType,
          walletAddress: params.walletAddress,
          year: params.year,
          jurisdiction: params.jurisdiction,
          expiresAt: params.expiresAt,
          consumedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(selectPrincipalClaimFields)

      if (row === undefined) {
        return yield* Effect.fail(
          new PersistenceError({
            operation: "principalClaimRepository.create",
            cause: "failed to create principal claim",
          })
        )
      }

      return yield* rowToPrincipalClaim(row)
    }).pipe(wrapSqlError("principalClaimRepository.create"))

  return PrincipalClaimRepository.of({
    create,
  } satisfies PrincipalClaimRepositoryService)
})

/**
 * PrincipalClaimRepositoryLive - Live ownership claim repository layer.
 */
export const PrincipalClaimRepositoryLive = Layer.effect(PrincipalClaimRepository, make)
