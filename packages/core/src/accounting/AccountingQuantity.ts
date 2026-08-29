/**
 * Exact asset quantities used by tax accounting.
 *
 * @module accounting/AccountingQuantity
 */

import * as BigDecimal from "effect/BigDecimal"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

const ZERO = BigDecimal.fromBigInt(0n)
const PLAIN_DECIMAL_PATTERN = /^[+-]?\d+(?:\.\d+)?$/

const formatPlainDecimal = (value: BigDecimal.BigDecimal): string => {
  if (value.scale <= 0) {
    return (value.value * 10n ** BigInt(-value.scale)).toString()
  }

  const negative = value.value < 0n
  const absoluteDigits = (negative ? -value.value : value.value)
    .toString()
    .padStart(value.scale + 1, "0")
  const whole = absoluteDigits.slice(0, -value.scale)
  const fraction = absoluteDigits.slice(-value.scale)

  return `${negative ? "-" : ""}${whole}.${fraction}`
}

const PlainBigDecimalFromString = Schema.Trim.pipe(
  Schema.check(Schema.isPattern(PLAIN_DECIMAL_PATTERN)),
  Schema.decodeTo(
    Schema.BigDecimal,
    SchemaTransformation.transform({
      decode: BigDecimal.fromStringUnsafe,
      encode: formatPlainDecimal,
    })
  )
)

/** A non-negative asset quantity encoded as a decimal string. */
export const AccountingQuantity = PlainBigDecimalFromString.pipe(
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
export const format = (quantity: AccountingQuantity): string => formatPlainDecimal(quantity)
