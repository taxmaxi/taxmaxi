/**
 * FactualLedgerRepository - Stored facts adapted to tax-accounting inputs.
 *
 * @module FactualLedgerRepository
 */

import type { AccountingEvent, CustodyUnitId, ValuationFact } from "@my/core/accounting"
import type { CurrencyCode } from "@my/core/currency"
import type { PrincipalId } from "@my/core/ownership"
import type { SourceId } from "@my/core/source"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { PersistenceError } from "../errors/RepositoryError.ts"

/** Inputs needed to load one principal's factual ledger and price facts. */
export interface LoadFactualLedgerParams {
  readonly principalId: PrincipalId
  readonly reportingCurrency: CurrencyCode
}

/** Current factual mapping from one custody source to its accounting inventory unit. */
export interface CustodyUnitMembership {
  readonly sourceId: SourceId
  readonly custodyUnitId: CustodyUnitId
}

/**
 * Canonical identity-override stream leaf read while adapting factual rows.
 *
 * Tuple order is part of the calculation input revision contract:
 * target ID, blockchain, representation type, contract, mint, override record ID,
 * operation, superseded record ID, and selected economic asset.
 */
export type PrincipalAssetOverrideRevisionRecord = readonly [
  targetId: string,
  blockchainId: string,
  representationType: "native" | "token" | "nft",
  contractAddress: string | null,
  mintAddress: string | null,
  overrideId: string,
  operation: "create" | "replace" | "withdraw",
  supersedesOverrideId: string | null,
  replacementAssetId: string | null,
]

/** Stored accounting facts ready for the pure tax-accounting engine. */
export interface FactualLedger {
  readonly events: ReadonlyArray<AccountingEvent>
  readonly valuationFacts: ReadonlyArray<ValuationFact>
  readonly custodyUnitMembership: ReadonlyArray<CustodyUnitMembership>
  readonly principalAssetOverrideRevision: ReadonlyArray<PrincipalAssetOverrideRevisionRecord>
}

/** Persistence contract for adapting stored rows to a factual ledger. */
export interface FactualLedgerRepositoryShape {
  readonly load: (params: LoadFactualLedgerParams) => Effect.Effect<FactualLedger, PersistenceError>
}

/** Context tag for factual-ledger reads. */
export class FactualLedgerRepository extends Context.Service<
  FactualLedgerRepository,
  FactualLedgerRepositoryShape
>()("@my/persistence/FactualLedgerRepository") {}
