import * as addresses from "./AddressesTable.ts"
import * as assetPrices from "./AssetPricesTable.ts"
import * as assets from "./AssetsTable.ts"
import * as blockchains from "./BlockchainsTable.ts"
import * as cex from "./CexTable.ts"
import * as cexAccount from "./CexAccountTable.ts"
import * as disposalMatches from "./DisposalMatchesTable.ts"
import * as duneProtocolCandidateObservations from "./DuneProtocolCandidateObservationsTable.ts"
import * as emailVerificationRequests from "./EmailVerificationRequestsTable.ts"
import * as fifoLots from "./FifoLotsTable.ts"
import * as identities from "./IdentitiesTable.ts"
import * as legalRules from "./LegalRulesTable.ts"
import * as oauthStates from "./OAuthStatesTable.ts"
import * as processingJobs from "./ProcessingJobsTable.ts"
import * as principalClaims from "./PrincipalClaimsTable.ts"
import * as principals from "./PrincipalsTable.ts"
import * as protocolCandidateObservations from "./ProtocolCandidateObservationsTable.ts"
import * as protocolCandidates from "./ProtocolCandidatesTable.ts"
import * as providerAssetMappings from "./ProviderAssetMappingsTable.ts"
import * as providerAssets from "./ProviderAssetsTable.ts"
import * as providerTransfers from "./ProviderTransfersTable.ts"
import * as providerTransactionTypeCatalog from "./ProviderTransactionTypeCatalogTable.ts"
import * as providerTransactionTypeMappings from "./ProviderTransactionTypeMappingsTable.ts"
import * as sessions from "./SessionsTable.ts"
import * as sourceRecordsRaw from "./SourceRecordsRawTable.ts"
import * as sourceSyncState from "./SourceSyncStateTable.ts"
import * as sources from "./SourcesTable.ts"
import * as syncRunItems from "./SyncRunItemsTable.ts"
import * as syncRuns from "./SyncRunsTable.ts"
import * as transactionCategories from "./TransactionCategoriesTable.ts"
import * as transactionLegs from "./TransactionLegsTable.ts"
import * as transactionOnchainContext from "./TransactionOnchainContextTable.ts"
import * as transactionReview from "./TransactionReviewTable.ts"
import * as transactionSubcategories from "./TransactionSubcategoriesTable.ts"
import * as transactionTypes from "./TransactionTypesTable.ts"
import * as transactionVenueContext from "./TransactionVenueContextTable.ts"
import * as transactions from "./TransactionsTable.ts"
import * as transferReconciliations from "./TransferReconciliationsTable.ts"
import * as transfers from "./TransfersTable.ts"
import * as users from "./UsersTable.ts"

export const schema = {
  ...addresses,
  ...assetPrices,
  ...assets,
  ...blockchains,
  ...cex,
  ...cexAccount,
  ...disposalMatches,
  ...duneProtocolCandidateObservations,
  ...emailVerificationRequests,
  ...fifoLots,
  ...identities,
  ...legalRules,
  ...oauthStates,
  ...processingJobs,
  ...principalClaims,
  ...principals,
  ...protocolCandidateObservations,
  ...protocolCandidates,
  ...providerAssetMappings,
  ...providerAssets,
  ...providerTransfers,
  ...providerTransactionTypeCatalog,
  ...providerTransactionTypeMappings,
  ...sessions,
  ...sourceRecordsRaw,
  ...sourceSyncState,
  ...sources,
  ...syncRunItems,
  ...syncRuns,
  ...transactionCategories,
  ...transactionLegs,
  ...transactionOnchainContext,
  ...transactionReview,
  ...transactionSubcategories,
  ...transactionTypes,
  ...transactionVenueContext,
  ...transactions,
  ...transferReconciliations,
  ...transfers,
  ...users,
}

export type { Address } from "./AddressesTable.ts"
export type { AssetPrice, AssetPriceInsert } from "./AssetPricesTable.ts"
export type { Asset, AssetInsert, AssetType } from "./AssetsTable.ts"
export type { Blockchain, BlockchainInsert, ChainType } from "./BlockchainsTable.ts"
export type { Cex, CexInsert } from "./CexTable.ts"
export type { CexAccount, CexAccountInsert } from "./CexAccountTable.ts"
export type { DisposalMatch, DisposalMatchInsert } from "./DisposalMatchesTable.ts"
export type {
  DuneProtocolCandidateObservationInsert,
  DuneProtocolCandidateObservationRow,
} from "./DuneProtocolCandidateObservationsTable.ts"
export type { EmailVerificationRequest } from "./EmailVerificationRequestsTable.ts"
export type { FifoLot, FifoLotInsert } from "./FifoLotsTable.ts"
export type { IdentityRow } from "./IdentitiesTable.ts"
export type {
  JurisdictionRuleSet,
  JurisdictionRuleSetInsert,
  JurisdictionRuleSetRule,
  JurisdictionRuleSetRuleInsert,
  LegalClause,
  LegalClauseInsert,
  LegalRule,
  LegalRuleCitation,
  LegalRuleCitationInsert,
  LegalRuleInsert,
  LegalSource,
  LegalSourceInsert,
  TransactionTypeLegalRule,
  TransactionTypeLegalRuleInsert,
} from "./LegalRulesTable.ts"
export type { OAuthStateRow } from "./OAuthStatesTable.ts"
export type { ProcessingJob, ProcessingJobInsert } from "./ProcessingJobsTable.ts"
export type { PrincipalClaimInsert, PrincipalClaimRow } from "./PrincipalClaimsTable.ts"
export type { PrincipalInsert, PrincipalRow } from "./PrincipalsTable.ts"
export type {
  ProtocolCandidateObservationInsert,
  ProtocolCandidateObservationRow,
  ProtocolCandidateObservationSource,
} from "./ProtocolCandidateObservationsTable.ts"
export type { ProtocolCandidateInsert, ProtocolCandidateRow } from "./ProtocolCandidatesTable.ts"
export type {
  ProviderAssetMappingKind,
  ProviderAssetMappingInsert,
  ProviderAssetMappingRow,
} from "./ProviderAssetMappingsTable.ts"
export type { ProviderAssetInsert, ProviderAssetRow } from "./ProviderAssetsTable.ts"
export type {
  ProviderTransfer,
  ProviderTransferDirection,
  ProviderTransferInsert,
} from "./ProviderTransfersTable.ts"
export type {
  ProviderTransactionTypeCatalogInsert,
  ProviderTransactionTypeCatalogRow,
} from "./ProviderTransactionTypeCatalogTable.ts"
export type {
  ProviderInventoryEffect,
  ProviderMappingStatus,
  ProviderResolutionStrategy,
  ProviderTaxTreatment,
  ProviderTransactionTypeMappingInsert,
  ProviderTransactionTypeMappingRow,
} from "./ProviderTransactionTypeMappingsTable.ts"
export type { SessionRow } from "./SessionsTable.ts"
export type { SourceRecordRaw, SourceRecordRawInsert } from "./SourceRecordsRawTable.ts"
export type { SourceSyncState, SourceSyncStateInsert } from "./SourceSyncStateTable.ts"
export type { SourceInsert, SourceRow } from "./SourcesTable.ts"
export type { SyncRunItem, SyncRunItemInsert } from "./SyncRunItemsTable.ts"
export type { SyncRun, SyncRunInsert } from "./SyncRunsTable.ts"
export type { TransactionCategory } from "./TransactionCategoriesTable.ts"
export type {
  LegKind,
  LegProvenance,
  TransactionLeg,
  TransactionLegInsert,
} from "./TransactionLegsTable.ts"
export type {
  TransactionOnchainContext,
  TransactionOnchainContextInsert,
} from "./TransactionOnchainContextTable.ts"
export type {
  ReviewStatus,
  TransactionReview,
  TransactionReviewInsert,
} from "./TransactionReviewTable.ts"
export type { TransactionSubcategory } from "./TransactionSubcategoriesTable.ts"
export type { TransactionType } from "./TransactionTypesTable.ts"
export type {
  TransactionVenueContext,
  TransactionVenueContextInsert,
} from "./TransactionVenueContextTable.ts"
export type { Transaction, TransactionInsert } from "./TransactionsTable.ts"
export type {
  TransferReconciliation,
  TransferReconciliationInsert,
  TransferReconciliationStatus,
} from "./TransferReconciliationsTable.ts"
export type { Transfer, TransferInsert, TransferType } from "./TransfersTable.ts"
export type { UserRow } from "./UsersTable.ts"
