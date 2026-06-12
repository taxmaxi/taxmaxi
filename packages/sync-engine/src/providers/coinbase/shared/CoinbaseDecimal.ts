/**
 * CoinbaseDecimal - Decimal amount helpers for Coinbase normalization, built on effect/BigDecimal.
 *
 * @module CoinbaseDecimal
 */

import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

/** Parse a decimal amount string, failing via `onInvalid` for malformed or empty input. */
export const parseAmount = <E>(
  value: string,
  onInvalid: (value: string) => E
): Effect.Effect<BigDecimal.BigDecimal, E> => {
  const trimmed = value.trim()
  if (trimmed === "") {
    return Effect.fail(onInvalid(value))
  }

  return Option.match(BigDecimal.fromString(trimmed), {
    onNone: () => Effect.fail(onInvalid(value)),
    onSome: (parsed) => Effect.succeed(parsed),
  })
}

/**
 * Format a `BigDecimal` as a plain decimal string at its stored scale, keeping
 * trailing zeros. `BigDecimal.format` normalizes away trailing zeros and falls
 * back to exponential notation for high-precision values, neither of which is
 * safe for persisted amount strings.
 */
export const formatPlain = (value: BigDecimal.BigDecimal): string => {
  if (value.scale <= 0) {
    return (value.value * 10n ** BigInt(-value.scale)).toString()
  }

  const negative = value.value < 0n
  const digits = (negative ? -value.value : value.value).toString().padStart(value.scale + 1, "0")
  const whole = digits.slice(0, -value.scale)
  const fraction = digits.slice(-value.scale)

  return `${negative ? "-" : ""}${whole}.${fraction}`
}

export const absoluteDecimal = (value: string): string =>
  value.startsWith("-") ? value.slice(1) : value

export const isNegativeAmount = (value: string): boolean => value.trim().startsWith("-")

export const isZeroAmount = (value: string): boolean => /^[+-]?0*(\.0*)?$/.test(value.trim())
