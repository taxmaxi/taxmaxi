/**
 * Exact asset quantities used by tax accounting.
 *
 * @module accounting/AccountingQuantity
 */

import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const ZERO = BigDecimal.fromBigInt(0n)

/** A non-negative asset quantity encoded as a decimal string. */
export const AccountingQuantity = Schema.BigDecimalFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigDecimal(ZERO)),
  Schema.brand("AccountingQuantity"),
  Schema.annotate({
    identifier: "AccountingQuantity",
    title: "Accounting Quantity",
    description: "An exact, non-negative asset quantity",
  })
)

/** The decoded accounting quantity value. */
export type AccountingQuantity = typeof AccountingQuantity.Type

const make = (value: BigDecimal.BigDecimal): AccountingQuantity => AccountingQuantity.make(value)

/** Add two exact quantities. */
export const add = (left: AccountingQuantity, right: AccountingQuantity): AccountingQuantity =>
  make(BigDecimal.sum(left, right))

/**
 * Subtract a quantity when enough is available.
 *
 * A negative result is represented by `Option.none` so inventory shortage can
 * stay a value instead of becoming an exception.
 */
export const subtract = (
  left: AccountingQuantity,
  right: AccountingQuantity
): Option.Option<AccountingQuantity> =>
  BigDecimal.isLessThan(left, right)
    ? Option.none()
    : Option.some(make(BigDecimal.subtract(left, right)))

/** Return the smaller of two exact quantities. */
export const min = (left: AccountingQuantity, right: AccountingQuantity): AccountingQuantity =>
  make(BigDecimal.min(left, right))

/** Format a quantity as a plain decimal string without exponent notation. */
export const format = (quantity: AccountingQuantity): string => {
  if (quantity.scale <= 0) {
    return (quantity.value * 10n ** BigInt(-quantity.scale)).toString()
  }

  const negative = quantity.value < 0n
  const absoluteDigits = (negative ? -quantity.value : quantity.value)
    .toString()
    .padStart(quantity.scale + 1, "0")
  const whole = absoluteDigits.slice(0, -quantity.scale)
  const fraction = absoluteDigits.slice(-quantity.scale)

  return `${negative ? "-" : ""}${whole}.${fraction}`
}
