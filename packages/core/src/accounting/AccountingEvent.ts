/**
 * Jurisdiction-neutral facts consumed by tax accounting.
 *
 * @module accounting/AccountingEvent
 */

import * as BigDecimal from "effect/BigDecimal"
import * as Schema from "effect/Schema"
import { SourceId } from "../source/Source.ts"
import { Timestamp } from "../shared/values/Timestamp.ts"
import { AccountingQuantity } from "./AccountingQuantity.ts"

const Uuid = Schema.String.check(Schema.isUUID())
const NonEmptyString = Schema.Trimmed.check(Schema.isNonEmpty())

/** Stable identifier used for ledger ordering, choices, and explanations. */
export const AccountingEventId = Uuid.pipe(
  Schema.brand("AccountingEventId"),
  Schema.annotate({
    identifier: "AccountingEventId",
    title: "Accounting Event ID",
    description: "Stable identifier for one factual accounting event",
  })
)

/** The AccountingEventId type. */
export type AccountingEventId = typeof AccountingEventId.Type

/** Factual provider transaction or operation shared by related events. */
export const AccountingTransactionReference = NonEmptyString.pipe(
  Schema.brand("AccountingTransactionReference"),
  Schema.annotate({
    identifier: "AccountingTransactionReference",
    title: "Accounting Transaction Reference",
    description: "Provider transaction or operation that produced related events",
  })
)

/** The AccountingTransactionReference type. */
export type AccountingTransactionReference = typeof AccountingTransactionReference.Type

/** Observable reason that ownership of an asset increased. */
export const AcquisitionCause = Schema.Literals([
  "purchase",
  "gift",
  "airdrop",
  "mining_reward",
  "staking_reward",
  "reward",
  "payment",
  "unknown",
]).annotate({
  identifier: "AcquisitionCause",
  title: "Acquisition Cause",
  description:
    "Factual reason ownership increased; purchase includes any exchange and unknown must produce an engine blocker",
})

/** The AcquisitionCause type. */
export type AcquisitionCause = typeof AcquisitionCause.Type

/** Observable reason that ownership of an asset decreased. */
export const DispositionCause = Schema.Literals([
  "sale",
  "gift",
  "fee",
  "payment",
  "unknown",
]).annotate({
  identifier: "DispositionCause",
  title: "Disposition Cause",
  description:
    "Factual reason ownership decreased; sale includes any exchange and unknown must produce an engine blocker",
})

/** The DispositionCause type. */
export type DispositionCause = typeof DispositionCause.Type

const PositiveAccountingQuantity = AccountingQuantity.pipe(
  Schema.check(Schema.isGreaterThanBigDecimal(BigDecimal.fromBigInt(0n)))
)

const CommonEventFields = {
  id: AccountingEventId,
  occurredAt: Timestamp,
  assetId: Uuid,
  quantity: PositiveAccountingQuantity,
  transactionReference: Schema.optional(AccountingTransactionReference),
}

/** Asset ownership increased at one custody source. */
export const AcquisitionEvent = Schema.TaggedStruct("acquisition", {
  ...CommonEventFields,
  custodySourceId: SourceId,
  cause: AcquisitionCause,
}).annotate({
  identifier: "AcquisitionEvent",
  title: "Acquisition Event",
  description: "Jurisdiction-neutral fact that asset ownership increased",
})

/** The AcquisitionEvent type. */
export type AcquisitionEvent = typeof AcquisitionEvent.Type

/** Asset ownership decreased at one custody source. */
export const DispositionEvent = Schema.TaggedStruct("disposition", {
  ...CommonEventFields,
  custodySourceId: SourceId,
  cause: DispositionCause,
}).annotate({
  identifier: "DispositionEvent",
  title: "Disposition Event",
  description: "Jurisdiction-neutral fact that asset ownership decreased",
})

/** The DispositionEvent type. */
export type DispositionEvent = typeof DispositionEvent.Type

/** The same asset moved between two custody sources owned by the principal. */
export const CustodyMovementEvent = Schema.TaggedStruct("custody_movement", {
  ...CommonEventFields,
  fromCustodySourceId: SourceId,
  toCustodySourceId: SourceId,
})
  .pipe(
    Schema.check(
      Schema.makeFilter((event) =>
        event.fromCustodySourceId === event.toCustodySourceId
          ? "Custody movement source and destination must differ."
          : undefined
      )
    )
  )
  .annotate({
    identifier: "CustodyMovementEvent",
    title: "Custody Movement Event",
    description: "Matched movement of the same asset between the principal's custody sources",
  })

/** The CustodyMovementEvent type. */
export type CustodyMovementEvent = typeof CustodyMovementEvent.Type

/**
 * One fact in a principal's factual ledger.
 *
 * A ledger has one deterministic order: ascending `occurredAt`, then ascending
 * `id` when timestamps match. Causes record observable facts only. Taxability,
 * income categories, matching choices, holding periods, and treatment codes are
 * engine inputs or results and must not appear on events. An `unknown` cause
 * produces a machine-readable engine blocker and must never be guessed.
 */
export const AccountingEvent = Schema.Union([
  AcquisitionEvent,
  DispositionEvent,
  CustodyMovementEvent,
]).annotate({
  identifier: "AccountingEvent",
  title: "Accounting Event",
  description: "Jurisdiction-neutral fact in a principal's factual ledger",
})

/** The AccountingEvent type. */
export type AccountingEvent = typeof AccountingEvent.Type
