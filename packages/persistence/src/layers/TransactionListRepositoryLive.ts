/**
 * TransactionListRepositoryLive - Drizzle-backed principal transaction list.
 *
 * @module TransactionListRepositoryLive
 */

import { and, asc, count, desc, eq, inArray, lt, or } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  TransactionListInvalidCursorError,
  TransactionListRepository,
  type TransactionListItem,
  type TransactionListMovement,
  type TransactionListRepositoryService,
} from "../services/TransactionListRepository.ts"
import { drizzle } from "./PgClientLive.ts"

interface CursorParts {
  readonly timestamp: Date
  readonly id: string
}

interface GainLossSummary {
  readonly realizedGainLoss: string | null
  readonly fiatCurrency: string | null
}

const TransactionCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  timestamp: Schema.DateFromString,
  id: Schema.String.check(Schema.isUUID()),
})

const TransactionCursor = Schema.fromJsonString(TransactionCursorPayload)

const makeCursor = ({ timestamp, id }: CursorParts): string =>
  Schema.encodeSync(TransactionCursor)({ version: 1, timestamp, id })

const parseCursor = (
  cursor: string | null
): Effect.Effect<Option.Option<CursorParts>, TransactionListInvalidCursorError> =>
  cursor === null
    ? Effect.succeed(Option.none())
    : Schema.decodeUnknownEffect(TransactionCursor)(cursor).pipe(
        Effect.map(({ id, timestamp }) => Option.some({ id, timestamp })),
        Effect.mapError(() => new TransactionListInvalidCursorError({ cursor }))
      )

const decodeDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: unknown
}) =>
  Schema.decodeUnknownEffect(Schema.BigDecimalFromString)(value).pipe(
    Effect.mapError(
      () =>
        new PersistenceError({
          operation,
          cause: `Invalid decimal value: ${String(value)}`,
        })
    )
  )

const make = Effect.gen(function* () {
  const db = yield* drizzle

  const ownedScope = (principalId: string) =>
    and(
      eq(schema.transactions.principalId, principalId),
      eq(schema.sources.principalId, principalId)
    )

  const loadTotalCount = (principalId: string) =>
    db
      .select({ count: count(schema.transactions.id) })
      .from(schema.transactions)
      .innerJoin(schema.sources, eq(schema.transactions.sourceId, schema.sources.id))
      .where(ownedScope(principalId))
      .pipe(
        wrapSqlError("transactionListRepository.list.count"),
        Effect.map((rows) => rows[0]?.count ?? 0)
      )

  const loadPageRows = ({
    cursor,
    limit,
    principalId,
  }: {
    readonly cursor: Option.Option<CursorParts>
    readonly limit: number
    readonly principalId: string
  }) => {
    const cursorPredicate = Option.match(cursor, {
      onNone: () => undefined,
      onSome: (value) =>
        or(
          lt(schema.transactions.timestamp, value.timestamp),
          and(
            eq(schema.transactions.timestamp, value.timestamp),
            lt(schema.transactions.id, value.id)
          )
        ),
    })
    const scope = ownedScope(principalId)

    return db
      .select({
        transactionId: schema.transactions.id,
        timestamp: schema.transactions.timestamp,
        transactionType: schema.transactions.transactionType,
        description: schema.transactions.providerDescription,
        externalId: schema.transactions.externalId,
        sourceId: schema.sources.id,
        sourceName: schema.sources.name,
        sourceKind: schema.sources.sourceableType,
      })
      .from(schema.transactions)
      .innerJoin(schema.sources, eq(schema.transactions.sourceId, schema.sources.id))
      .where(cursorPredicate === undefined ? scope : and(scope, cursorPredicate))
      .orderBy(desc(schema.transactions.timestamp), desc(schema.transactions.id))
      .limit(limit + 1)
      .pipe(wrapSqlError("transactionListRepository.list.transactions"))
  }

  const loadMovements = (transactionIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (transactionIds.length === 0) {
        return new Map<string, ReadonlyArray<TransactionListMovement>>()
      }

      const rows = yield* db
        .select({
          transactionId: schema.transactionLegs.transactionId,
          amount: schema.transactionLegs.amount,
          assetSymbol: schema.assets.symbol,
          kind: schema.transactionLegs.kind,
        })
        .from(schema.transactionLegs)
        .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
        .where(inArray(schema.transactionLegs.transactionId, transactionIds))
        .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
        .pipe(wrapSqlError("transactionListRepository.list.movements"))

      const decoded = yield* Effect.forEach(rows, (row) =>
        decodeDecimal({
          operation: "transactionListRepository.list.movementAmount",
          value: row.amount,
        }).pipe(
          Effect.map((amount): readonly [string | null, TransactionListMovement] => [
            row.transactionId,
            {
              amount: BigDecimal.format(amount),
              assetSymbol: row.assetSymbol,
              kind: row.kind,
            },
          ])
        )
      )
      const byTransaction = new Map<string, Array<TransactionListMovement>>()
      for (const [transactionId, movement] of decoded) {
        if (transactionId === null) continue
        const movements = byTransaction.get(transactionId) ?? []
        movements.push(movement)
        byTransaction.set(transactionId, movements)
      }
      return byTransaction
    })

  const loadGainLoss = (transactionIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (transactionIds.length === 0) {
        return new Map<string, GainLossSummary>()
      }

      const rows = yield* db
        .select({
          transactionId: schema.transactionLegs.transactionId,
          gainLoss: schema.disposalMatches.gainLoss,
          fiatCurrency: schema.transactionLegs.fiatCurrency,
        })
        .from(schema.disposalMatches)
        .innerJoin(
          schema.transactionLegs,
          eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
        )
        .where(inArray(schema.transactionLegs.transactionId, transactionIds))
        .pipe(wrapSqlError("transactionListRepository.list.gainLoss"))

      const decoded = yield* Effect.forEach(rows, (row) =>
        decodeDecimal({
          operation: "transactionListRepository.list.gainLossAmount",
          value: row.gainLoss,
        }).pipe(
          Effect.map((amount) => ({
            transactionId: row.transactionId,
            amount,
            fiatCurrency: row.fiatCurrency,
          }))
        )
      )
      const amounts = new Map<string, Array<BigDecimal.BigDecimal>>()
      const currencies = new Map<string, Set<string>>()
      for (const row of decoded) {
        if (row.transactionId === null) continue
        const transactionAmounts = amounts.get(row.transactionId) ?? []
        transactionAmounts.push(row.amount)
        amounts.set(row.transactionId, transactionAmounts)
        if (row.fiatCurrency !== null) {
          const transactionCurrencies = currencies.get(row.transactionId) ?? new Set<string>()
          transactionCurrencies.add(row.fiatCurrency)
          currencies.set(row.transactionId, transactionCurrencies)
        }
      }

      return new Map(
        transactionIds.map((transactionId): readonly [string, GainLossSummary] => {
          const transactionAmounts = amounts.get(transactionId) ?? []
          const transactionCurrencies = currencies.get(transactionId) ?? new Set<string>()
          return [
            transactionId,
            {
              realizedGainLoss:
                transactionAmounts.length === 0
                  ? null
                  : BigDecimal.format(BigDecimal.sumAll(transactionAmounts)),
              fiatCurrency:
                transactionCurrencies.size === 1
                  ? (transactionCurrencies.values().next().value ?? null)
                  : null,
            },
          ]
        })
      )
    })

  const loadReviewStates = (transactionIds: ReadonlyArray<string>) =>
    transactionIds.length === 0
      ? Effect.succeed(new Map<string, boolean>())
      : db
          .select({
            transactionId: schema.transactionReviews.transactionId,
            needsReview: schema.transactionReviews.needsReview,
          })
          .from(schema.transactionReviews)
          .where(inArray(schema.transactionReviews.transactionId, transactionIds))
          .pipe(
            wrapSqlError("transactionListRepository.list.reviews"),
            Effect.map(
              (rows) => new Map(rows.map((row) => [row.transactionId, row.needsReview] as const))
            )
          )

  const list: TransactionListRepositoryService["list"] = (params) =>
    Effect.gen(function* () {
      const cursor = yield* parseCursor(params.cursor)
      const totalCount = yield* loadTotalCount(params.principalId)
      const rows = yield* loadPageRows({
        cursor,
        limit: params.limit,
        principalId: params.principalId,
      })
      const pageRows = rows.slice(0, params.limit)
      const transactionIds = pageRows.map((row) => row.transactionId)
      const [movements, gainLoss, reviewStates] = yield* Effect.all([
        loadMovements(transactionIds),
        loadGainLoss(transactionIds),
        loadReviewStates(transactionIds),
      ])

      const items = pageRows.map((row): TransactionListItem => {
        const totals = gainLoss.get(row.transactionId)
        return {
          transactionId: row.transactionId,
          timestamp: row.timestamp.toISOString(),
          source: {
            sourceId: row.sourceId,
            name: row.sourceName,
            kind: row.sourceKind,
          },
          transactionType: row.transactionType,
          description: row.description,
          externalId: row.externalId,
          movements: movements.get(row.transactionId) ?? [],
          realizedGainLoss: totals?.realizedGainLoss ?? null,
          fiatCurrency: totals?.fiatCurrency ?? null,
          needsReview: reviewStates.get(row.transactionId) ?? false,
        }
      })
      const hasMore = rows.length > params.limit
      const last = pageRows.at(-1)

      return {
        items,
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? makeCursor({ timestamp: last.timestamp, id: last.transactionId })
            : null,
        totalCount,
      }
    })

  return TransactionListRepository.of({ list })
})

/** Live PostgreSQL implementation of the canonical transaction list. */
export const TransactionListRepositoryLive = Layer.effect(TransactionListRepository, make)
