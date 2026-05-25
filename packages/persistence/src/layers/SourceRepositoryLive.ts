import { and, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { PrincipalId } from "@my/core/ownership"
import { Timestamp } from "@my/core/shared/values/Timestamp"
import {
  CexSourceRef,
  DexSourceRef,
  OnchainSourceRef,
  Source,
  SourceId,
  type SourceRef,
} from "@my/core/source"
import { EntityNotFoundError, PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { addresses } from "../schema/AddressesTable.ts"
import { sources, type SourceRow } from "../schema/SourcesTable.ts"
import { drizzle } from "./PgClientLive.ts"
import {
  SourceRepository,
  type OnchainSourceChainType,
  type SourceRepositoryService,
} from "../services/SourceRepository.ts"

type SelectedSourceRow = Pick<
  SourceRow,
  | "id"
  | "principalId"
  | "name"
  | "providerKey"
  | "sourceableType"
  | "addressId"
  | "cexAccountId"
  | "createdAt"
>

const providerKeyForOnchainSource = (chainType: OnchainSourceChainType): string => {
  switch (chainType) {
    case "solana":
      return "helius-solana"
    case "evm":
    case "bitcoin":
      return chainType
  }
}

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const selectSourceFields = {
    id: sources.id,
    principalId: sources.principalId,
    name: sources.name,
    providerKey: sources.providerKey,
    sourceableType: sources.sourceableType,
    addressId: sources.addressId,
    cexAccountId: sources.cexAccountId,
    createdAt: sources.createdAt,
  } as const

  const rowToSourceRef = (row: SelectedSourceRow): Effect.Effect<SourceRef> => {
    switch (row.sourceableType) {
      case "onchain":
        if (row.addressId === null) {
          return Effect.dieMessage(`Source ${row.id} is onchain but has no addressId`)
        }
        return Effect.succeed(OnchainSourceRef.make({ addressId: row.addressId }))

      case "cex":
        if (row.cexAccountId === null) {
          return Effect.dieMessage(`Source ${row.id} is cex but has no cexAccountId`)
        }
        return Effect.succeed(CexSourceRef.make({ cexAccountId: row.cexAccountId }))

      case "dex":
        if (row.addressId === null) {
          return Effect.dieMessage(`Source ${row.id} is dex but has no addressId`)
        }
        return Effect.succeed(DexSourceRef.make({ addressId: row.addressId }))
    }
  }

  const rowToSource = (row: SelectedSourceRow): Effect.Effect<Source> =>
    Effect.gen(function* () {
      const sourceRef = yield* rowToSourceRef(row)

      return Source.make({
        id: SourceId.make(row.id),
        principalId: PrincipalId.make(row.principalId),
        name: row.name,
        providerKey: row.providerKey,
        sourceRef,
        createdAt: Timestamp.make({ epochMillis: row.createdAt.getTime() }),
      })
    })

  const findById: SourceRepositoryService["findById"] = (id) =>
    Effect.gen(function* () {
      const [row] = yield* db.select(selectSourceFields).from(sources).where(eq(sources.id, id))

      if (row === undefined) {
        return Option.none<Source>()
      }

      const source = yield* rowToSource(row)

      return Option.some(source)
    }).pipe(wrapSqlError("findById"))

  const findByPrincipalId: SourceRepositoryService["findByPrincipalId"] = (id) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select(selectSourceFields)
        .from(sources)
        .where(eq(sources.principalId, id))
      return yield* Effect.forEach(rows, rowToSource)
    }).pipe(wrapSqlError("findByPrincipalId"))

  const findByPrincipalAndProviderKey: SourceRepositoryService["findByPrincipalAndProviderKey"] = (
    params
  ) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectSourceFields)
        .from(sources)
        .where(
          and(
            eq(sources.principalId, params.principalId),
            eq(sources.providerKey, params.providerKey)
          )
        )
        .limit(1)

      if (row === undefined) {
        return Option.none<Source>()
      }

      const source = yield* rowToSource(row)
      return Option.some(source)
    }).pipe(wrapSqlError("findByPrincipalAndProviderKey"))

  const findByPrincipalAndSourceRef: SourceRepositoryService["findByPrincipalAndSourceRef"] = (
    params
  ) =>
    Effect.gen(function* () {
      const [row] =
        params.sourceRef._tag === "cex"
          ? yield* db
              .select(selectSourceFields)
              .from(sources)
              .where(
                and(
                  eq(sources.principalId, params.principalId),
                  eq(sources.sourceableType, "cex"),
                  eq(sources.cexAccountId, params.sourceRef.cexAccountId)
                )
              )
              .limit(1)
          : params.sourceRef._tag === "onchain"
            ? yield* db
                .select(selectSourceFields)
                .from(sources)
                .where(
                  and(
                    eq(sources.principalId, params.principalId),
                    eq(sources.sourceableType, "onchain"),
                    eq(sources.addressId, params.sourceRef.addressId)
                  )
                )
                .limit(1)
            : yield* db
                .select(selectSourceFields)
                .from(sources)
                .where(
                  and(
                    eq(sources.principalId, params.principalId),
                    eq(sources.sourceableType, "dex"),
                    eq(sources.addressId, params.sourceRef.addressId)
                  )
                )
                .limit(1)

      if (row === undefined) {
        return Option.none<Source>()
      }

      const source = yield* rowToSource(row)
      return Option.some(source)
    }).pipe(wrapSqlError("findByPrincipalAndSourceRef"))

  const findOnchainSourceByAddressId = ({
    principalId,
    addressId,
  }: {
    readonly principalId: string
    readonly addressId: string
  }) =>
    Effect.gen(function* () {
      const [row] = yield* db
        .select(selectSourceFields)
        .from(sources)
        .where(
          and(
            eq(sources.principalId, principalId),
            eq(sources.sourceableType, "onchain"),
            eq(sources.addressId, addressId)
          )
        )
        .limit(1)

      if (row === undefined) {
        return Option.none<Source>()
      }

      const source = yield* rowToSource(row)
      return Option.some(source)
    })

  const createOrReuseOnchainSource: SourceRepositoryService["createOrReuseOnchainSource"] = ({
    principalId,
    chainType,
    walletAddress,
    name,
  }) =>
    Effect.gen(function* () {
      const now = new Date()
      const [addressRow] = yield* db
        .insert(addresses)
        .values({
          address: walletAddress,
          type: chainType,
          name,
          principalId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [addresses.address, addresses.principalId],
          set: {
            name,
            type: chainType,
            updatedAt: now,
          },
        })
        .returning({ id: addresses.id })

      if (addressRow === undefined) {
        return yield* Effect.fail(
          new PersistenceError({
            operation: "sourceRepository.createOrReuseOnchainSource.address",
            cause: "failed to create or reuse address",
          })
        )
      }

      const maybeExistingSource = yield* findOnchainSourceByAddressId({
        principalId,
        addressId: addressRow.id,
      })

      if (Option.isSome(maybeExistingSource)) {
        return { source: maybeExistingSource.value, created: false }
      }

      const sourceId = SourceId.make(crypto.randomUUID())
      const providerKey = providerKeyForOnchainSource(chainType)
      const [created] = yield* db
        .insert(sources)
        .values({
          id: sourceId,
          principalId,
          name,
          providerKey,
          providerMetadata: { chainType, walletAddress },
          sourceableType: "onchain",
          addressId: addressRow.id,
          cexAccountId: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [sources.principalId, sources.addressId],
        })
        .returning(selectSourceFields)

      if (created !== undefined) {
        return { source: yield* rowToSource(created), created: true }
      }

      const maybeConcurrentSource = yield* findOnchainSourceByAddressId({
        principalId,
        addressId: addressRow.id,
      })

      if (Option.isNone(maybeConcurrentSource)) {
        return yield* Effect.fail(
          new PersistenceError({
            operation: "sourceRepository.createOrReuseOnchainSource.source",
            cause: "failed to create or reuse onchain source",
          })
        )
      }

      return { source: maybeConcurrentSource.value, created: false }
    }).pipe(wrapSqlError("createOrReuseOnchainSource"))

  const create: SourceRepositoryService["create"] = (source) =>
    Effect.gen(function* () {
      const now = new Date()
      const baseValues = {
        id: source.id,
        principalId: source.principalId,
        name: source.name,
        providerKey: source.providerKey ?? null,
        providerMetadata: source.providerMetadata ?? null,
        sourceableType: source.sourceRef._tag,
        createdAt: now,
        updatedAt: now,
      } as const

      const sourceValues =
        source.sourceRef._tag === "cex"
          ? {
              ...baseValues,
              cexAccountId: source.sourceRef.cexAccountId,
              addressId: null,
            }
          : {
              ...baseValues,
              cexAccountId: null,
              addressId: source.sourceRef.addressId,
            }

      const [created] = yield* db.insert(sources).values(sourceValues).returning(selectSourceFields)

      if (!created) {
        return yield* Effect.fail(
          new EntityNotFoundError({ entityType: "Source", entityId: source.id })
        )
      }

      return yield* rowToSource(created)
    }).pipe(wrapSqlError("create"))

  return {
    findById,
    findByPrincipalId,
    findByPrincipalAndProviderKey,
    findByPrincipalAndSourceRef,
    createOrReuseOnchainSource,
    create,
  } satisfies SourceRepositoryService
})

export const SourceRepositoryLive = Layer.effect(SourceRepository, make)
