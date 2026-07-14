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

export function formatTokenAmount(value: number): string {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 6 : 2,
  })
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString("de-DE", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`
}
