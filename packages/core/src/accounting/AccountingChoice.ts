/**
 * Shared inputs that select tax-accounting policy.
 *
 * @module accounting/AccountingChoice
 */

import * as Schema from "effect/Schema"
import { Timestamp } from "../shared/values/Timestamp.ts"

const Uuid = Schema.String.check(Schema.isUUID())
const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())

/** Open jurisdiction code interpreted only by an accounting jurisdiction module. */
export const JurisdictionCode = NonEmptyString.pipe(
  Schema.brand("JurisdictionCode"),
  Schema.annotate({
    identifier: "JurisdictionCode",
    title: "Jurisdiction Code",
    description: "Open code selecting one tax-accounting jurisdiction module",
  })
)

/** The JurisdictionCode type. */
export type JurisdictionCode = typeof JurisdictionCode.Type

/** Calendar year requested from a jurisdiction module. */
export const TaxYear = Schema.Finite.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  Schema.brand("TaxYear"),
  Schema.annotate({
    identifier: "TaxYear",
    title: "Tax Year",
    description: "Calendar year interpreted in the selected jurisdiction",
  })
)

/** The TaxYear type. */
export type TaxYear = typeof TaxYear.Type

/** Stable identifier for a recorded accounting choice. */
export const AccountingChoiceId = Uuid.pipe(
  Schema.brand("AccountingChoiceId"),
  Schema.annotate({
    identifier: "AccountingChoiceId",
    title: "Accounting Choice ID",
    description: "Stable identifier for one append-only accounting choice",
  })
)

/** The AccountingChoiceId type. */
export type AccountingChoiceId = typeof AccountingChoiceId.Type

/** Open identifier for an accounting method implemented by the engine. */
export const AccountingMethodId = NonEmptyString.pipe(
  Schema.brand("AccountingMethodId"),
  Schema.annotate({
    identifier: "AccountingMethodId",
    title: "Accounting Method ID",
    description: "Machine-readable accounting method identifier",
  })
)

/** The AccountingMethodId type. */
export type AccountingMethodId = typeof AccountingMethodId.Type

/** Boundary within which an asset disposition may match inventory. */
export const InventoryScope = Schema.Literals(["per_custody_unit", "whole_taxpayer"]).annotate({
  identifier: "InventoryScope",
  title: "Inventory Scope",
  description: "Per-custody-unit inventory or one taxpayer-wide inventory",
})

/** The InventoryScope type. */
export type InventoryScope = typeof InventoryScope.Type

/** Engine-facing custody unit, defaulting to one source during this delivery phase. */
export const CustodyUnitId = Uuid.pipe(
  Schema.brand("CustodyUnitId"),
  Schema.annotate({
    identifier: "CustodyUnitId",
    title: "Custody Unit ID",
    description: "Recorded custody grouping used by derived accounting inventory",
  })
)

/** The CustodyUnitId type. */
export type CustodyUnitId = typeof CustodyUnitId.Type

const CommonChoiceFields = {
  id: AccountingChoiceId,
  jurisdiction: JurisdictionCode,
  recordedAt: Timestamp,
  actor: NonEmptyString,
  evidence: NonEmptyString,
  supersedesChoiceId: Schema.optional(AccountingChoiceId),
}

/** Append-only selection of an accounting method. */
export const AccountingMethodChoice = Schema.TaggedStruct("accounting_method", {
  ...CommonChoiceFields,
  method: AccountingMethodId,
}).annotate({
  identifier: "AccountingMethodChoice",
  title: "Accounting Method Choice",
  description: "Recorded accounting-method selection with audit evidence",
})

/** The AccountingMethodChoice type. */
export type AccountingMethodChoice = typeof AccountingMethodChoice.Type

/** Append-only selection of an inventory scope. */
export const InventoryScopeChoice = Schema.TaggedStruct("inventory_scope", {
  ...CommonChoiceFields,
  scope: InventoryScope,
}).annotate({
  identifier: "InventoryScopeChoice",
  title: "Inventory Scope Choice",
  description: "Recorded inventory-scope selection with audit evidence",
})

/** The InventoryScopeChoice type. */
export type InventoryScopeChoice = typeof InventoryScopeChoice.Type

/** Recorded input choices consumed by tax accounting. */
export const AccountingChoice = Schema.Union([
  AccountingMethodChoice,
  InventoryScopeChoice,
]).annotate({
  identifier: "AccountingChoice",
  title: "Accounting Choice",
  description: "Append-only accounting-method or inventory-scope choice",
})

/** The AccountingChoice type. */
export type AccountingChoice = typeof AccountingChoice.Type
