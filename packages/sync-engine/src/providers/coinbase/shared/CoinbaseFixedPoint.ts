/**
 * CoinbaseFixedPoint - Shared fixed-point helpers for Coinbase normalization and FIFO.
 *
 * @module CoinbaseFixedPoint
 */

import * as Effect from "effect/Effect"

export interface ParsedDecimal {
  readonly sign: 1 | -1
  readonly digits: bigint
  readonly scale: number
}

export interface FixedPointErrorFactory<E> {
  readonly invalidDecimal: (value: string) => E
  readonly invalidPrecision: (params: { readonly amount: string; readonly decimals: number }) => E
}

export const makeFixedPointErrorFactory = <E>(
  makeError: (params: {
    readonly kind: "invalidDecimal" | "invalidPrecision"
    readonly message: string
  }) => E
): FixedPointErrorFactory<E> => ({
  invalidDecimal: (value) =>
    makeError({
      kind: "invalidDecimal",
      message: `Invalid decimal amount: ${value}`,
    }),
  invalidPrecision: ({ amount, decimals }) =>
    makeError({
      kind: "invalidPrecision",
      message: `Amount ${amount} exceeds asset precision ${decimals}`,
    }),
})

export const powerOfTen = (value: number): bigint => 10n ** BigInt(value)

/** Parse a decimal string into sign, integer digits, and scale. */
export const parseDecimal = <E>(
  value: string,
  errorFactory: FixedPointErrorFactory<E>
): Effect.Effect<ParsedDecimal, E> => {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (match === null) {
    return Effect.fail(errorFactory.invalidDecimal(value))
  }

  const [, signText, wholePart, fractionPart = ""] = match
  const combinedDigits = `${wholePart}${fractionPart}`.replace(/^0+(?=\d)/, "")

  return Effect.succeed({
    sign: signText === "-" ? -1 : 1,
    digits: BigInt(combinedDigits === "" ? "0" : combinedDigits),
    scale: fractionPart.length,
  })
}

/** Format a scaled integer as a decimal string. */
export const formatScaled = ({
  digits,
  scale,
}: {
  readonly digits: bigint
  readonly scale: number
}): string => {
  const negative = digits < 0n
  const absoluteDigits = negative ? -digits : digits
  const digitsText = absoluteDigits.toString()

  if (scale === 0) {
    return `${negative ? "-" : ""}${digitsText}`
  }

  const padded = digitsText.padStart(scale + 1, "0")
  const whole = padded.slice(0, -scale)
  const fraction = padded.slice(-scale)
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "")

  return `${negative ? "-" : ""}${normalizedWhole}.${fraction}`
}

/** Round a rational number to a target decimal scale using half-up rounding. */
export const divideToScale = ({
  numerator,
  denominator,
  scale,
}: {
  readonly numerator: bigint
  readonly denominator: bigint
  readonly scale: number
}): string => {
  const scaledNumerator = numerator * powerOfTen(scale)
  const quotient = scaledNumerator / denominator
  const remainder = scaledNumerator % denominator
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient

  return formatScaled({ digits: rounded, scale })
}

/** Convert a positive decimal token amount into atomic units. */
export const decimalToAtomic = <E>({
  amount,
  decimals,
  errorFactory,
}: {
  readonly amount: string
  readonly decimals: number
  readonly errorFactory: FixedPointErrorFactory<E>
}): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    const parsed = yield* parseDecimal(amount, errorFactory)

    if (parsed.scale > decimals) {
      const extraScale = parsed.scale - decimals
      const divisor = powerOfTen(extraScale)

      if (parsed.digits % divisor !== 0n) {
        return yield* Effect.fail(errorFactory.invalidPrecision({ amount, decimals }))
      }

      return (parsed.digits / divisor).toString()
    }

    return (parsed.digits * powerOfTen(decimals - parsed.scale)).toString()
  })

export const absoluteDecimal = (value: string): string =>
  value.startsWith("-") ? value.slice(1) : value

export const isNegativeAmount = (value: string): boolean => value.trim().startsWith("-")
