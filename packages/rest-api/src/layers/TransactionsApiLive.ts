/**
 * TransactionsApiLive - Accounting transaction list and detail handlers.
 *
 * @module TransactionsApiLive
 */

import { HttpApiBuilder } from "@effect/platform"
import {
  AccountingTransactionReadRepository,
  type AccountingTransactionListItem,
} from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  TransactionAsset,
  TransactionBadRequestError,
  TransactionCanonicalTransfer,
  TransactionClassification,
  TransactionClassificationExplanation,
  TransactionCustodyState,
  TransactionDerivation,
  TransactionDetailResponse,
  TransactionDisposal,
  TransactionExternalReferences,
  TransactionFiatValue,
  TransactionListItem,
  TransactionMatchedLot,
  TransactionMovement,
  TransactionNotFoundError,
  TransactionOnchainContext,
  TransactionPageInfo,
  TransactionProviderEvidence,
  TransactionProviderTransfer,
  TransactionReconciliation,
  TransactionsResponse,
  TransactionSource,
  TransactionTotals,
  TransactionVenueContext,
} from "../definitions/TransactionsApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const defaultPageLimit = 25
const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

const mapError = (message: string) => (error: { readonly _tag: string }) => {
  switch (error._tag) {
    case "AccountingTransactionInvalidCursorError":
      return new TransactionBadRequestError({ message: "Invalid transaction cursor." })
    case "AccountingTransactionNotFoundError":
      return new TransactionNotFoundError({ message: "Transaction not found." })
    default:
      return internalError(message)
  }
}

const fiatValue = (value: { readonly amount: string; readonly currency: string }) =>
  TransactionFiatValue.make(value)

const listItem = (item: AccountingTransactionListItem) =>
  TransactionListItem.make({
    transactionId: item.transactionId,
    timestamp: item.timestamp,
    classification: TransactionClassification.make(item.classification),
    source: TransactionSource.make(item.source),
    movements: item.movements.map((movement) =>
      TransactionMovement.make({
        ...movement,
        asset: TransactionAsset.make(movement.asset),
        fiatValue: movement.fiatValue === null ? null : fiatValue(movement.fiatValue),
        derivation:
          movement.derivation === null ? null : TransactionDerivation.make(movement.derivation),
        custody: movement.custody === null ? null : TransactionCustodyState.make(movement.custody),
      })
    ),
    totals: TransactionTotals.make(item.totals),
    externalReferences: TransactionExternalReferences.make(item.externalReferences),
  })

export const TransactionsApiLive = HttpApiBuilder.group(TaxMaxiApi, "transactions", (handlers) =>
  Effect.gen(function* () {
    const repository = yield* AccountingTransactionReadRepository
    const principalResolution = yield* PrincipalResolutionService
    const principalId = principalResolution.resolveCurrentUserPrincipal.pipe(
      Effect.map(({ principal }) => principal.id),
      Effect.mapError((error) => internalError(error.message))
    )

    return handlers
      .handle("listTransactions", ({ urlParams }) =>
        Effect.gen(function* () {
          const currentPrincipalId = yield* principalId
          const page = yield* repository
            .list({
              principalId: currentPrincipalId,
              sourceId: urlParams.sourceId ?? null,
              cursor: urlParams.cursor ?? null,
              limit: urlParams.limit ?? defaultPageLimit,
              search: urlParams.search ?? null,
              classificationKey: urlParams.classificationKey ?? null,
              categoryKey: urlParams.categoryKey ?? null,
              reviewState: urlParams.reviewState ?? null,
            })
            .pipe(Effect.mapError(mapError("Failed to load transactions.")))

          return TransactionsResponse.make({
            transactions: page.items.map(listItem),
            page: TransactionPageInfo.make({
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            }),
          })
        })
      )
      .handle("getTransaction", ({ path }) =>
        Effect.gen(function* () {
          const currentPrincipalId = yield* principalId
          const detail = yield* repository
            .getById({ principalId: currentPrincipalId, transactionId: path.transactionId })
            .pipe(Effect.mapError(mapError("Failed to load transaction.")))
          const row = listItem(detail)

          return TransactionDetailResponse.make({
            transactionId: row.transactionId,
            timestamp: row.timestamp,
            classification: row.classification,
            source: row.source,
            movements: row.movements,
            totals: row.totals,
            externalReferences: row.externalReferences,
            disposals: detail.disposals.map((disposal) =>
              TransactionDisposal.make({
                ...disposal,
                asset: TransactionAsset.make(disposal.asset),
                matchedLots: disposal.matchedLots.map((lot) => TransactionMatchedLot.make(lot)),
              })
            ),
            canonicalTransfers: detail.canonicalTransfers.map((transfer) =>
              TransactionCanonicalTransfer.make({
                ...transfer,
                asset: TransactionAsset.make(transfer.asset),
              })
            ),
            providerTransfers: detail.providerTransfers.map((transfer) =>
              TransactionProviderTransfer.make(transfer)
            ),
            reconciliations: detail.reconciliations.map((reconciliation) =>
              TransactionReconciliation.make(reconciliation)
            ),
            venue: detail.venue === null ? null : TransactionVenueContext.make(detail.venue),
            onchain:
              detail.onchain === null
                ? null
                : TransactionOnchainContext.make({
                    ...detail.onchain,
                    feeFiatValue:
                      detail.onchain.feeFiatValue === null
                        ? null
                        : fiatValue(detail.onchain.feeFiatValue),
                  }),
            providerEvidence:
              detail.providerEvidence === null
                ? null
                : TransactionProviderEvidence.make(detail.providerEvidence),
            classificationExplanation:
              detail.classificationExplanation === null
                ? null
                : TransactionClassificationExplanation.make(detail.classificationExplanation),
          })
        })
      )
  })
)
