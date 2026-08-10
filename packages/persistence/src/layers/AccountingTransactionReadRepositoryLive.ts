/**
 * AccountingTransactionReadRepositoryLive - Drizzle-backed transaction read projections.
 *
 * @module AccountingTransactionReadRepositoryLive
 */

import {
  aliasedTable,
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  AccountingTransactionInvalidCursorError,
  AccountingTransactionNotFoundError,
  AccountingTransactionReadRepository,
  type AccountingTransactionAsset,
  type AccountingTransactionCalculationStatus,
  type AccountingTransactionClassification,
  type AccountingTransactionDetail,
  type AccountingTransactionDisposal,
  type AccountingTransactionListItem,
  type AccountingTransactionMatchedLot,
  type AccountingTransactionMovement,
  type AccountingTransactionPage,
  type AccountingTransactionReadRepositoryService,
  type AccountingTransactionReviewState,
  type AccountingTransactionTaxTreatment,
  type AccountingTransactionTotals,
} from "../services/AccountingTransactionReadRepository.ts"
import { drizzle } from "./PgClientLive.ts"

const CursorScopeSchema = Schema.Struct({
  sourceId: Schema.NullOr(Schema.String),
  search: Schema.String,
  classificationKey: Schema.NullOr(Schema.String),
  categoryKey: Schema.NullOr(Schema.String),
  reviewState: Schema.NullOr(Schema.String),
})

const CursorPayloadSchema = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.String,
  timestamp: Schema.String,
  id: Schema.UUID,
  scope: CursorScopeSchema,
})

const EncodedCursorPayloadSchema = Schema.parseJson(CursorPayloadSchema)

type CursorScope = typeof CursorScopeSchema.Type

interface CursorParts {
  readonly generation: Date
  readonly timestamp: Date
  readonly id: string
  readonly scope: CursorScope
}

interface BaseRow {
  readonly transactionId: string
  readonly timestamp: Date
  readonly sourceId: string
  readonly sourceName: string
  readonly sourceKind: "onchain" | "cex" | "dex"
  readonly sourceProvider: string | null
  readonly addressReference: string | null
  readonly accountReference: string | null
  readonly classificationKey: string | null
  readonly classificationLabel: string | null
  readonly categoryKey: string | null
  readonly categoryLabel: string | null
  readonly reviewId: string | null
  readonly reviewStatus: "auto_applied" | "needs_review" | "approved" | "changed" | null
  readonly needsReview: boolean | null
  readonly originalTypeKey: string | null
  readonly currentTypeKey: string | null
  readonly categorizationReason: string | null
  readonly matchedLayer: string | null
  readonly userNotes: string | null
  readonly reviewedAt: Date | null
  readonly externalId: string | null
  readonly externalGroupId: string | null
  readonly providerTransactionType: string | null
  readonly providerStatus: string | null
  readonly providerDescription: string | null
  readonly transactionHash: string | null
  readonly onchainFeeAmount: string | null
  readonly onchainFeeCostBasisAmount: string | null
  readonly onchainFeeCostBasisCurrency: string | null
  readonly onchainFeePaidByPrincipal: boolean | null
  readonly sourceRawRecordId: string | null
}

interface LegRow {
  readonly transactionId: string | null
  readonly legId: string
  readonly sourceTransferId: string | null
  readonly timestamp: Date
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly kind: "acquisition" | "disposal" | "income" | "fee"
  readonly amount: string
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly provenance: "deterministic" | "rule" | "ai" | "manual"
  readonly derivationRule: string | null
  readonly inventoryMovementId: string | null
  readonly inventoryPurpose: "principal" | "fee" | "reward" | null
  readonly inventoryTaxTreatment: "taxable" | "non_taxable" | "pending_review" | null
  readonly inventoryReconciliationStatus: "unmatched" | "matched" | "needs_review" | null
}

interface CustodyRow {
  readonly transactionId: string
  readonly movementId: string
  readonly assetId: string
  readonly symbol: string
  readonly name: string
  readonly direction: "inbound" | "outbound"
  readonly purpose: "principal" | "fee" | "reward"
  readonly taxTreatment: "taxable" | "non_taxable" | "pending_review"
  readonly reconciliationStatus: "unmatched" | "matched" | "needs_review"
  readonly amount: string
}

interface MatchSummaryRow {
  readonly transactionId: string | null
  readonly legId: string
  readonly costBasisCurrency: string | null
  readonly costBasisComplete: boolean
  readonly matchedAmount: string
  readonly costBasis: string | null
  readonly hasTaxableLots: boolean
  readonly hasTaxFreeLots: boolean
}

interface MatchRow {
  readonly transactionId: string | null
  readonly legId: string
  readonly disposedAt: Date
  readonly lotId: string
  readonly acquiredAt: Date
  readonly costBasisCurrency: string
  readonly costBasisStatus: "pending_review" | "known"
  readonly matchedAmount: string
  readonly costBasis: string
  readonly proceeds: string
  readonly gainLoss: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const zero = BigDecimal.fromBigInt(0n)

const makeCursor = ({ generation, timestamp, id, scope }: CursorParts): string =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      generation: generation.toISOString(),
      timestamp: timestamp.toISOString(),
      id,
      scope,
    })
  ).toString("base64url")

const normalizeSearch = (search: string | null | undefined): string =>
  search?.trim().toLowerCase() ?? ""

const cursorScopeMatches = (left: CursorScope, right: CursorScope): boolean =>
  left.sourceId === right.sourceId &&
  left.search === right.search &&
  left.classificationKey === right.classificationKey &&
  left.categoryKey === right.categoryKey &&
  left.reviewState === right.reviewState

const parseCursor = (cursor: string | null) =>
  Effect.gen(function* () {
    if (cursor === null) {
      return Option.none<CursorParts>()
    }

    const decoded = yield* Effect.try({
      try: () => Buffer.from(cursor, "base64url").toString("utf8"),
      catch: () => new AccountingTransactionInvalidCursorError({ cursor }),
    })
    const payload = yield* Schema.decodeUnknown(EncodedCursorPayloadSchema)(decoded).pipe(
      Effect.mapError(() => new AccountingTransactionInvalidCursorError({ cursor }))
    )
    const generation = new Date(payload.generation)
    const timestamp = new Date(payload.timestamp)
    if (
      Number.isNaN(generation.getTime()) ||
      Number.isNaN(timestamp.getTime()) ||
      !uuidPattern.test(payload.id)
    ) {
      return yield* Effect.fail(new AccountingTransactionInvalidCursorError({ cursor }))
    }

    return Option.some({ generation, timestamp, id: payload.id, scope: payload.scope })
  })

const decodeDecimal = ({
  operation,
  value,
}: {
  readonly operation: string
  readonly value: string
}): Effect.Effect<BigDecimal.BigDecimal, PersistenceError> => {
  const parsed = BigDecimal.fromString(value)
  if (Option.isNone(parsed)) {
    return Effect.fail(
      new PersistenceError({ operation, cause: `Invalid database decimal: ${value}` })
    )
  }
  return Effect.succeed(parsed.value)
}

const formatDecimal = (value: BigDecimal.BigDecimal): string => BigDecimal.format(value)

const combineCurrency = (current: string | null, next: string | null): string | null => {
  if (next === null) return current
  if (current === null) return next
  return current === next ? current : "mixed"
}

const escapeSearchPattern = (value: string): string => value.replace(/[\\%_]/g, "\\$&")

const combineTreatments = (
  treatments: ReadonlyArray<AccountingTransactionTaxTreatment>
): AccountingTransactionTaxTreatment => {
  const values = new Set(treatments)
  if (values.size === 0) return "unknown"
  if (values.has("unknown")) return "unknown"
  if (values.size === 1) return treatments[0] ?? "unknown"
  return "mixed"
}

const lotTaxTreatment = ({ acquiredAt, disposedAt }: { acquiredAt: Date; disposedAt: Date }) => {
  const taxFreeAt = new Date(acquiredAt.getTime())
  taxFreeAt.setUTCFullYear(taxFreeAt.getUTCFullYear() + 1)
  return disposedAt.getTime() >= taxFreeAt.getTime() ? ("tax_free" as const) : ("taxable" as const)
}

const matchSummaryTaxTreatment = (summary: MatchSummaryRow): AccountingTransactionTaxTreatment => {
  if (summary.hasTaxableLots && summary.hasTaxFreeLots) return "mixed"
  if (summary.hasTaxFreeLots) return "tax_free"
  if (summary.hasTaxableLots) return "taxable"
  return "unknown"
}

const reviewState = (
  value: AccountingTransactionReviewState | null
): AccountingTransactionReviewState => value ?? "unreviewed"

const directionForKind = (
  kind: "acquisition" | "disposal" | "income" | "fee"
): "inbound" | "outbound" => (kind === "acquisition" || kind === "income" ? "inbound" : "outbound")

const asset = (row: {
  readonly assetId: string
  readonly symbol: string
  readonly name: string
}): AccountingTransactionAsset => ({
  assetId: row.assetId,
  symbol: row.symbol,
  name: row.name,
})

const groupByTransaction = <Row>(
  rows: ReadonlyArray<Row>,
  transactionId: (row: Row) => string | null
): Map<string, Array<Row>> => {
  const grouped = new Map<string, Array<Row>>()
  for (const row of rows) {
    const id = transactionId(row)
    if (id === null) continue
    const transactionRows = grouped.get(id) ?? []
    transactionRows.push(row)
    grouped.set(id, transactionRows)
  }
  return grouped
}

const indexMatchSummaries = (rows: ReadonlyArray<MatchSummaryRow>): Map<string, MatchSummaryRow> =>
  new Map(rows.map((row) => [row.legId, row]))

const movementFromLeg = (leg: LegRow): AccountingTransactionMovement => ({
  movementId: leg.inventoryMovementId ?? leg.legId,
  legId: leg.legId,
  asset: asset(leg),
  kind: leg.kind,
  direction: directionForKind(leg.kind),
  amount: String(leg.amount),
  fiatValue:
    leg.fiatAmount === null || leg.fiatCurrency === null
      ? null
      : { amount: String(leg.fiatAmount), currency: leg.fiatCurrency },
  derivation: { provenance: leg.provenance, rule: leg.derivationRule },
  custody:
    leg.inventoryMovementId === null ||
    leg.inventoryPurpose === null ||
    leg.inventoryTaxTreatment === null ||
    leg.inventoryReconciliationStatus === null
      ? null
      : {
          purpose: leg.inventoryPurpose,
          taxTreatment: leg.inventoryTaxTreatment,
          reconciliationStatus: leg.inventoryReconciliationStatus,
        },
})

const movementFromCustody = (movement: CustodyRow): AccountingTransactionMovement => ({
  movementId: movement.movementId,
  legId: null,
  asset: asset(movement),
  kind: "custody",
  direction: movement.direction,
  amount: String(movement.amount),
  fiatValue: null,
  derivation: null,
  custody: {
    purpose: movement.purpose,
    taxTreatment: movement.taxTreatment,
    reconciliationStatus: movement.reconciliationStatus,
  },
})

const assembleMovements = ({
  custodyRows,
  legRows,
}: {
  readonly custodyRows: ReadonlyArray<CustodyRow>
  readonly legRows: ReadonlyArray<LegRow>
}): ReadonlyArray<AccountingTransactionMovement> => [
  ...legRows.map(movementFromLeg),
  ...custodyRows.map(movementFromCustody),
]

const treatmentFromInventory = (
  treatment: "taxable" | "non_taxable" | "pending_review"
): AccountingTransactionTaxTreatment => (treatment === "pending_review" ? "unknown" : treatment)

const currencyForRows = (
  legRows: ReadonlyArray<LegRow>,
  summaries: ReadonlyArray<MatchSummaryRow>,
  onchainFeeCurrency: string | null
): string | null => {
  let currency: string | null = null
  for (const leg of legRows) currency = combineCurrency(currency, leg.fiatCurrency)
  for (const summary of summaries) currency = combineCurrency(currency, summary.costBasisCurrency)
  currency = combineCurrency(currency, onchainFeeCurrency)
  return currency
}

interface OnchainFeeEvidence {
  readonly amount: string | null
  readonly fiatAmount: string | null
  readonly fiatCurrency: string | null
  readonly paidByPrincipal: boolean
}

const hasOnchainFeeEvidence = (fee: OnchainFeeEvidence): boolean =>
  fee.paidByPrincipal &&
  (fee.amount !== null || fee.fiatAmount !== null || fee.fiatCurrency !== null)

const isFullyMatched = ({
  amount,
  matchedAmount,
  operation,
}: {
  readonly amount: string
  readonly matchedAmount: string | undefined
  readonly operation: string
}): Effect.Effect<boolean, PersistenceError> =>
  Effect.gen(function* () {
    const matched =
      matchedAmount === undefined
        ? zero
        : yield* decodeDecimal({ operation: `${operation}.matchedAmount`, value: matchedAmount })
    const total = yield* decodeDecimal({ operation: `${operation}.amount`, value: amount })
    return BigDecimal.equals(BigDecimal.abs(total), matched)
  })

const taxTreatmentForLeg = (
  leg: LegRow,
  summariesByLeg: ReadonlyMap<string, MatchSummaryRow>
): Effect.Effect<AccountingTransactionTaxTreatment, PersistenceError> => {
  if (leg.kind === "fee") return Effect.succeed("deductible")
  if (leg.kind === "income") return Effect.succeed("taxable")
  if (leg.kind === "acquisition") {
    return Effect.succeed(leg.derivationRule === "internal_transfer_in" ? "non_taxable" : "unknown")
  }
  if (leg.derivationRule === "internal_transfer_out") return Effect.succeed("non_taxable")

  const summary = summariesByLeg.get(leg.legId)
  return isFullyMatched({
    amount: String(leg.amount),
    matchedAmount: summary?.matchedAmount,
    operation: "accountingTransactionReadRepository.assemble.disposalTreatment",
  }).pipe(
    Effect.map((complete) =>
      complete && summary !== undefined ? matchSummaryTaxTreatment(summary) : "unknown"
    )
  )
}

interface LegTotals {
  readonly incomingValue: BigDecimal.BigDecimal
  readonly outgoingValue: BigDecimal.BigDecimal
  readonly fees: BigDecimal.BigDecimal
  readonly valueComplete: boolean
  readonly feeComplete: boolean
  readonly hasFee: boolean
  readonly treatments: ReadonlyArray<AccountingTransactionTaxTreatment>
}

const calculateLegTotals = ({
  currencyComplete,
  custodyRows,
  legRows,
  onchainFee,
  summariesByLeg,
  useOnchainFee,
}: {
  readonly currencyComplete: boolean
  readonly custodyRows: ReadonlyArray<CustodyRow>
  readonly legRows: ReadonlyArray<LegRow>
  readonly onchainFee: OnchainFeeEvidence
  readonly summariesByLeg: ReadonlyMap<string, MatchSummaryRow>
  readonly useOnchainFee: boolean
}): Effect.Effect<LegTotals, PersistenceError> =>
  Effect.gen(function* () {
    let incomingValue = zero
    let outgoingValue = zero
    let fees = zero
    let valueComplete = legRows.length > 0
    const hasUnvaluedCustodyFee = custodyRows.some((movement) => movement.purpose === "fee")
    let feeComplete = !hasUnvaluedCustodyFee
    let hasFee = hasUnvaluedCustodyFee
    const treatments: Array<AccountingTransactionTaxTreatment> = custodyRows.map((movement) =>
      treatmentFromInventory(movement.taxTreatment)
    )

    for (const leg of legRows) {
      if (leg.inventoryTaxTreatment !== null) {
        treatments.push(treatmentFromInventory(leg.inventoryTaxTreatment))
      }
      treatments.push(yield* taxTreatmentForLeg(leg, summariesByLeg))

      if (leg.kind === "fee") {
        hasFee = true
        if (leg.fiatAmount === null || leg.fiatCurrency === null || !currencyComplete) {
          feeComplete = false
        } else {
          const amountValue = yield* decodeDecimal({
            operation: "accountingTransactionReadRepository.assemble.fee",
            value: String(leg.fiatAmount),
          })
          fees = BigDecimal.sum(fees, BigDecimal.abs(amountValue))
        }
        continue
      }

      if (leg.fiatAmount === null || leg.fiatCurrency === null || !currencyComplete) {
        valueComplete = false
        continue
      }
      const amountValue = yield* decodeDecimal({
        operation: "accountingTransactionReadRepository.assemble.value",
        value: String(leg.fiatAmount),
      })
      if (directionForKind(leg.kind) === "inbound") {
        incomingValue = BigDecimal.sum(incomingValue, BigDecimal.abs(amountValue))
      } else {
        outgoingValue = BigDecimal.sum(outgoingValue, BigDecimal.abs(amountValue))
      }
    }

    if (useOnchainFee) {
      hasFee = true
      if (onchainFee.fiatAmount === null || onchainFee.fiatCurrency === null || !currencyComplete) {
        feeComplete = false
      } else {
        const amountValue = yield* decodeDecimal({
          operation: "accountingTransactionReadRepository.assemble.onchainFee",
          value: onchainFee.fiatAmount,
        })
        fees = BigDecimal.sum(fees, BigDecimal.abs(amountValue))
      }
    }

    return {
      incomingValue,
      outgoingValue,
      fees,
      valueComplete,
      feeComplete,
      hasFee,
      treatments,
    }
  })

interface DisposalTotals {
  readonly proceeds: BigDecimal.BigDecimal
  readonly costBasis: BigDecimal.BigDecimal
  readonly gainLoss: BigDecimal.BigDecimal
  readonly complete: boolean
  readonly valuationComplete: boolean
  readonly costBasisComplete: boolean
  readonly hasDisposals: boolean
}

const calculateDisposalTotals = ({
  currencyComplete,
  legRows,
  summariesByLeg,
}: {
  readonly currencyComplete: boolean
  readonly legRows: ReadonlyArray<LegRow>
  readonly summariesByLeg: ReadonlyMap<string, MatchSummaryRow>
}): Effect.Effect<DisposalTotals, PersistenceError> =>
  Effect.gen(function* () {
    const taxDisposalLegs = legRows.filter(
      (leg) => leg.kind === "disposal" && leg.derivationRule !== "internal_transfer_out"
    )
    let proceeds = zero
    let costBasis = zero

    let complete = true
    let valuationComplete = true
    let costBasisComplete = true
    for (const leg of taxDisposalLegs) {
      const summary = summariesByLeg.get(leg.legId)
      const legComplete = yield* isFullyMatched({
        amount: String(leg.amount),
        matchedAmount: summary?.matchedAmount,
        operation: "accountingTransactionReadRepository.assemble.disposal",
      })
      if (!legComplete) {
        complete = false
      }
      if (leg.fiatAmount === null || leg.fiatCurrency === null) {
        valuationComplete = false
      } else if (currencyComplete) {
        const legProceeds = yield* decodeDecimal({
          operation: "accountingTransactionReadRepository.assemble.proceeds",
          value: String(leg.fiatAmount),
        })
        proceeds = BigDecimal.sum(proceeds, BigDecimal.abs(legProceeds))
      }

      if (
        !legComplete ||
        summary === undefined ||
        !summary.costBasisComplete ||
        summary.costBasis === null
      ) {
        costBasisComplete = false
      } else if (currencyComplete) {
        const legCostBasis = yield* decodeDecimal({
          operation: "accountingTransactionReadRepository.assemble.costBasis",
          value: summary.costBasis,
        })
        costBasis = BigDecimal.sum(costBasis, legCostBasis)
      }
    }

    return {
      proceeds,
      costBasis,
      gainLoss: BigDecimal.subtract(proceeds, costBasis),
      complete,
      valuationComplete,
      costBasisComplete,
      hasDisposals: taxDisposalLegs.length > 0,
    }
  })

const calculateTotals = ({
  custodyRows,
  legRows,
  onchainFee,
  summaries,
  summariesByLeg,
}: {
  readonly custodyRows: ReadonlyArray<CustodyRow>
  readonly legRows: ReadonlyArray<LegRow>
  readonly onchainFee: OnchainFeeEvidence
  readonly summaries: ReadonlyArray<MatchSummaryRow>
  readonly summariesByLeg: ReadonlyMap<string, MatchSummaryRow>
}): Effect.Effect<AccountingTransactionTotals, PersistenceError> =>
  Effect.gen(function* () {
    const hasExplicitFee =
      legRows.some((leg) => leg.kind === "fee") ||
      custodyRows.some((movement) => movement.purpose === "fee")
    const useOnchainFee = !hasExplicitFee && hasOnchainFeeEvidence(onchainFee)
    const currency = currencyForRows(
      legRows,
      summaries,
      useOnchainFee ? onchainFee.fiatCurrency : null
    )
    const currencyComplete = currency !== "mixed"
    const [legTotals, disposalTotals] = yield* Effect.all([
      calculateLegTotals({
        currencyComplete,
        custodyRows,
        legRows,
        onchainFee,
        summariesByLeg,
        useOnchainFee,
      }),
      calculateDisposalTotals({ currencyComplete, legRows, summariesByLeg }),
    ])

    const hasSomeCalculation =
      legRows.some((leg) => leg.fiatAmount !== null && leg.fiatCurrency !== null) ||
      summaries.length > 0 ||
      (useOnchainFee && onchainFee.fiatAmount !== null && onchainFee.fiatCurrency !== null)
    const allCalculationsComplete =
      legTotals.valueComplete &&
      legTotals.feeComplete &&
      disposalTotals.complete &&
      disposalTotals.valuationComplete &&
      disposalTotals.costBasisComplete &&
      currencyComplete
    const calculationStatus: AccountingTransactionCalculationStatus =
      legRows.length === 0 || !hasSomeCalculation
        ? "pending"
        : allCalculationsComplete
          ? "complete"
          : "partial"
    const value = BigDecimal.greaterThan(legTotals.incomingValue, legTotals.outgoingValue)
      ? legTotals.incomingValue
      : legTotals.outgoingValue

    return {
      value: legTotals.valueComplete && currencyComplete ? formatDecimal(value) : null,
      fees: legTotals.hasFee
        ? legTotals.feeComplete && currencyComplete
          ? formatDecimal(legTotals.fees)
          : null
        : "0",
      proceeds:
        disposalTotals.hasDisposals && disposalTotals.valuationComplete && currencyComplete
          ? formatDecimal(disposalTotals.proceeds)
          : null,
      costBasis:
        disposalTotals.hasDisposals &&
        disposalTotals.complete &&
        disposalTotals.costBasisComplete &&
        currencyComplete
          ? formatDecimal(disposalTotals.costBasis)
          : null,
      gainLoss:
        disposalTotals.hasDisposals &&
        disposalTotals.complete &&
        disposalTotals.valuationComplete &&
        disposalTotals.costBasisComplete &&
        currencyComplete
          ? formatDecimal(disposalTotals.gainLoss)
          : null,
      currency,
      taxTreatment: combineTreatments(legTotals.treatments),
      calculationStatus,
    }
  })

const classificationFromBase = (row: BaseRow): AccountingTransactionClassification => ({
  key: row.classificationKey,
  label: row.classificationLabel,
  categoryKey: row.categoryKey,
  categoryLabel: row.categoryLabel,
  reviewState: reviewState(row.reviewStatus),
  needsReview: row.needsReview ?? false,
})

const assembleListItem = ({
  base,
  custodyRows,
  legRows,
  summaries,
  summariesByLeg,
}: {
  readonly base: BaseRow
  readonly custodyRows: ReadonlyArray<CustodyRow>
  readonly legRows: ReadonlyArray<LegRow>
  readonly summaries: ReadonlyArray<MatchSummaryRow>
  readonly summariesByLeg: ReadonlyMap<string, MatchSummaryRow>
}): Effect.Effect<AccountingTransactionListItem, PersistenceError> =>
  Effect.gen(function* () {
    const totals = yield* calculateTotals({
      custodyRows,
      legRows,
      onchainFee: {
        amount: base.onchainFeeAmount,
        fiatAmount: base.onchainFeeCostBasisAmount,
        fiatCurrency: base.onchainFeeCostBasisCurrency,
        paidByPrincipal: base.onchainFeePaidByPrincipal ?? false,
      },
      summaries,
      summariesByLeg,
    })
    return {
      transactionId: base.transactionId,
      timestamp: base.timestamp.toISOString(),
      classification: classificationFromBase(base),
      source: {
        sourceId: base.sourceId,
        name: base.sourceName,
        kind: base.sourceKind,
        provider: base.sourceProvider,
        displayReference: base.addressReference ?? base.accountReference,
      },
      movements: assembleMovements({ custodyRows, legRows }),
      totals,
      externalReferences: {
        externalId: base.externalId,
        externalGroupId: base.externalGroupId,
        providerTransactionType: base.providerTransactionType,
        providerStatus: base.providerStatus,
        providerDescription: base.providerDescription,
        transactionHash: base.transactionHash,
      },
    }
  })

const assembleDisposal = ({
  leg,
  matches,
  transactionCurrencyComplete,
}: {
  readonly leg: LegRow
  readonly matches: ReadonlyArray<MatchRow>
  readonly transactionCurrencyComplete: boolean
}): Effect.Effect<AccountingTransactionDisposal, PersistenceError> =>
  Effect.gen(function* () {
    const isInternalTransfer = leg.derivationRule === "internal_transfer_out"
    const valuationKnown = leg.fiatAmount !== null && leg.fiatCurrency !== null
    const costBasisComplete = matches.every((match) => match.costBasisStatus === "known")
    const matchCurrencies = new Set(
      matches
        .filter((match) => match.costBasisStatus === "known")
        .map((match) => match.costBasisCurrency)
    )
    const currencyComplete =
      transactionCurrencyComplete &&
      matchCurrencies.size <= 1 &&
      (leg.fiatCurrency === null ||
        matchCurrencies.size === 0 ||
        matchCurrencies.has(leg.fiatCurrency))
    const matchedLots: Array<AccountingTransactionMatchedLot> = matches.map((match) => ({
      lotId: match.lotId,
      acquiredAt: match.acquiredAt.toISOString(),
      matchedAmount: String(match.matchedAmount),
      costBasis:
        match.costBasisStatus === "known" && currencyComplete ? String(match.costBasis) : null,
      proceeds: valuationKnown && currencyComplete ? String(match.proceeds) : null,
      gainLoss:
        valuationKnown && match.costBasisStatus === "known" && currencyComplete
          ? String(match.gainLoss)
          : null,
      taxTreatment: isInternalTransfer
        ? "non_taxable"
        : lotTaxTreatment({ acquiredAt: match.acquiredAt, disposedAt: match.disposedAt }),
    }))
    const matchedAmount = yield* Effect.reduce(matches, zero, (total, match) =>
      decodeDecimal({
        operation: "accountingTransactionReadRepository.getById.matchedAmount",
        value: String(match.matchedAmount),
      }).pipe(Effect.map((amountValue) => BigDecimal.sum(total, amountValue)))
    )
    const complete = yield* isFullyMatched({
      amount: String(leg.amount),
      matchedAmount: formatDecimal(matchedAmount),
      operation: "accountingTransactionReadRepository.getById.disposal",
    })
    const costBasis = yield* Effect.reduce(matches, zero, (total, match) =>
      decodeDecimal({
        operation: "accountingTransactionReadRepository.getById.costBasis",
        value: String(match.costBasis),
      }).pipe(Effect.map((amountValue) => BigDecimal.sum(total, amountValue)))
    )
    const proceeds =
      valuationKnown && leg.fiatAmount !== null
        ? yield* decodeDecimal({
            operation: "accountingTransactionReadRepository.getById.proceeds",
            value: String(leg.fiatAmount),
          })
        : zero
    const gainLoss = BigDecimal.subtract(BigDecimal.abs(proceeds), costBasis)

    return {
      legId: leg.legId,
      asset: asset(leg),
      amount: String(leg.amount),
      disposedAt: leg.timestamp.toISOString(),
      proceeds:
        !valuationKnown || !currencyComplete ? null : formatDecimal(BigDecimal.abs(proceeds)),
      costBasis:
        !complete || matchedLots.length === 0 || !costBasisComplete || !currencyComplete
          ? null
          : formatDecimal(costBasis),
      gainLoss:
        !complete ||
        matchedLots.length === 0 ||
        !valuationKnown ||
        !costBasisComplete ||
        !currencyComplete
          ? null
          : formatDecimal(gainLoss),
      taxTreatment: isInternalTransfer
        ? "non_taxable"
        : complete
          ? combineTreatments(matchedLots.map((match) => match.taxTreatment))
          : "unknown",
      calculationStatus:
        complete &&
        matchedLots.length > 0 &&
        valuationKnown &&
        costBasisComplete &&
        currencyComplete
          ? "complete"
          : valuationKnown || matchedLots.length > 0
            ? "partial"
            : "pending",
      matchedLots,
    }
  })

const make = Effect.gen(function* () {
  const db = yield* drizzle
  type ReadTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

  const inReadTransaction = <A, E>(
    operation: string,
    effect: (tx: ReadTransaction) => Effect.Effect<A, E>
  ): Effect.Effect<A, E | PersistenceError> =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .setTransaction({ isolationLevel: "repeatable read", accessMode: "read only" })
            .pipe(wrapSqlError(`${operation}.snapshot`))
          return yield* effect(tx)
        })
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new PersistenceError({ operation, cause }))
        )
      )

  const assertOwnedSource = (tx: ReadTransaction, principalId: string, sourceId: string) =>
    Effect.gen(function* () {
      if (!uuidPattern.test(sourceId)) {
        return yield* Effect.fail(new AccountingTransactionNotFoundError({ resourceId: sourceId }))
      }

      const [owned] = yield* tx
        .select({ id: schema.sources.id })
        .from(schema.sources)
        .where(and(eq(schema.sources.id, sourceId), eq(schema.sources.principalId, principalId)))
        .limit(1)
        .pipe(wrapSqlError("accountingTransactionReadRepository.assertOwnedSource"))

      if (owned === undefined) {
        return yield* Effect.fail(new AccountingTransactionNotFoundError({ resourceId: sourceId }))
      }
    })

  const loadGeneration = (tx: ReadTransaction, principalId: string, sourceId: string | null) =>
    Effect.gen(function* () {
      const [row] = yield* tx
        .select({
          generation: sql<Date>`greatest(
              coalesce(
                max(greatest(
                  ${schema.sources.updatedAt},
                  coalesce(${schema.sourceSyncState.updatedAt}, ${schema.sources.updatedAt})
                )),
                timestamp '1970-01-01 00:00:00'
              ),
              coalesce(
                (
                  select max(review_generation.updated_at)
                  from ${schema.transactionReviews} review_generation
                  where review_generation.principal_id = ${principalId}
                    and (
                      cast(${sourceId} as uuid) is null
                      or exists (
                        select 1
                        from ${schema.transactions} reviewed_transaction
                        where reviewed_transaction.id = review_generation.transaction_id
                          and reviewed_transaction.source_id = cast(${sourceId} as uuid)
                      )
                    )
                ),
                timestamp '1970-01-01 00:00:00'
              ),
              coalesce(
                (
                  select max(transaction_generation.updated_at)
                  from ${schema.transactions} transaction_generation
                  where transaction_generation.principal_id = ${principalId}
                    and (
                      cast(${sourceId} as uuid) is null
                      or transaction_generation.source_id = cast(${sourceId} as uuid)
                    )
                ),
                timestamp '1970-01-01 00:00:00'
              ),
              coalesce(
                (
                  select max(reconciliation_generation.updated_at)
                  from ${schema.transferReconciliations} reconciliation_generation
                  where reconciliation_generation.principal_id = ${principalId}
                    and (
                      cast(${sourceId} as uuid) is null
                      or exists (
                        select 1
                        from ${schema.providerTransfers} reconciliation_provider_transfer
                        where reconciliation_provider_transfer.id = reconciliation_generation.provider_transfer_id
                          and reconciliation_provider_transfer.source_id = cast(${sourceId} as uuid)
                      )
                      or exists (
                        select 1
                        from ${schema.transactions} reconciliation_canonical_transaction
                        where reconciliation_canonical_transaction.id = reconciliation_generation.canonical_transaction_id
                          and reconciliation_canonical_transaction.source_id = cast(${sourceId} as uuid)
                      )
                      or exists (
                        select 1
                        from ${schema.transfers} reconciliation_canonical_transfer
                        where reconciliation_canonical_transfer.id = reconciliation_generation.canonical_transfer_id
                          and reconciliation_canonical_transfer.source_id = cast(${sourceId} as uuid)
                      )
                    )
                ),
                timestamp '1970-01-01 00:00:00'
              )
            )`.mapWith(schema.sources.updatedAt),
        })
        .from(schema.sources)
        .leftJoin(schema.sourceSyncState, eq(schema.sourceSyncState.sourceId, schema.sources.id))
        .where(
          and(
            eq(schema.sources.principalId, principalId),
            sourceId === null ? undefined : eq(schema.sources.id, sourceId)
          )
        )
        .pipe(wrapSqlError("accountingTransactionReadRepository.loadGeneration"))

      return row?.generation ?? new Date(0)
    })

  const onchainAddress = aliasedTable(schema.addresses, "transaction_onchain_address")

  const baseSelection = {
    transactionId: schema.transactions.id,
    timestamp: schema.transactions.timestamp,
    sourceId: schema.sources.id,
    sourceName: schema.sources.name,
    sourceKind: schema.sources.sourceableType,
    sourceProvider: schema.sources.providerKey,
    addressReference: schema.addresses.address,
    accountReference: schema.cexAccount.providerAccountId,
    classificationKey: sql<
      string | null
    >`coalesce(${schema.transactionReviews.currentTypeKey}, ${schema.transactions.transactionType})`,
    classificationLabel: schema.transactionTypes.labelEn,
    categoryKey: schema.transactionTypes.categoryKey,
    categoryLabel: schema.transactionCategories.nameEn,
    reviewId: schema.transactionReviews.id,
    reviewStatus: schema.transactionReviews.reviewStatus,
    needsReview: schema.transactionReviews.needsReview,
    originalTypeKey: schema.transactionReviews.originalTypeKey,
    currentTypeKey: schema.transactionReviews.currentTypeKey,
    categorizationReason: schema.transactionReviews.categorizationReason,
    matchedLayer: schema.transactionReviews.matchedLayer,
    userNotes: schema.transactionReviews.userNotes,
    reviewedAt: schema.transactionReviews.reviewedAt,
    externalId: schema.transactions.externalId,
    externalGroupId: schema.transactions.externalGroupId,
    providerTransactionType: schema.transactions.providerTransactionType,
    providerStatus: schema.transactions.providerStatus,
    providerDescription: schema.transactions.providerDescription,
    transactionHash: schema.transactionOnchainContext.chainTxId,
    onchainFeeAmount: schema.transactionOnchainContext.feeAmount,
    onchainFeeCostBasisAmount: schema.transactionOnchainContext.feeCostBasisAmount,
    onchainFeeCostBasisCurrency: schema.transactionOnchainContext.feeCostBasisCurrency,
    onchainFeePaidByPrincipal: sql<boolean | null>`
      case
        when ${schema.transactionOnchainContext.transactionId} is null then null
        when ${onchainAddress.type} = 'evm'
          then lower(${schema.transactionOnchainContext.fromAddress}) = lower(${onchainAddress.address})
        else ${schema.transactionOnchainContext.fromAddress} = ${onchainAddress.address}
      end
    `,
    sourceRawRecordId: schema.transactions.sourceRawRecordId,
  } as const

  const baseQuery = (tx: ReadTransaction) =>
    tx
      .select(baseSelection)
      .from(schema.transactions)
      .innerJoin(schema.sources, eq(schema.transactions.sourceId, schema.sources.id))
      .leftJoin(schema.addresses, eq(schema.sources.addressId, schema.addresses.id))
      .leftJoin(schema.cexAccount, eq(schema.sources.cexAccountId, schema.cexAccount.id))
      .leftJoin(
        schema.transactionReviews,
        and(
          eq(schema.transactionReviews.transactionId, schema.transactions.id),
          eq(schema.transactionReviews.principalId, schema.transactions.principalId)
        )
      )
      .leftJoin(
        schema.transactionTypes,
        eq(
          schema.transactionTypes.typeKey,
          sql<string>`coalesce(${schema.transactionReviews.currentTypeKey}, ${schema.transactions.transactionType})`
        )
      )
      .leftJoin(
        schema.transactionCategories,
        eq(schema.transactionTypes.categoryKey, schema.transactionCategories.categoryKey)
      )
      .leftJoin(
        schema.transactionOnchainContext,
        eq(schema.transactions.id, schema.transactionOnchainContext.transactionId)
      )
      .leftJoin(onchainAddress, eq(schema.transactionOnchainContext.addressId, onchainAddress.id))

  const loadLegs = (tx: ReadTransaction, transactionIds: ReadonlyArray<string>) =>
    transactionIds.length === 0
      ? Effect.succeed([])
      : tx
          .select({
            transactionId: schema.transactionLegs.transactionId,
            legId: schema.transactionLegs.id,
            sourceTransferId: schema.transactionLegs.sourceTransferId,
            timestamp: schema.transactionLegs.timestamp,
            assetId: schema.assets.id,
            symbol: schema.assets.symbol,
            name: schema.assets.name,
            kind: schema.transactionLegs.kind,
            amount: schema.transactionLegs.amount,
            fiatAmount: schema.transactionLegs.fiatAmount,
            fiatCurrency: schema.transactionLegs.fiatCurrency,
            provenance: schema.transactionLegs.provenance,
            derivationRule: schema.transactionLegs.derivationRule,
            inventoryMovementId: schema.inventoryMovements.id,
            inventoryPurpose: schema.inventoryMovements.purpose,
            inventoryTaxTreatment: schema.inventoryMovements.taxTreatment,
            inventoryReconciliationStatus: schema.inventoryMovements.reconciliationStatus,
          })
          .from(schema.transactionLegs)
          .innerJoin(schema.assets, eq(schema.transactionLegs.assetId, schema.assets.id))
          .leftJoin(
            schema.inventoryMovements,
            eq(schema.inventoryMovements.transactionLegId, schema.transactionLegs.id)
          )
          .where(inArray(schema.transactionLegs.transactionId, [...transactionIds]))
          .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
          .pipe(wrapSqlError("accountingTransactionReadRepository.loadLegs"))

  const loadCustodyMovements = (tx: ReadTransaction, transactionIds: ReadonlyArray<string>) =>
    transactionIds.length === 0
      ? Effect.succeed([])
      : tx
          .select({
            transactionId: schema.inventoryMovements.transactionId,
            movementId: schema.inventoryMovements.id,
            assetId: schema.assets.id,
            symbol: schema.assets.symbol,
            name: schema.assets.name,
            direction: schema.inventoryMovements.direction,
            purpose: schema.inventoryMovements.purpose,
            taxTreatment: schema.inventoryMovements.taxTreatment,
            reconciliationStatus: schema.inventoryMovements.reconciliationStatus,
            amount: schema.inventoryMovements.amount,
          })
          .from(schema.inventoryMovements)
          .innerJoin(schema.assets, eq(schema.inventoryMovements.assetId, schema.assets.id))
          .where(
            and(
              inArray(schema.inventoryMovements.transactionId, [...transactionIds]),
              isNull(schema.inventoryMovements.transactionLegId)
            )
          )
          .orderBy(asc(schema.inventoryMovements.timestamp), asc(schema.inventoryMovements.id))
          .pipe(wrapSqlError("accountingTransactionReadRepository.loadCustodyMovements"))

  const loadMatches = (tx: ReadTransaction, transactionIds: ReadonlyArray<string>) =>
    transactionIds.length === 0
      ? Effect.succeed([])
      : tx
          .select({
            transactionId: schema.transactionLegs.transactionId,
            legId: schema.transactionLegs.id,
            disposedAt: schema.transactionLegs.timestamp,
            lotId: schema.fifoLots.id,
            acquiredAt: schema.fifoLots.acquiredAt,
            costBasisCurrency: schema.fifoLots.costBasisCurrency,
            costBasisStatus: schema.fifoLots.costBasisStatus,
            matchedAmount: schema.disposalMatches.matchedAmount,
            costBasis: schema.disposalMatches.costBasis,
            proceeds: schema.disposalMatches.proceeds,
            gainLoss: schema.disposalMatches.gainLoss,
          })
          .from(schema.disposalMatches)
          .innerJoin(
            schema.transactionLegs,
            eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
          )
          .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
          .where(inArray(schema.transactionLegs.transactionId, [...transactionIds]))
          .orderBy(asc(schema.fifoLots.acquiredAt), asc(schema.fifoLots.id))
          .pipe(wrapSqlError("accountingTransactionReadRepository.loadMatches"))

  const loadMatchSummaries = (tx: ReadTransaction, transactionIds: ReadonlyArray<string>) => {
    const taxFreeAt = sql`(
      date_trunc('month', ${schema.fifoLots.acquiredAt}) + interval '1 year'
      + (extract(day from ${schema.fifoLots.acquiredAt}) - 1) * interval '1 day'
      + (${schema.fifoLots.acquiredAt} - date_trunc('day', ${schema.fifoLots.acquiredAt}))
    )`

    return transactionIds.length === 0
      ? Effect.succeed([])
      : tx
          .select({
            transactionId: schema.transactionLegs.transactionId,
            legId: schema.transactionLegs.id,
            costBasisCurrency: sql<string | null>`case
              when count(*) filter (where ${schema.fifoLots.costBasisStatus} = 'known') = 0
                then null
              when count(distinct ${schema.fifoLots.costBasisCurrency}) filter (
                where ${schema.fifoLots.costBasisStatus} = 'known'
              ) = 1
                then min(${schema.fifoLots.costBasisCurrency}) filter (
                  where ${schema.fifoLots.costBasisStatus} = 'known'
                )
              else 'mixed'
            end`,
            costBasisComplete: sql<boolean>`bool_and(${schema.fifoLots.costBasisStatus} = 'known')`,
            matchedAmount: sql<string>`sum(${schema.disposalMatches.matchedAmount})`,
            costBasis: sql<string | null>`case
              when bool_and(${schema.fifoLots.costBasisStatus} = 'known')
                and count(distinct ${schema.fifoLots.costBasisCurrency}) = 1
                then sum(${schema.disposalMatches.costBasis})
              else null
            end`,
            hasTaxableLots: sql<boolean>`bool_or(
              ${schema.transactionLegs.timestamp} < ${taxFreeAt}
            )`,
            hasTaxFreeLots: sql<boolean>`bool_or(
              ${schema.transactionLegs.timestamp} >= ${taxFreeAt}
            )`,
          })
          .from(schema.disposalMatches)
          .innerJoin(
            schema.transactionLegs,
            eq(schema.disposalMatches.disposalLegId, schema.transactionLegs.id)
          )
          .innerJoin(schema.fifoLots, eq(schema.disposalMatches.fifoLotId, schema.fifoLots.id))
          .where(inArray(schema.transactionLegs.transactionId, [...transactionIds]))
          .groupBy(schema.transactionLegs.transactionId, schema.transactionLegs.id)
          .orderBy(asc(schema.transactionLegs.id))
          .pipe(wrapSqlError("accountingTransactionReadRepository.loadMatchSummaries"))
  }

  const assemble = ({
    baseRows,
    custodyRows,
    legRows,
    matchSummaryRows,
  }: {
    readonly baseRows: ReadonlyArray<BaseRow>
    readonly custodyRows: ReadonlyArray<CustodyRow>
    readonly legRows: ReadonlyArray<LegRow>
    readonly matchSummaryRows: ReadonlyArray<MatchSummaryRow>
  }) =>
    Effect.gen(function* () {
      const legsByTransaction = groupByTransaction(legRows, (row) => row.transactionId)
      const custodyByTransaction = groupByTransaction(custodyRows, (row) => row.transactionId)
      const summariesByTransaction = groupByTransaction(
        matchSummaryRows,
        (row) => row.transactionId
      )
      const summariesByLeg = indexMatchSummaries(matchSummaryRows)

      return yield* Effect.forEach(baseRows, (base) =>
        assembleListItem({
          base,
          legRows: legsByTransaction.get(base.transactionId) ?? [],
          custodyRows: custodyByTransaction.get(base.transactionId) ?? [],
          summaries: summariesByTransaction.get(base.transactionId) ?? [],
          summariesByLeg,
        })
      )
    })

  const list: AccountingTransactionReadRepositoryService["list"] = (params) =>
    inReadTransaction("accountingTransactionReadRepository.list", (tx) =>
      Effect.gen(function* () {
        if (params.sourceId !== null)
          yield* assertOwnedSource(tx, params.principalId, params.sourceId)
        const normalizedSearch = normalizeSearch(params.search)
        const scope: CursorScope = {
          sourceId: params.sourceId,
          search: normalizedSearch,
          classificationKey: params.classificationKey,
          categoryKey: params.categoryKey,
          reviewState: params.reviewState,
        }
        const cursor = yield* parseCursor(params.cursor)
        const generation = yield* loadGeneration(tx, params.principalId, params.sourceId)
        if (
          Option.isSome(cursor) &&
          (cursor.value.generation.getTime() !== generation.getTime() ||
            !cursorScopeMatches(cursor.value.scope, scope))
        ) {
          return yield* Effect.fail(
            new AccountingTransactionInvalidCursorError({ cursor: params.cursor ?? "" })
          )
        }
        const cursorCondition = Option.match(cursor, {
          onNone: (): SQL | undefined => undefined,
          onSome: (value) =>
            or(
              lt(schema.transactions.timestamp, value.timestamp),
              and(
                eq(schema.transactions.timestamp, value.timestamp),
                lt(schema.transactions.id, value.id)
              )
            ),
        })
        const searchPattern = `%${escapeSearchPattern(normalizedSearch)}%`
        const searchCondition =
          normalizedSearch === ""
            ? undefined
            : or(
                ilike(schema.transactions.externalId, searchPattern),
                ilike(schema.transactions.externalGroupId, searchPattern),
                ilike(schema.transactions.providerDescription, searchPattern),
                ilike(schema.sources.name, searchPattern),
                ilike(schema.transactionTypes.typeKey, searchPattern),
                ilike(schema.transactionTypes.labelEn, searchPattern),
                ilike(schema.transactionOnchainContext.chainTxId, searchPattern),
                sql<boolean>`exists (
                select 1 from transaction_legs search_leg
                inner join assets search_asset on search_asset.id = search_leg.asset_id
                where search_leg.transaction_id = ${schema.transactions.id}
                  and search_asset.symbol ilike ${searchPattern}
              )`
              )
        const reviewCondition =
          params.reviewState === null
            ? undefined
            : params.reviewState === "unreviewed"
              ? isNull(schema.transactionReviews.id)
              : eq(schema.transactionReviews.reviewStatus, params.reviewState)

        const rows = yield* baseQuery(tx)
          .where(
            and(
              eq(schema.transactions.principalId, params.principalId),
              eq(schema.sources.principalId, params.principalId),
              params.sourceId === null
                ? undefined
                : eq(schema.transactions.sourceId, params.sourceId),
              cursorCondition,
              searchCondition,
              params.classificationKey === null
                ? undefined
                : sql<boolean>`coalesce(${schema.transactionReviews.currentTypeKey}, ${schema.transactions.transactionType}) = ${params.classificationKey}`,
              params.categoryKey === null
                ? undefined
                : eq(schema.transactionTypes.categoryKey, params.categoryKey),
              reviewCondition
            )
          )
          .orderBy(desc(schema.transactions.timestamp), desc(schema.transactions.id))
          .limit(params.limit + 1)
          .pipe(wrapSqlError("accountingTransactionReadRepository.list.transactions"))

        const pageRows = rows.slice(0, params.limit)
        const transactionIds = pageRows.map((row) => row.transactionId)
        const [legRows, custodyRows, matchSummaryRows] = yield* Effect.all(
          [
            loadLegs(tx, transactionIds),
            loadCustodyMovements(tx, transactionIds),
            loadMatchSummaries(tx, transactionIds),
          ],
          { concurrency: 1 }
        )
        const items = yield* assemble({
          baseRows: pageRows,
          legRows,
          custodyRows,
          matchSummaryRows,
        })
        const last = pageRows.at(-1)
        const hasMore = rows.length > params.limit
        return {
          items,
          hasMore,
          nextCursor:
            hasMore && last !== undefined
              ? makeCursor({
                  generation,
                  timestamp: last.timestamp,
                  id: last.transactionId,
                  scope,
                })
              : null,
        } satisfies AccountingTransactionPage
      })
    )

  const loadVenueEvidence = (tx: ReadTransaction, transactionId: string) =>
    tx
      .select({
        venueType: schema.transactionVenueContext.venueType,
        externalAccountId: schema.transactionVenueContext.externalAccountId,
        externalOrderId: schema.transactionVenueContext.externalOrderId,
        externalFillId: schema.transactionVenueContext.externalFillId,
        side: schema.transactionVenueContext.side,
        instrument: schema.transactionVenueContext.instrument,
        fillPrice: schema.transactionVenueContext.fillPrice,
        commissionAmount: schema.transactionVenueContext.commissionAmount,
        commissionCurrency: schema.transactionVenueContext.commissionCurrency,
      })
      .from(schema.transactionVenueContext)
      .where(eq(schema.transactionVenueContext.transactionId, transactionId))
      .limit(1)
      .pipe(wrapSqlError("accountingTransactionReadRepository.getById.venue"))

  const loadOnchainEvidence = (tx: ReadTransaction, transactionId: string) =>
    tx
      .select({
        blockchain: schema.blockchains.name,
        chainType: schema.blockchains.chainType,
        explorerUrl: schema.blockchains.explorerUrl,
        transactionHash: schema.transactionOnchainContext.chainTxId,
        blockHeight: schema.transactionOnchainContext.blockHeight,
        blockHash: schema.transactionOnchainContext.blockHash,
        fromAddress: schema.transactionOnchainContext.fromAddress,
        toAddress: schema.transactionOnchainContext.toAddress,
        functionName: schema.transactionOnchainContext.functionName,
        failed: schema.transactionOnchainContext.isError,
        feeAmount: schema.transactionOnchainContext.feeAmount,
        feeAssetSymbol: schema.assets.symbol,
        feeCostBasisAmount: schema.transactionOnchainContext.feeCostBasisAmount,
        feeCostBasisCurrency: schema.transactionOnchainContext.feeCostBasisCurrency,
      })
      .from(schema.transactionOnchainContext)
      .innerJoin(
        schema.blockchains,
        eq(schema.transactionOnchainContext.blockchainId, schema.blockchains.id)
      )
      .leftJoin(schema.assets, eq(schema.transactionOnchainContext.feeAssetId, schema.assets.id))
      .where(eq(schema.transactionOnchainContext.transactionId, transactionId))
      .limit(1)
      .pipe(wrapSqlError("accountingTransactionReadRepository.getById.onchain"))

  const loadProviderEvidence = (
    tx: ReadTransaction,
    sourceId: string,
    sourceRawRecordId: string | null
  ) =>
    sourceRawRecordId === null
      ? Effect.succeed([])
      : tx
          .select({
            provider: schema.sourceRecordsRaw.provider,
            recordType: schema.sourceRecordsRaw.recordType,
            externalRecordId: schema.sourceRecordsRaw.externalRecordId,
            externalParentId: schema.sourceRecordsRaw.externalParentId,
            externalAccountId: schema.sourceRecordsRaw.externalAccountId,
            occurredAt: schema.sourceRecordsRaw.occurredAt,
          })
          .from(schema.sourceRecordsRaw)
          .where(
            and(
              eq(schema.sourceRecordsRaw.id, sourceRawRecordId),
              eq(schema.sourceRecordsRaw.sourceId, sourceId)
            )
          )
          .limit(1)
          .pipe(wrapSqlError("accountingTransactionReadRepository.getById.providerEvidence"))

  const loadReconciliations = ({
    principalId,
    sourceTransferIds,
    transactionId,
    tx,
  }: {
    readonly principalId: string
    readonly sourceTransferIds: ReadonlyArray<string>
    readonly transactionId: string
    readonly tx: ReadTransaction
  }) =>
    tx
      .select({
        reconciliationId: schema.transferReconciliations.id,
        providerTransferId: schema.transferReconciliations.providerTransferId,
        canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
        canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
        status: schema.transferReconciliations.status,
        reason: schema.transferReconciliations.matchReason,
        confidence: schema.transferReconciliations.confidence,
        deterministic: schema.transferReconciliations.deterministic,
      })
      .from(schema.transferReconciliations)
      .where(
        and(
          eq(schema.transferReconciliations.principalId, principalId),
          or(
            eq(schema.transferReconciliations.canonicalTransactionId, transactionId),
            sourceTransferIds.length === 0
              ? undefined
              : inArray(schema.transferReconciliations.canonicalTransferId, [...sourceTransferIds]),
            sql<boolean>`exists (
              select 1
              from provider_transfers reconciliation_provider_transfer
              inner join sources reconciliation_source
                on reconciliation_source.id = reconciliation_provider_transfer.source_id
              where reconciliation_provider_transfer.id =
                ${schema.transferReconciliations.providerTransferId}
                and reconciliation_provider_transfer.transaction_id = ${transactionId}
                and reconciliation_source.principal_id = ${principalId}
            )`
          )
        )
      )
      .orderBy(
        asc(schema.transferReconciliations.createdAt),
        asc(schema.transferReconciliations.id)
      )
      .pipe(wrapSqlError("accountingTransactionReadRepository.getById.reconciliations"))

  const loadCanonicalTransfers = ({
    principalId,
    transferIds,
    tx,
  }: {
    readonly principalId: string
    readonly transferIds: ReadonlyArray<string>
    readonly tx: ReadTransaction
  }) =>
    transferIds.length === 0
      ? Effect.succeed([])
      : tx
          .select({
            transferId: schema.transfers.id,
            type: schema.transfers.type,
            transactionHash: schema.transfers.txHash,
            fromAddress: schema.transfers.fromAddress,
            fromAccountRef: schema.transfers.fromAccountRef,
            toAddress: schema.transfers.toAddress,
            toAccountRef: schema.transfers.toAccountRef,
            assetId: schema.assets.id,
            symbol: schema.assets.symbol,
            name: schema.assets.name,
            amount: schema.transfers.amount,
          })
          .from(schema.transfers)
          .innerJoin(schema.assets, eq(schema.transfers.assetId, schema.assets.id))
          .where(
            and(
              inArray(schema.transfers.id, [...transferIds]),
              eq(schema.transfers.principalId, principalId)
            )
          )
          .orderBy(asc(schema.transfers.timestamp), asc(schema.transfers.id))
          .pipe(wrapSqlError("accountingTransactionReadRepository.getById.canonicalTransfers"))

  const loadProviderTransfers = ({
    principalId,
    reconciledProviderTransferIds,
    transactionId,
    tx,
  }: {
    readonly principalId: string
    readonly reconciledProviderTransferIds: ReadonlyArray<string>
    readonly transactionId: string
    readonly tx: ReadTransaction
  }) =>
    tx
      .select({
        providerTransferId: schema.providerTransfers.id,
        externalId: schema.providerTransfers.externalId,
        direction: schema.providerTransfers.direction,
        assetCode: schema.providerAssets.currencyCode,
        amount: schema.providerTransfers.amount,
        fromAddress: schema.providerTransfers.fromAddress,
        fromAccountRef: schema.providerTransfers.fromAccountRef,
        toAddress: schema.providerTransfers.toAddress,
        toAccountRef: schema.providerTransfers.toAccountRef,
        networkName: schema.providerTransfers.networkName,
        networkHash: schema.providerTransfers.networkHash,
      })
      .from(schema.providerTransfers)
      .innerJoin(schema.sources, eq(schema.providerTransfers.sourceId, schema.sources.id))
      .leftJoin(
        schema.providerAssets,
        eq(schema.providerTransfers.providerAssetId, schema.providerAssets.id)
      )
      .where(
        and(
          eq(schema.sources.principalId, principalId),
          reconciledProviderTransferIds.length === 0
            ? eq(schema.providerTransfers.transactionId, transactionId)
            : or(
                eq(schema.providerTransfers.transactionId, transactionId),
                inArray(schema.providerTransfers.id, [...reconciledProviderTransferIds])
              )
        )
      )
      .orderBy(asc(schema.providerTransfers.timestamp), asc(schema.providerTransfers.id))
      .pipe(wrapSqlError("accountingTransactionReadRepository.getById.providerTransfers"))

  const getById: AccountingTransactionReadRepositoryService["getById"] = (params) =>
    inReadTransaction("accountingTransactionReadRepository.getById", (tx) =>
      Effect.gen(function* () {
        if (!uuidPattern.test(params.transactionId)) {
          return yield* Effect.fail(
            new AccountingTransactionNotFoundError({ resourceId: params.transactionId })
          )
        }

        const [base] = yield* baseQuery(tx)
          .where(
            and(
              eq(schema.transactions.id, params.transactionId),
              eq(schema.transactions.principalId, params.principalId),
              eq(schema.sources.principalId, params.principalId)
            )
          )
          .limit(1)
          .pipe(wrapSqlError("accountingTransactionReadRepository.getById.transaction"))

        if (base === undefined) {
          return yield* Effect.fail(
            new AccountingTransactionNotFoundError({ resourceId: params.transactionId })
          )
        }

        const transactionIds = [params.transactionId]
        const [
          legRows,
          custodyRows,
          matchRows,
          matchSummaryRows,
          venueRows,
          onchainRows,
          providerEvidenceRows,
        ] = yield* Effect.all(
          [
            loadLegs(tx, transactionIds),
            loadCustodyMovements(tx, transactionIds),
            loadMatches(tx, transactionIds),
            loadMatchSummaries(tx, transactionIds),
            loadVenueEvidence(tx, params.transactionId),
            loadOnchainEvidence(tx, params.transactionId),
            loadProviderEvidence(tx, base.sourceId, base.sourceRawRecordId),
          ],
          { concurrency: 1 }
        )

        const [item] = yield* assemble({
          baseRows: [base],
          legRows,
          custodyRows,
          matchSummaryRows,
        })
        if (item === undefined) {
          return yield* Effect.fail(
            new AccountingTransactionNotFoundError({ resourceId: params.transactionId })
          )
        }

        const sourceTransferIds = legRows.flatMap((leg) =>
          leg.sourceTransferId === null ? [] : [leg.sourceTransferId]
        )
        const reconciliationRows = yield* loadReconciliations({
          tx,
          principalId: params.principalId,
          transactionId: params.transactionId,
          sourceTransferIds,
        })

        const reconciliationTransferIds = reconciliationRows.flatMap((reconciliation) =>
          reconciliation.canonicalTransferId === null ? [] : [reconciliation.canonicalTransferId]
        )
        const canonicalTransferIds = [
          ...new Set([...sourceTransferIds, ...reconciliationTransferIds]),
        ]
        const canonicalTransferRows = yield* loadCanonicalTransfers({
          tx,
          principalId: params.principalId,
          transferIds: canonicalTransferIds,
        })

        const reconciledProviderTransferIds = reconciliationRows.map(
          (reconciliation) => reconciliation.providerTransferId
        )
        const providerTransferRows = yield* loadProviderTransfers({
          tx,
          principalId: params.principalId,
          transactionId: params.transactionId,
          reconciledProviderTransferIds,
        })

        const matchesByLeg = new Map<string, Array<MatchRow>>()
        for (const match of matchRows) {
          const matches = matchesByLeg.get(match.legId) ?? []
          matches.push(match)
          matchesByLeg.set(match.legId, matches)
        }
        const disposals = yield* Effect.forEach(
          legRows.filter((candidate) => candidate.kind === "disposal"),
          (leg) =>
            assembleDisposal({
              leg,
              matches: matchesByLeg.get(leg.legId) ?? [],
              transactionCurrencyComplete: item.totals.currency !== "mixed",
            })
        )

        const venue = venueRows[0]
        const onchain = onchainRows[0]
        const providerEvidence = providerEvidenceRows[0]
        return {
          ...item,
          disposals,
          canonicalTransfers: canonicalTransferRows.map((transfer) => ({
            transferId: transfer.transferId,
            type: transfer.type,
            transactionHash: transfer.transactionHash,
            from: transfer.fromAddress ?? transfer.fromAccountRef,
            to: transfer.toAddress ?? transfer.toAccountRef,
            asset: asset(transfer),
            amount: String(transfer.amount),
          })),
          providerTransfers: providerTransferRows.map((transfer) => ({
            providerTransferId: transfer.providerTransferId,
            externalId: transfer.externalId,
            direction: transfer.direction,
            assetCode: transfer.assetCode,
            amount: String(transfer.amount),
            from: transfer.fromAddress ?? transfer.fromAccountRef,
            to: transfer.toAddress ?? transfer.toAccountRef,
            network: transfer.networkName,
            networkHash: transfer.networkHash,
          })),
          reconciliations: reconciliationRows.map((reconciliation) => ({
            ...reconciliation,
            confidence: String(reconciliation.confidence),
          })),
          venue:
            venue === undefined
              ? null
              : {
                  type: venue.venueType,
                  accountReference: venue.externalAccountId,
                  orderId: venue.externalOrderId,
                  fillId: venue.externalFillId,
                  side: venue.side,
                  instrument: venue.instrument,
                  fillPrice: venue.fillPrice === null ? null : String(venue.fillPrice),
                  commissionAmount:
                    venue.commissionAmount === null ? null : String(venue.commissionAmount),
                  commissionCurrency: venue.commissionCurrency,
                },
          onchain:
            onchain === undefined
              ? null
              : {
                  blockchain: onchain.blockchain,
                  chainType: onchain.chainType,
                  explorerUrl: onchain.explorerUrl,
                  transactionHash: onchain.transactionHash,
                  blockHeight: onchain.blockHeight === null ? null : String(onchain.blockHeight),
                  blockHash: onchain.blockHash,
                  fromAddress: onchain.fromAddress,
                  toAddress: onchain.toAddress,
                  functionName: onchain.functionName,
                  failed: onchain.failed,
                  feeAmount: onchain.feeAmount === null ? null : String(onchain.feeAmount),
                  feeAssetSymbol: onchain.feeAssetSymbol,
                  feeFiatValue:
                    onchain.feeCostBasisAmount === null || onchain.feeCostBasisCurrency === null
                      ? null
                      : {
                          amount: String(onchain.feeCostBasisAmount),
                          currency: onchain.feeCostBasisCurrency,
                        },
                },
          providerEvidence:
            providerEvidence === undefined
              ? null
              : {
                  ...providerEvidence,
                  occurredAt: providerEvidence.occurredAt.toISOString(),
                },
          classificationExplanation:
            base.reviewId === null
              ? null
              : {
                  originalKey: base.originalTypeKey,
                  currentKey: base.currentTypeKey,
                  reason: base.categorizationReason,
                  matchedLayer: base.matchedLayer,
                  userNotes: base.userNotes,
                  reviewedAt: base.reviewedAt === null ? null : base.reviewedAt.toISOString(),
                },
        } satisfies AccountingTransactionDetail
      })
    )

  return AccountingTransactionReadRepository.of({ list, getById })
})

/** Live layer for bounded accounting transaction list and detail reads. */
export const AccountingTransactionReadRepositoryLive = Layer.effect(
  AccountingTransactionReadRepository,
  make
)
