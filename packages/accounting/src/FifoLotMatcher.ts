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
  MonetaryAmount,
  round,
  subtract,
} from "@my/core/shared/values/MonetaryAmount"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

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
  readonly proceeds: MonetaryAmount | null
}

/** Minimum lot shape needed to allocate a quantity in FIFO order. */
export interface FifoQuantityLot {
  readonly remainingQuantity: AccountingQuantity
}

/** Quantity taken from one FIFO lot without assigning monetary meaning. */
export interface FifoQuantityAllocation<Lot extends FifoQuantityLot> {
  readonly lot: Lot
  readonly matchedQuantity: AccountingQuantity
  readonly remainingQuantity: AccountingQuantity
}

/** Quantity allocation across ordered lots, including any uncovered suffix. */
export interface FifoQuantityAllocationResult<Lot extends FifoQuantityLot> {
  readonly allocations: ReadonlyArray<FifoQuantityAllocation<Lot>>
  readonly shortage: AccountingQuantity | null
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

/** A monetary matcher input that is outside the factual FIFO domain. */
export class FifoMonetaryValueOutOfRangeError extends Schema.TaggedError<FifoMonetaryValueOutOfRangeError>()(
  "FifoMonetaryValueOutOfRangeError",
  {
    field: Schema.Literals(["costBasisPerUnit", "proceeds"]),
    value: Schema.String,
  }
) {
  override get message(): string {
    return `${this.field} must be non-negative, got ${this.value}`
  }
}

/** A FIFO input that cannot be processed without inventing accounting facts. */
export class FifoInputRejectedError extends Schema.TaggedError<FifoInputRejectedError>()(
  "FifoInputRejectedError",
  { cause: Schema.Unknown }
) {
  override get message(): string {
    return `FIFO input rejected: ${String(this.cause)}`
  }
}

/** Check whether an error is a tagged FIFO input rejection. */
export const isFifoInputRejectedError = Schema.is(FifoInputRejectedError)

/** Typed failures possible while calculating monetary allocations. */
export type FifoMatchError = CurrencyMismatchError | DivisionByZeroError | FifoInputRejectedError

const subtractQuantity = (
  left: AccountingQuantity,
  right: AccountingQuantity
): AccountingQuantity => AccountingQuantitySchema.make(BigDecimal.subtract(left, right))

/** Allocate a positive quantity across immutable lots in the supplied FIFO order. */
export const allocateFifoQuantity = <Lot extends FifoQuantityLot>({
  lots,
  quantity,
}: {
  readonly lots: ReadonlyArray<Lot>
  readonly quantity: AccountingQuantity
}): FifoQuantityAllocationResult<Lot> => {
  let remainingQuantity = quantity
  const allocations: Array<FifoQuantityAllocation<Lot>> = []

  for (const lot of lots) {
    if (BigDecimal.isZero(remainingQuantity)) {
      break
    }

    if (BigDecimal.isZero(lot.remainingQuantity)) {
      continue
    }

    const matchedQuantity = min(lot.remainingQuantity, remainingQuantity)
    allocations.push({
      lot,
      matchedQuantity,
      remainingQuantity: subtractQuantity(lot.remainingQuantity, matchedQuantity),
    })
    remainingQuantity = subtractQuantity(remainingQuantity, matchedQuantity)
  }

  return {
    allocations,
    shortage: BigDecimal.isZero(remainingQuantity) ? null : remainingQuantity,
  }
}

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
    if (disposal.proceeds?.isNegative === true) {
      return yield* new FifoInputRejectedError({
        cause: new FifoMonetaryValueOutOfRangeError({
          field: "proceeds",
          value: disposal.proceeds.format(),
        }),
      })
    }

    const quantityResult = allocateFifoQuantity({ lots, quantity: disposal.quantity })
    const allocations: Array<FifoAllocation> = []

    for (const quantityAllocation of quantityResult.allocations) {
      const lot = quantityAllocation.lot
      if (lot.costBasisPerUnit.isNegative) {
        return yield* new FifoInputRejectedError({
          cause: new FifoMonetaryValueOutOfRangeError({
            field: "costBasisPerUnit",
            value: lot.costBasisPerUnit.format(),
          }),
        })
      }

      const matchedQuantity = quantityAllocation.matchedQuantity
      const costBasis = round(
        multiplyByQuantity(lot.costBasisPerUnit, matchedQuantity),
        ALLOCATION_SCALE
      )
      const proceeds = yield* prorate({
        total: disposal.proceeds ?? MonetaryAmount.zero(lot.costBasisPerUnit.currency),
        part: matchedQuantity,
        whole: disposal.quantity,
        scale: ALLOCATION_SCALE,
      })
      const gainLoss = yield* subtract(proceeds, costBasis)

      allocations.push({
        lotId: lot.id,
        matchedQuantity,
        remainingQuantity: quantityAllocation.remainingQuantity,
        costBasis,
        proceeds,
        gainLoss,
      })
    }

    return quantityResult.shortage === null
      ? { _tag: "FullyMatched", allocations }
      : { _tag: "InventoryShortage", allocations, shortage: quantityResult.shortage }
  })
