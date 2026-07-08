export const ALL_ACCOUNTS = "all"

export type AccountScope = typeof ALL_ACCOUNTS | AccountId
export type TransactionMode = "tax" | "raw"
export type AccountKind = "exchange" | "wallet"
export type AccountId = string
export type TaxYear = 2025 | 2024 | 2023

export type Account = {
  id: AccountId
  name: string
  kind: AccountKind
  network?: string
  importedTransactions: number
  unresolvedItems: number
  lastSync: string
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

export type DashboardTransaction = {
  id: string
  accountId: AccountId
  taxYear: TaxYear
  date: string
  asset: string
  rawAction: string
  taxTreatment: string
  amount: number
  value: number
  realizedProfitLoss: number
  taxImpact: number
  txId: string
  taxRelevant: boolean
}
