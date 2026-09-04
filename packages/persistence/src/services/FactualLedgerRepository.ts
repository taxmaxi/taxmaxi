/**
 * FactualLedgerRepository - Stored facts adapted to tax-accounting inputs.
 *
 * @module FactualLedgerRepository
 */

import type { AccountingEvent, CustodyUnitId, ValuationFact } from "@my/core/accounting"
import type { PrincipalAssetTechnicalBlocker } from "@my/core/assets"
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

/** Fact-layer reason a stored movement cannot become an accounting event. */
export type FactualLedgerInputBlockerCode = PrincipalAssetTechnicalBlocker | "unresolved_identity"

/** At least one stored target that identifies the blocked fact. */
export type FactualLedgerInputBlockerTarget =
  | {
      readonly assetId: string
      readonly providerAssetRowId?: string | null
    }
  | {
      readonly assetId?: null
      readonly providerAssetRowId: string
    }

/** Machine-readable fact-layer blocker stored beside engine blockers on a run. */
export type FactualLedgerInputBlocker = {
  readonly code: FactualLedgerInputBlockerCode
  readonly eventId: AccountingEvent["id"]
  readonly occurredAt: Date
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity: null
} & FactualLedgerInputBlockerTarget

/**
 * Canonical identity-override stream leaf read while adapting factual rows.
 *
 * The tagged target keeps exact representations and chainless provider assets distinct.
 * Every leaf includes its stream kind, record ID, operation, supersession link, and
 * replacement so the calculation input commits to the decision snapshot it read.
 */
export type PrincipalAssetOverrideRevisionRecord =
  | {
      readonly target: {
        readonly _tag: "representation"
        readonly targetId: string
        readonly blockchainId: string
        readonly representationType: "native" | "token" | "nft"
        readonly contractAddress: string | null
        readonly mintAddress: string | null
      }
      readonly kind: "identity" | "inclusion"
      readonly overrideId: string
      readonly operation: "create" | "replace" | "withdraw"
      readonly supersedesOverrideId: string | null
      readonly replacementAssetId: string | null
      readonly replacementInclusion: "included" | "excluded" | null
    }
  | {
      readonly target: {
        readonly _tag: "provider_asset"
        readonly targetId: string
        readonly providerAssetRowId: string
      }
      readonly kind: "identity" | "inclusion"
      readonly overrideId: string
      readonly operation: "create" | "replace" | "withdraw"
      readonly supersedesOverrideId: string | null
      readonly replacementAssetId: string | null
      readonly replacementInclusion: "included" | "excluded" | null
    }

/** Stored accounting facts ready for the pure tax-accounting engine. */
export interface FactualLedger {
  readonly events: ReadonlyArray<AccountingEvent>
  readonly inputBlockers: ReadonlyArray<FactualLedgerInputBlocker>
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
