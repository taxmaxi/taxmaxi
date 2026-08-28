/**
 * FifoAccounting - Exact decimal calculations shared by normalization and accounting rebuilds.
 *
 * @module FifoAccounting
 */

import * as Effect from "effect/Effect"
import {
  divideToScale,
  formatScaled,
  type FixedPointErrorFactory,
  type ParsedDecimal,
  parseDecimal,
  powerOfTen,
} from "./SourceNormalizationFixedPoint.ts"

const signedDigits = (params: { readonly sign: 1 | -1; readonly digits: bigint }): bigint =>
  params.sign === -1 ? -params.digits : params.digits

const alignDecimalDigits = ({
  left,
  right,
}: {
  readonly left: ParsedDecimal
  readonly right: ParsedDecimal
}) => {
  const scale = Math.max(left.scale, right.scale)
  return {
    left: signedDigits(left) * powerOfTen(scale - left.scale),
    right: signedDigits(right) * powerOfTen(scale - right.scale),
    scale,
  }
}

/** FIFO lot fields needed by the shared allocation policy. */
export interface OpenFifoLot {
  readonly id: string
  readonly remainingAmount: string
  readonly costBasisPerToken: string
}

/** One FIFO allocation with its updated lot balance and tax values. */
export interface FifoAllocation {
  readonly fifoLotId: string
  readonly matchedAmount: string
  readonly remainingAmount: string
  readonly costBasis: string
  readonly proceeds: string
  readonly gainLoss: string
}

/** Transaction-review fields used by FIFO shortage lifecycle updates. */
export interface FifoInventoryReviewState {
  readonly reviewStatus: "auto_applied" | "needs_review" | "approved" | "changed"
  readonly categorizationReason: string | null | undefined
  readonly matchedLayer: string | null | undefined
  readonly userNotes?: string | null
}

export const FIFO_INVENTORY_REVIEW_LAYER = "fifo_inventory"
export const FIFO_INVENTORY_REVIEW_REASON_PREFIX = "fifo_inventory:"

const withoutFifoReviewSegments = (review: FifoInventoryReviewState) => ({
  reasons: (review.categorizationReason ?? "")
    .split("\n")
    .filter(
      (reason) =>
        reason.trim() !== "" && !reason.trimStart().startsWith(FIFO_INVENTORY_REVIEW_REASON_PREFIX)
    ),
  layers: (review.matchedLayer ?? "")
    .split(",")
    .map((layer) => layer.trim())
    .filter((layer) => layer !== "" && layer !== FIFO_INVENTORY_REVIEW_LAYER),
})

/** Add or replace the FIFO shortage segment while preserving other review state. */
export const addFifoInventoryReview = ({
  review,
  reason,
}: {
  readonly review: FifoInventoryReviewState | null | undefined
  readonly reason: string
}) => {
  const existing = review ?? {
    reviewStatus: "needs_review" as const,
    categorizationReason: null,
    matchedLayer: null,
  }
  const remaining = withoutFifoReviewSegments(existing)
  return {
    reviewStatus:
      existing.reviewStatus === "approved" || existing.reviewStatus === "changed"
        ? existing.reviewStatus
        : ("needs_review" as const),
    categorizationReason: [...remaining.reasons, reason].join("\n"),
    matchedLayer: [...remaining.layers, FIFO_INVENTORY_REVIEW_LAYER].join(","),
    needsReview: true as const,
  }
}

/** Remove the FIFO shortage segment, or return null when no review state remains. */
export const removeFifoInventoryReview = (review: FifoInventoryReviewState) => {
  const remaining = withoutFifoReviewSegments(review)
  const preservesUserReview =
    review.reviewStatus === "approved" || review.reviewStatus === "changed"
  const shouldKeepReview =
    remaining.layers.length > 0 ||
    remaining.reasons.length > 0 ||
    (review.userNotes !== null && review.userNotes !== undefined) ||
    preservesUserReview
  if (!shouldKeepReview) return null

  return {
    categorizationReason: remaining.reasons.length === 0 ? null : remaining.reasons.join("\n"),
    matchedLayer: remaining.layers.length === 0 ? null : remaining.layers.join(","),
    needsReview: review.reviewStatus === "needs_review",
  }
}

/** Compare two exact decimal quantity strings. */
export const compareDecimalQuantities = <E>({
  left,
  right,
  errorFactory,
}: {
  readonly left: string
  readonly right: string
  readonly errorFactory: FixedPointErrorFactory<E>
}) =>
  Effect.gen(function* () {
    const parsedLeft = yield* parseDecimal(left, errorFactory)
    const parsedRight = yield* parseDecimal(right, errorFactory)
    const digits = alignDecimalDigits({ left: parsedLeft, right: parsedRight })

    if (digits.left < digits.right) return -1
    if (digits.left > digits.right) return 1
    return 0
  })

/** Subtract one exact decimal quantity from another. */
export const subtractDecimalQuantities = <E>({
  left,
  right,
  errorFactory,
}: {
  readonly left: string
  readonly right: string
  readonly errorFactory: FixedPointErrorFactory<E>
}) =>
  Effect.gen(function* () {
    const parsedLeft = yield* parseDecimal(left, errorFactory)
    const parsedRight = yield* parseDecimal(right, errorFactory)
    const digits = alignDecimalDigits({ left: parsedLeft, right: parsedRight })

    return formatScaled({ digits: digits.left - digits.right, scale: digits.scale })
  })

/** Subtract decimal values and format the result at a fixed scale. */
export const subtractScaledDecimals = <E>({
  left,
  right,
  scale,
  errorFactory,
}: {
  readonly left: string
  readonly right: string
  readonly scale: number
  readonly errorFactory: FixedPointErrorFactory<E>
}) =>
  Effect.gen(function* () {
    const parsedLeft = yield* parseDecimal(left, errorFactory)
    const parsedRight = yield* parseDecimal(right, errorFactory)
    const leftDigits = parsedLeft.digits * powerOfTen(scale - parsedLeft.scale)
    const rightDigits = parsedRight.digits * powerOfTen(scale - parsedRight.scale)

    return formatScaled({ digits: leftDigits - rightDigits, scale })
  })

/** Calculate one lot's cost basis per token from the leg valuation. */
export const toCostBasisPerToken = <E>({
  fiatAmount,
  quantityAmount,
  errorFactory,
}: {
  readonly fiatAmount: string | null
  readonly quantityAmount: string
  readonly errorFactory: FixedPointErrorFactory<E>
}) =>
  Effect.gen(function* () {
    if (fiatAmount === null) return "0.000000000000000000"

    const parsedFiat = yield* parseDecimal(fiatAmount, errorFactory)
    const parsedQuantity = yield* parseDecimal(quantityAmount, errorFactory)
    return divideToScale({
      numerator: parsedFiat.digits * powerOfTen(parsedQuantity.scale),
      denominator: parsedQuantity.digits * powerOfTen(parsedFiat.scale),
      scale: 18,
    })
  })

/** Allocate a disposal's total proceeds to one FIFO match. */
export const allocateProceeds = <E>({
  totalFiat,
  matchedAmount,
  totalAmount,
  errorFactory,
}: {
  readonly totalFiat: string | null
  readonly matchedAmount: string
  readonly totalAmount: string
  readonly errorFactory: FixedPointErrorFactory<E>
}) =>
  Effect.gen(function* () {
    if (totalFiat === null) return "0.00000000"

    const parsedFiat = yield* parseDecimal(totalFiat, errorFactory)
    const parsedMatched = yield* parseDecimal(matchedAmount, errorFactory)
    const parsedTotal = yield* parseDecimal(totalAmount, errorFactory)
    return divideToScale({
      numerator: parsedFiat.digits * parsedMatched.digits * powerOfTen(parsedTotal.scale),
      denominator: parsedTotal.digits * powerOfTen(parsedFiat.scale + parsedMatched.scale),
      scale: 8,
    })
  })

/** Calculate the cost basis consumed by one FIFO match. */
export const calculateMatchedCostBasis = <E>({
  costBasisPerToken,
  matchedAmount,
  errorFactory,
}: {
  readonly costBasisPerToken: string
  readonly matchedAmount: string
  readonly errorFactory: FixedPointErrorFactory<E>
}) =>
  Effect.gen(function* () {
    const parsedCostBasisPerToken = yield* parseDecimal(costBasisPerToken, errorFactory)
    const parsedMatched = yield* parseDecimal(matchedAmount, errorFactory)
    return divideToScale({
      numerator: parsedCostBasisPerToken.digits * parsedMatched.digits,
      denominator: powerOfTen(parsedCostBasisPerToken.scale + parsedMatched.scale),
      scale: 8,
    })
  })

/** Apply the shared oldest-lot-first allocation policy. */
export const buildFifoAllocations = <E>({
  lots,
  amount,
  fiatAmount,
  errorFactory,
  insufficientInventoryError,
}: {
  readonly lots: ReadonlyArray<OpenFifoLot>
  readonly amount: string
  readonly fiatAmount: string | null
  readonly errorFactory: FixedPointErrorFactory<E>
  readonly insufficientInventoryError: (remainingAmount: string) => E
}): Effect.Effect<ReadonlyArray<FifoAllocation>, E> =>
  Effect.gen(function* () {
    let remainingAmount = amount
    const allocations: Array<FifoAllocation> = []

    for (const lot of lots) {
      if (
        (yield* compareDecimalQuantities({
          left: remainingAmount,
          right: "0",
          errorFactory,
        })) === 0
      ) {
        break
      }

      if (
        (yield* compareDecimalQuantities({
          left: lot.remainingAmount,
          right: "0",
          errorFactory,
        })) <= 0
      ) {
        continue
      }

      const lotComparison = yield* compareDecimalQuantities({
        left: lot.remainingAmount,
        right: remainingAmount,
        errorFactory,
      })
      const matchedAmount = lotComparison <= 0 ? lot.remainingAmount : remainingAmount
      const nextLotRemainingAmount = yield* subtractDecimalQuantities({
        left: lot.remainingAmount,
        right: matchedAmount,
        errorFactory,
      })
      remainingAmount = yield* subtractDecimalQuantities({
        left: remainingAmount,
        right: matchedAmount,
        errorFactory,
      })
      const costBasis = yield* calculateMatchedCostBasis({
        costBasisPerToken: lot.costBasisPerToken,
        matchedAmount,
        errorFactory,
      })
      const proceeds = yield* allocateProceeds({
        totalFiat: fiatAmount,
        matchedAmount,
        totalAmount: amount,
        errorFactory,
      })
      const gainLoss = yield* subtractScaledDecimals({
        left: proceeds,
        right: costBasis,
        scale: 8,
        errorFactory,
      })

      allocations.push({
        fifoLotId: lot.id,
        matchedAmount,
        remainingAmount: nextLotRemainingAmount,
        costBasis,
        proceeds,
        gainLoss,
      })
    }

    if (
      (yield* compareDecimalQuantities({
        left: remainingAmount,
        right: "0",
        errorFactory,
      })) > 0
    ) {
      return yield* Effect.fail(insufficientInventoryError(remainingAmount))
    }

    return allocations
  })
