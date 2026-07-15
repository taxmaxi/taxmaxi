export function formatCurrency(value: number, currency = "EUR"): string {
  return `${value.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency.toUpperCase()}`
}

export function formatSignedCurrency(value: number, currency = "EUR"): string {
  if (value === 0) {
    return formatCurrency(0, currency)
  }

  const prefix = value > 0 ? "+" : "-"
  return `${prefix}${formatCurrency(Math.abs(value), currency)}`
}

export function formatInteger(value: number): string {
  return value.toLocaleString("de-DE")
}

export function formatTokenAmount(value: string): string {
  const decimal = parseDecimal(value)
  if (decimal === null) return value

  const isBelowOne = decimal.integer === "0"
  return formatDecimal(decimal, {
    minimumFractionDigits: isBelowOne ? 4 : 2,
    maximumFractionDigits: isBelowOne ? 6 : 2,
  })
}

export function formatTokenPrice(value: string, currency = "EUR"): string {
  const decimal = parseDecimal(value)
  if (decimal === null) return `${value} ${currency.toUpperCase()}`

  const firstSignificantFractionIndex = decimal.fraction.search(/[1-9]/)
  const maximumFractionDigits =
    decimal.integer === "0" && firstSignificantFractionIndex >= 0
      ? Math.min(18, Math.max(2, firstSignificantFractionIndex + 4))
      : 2

  return `${formatDecimal(decimal, {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  })} ${currency.toUpperCase()}`
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`
}

interface DecimalParts {
  readonly negative: boolean
  readonly integer: string
  readonly fraction: string
}

interface DecimalFormatOptions {
  readonly minimumFractionDigits: number
  readonly maximumFractionDigits: number
}

const parseDecimal = (value: string): DecimalParts | null => {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (match === null) return null

  const integer = (match[2] ?? "0").replace(/^0+(?=\d)/, "")

  return {
    negative: match[1] === "-",
    integer,
    fraction: match[3] ?? "",
  }
}

const formatDecimal = (
  decimal: DecimalParts,
  { minimumFractionDigits, maximumFractionDigits }: DecimalFormatOptions
): string => {
  const retainedFraction = decimal.fraction
    .slice(0, maximumFractionDigits)
    .padEnd(maximumFractionDigits, "0")
  const shouldRoundUp = "56789".includes(decimal.fraction[maximumFractionDigits] ?? "0")
  const scale = 10n ** BigInt(maximumFractionDigits)
  const scaledValue =
    BigInt(decimal.integer) * scale +
    BigInt(retainedFraction === "" ? "0" : retainedFraction) +
    (shouldRoundUp ? 1n : 0n)
  const roundedInteger = scaledValue / scale
  const roundedFraction =
    maximumFractionDigits === 0
      ? ""
      : (scaledValue % scale).toString().padStart(maximumFractionDigits, "0")
  const visibleFraction = roundedFraction.replace(
    new RegExp(`0{0,${Math.max(0, maximumFractionDigits - minimumFractionDigits)}}$`),
    ""
  )
  const isZero = roundedInteger === 0n && !/[1-9]/.test(visibleFraction)
  const sign = decimal.negative && !isZero ? "-" : ""
  const groupedInteger = roundedInteger.toLocaleString("de-DE")

  return visibleFraction === ""
    ? `${sign}${groupedInteger}`
    : `${sign}${groupedInteger},${visibleFraction}`
}
