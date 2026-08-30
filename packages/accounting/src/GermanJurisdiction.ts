/**
 * German private-assets tax-accounting policy.
 *
 * @module accounting/GermanJurisdiction
 */

import {
  AccountingMethodId,
  JurisdictionCode,
  type AcquisitionCause,
  type AccountingMethodChoice,
  type DispositionCause,
  type InventoryScope,
  type InventoryScopeChoice,
} from "@my/core/accounting"
import type { Timestamp } from "@my/core/shared/values/Timestamp"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/** Jurisdiction code owned by the German private-assets module. */
export const GERMAN_JURISDICTION = JurisdictionCode.make("DE")

/** Citation-backed German crypto rule-set version recorded on calculation results. */
export const GERMAN_RULE_SET_VERSION = "de-crypto-income-tax-v2025-03-06"

/** German default when no effective accounting-method choice is recorded. */
export const GERMAN_DEFAULT_ACCOUNTING_METHOD = AccountingMethodId.make("fifo")

/** German default when no effective inventory-scope choice is recorded. */
export const GERMAN_DEFAULT_INVENTORY_SCOPE: InventoryScope = "per_custody_unit"

/** A well-formed accounting choice is not legal for German private assets. */
export class IllegalGermanAccountingChoiceError extends Schema.TaggedError<IllegalGermanAccountingChoiceError>()(
  "IllegalAccountingChoiceError",
  {
    jurisdiction: Schema.String,
    choiceKind: Schema.Literals(["accounting_method", "inventory_scope"]),
    value: Schema.String,
  }
) {}

/** Effective structural policy selected by the German private-assets module. */
export interface GermanAccountingPolicy {
  readonly accountingMethod: AccountingMethodId
  readonly inventoryScope: InventoryScope
}

/** Apply German defaults and reject choices unavailable for private assets. */
export const resolveGermanAccountingPolicy = ({
  methodChoice,
  scopeChoice,
}: {
  readonly methodChoice: AccountingMethodChoice | null
  readonly scopeChoice: InventoryScopeChoice | null
}): Effect.Effect<GermanAccountingPolicy, IllegalGermanAccountingChoiceError> =>
  Effect.gen(function* () {
    const accountingMethod = methodChoice?.method ?? GERMAN_DEFAULT_ACCOUNTING_METHOD
    const inventoryScope = scopeChoice?.scope ?? GERMAN_DEFAULT_INVENTORY_SCOPE

    if (accountingMethod !== "fifo") {
      return yield* new IllegalGermanAccountingChoiceError({
        jurisdiction: GERMAN_JURISDICTION,
        choiceKind: "accounting_method",
        value: accountingMethod,
      })
    }

    if (inventoryScope !== "per_custody_unit") {
      return yield* new IllegalGermanAccountingChoiceError({
        jurisdiction: GERMAN_JURISDICTION,
        choiceKind: "inventory_scope",
        value: inventoryScope,
      })
    }

    return { accountingMethod, inventoryScope }
  })

/** German rules applied by every private-assets calculation. */
export const GERMAN_APPLIED_RULES = [
  "de.private.section23.disposal-within-one-year",
  "de.private.section23.wallet-fifo-method",
  "de.private.section22.staking-income",
] as const

const GERMAN_TIME_ZONE = "Europe/Berlin"

/** German civil-calendar year containing a source-recorded event instant. */
export const germanTaxYearOf = (timestamp: Timestamp): number =>
  DateTime.toParts(DateTime.setZoneNamedUnsafe(timestamp.toDateTime(), GERMAN_TIME_ZONE)).year

/** German treatment codes attached to private-assets results. */
export type GermanTreatmentCode =
  | "de.taxable_private_disposal"
  | "de.tax_free_holding_period"
  | "de.taxable_income_section22_3_staking"

/** German review reasons where a factual cause does not prove the legal treatment. */
export type GermanBlockerCode =
  | "de.staking_activity_classification_required"
  | "de.mining_activity_classification_required"
  | "de.airdrop_classification_required"
  | "de.reward_classification_required"
  | "de.payment_income_classification_required"
  | "de.gift_acquisition_basis_required"
  | "de.gift_disposition_classification_required"
  | "de.fee_allocation_required"

/** Return the German blocker for an acquisition whose factual cause is not legally decisive. */
export const germanAcquisitionBlocker = (cause: AcquisitionCause): GermanBlockerCode | null => {
  switch (cause) {
    case "staking_reward":
      return "de.staking_activity_classification_required"
    case "mining_reward":
      return "de.mining_activity_classification_required"
    case "airdrop":
      return "de.airdrop_classification_required"
    case "reward":
      return "de.reward_classification_required"
    case "payment":
      return "de.payment_income_classification_required"
    case "gift":
      return "de.gift_acquisition_basis_required"
    case "passive_staking_reward":
    case "purchase":
    case "unknown":
      return null
  }
}

/** Return an income treatment only when the factual cause proves passive staking. */
export const germanAcquisitionIncomeTreatment = (
  cause: AcquisitionCause
): GermanTreatmentCode | null =>
  cause === "passive_staking_reward" ? "de.taxable_income_section22_3_staking" : null

/** Return the German blocker for a disposition that cannot produce a section 23 result yet. */
export const germanDispositionBlocker = (cause: DispositionCause): GermanBlockerCode | null => {
  switch (cause) {
    case "gift":
      return "de.gift_disposition_classification_required"
    case "fee":
      return "de.fee_allocation_required"
    case "payment":
    case "sale":
    case "unknown":
      return null
  }
}

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)

const daysInMonth = ({
  year,
  month,
}: {
  readonly year: number
  readonly month: number
}): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28
  }

  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

const germanDateParts = (timestamp: Timestamp) =>
  DateTime.toParts(DateTime.setZoneNamedUnsafe(timestamp.toDateTime(), GERMAN_TIME_ZONE))

const compareCivilDates = (
  left: { readonly year: number; readonly month: number; readonly day: number },
  right: { readonly year: number; readonly month: number; readonly day: number }
): number => {
  if (left.year !== right.year) return left.year - right.year
  if (left.month !== right.month) return left.month - right.month
  return left.day - right.day
}

/** Apply the German section 23 civil-day holding-period rule to a supported disposition. */
export const germanPrivateDisposalTreatment = ({
  acquisition,
  acquisitionCause,
  disposition,
  cause,
}: {
  readonly acquisition: Timestamp
  readonly acquisitionCause: AcquisitionCause
  readonly disposition: Timestamp
  readonly cause: DispositionCause
}): GermanTreatmentCode | null => {
  if (acquisitionCause === "unknown" || (cause !== "sale" && cause !== "payment")) {
    return null
  }

  const acquiredDate = germanDateParts(acquisition)
  const disposedDate = germanDateParts(disposition)
  const anniversaryYear = acquiredDate.year + 1
  const anniversaryDate = {
    year: anniversaryYear,
    month: acquiredDate.month,
    day: Math.min(
      acquiredDate.day,
      daysInMonth({ year: anniversaryYear, month: acquiredDate.month })
    ),
  }

  return compareCivilDates(disposedDate, anniversaryDate) > 0
    ? "de.tax_free_holding_period"
    : "de.taxable_private_disposal"
}

/** Whether a jurisdiction code selects the German private-assets module. */
export const isGermanJurisdiction = (jurisdiction: JurisdictionCode): boolean =>
  jurisdiction === GERMAN_JURISDICTION
