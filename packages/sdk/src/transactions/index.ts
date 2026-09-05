import { TransactionListResponse } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

export type Transactions = Schema.Codec.Encoded<typeof TransactionListResponse>
export type TransactionListItem = Transactions["transactions"][number]

export type TransactionListInput = {
  readonly sourceId?: string
  readonly cursor?: string | null
  readonly limit?: number
}

export type TransactionsEffectResource = {
  readonly list: (input?: TransactionListInput) => Effect.Effect<Transactions, unknown, never>
}

export type TransactionsPromiseResource = {
  readonly list: (input?: TransactionListInput) => Promise<Transactions>
}

const encodeTransactions = Schema.encodeSync(TransactionListResponse)

export const makeTransactionsEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): TransactionsEffectResource => ({
  list: (input = {}) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.transactions.listTransactions({
          query: {
            sourceId: input.sourceId,
            cursor: input.cursor ?? undefined,
            limit: input.limit,
          },
        })
      ),
      encodeTransactions
    ),
})

export const makeTransactionsPromiseResource = (
  effect: TransactionsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): TransactionsPromiseResource => ({
  list: (input) => run(effect.list(input)),
})
