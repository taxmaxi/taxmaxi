import * as Schema from "effect/Schema"

export const SYNC_CREDIT_REASON_CODES = ["no_usable_credits"] as const

/**
 * SyncCreditReasonCode - Stable reason codes for sync admission credit refusals.
 */
export const SyncCreditReasonCode = Schema.Literals(SYNC_CREDIT_REASON_CODES).annotate({
  identifier: "SyncCreditReasonCode",
  title: "Sync Credit Reason Code",
  description:
    "Machine-readable reason code explaining why a sync was refused for lack of credits.",
})

export type SyncCreditReasonCode = typeof SyncCreditReasonCode.Type
