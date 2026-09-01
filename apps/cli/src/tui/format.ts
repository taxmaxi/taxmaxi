/**
 * Display formatting helpers for the report screens.
 *
 * Report amounts arrive as decimal strings. These helpers only shape them
 * for display and never feed values back into calculations.
 */
import { theme } from "./theme.ts"

const MAX_FRACTION_DIGITS = 8

const ZERO_AMOUNT = /^-?0*\.?0*$/

export const isZeroAmount = (value: string): boolean => ZERO_AMOUNT.test(value)

/**
 * Trims a decimal string for display: caps fraction digits and drops
 * trailing zeros, for example "0.000000010000" -> "0.00000001".
 */
export const formatAmount = (value: string): string => {
  const [whole = "0", fraction = ""] = value.split(".")
  const trimmed = fraction.slice(0, MAX_FRACTION_DIGITS).replace(/0+$/, "")
  return trimmed === "" ? whole : `${whole}.${trimmed}`
}

/**
 * Formats a fiat decimal string with two fraction digits and an optional
 * currency code, for example "12.3" -> "12.30 EUR".
 */
export const formatFiat = (value: string, currency: string | null): string => {
  const numeric = Number(value)
  const formatted = Number.isFinite(numeric) ? numeric.toFixed(2) : formatAmount(value)
  return currency === null ? formatted : `${formatted} ${currency}`
}

/**
 * Formats a gain/loss amount with an explicit sign, for example "+12.3".
 */
export const formatSigned = (value: string): string => {
  const formatted = formatAmount(value)
  return value.startsWith("-") || isZeroAmount(value) ? formatted : `+${formatted}`
}

/**
 * Picks the display color for a gain/loss amount.
 */
export const gainLossColor = (value: string): string => {
  if (isZeroAmount(value)) {
    return theme.textSoft
  }
  return value.startsWith("-") ? theme.error : theme.success
}

export const formatDate = (iso: string): string => iso.slice(0, 10)

export const formatDateTime = (iso: string): string =>
  `${iso.slice(0, 10)} ${iso.slice(11, 16)}`.trim()

export const truncateText = (value: string, maxLength: number): string =>
  value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`

export const formatLabel = (value: string): string => value.replaceAll("_", " ")

/**
 * Maps treatment codes to CLI display copy while keeping unknown future codes readable.
 */
export const formatTreatmentCodes = (treatmentCodes: ReadonlyArray<string>): string => {
  if (treatmentCodes.length === 0) {
    return "No treatment"
  }

  return treatmentCodes
    .map((code) => {
      switch (code) {
        case "de.tax_free_holding_period":
          return "Tax free after holding period"
        case "de.taxable_private_disposal":
          return "Taxable private disposal"
        case "de.taxable_income_section22_3_staking":
          return "Taxable staking income"
        default:
          return code
      }
    })
    .join(", ")
}

/** Picks the display color for treatment codes without interpreting unknown codes. */
export const treatmentCodesColor = (treatmentCodes: ReadonlyArray<string>): string => {
  if (treatmentCodes.some((code) => code.startsWith("de.taxable_"))) {
    return theme.warning
  }
  if (treatmentCodes.includes("de.tax_free_holding_period")) {
    return theme.success
  }
  return theme.textMuted
}
