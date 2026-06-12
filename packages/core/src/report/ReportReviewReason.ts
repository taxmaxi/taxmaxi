import * as Schema from "effect/Schema"

export const REPORT_REVIEW_REASON_CODES = ["fifo_inventory_shortfall"] as const

/**
 * ReportReviewReasonCode - Stable reason codes for report review blockers.
 */
export const ReportReviewReasonCode = Schema.Literal(...REPORT_REVIEW_REASON_CODES).annotations({
  identifier: "ReportReviewReasonCode",
  title: "Report Review Reason Code",
  description: "Machine-readable reason code explaining why a report needs review.",
})

export type ReportReviewReasonCode = typeof ReportReviewReasonCode.Type
