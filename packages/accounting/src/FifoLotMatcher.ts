/**
 * Pure FIFO lot matching for tax accounting.
 *
 * @module accounting/FifoLotMatcher
 */

import {
  AccountingQuantity as AccountingQuantitySchema,
  min,
  multiplyByQuantity,
  prorate,
  type AccountingQuantity,
} from "@my/core/accounting"
import {
  type CurrencyMismatchError,
  type DivisionByZeroError,
  type MonetaryAmount,
  round,
  subtract,
} from "@my/core/shared/values/MonetaryAmount"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"

const ALLOCATION_SCALE = 8

/** One available acquisition lot. Lots must be passed in FIFO order. */
export interface FifoLot {
  readonly id: string
  readonly remainingQuantity: AccountingQuantity
  readonly costBasisPerUnit: MonetaryAmount
}

/** One disposal to match against ordered acquisition lots. */
export interface FifoDisposal {
  readonly quantity: AccountingQuantity
  readonly proceeds: MonetaryAmount
}

/** The factual values allocated from one acquisition lot to the disposal. */
export interface FifoAllocation {
  readonly lotId: string
  readonly matchedQuantity: AccountingQuantity
  readonly remainingQuantity: AccountingQuantity
  readonly costBasis: MonetaryAmount
  readonly proceeds: MonetaryAmount
  readonly gainLoss: MonetaryAmount
}

/** A disposal fully covered by the available lots. */
export interface FullyMatched {
  readonly _tag: "FullyMatched"
  readonly allocations: ReadonlyArray<FifoAllocation>
}

/** A disposal only partly covered by the available lots. */
export interface InventoryShortage {
  readonly _tag: "InventoryShortage"
  readonly allocations: ReadonlyArray<FifoAllocation>
  readonly shortage: AccountingQuantity
}

/** The complete FIFO match, including a possible inventory shortage value. */
export type FifoMatchResult = FullyMatched | InventoryShortage

/** Typed failures possible while calculating monetary allocations. */
export type FifoMatchError = CurrencyMismatchError | DivisionByZeroError

const subtractQuantity = (
  left: AccountingQuantity,
  right: AccountingQuantity
): AccountingQuantity => AccountingQuantitySchema.make(BigDecimal.subtract(left, right))

/**
 * Match a disposal against lots in the order supplied by the caller.
 *
 * The function does not mutate its inputs. Monetary allocations use the
 * existing eight-decimal accounting scale.
 */
export const matchFifoLots = ({
  lots,
  disposal,
}: {
  readonly lots: ReadonlyArray<FifoLot>
  readonly disposal: FifoDisposal
}): Effect.Effect<FifoMatchResult, FifoMatchError, never> =>
  Effect.gen(function* () {
    let remainingQuantity = disposal.quantity
    const allocations: Array<FifoAllocation> = []

    for (const lot of lots) {
      if (BigDecimal.isZero(remainingQuantity)) {
        break
      }

      if (BigDecimal.isZero(lot.remainingQuantity)) {
        continue
      }

      const matchedQuantity = min(lot.remainingQuantity, remainingQuantity)
      const remainingLotQuantity = subtractQuantity(lot.remainingQuantity, matchedQuantity)
      const costBasis = round(
        multiplyByQuantity(lot.costBasisPerUnit, matchedQuantity),
        ALLOCATION_SCALE
      )
      const proceeds = yield* prorate({
        total: disposal.proceeds,
        part: matchedQuantity,
        whole: disposal.quantity,
        scale: ALLOCATION_SCALE,
      })
      const gainLoss = yield* subtract(proceeds, costBasis)

      allocations.push({
        lotId: lot.id,
        matchedQuantity,
        remainingQuantity: remainingLotQuantity,
        costBasis,
        proceeds,
        gainLoss,
      })
      remainingQuantity = subtractQuantity(remainingQuantity, matchedQuantity)
    }

    return BigDecimal.isZero(remainingQuantity)
      ? { _tag: "FullyMatched", allocations }
      : { _tag: "InventoryShortage", allocations, shortage: remainingQuantity }
  })
