declare global {
  namespace Intl {
    interface NumberFormat {
      format(value: `${number}`): string
    }
  }
}

export function formatCurrency(value: string, currency = "EUR"): string {
  if (!isDecimalString(value)) return `${value} ${currency.toUpperCase()}`

  return `${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)} ${currency.toUpperCase()}`
}

export function formatSignedCurrency(value: string, currency = "EUR"): string {
  if (!isDecimalString(value)) return `${value} ${currency.toUpperCase()}`

  return `${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(value)} ${currency.toUpperCase()}`
}

export function formatInteger(value: number): string {
  return value.toLocaleString("de-DE")
}

export function formatTokenAmount(value: string): string {
  if (!isDecimalString(value)) return value

  const isBelowOne = getUnsignedInteger(value) === "0"
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: isBelowOne ? 4 : 2,
    maximumFractionDigits: isBelowOne ? 6 : 2,
  }).format(value)
}

export function formatTokenPrice(value: string, currency = "EUR"): string {
  if (!isDecimalString(value)) return `${value} ${currency.toUpperCase()}`

  const [integer, fraction = ""] = getUnsignedDecimal(value).split(".")
  const firstSignificantFractionIndex = fraction.search(/[1-9]/)
  const maximumFractionDigits =
    integer === "0" && firstSignificantFractionIndex >= 0
      ? Math.min(18, Math.max(2, firstSignificantFractionIndex + 4))
      : 2

  return `${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(value)} ${currency.toUpperCase()}`
}

export function formatPercent(value: string): string {
  if (!isDecimalString(value)) return `${value}%`

  return `${new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)}%`
}

const isDecimalString = (value: string): value is `${number}` =>
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)

const getUnsignedDecimal = (value: `${number}`): string =>
  value.startsWith("-") ? value.slice(1) : value

const getUnsignedInteger = (value: `${number}`): string =>
  getUnsignedDecimal(value).split(".", 1)[0] ?? "0"
