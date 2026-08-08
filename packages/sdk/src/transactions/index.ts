import { TransactionDetailResponse, TransactionsResponse } from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { TaxMaxiEffectClient } from "../client.ts"

export type Transactions = Schema.Schema.Encoded<typeof TransactionsResponse>
export type TransactionDetail = Schema.Schema.Encoded<typeof TransactionDetailResponse>

export type TransactionListInput = {
  readonly sourceId?: string | null
  readonly cursor?: string | null
  readonly limit?: number
  readonly search?: string | null
  readonly classificationKey?: string | null
  readonly categoryKey?: string | null
  readonly reviewState?:
    | "unreviewed"
    | "auto_applied"
    | "needs_review"
    | "approved"
    | "changed"
    | null
}

export type TransactionDetailInput = { readonly transactionId: string }

export type TransactionsEffectResource = {
  readonly list: (input?: TransactionListInput) => Effect.Effect<Transactions, unknown, never>
  readonly get: (input: TransactionDetailInput) => Effect.Effect<TransactionDetail, unknown, never>
}

export type TransactionsPromiseResource = {
  readonly list: (input?: TransactionListInput) => Promise<Transactions>
  readonly get: (input: TransactionDetailInput) => Promise<TransactionDetail>
}

const encodeTransactions = Schema.encodeSync(TransactionsResponse)
const encodeTransactionDetail = Schema.encodeSync(TransactionDetailResponse)

export const makeTransactionsEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): TransactionsEffectResource => ({
  list: (input = {}) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.transactions.listTransactions({
          urlParams: {
            sourceId: input.sourceId ?? undefined,
            cursor: input.cursor ?? undefined,
            limit: input.limit,
            search: input.search ?? undefined,
            classificationKey: input.classificationKey ?? undefined,
            categoryKey: input.categoryKey ?? undefined,
            reviewState: input.reviewState ?? undefined,
          },
        })
      ),
      encodeTransactions
    ),
  get: ({ transactionId }) =>
    Effect.map(
      Effect.flatMap(client, (resolved) =>
        resolved.transactions.getTransaction({ path: { transactionId } })
      ),
      encodeTransactionDetail
    ),
})

export const makeTransactionsPromiseResource = (
  effect: TransactionsEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): TransactionsPromiseResource => ({
  list: (input) => run(effect.list(input)),
  get: (input) => run(effect.get(input)),
})
