/**
 * PrincipalClaimRepositoryLive - Postgres-backed ownership claim repository.
 *
 * @module PrincipalClaimRepositoryLive
 */

import { and, eq, gt, isNull, or, sql } from "drizzle-orm"
import { PrincipalId } from "@my/core/ownership"
import type { ChainType } from "@my/core/source"
import { SourceId } from "@my/core/source"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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

  const findValidCliSourceClaim: PrincipalClaimRepositoryService["findValidCliSourceClaim"] = (
    params
  ) =>
    Effect.gen(function* () {
      const now = new Date()
      const [row] = yield* db
        .select(selectPrincipalClaimFields)
        .from(schema.principalClaims)
        .innerJoin(schema.principals, eq(schema.principals.id, schema.principalClaims.principalId))
        .innerJoin(schema.sources, eq(schema.sources.id, schema.principalClaims.sourceId))
        .innerJoin(schema.addresses, eq(schema.addresses.id, schema.sources.addressId))
        .where(
          and(
            eq(schema.principalClaims.requestId, params.requestId),
            eq(schema.principalClaims.claimType, "cli_claim_token"),
            eq(schema.principalClaims.claimValueHash, params.claimValueHash),
            isNull(schema.principalClaims.consumedAt),
            or(isNull(schema.principalClaims.expiresAt), gt(schema.principalClaims.expiresAt, now)),
            eq(schema.principals.kind, "anonymous_wallet"),
            eq(schema.sources.principalId, schema.principalClaims.principalId),
            eq(schema.addresses.principalId, schema.principalClaims.principalId),
            eq(schema.sources.sourceableType, "onchain"),
            sql`${schema.addresses.type}::text = ${schema.principalClaims.chainType}`,
            eq(schema.addresses.address, schema.principalClaims.walletAddress)
          )
        )
        .limit(1)

      if (row === undefined) {
        return Option.none<PrincipalClaim>()
      }

      if (
        row.sourceId === null ||
        row.chainType === null ||
        row.walletAddress === null ||
        row.year === null ||
        row.jurisdiction === null
      ) {
        return Option.none<PrincipalClaim>()
      }

      const [receiptRow] = yield* db
        .select({ id: schema.principalClaims.id })
        .from(schema.principalClaims)
        .where(
          and(
            eq(schema.principalClaims.requestId, row.requestId),
            eq(schema.principalClaims.claimType, "x402_receipt"),
            eq(schema.principalClaims.principalId, row.principalId),
            eq(schema.principalClaims.sourceId, row.sourceId),
            eq(schema.principalClaims.chainType, row.chainType),
            eq(schema.principalClaims.walletAddress, row.walletAddress),
            eq(schema.principalClaims.year, row.year),
            eq(schema.principalClaims.jurisdiction, row.jurisdiction),
            isNull(schema.principalClaims.consumedAt)
          )
        )
        .limit(1)

      if (receiptRow === undefined) {
        return Option.none<PrincipalClaim>()
      }

      const claim = yield* rowToPrincipalClaim(row)
      return Option.some(claim)
    }).pipe(wrapSqlError("principalClaimRepository.findValidCliSourceClaim"))

  return PrincipalClaimRepository.of({
    create,
    findValidCliSourceClaim,
  } satisfies PrincipalClaimRepositoryService)
})

/**
 * PrincipalClaimRepositoryLive - Live ownership claim repository layer.
 */
export const PrincipalClaimRepositoryLive = Layer.effect(PrincipalClaimRepository, make)
