/**
 * TransactionsApiLive - Canonical transaction list handler.
 *
 * @module TransactionsApiLive
 */

import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JurisdictionCode } from "@my/core/accounting"
import { EUR } from "@my/core/currency"
import { TransactionListRepository } from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { InternalServerError } from "../definitions/ApiErrors.ts"
import { SourceNotFoundError } from "../definitions/SourcesApi.ts"
import { TaxMaxiApi } from "../definitions/TaxMaxiApi.ts"
import {
  TransactionBadRequestError,
  TransactionListItem,
  TransactionListMovement,
  TransactionListPageInfo,
  TransactionListResponse,
  TransactionListSource,
} from "../definitions/TransactionsApi.ts"
import { PrincipalResolutionService } from "../services/PrincipalResolutionService.ts"

const defaultPageLimit = 25
const GERMAN_JURISDICTION = JurisdictionCode.make("DE")
const internalError = (message: string) =>
  new InternalServerError({ requestId: Option.none(), message })

export const TransactionsApiLive = HttpApiBuilder.group(TaxMaxiApi, "transactions", (handlers) =>
  Effect.gen(function* () {
    const repository = yield* TransactionListRepository
    const principalResolutionService = yield* PrincipalResolutionService

    return handlers.handle("listTransactions", ({ query }) =>
      Effect.gen(function* () {
        const { principal } = yield* principalResolutionService.resolveCurrentUserPrincipal.pipe(
          Effect.mapError(() => internalError("Failed to resolve the current user."))
        )
        const page = yield* repository
          .list({
            principalId: principal.id,
            jurisdiction: GERMAN_JURISDICTION,
            reportingCurrency: EUR,
            sourceId: query.sourceId ?? null,
            cursor: query.cursor ?? null,
            limit: query.limit ?? defaultPageLimit,
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "TransactionListInvalidCursorError"
                ? new TransactionBadRequestError({ message: error.message })
                : error._tag === "TransactionListSourceNotFoundError"
                  ? new SourceNotFoundError({ message: error.message })
                  : internalError("Failed to load transactions.")
            )
          )

        return TransactionListResponse.make({
          transactions: page.items.map((item) =>
            TransactionListItem.make({
              ...item,
              source: TransactionListSource.make(item.source),
              movements: item.movements.map((movement) => TransactionListMovement.make(movement)),
            })
          ),
          page: TransactionListPageInfo.make({
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          }),
          totalCount: page.totalCount,
        })
      })
    )
  })
)
