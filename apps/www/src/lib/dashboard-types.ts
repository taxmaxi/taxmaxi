import type { Source } from "taxmaxi"

export const ALL_ACCOUNTS = "all"
export const taxYears = [2025, 2024, 2023] as const

export type AccountScope = typeof ALL_ACCOUNTS | AccountId
export type AccountKind = "exchange" | "wallet"
export type AccountId = Source["id"]
export type TaxYear = (typeof taxYears)[number]

export type Account = {
  id: AccountId
  name: Source["name"]
  kind: AccountKind
  network?: string
  providerKey?: NonNullable<Source["providerKey"]>
  importedTransactions: number
  unresolvedItems: number
  lastSync: string
  lastSyncedAt?: string
}

export type TaxYearAccountSummary = {
  accountId: AccountId
  taxYear: TaxYear
  realizedProfitLoss: number
  taxesPayable: number
  taxesReceivable: number
  taxableEvents: number
  missingClassifications: number
}

export type AssetHolding = {
  asset: string
  name: string
  lots: ReadonlyArray<{
    accountId: AccountId
    amount: number
    value: number
    costBasis: number
  }>
}
