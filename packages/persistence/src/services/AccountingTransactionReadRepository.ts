/**
 * AccountingTransactionReadRepository - Principal-owned transaction read projections.
 *
 * @module AccountingTransactionReadRepository
 */

import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** A requested transaction or source is absent or belongs to another principal. */
export class AccountingTransactionNotFoundError extends Schema.TaggedError<AccountingTransactionNotFoundError>()(
  "AccountingTransactionNotFoundError",
  { resourceId: Schema.String }
) {
  override get message(): string {
    return `Accounting transaction resource not found: ${this.resourceId}`
  }
}

/** The list cursor is malformed. */
export class AccountingTransactionInvalidCursorError extends Schema.TaggedError<AccountingTransactionInvalidCursorError>()(
  "AccountingTransactionInvalidCursorError",
  { cursor: Schema.String }
) {
  override get message(): string {
    return "Invalid accounting transaction pagination cursor."
  }
}

export type AccountingTransactionReadRepositoryError =
  | AccountingTransactionNotFoundError
  | AccountingTransactionInvalidCursorError
  | PersistenceError

export type AccountingTransactionReviewState =
  | "unreviewed"
  | "auto_applied"
  | "needs_review"
  | "approved"
  | "changed"

export type AccountingTransactionTaxTreatment =
  | "taxable"
  | "tax_free"
  | "deductible"
  | "non_taxable"
  | "unknown"
  | "mixed"

export type AccountingTransactionCalculationStatus = "complete" | "partial" | "pending"

export interface AccountingTransactionAsset {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
}

export interface AccountingTransactionSource {
  readonly sourceId: string
  readonly name: string
  readonly kind: "onchain" | "cex" | "dex"
  readonly provider: string | null
  readonly displayReference: string | null
}

export interface AccountingTransactionClassification {
  readonly key: string | null
  readonly label: string | null
  readonly categoryKey: string | null
  readonly categoryLabel: string | null
  readonly reviewState: AccountingTransactionReviewState
  readonly needsReview: boolean
}

export interface AccountingTransactionFiatValue {
  readonly amount: string
  readonly currency: string
}

export interface AccountingTransactionMovement {
  readonly movementId: string
  readonly legId: string | null
  readonly asset: AccountingTransactionAsset
  readonly kind: "acquisition" | "disposal" | "income" | "fee" | "custody"
  readonly direction: "inbound" | "outbound"
  readonly amount: string
  readonly fiatValue: AccountingTransactionFiatValue | null
  readonly derivation: {
    readonly provenance: "deterministic" | "rule" | "ai" | "manual"
    readonly rule: string | null
  } | null
  readonly custody: {
    readonly purpose: "principal" | "fee" | "reward"
    readonly taxTreatment: "taxable" | "non_taxable" | "pending_review"
    readonly reconciliationStatus: "unmatched" | "matched" | "needs_review"
  } | null
}

export interface AccountingTransactionTotals {
  readonly value: string | null
  readonly fees: string | null
  readonly proceeds: string | null
  readonly costBasis: string | null
  readonly gainLoss: string | null
  readonly currency: string | null
  readonly taxTreatment: AccountingTransactionTaxTreatment
  readonly calculationStatus: AccountingTransactionCalculationStatus
}

export interface AccountingTransactionExternalReferences {
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly providerTransactionType: string | null
  readonly providerStatus: string | null
  readonly providerDescription: string | null
  readonly transactionHash: string | null
}

export interface AccountingTransactionListItem {
  readonly transactionId: string
  readonly timestamp: string
  readonly classification: AccountingTransactionClassification
  readonly source: AccountingTransactionSource
  readonly movements: ReadonlyArray<AccountingTransactionMovement>
  readonly totals: AccountingTransactionTotals
  readonly externalReferences: AccountingTransactionExternalReferences
}

export interface AccountingTransactionMatchedLot {
  readonly lotId: string
  readonly acquiredAt: string
  readonly matchedAmount: string
  readonly costBasis: string | null
  readonly proceeds: string | null
  readonly gainLoss: string | null
  readonly taxTreatment: "taxable" | "tax_free" | "non_taxable"
}

export interface AccountingTransactionDisposal {
  readonly legId: string
  readonly asset: AccountingTransactionAsset
  readonly amount: string
  readonly disposedAt: string
  readonly proceeds: string | null
  readonly costBasis: string | null
  readonly gainLoss: string | null
  readonly taxTreatment: AccountingTransactionTaxTreatment
  readonly calculationStatus: AccountingTransactionCalculationStatus
  readonly matchedLots: ReadonlyArray<AccountingTransactionMatchedLot>
}

export interface AccountingTransactionCanonicalTransferEvidence {
  readonly transferId: string
  readonly type: string
  readonly transactionHash: string | null
  readonly from: string | null
  readonly to: string | null
  readonly asset: AccountingTransactionAsset
  readonly amount: string
}

export interface AccountingTransactionProviderTransferEvidence {
  readonly providerTransferId: string
  readonly externalId: string | null
  readonly direction: "inbound" | "outbound"
  readonly assetCode: string | null
  readonly amount: string
  readonly from: string | null
  readonly to: string | null
  readonly network: string | null
  readonly networkHash: string | null
}

export interface AccountingTransactionReconciliationEvidence {
  readonly reconciliationId: string
  readonly providerTransferId: string
  readonly canonicalTransferId: string | null
  readonly canonicalTransactionId: string | null
  readonly status: "pending" | "needs_review" | "approved" | "rejected" | "auto_applied"
  readonly reason: string
  readonly confidence: string
  readonly deterministic: boolean
}

export interface AccountingTransactionVenueContext {
  readonly type: "cex" | "dex"
  readonly accountReference: string | null
  readonly orderId: string | null
  readonly fillId: string | null
  readonly side: string | null
  readonly instrument: string | null
  readonly fillPrice: string | null
  readonly commissionAmount: string | null
  readonly commissionCurrency: string | null
}

export interface AccountingTransactionOnchainContext {
  readonly blockchain: string
  readonly chainType: string
  readonly explorerUrl: string | null
  readonly transactionHash: string
  readonly blockHeight: string | null
  readonly blockHash: string | null
  readonly fromAddress: string
  readonly toAddress: string | null
  readonly functionName: string | null
  readonly failed: boolean
  readonly feeAmount: string | null
  readonly feeAssetSymbol: string | null
  readonly feeFiatValue: AccountingTransactionFiatValue | null
}

export interface AccountingTransactionProviderEvidence {
  readonly provider: string
  readonly recordType: string
  readonly externalRecordId: string
  readonly externalParentId: string | null
  readonly externalAccountId: string | null
  readonly occurredAt: string
}

export interface AccountingTransactionClassificationExplanation {
  readonly originalKey: string | null
  readonly currentKey: string | null
  readonly reason: string | null
  readonly matchedLayer: string | null
  readonly userNotes: string | null
  readonly reviewedAt: string | null
}

export interface AccountingTransactionDetail extends AccountingTransactionListItem {
  readonly disposals: ReadonlyArray<AccountingTransactionDisposal>
  readonly canonicalTransfers: ReadonlyArray<AccountingTransactionCanonicalTransferEvidence>
  readonly providerTransfers: ReadonlyArray<AccountingTransactionProviderTransferEvidence>
  readonly reconciliations: ReadonlyArray<AccountingTransactionReconciliationEvidence>
  readonly venue: AccountingTransactionVenueContext | null
  readonly onchain: AccountingTransactionOnchainContext | null
  readonly providerEvidence: AccountingTransactionProviderEvidence | null
  readonly classificationExplanation: AccountingTransactionClassificationExplanation | null
}

export interface AccountingTransactionListParams {
  readonly principalId: string
  readonly sourceId: string | null
  readonly cursor: string | null
  readonly limit: number
  readonly search: string | null
  readonly classificationKey: string | null
  readonly categoryKey: string | null
  readonly reviewState: AccountingTransactionReviewState | null
}

export interface AccountingTransactionPage {
  readonly items: ReadonlyArray<AccountingTransactionListItem>
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

/** Persistence contract for stable accounting transaction list and detail reads. */
export interface AccountingTransactionReadRepositoryService {
  readonly list: (
    params: AccountingTransactionListParams
  ) => Effect.Effect<AccountingTransactionPage, AccountingTransactionReadRepositoryError>
  readonly getById: (params: {
    readonly principalId: string
    readonly transactionId: string
  }) => Effect.Effect<AccountingTransactionDetail, AccountingTransactionReadRepositoryError>
}

/** Context tag for accounting transaction read projections. */
export class AccountingTransactionReadRepository extends Context.Tag(
  "@my/persistence/AccountingTransactionReadRepository"
)<AccountingTransactionReadRepository, AccountingTransactionReadRepositoryService>() {}
