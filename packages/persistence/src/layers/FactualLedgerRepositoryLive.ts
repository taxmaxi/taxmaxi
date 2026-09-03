/**
 * FactualLedgerRepositoryLive - Drizzle-backed factual-ledger adapter.
 *
 * @module FactualLedgerRepositoryLive
 */

import {
  AcquisitionEvent,
  AccountingEventId,
  CustodyUnitId,
  CustodyMovementEvent,
  DispositionEvent,
  MarketQuoteFact,
  ObservedConsiderationFact,
  type AcquisitionCause,
  type AccountingEvent,
  type DispositionCause,
  type ValuationFact,
} from "@my/core/accounting"
import type { PrincipalAssetEffectiveDecision } from "@my/core/assets"
import { CURRENCIES_BY_CODE, type CurrencyCode } from "@my/core/currency"
import { SourceId } from "@my/core/source"
import { aliasedTable, and, asc, eq, inArray, or, sql } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { PersistenceError, wrapSqlError } from "../errors/RepositoryError.ts"
import { schema } from "../schema/index.ts"
import {
  FactualLedgerRepository,
  type FactualLedgerRepositoryShape,
  type FactualLedgerInputBlocker,
} from "../services/FactualLedgerRepository.ts"
import { drizzle } from "./PgClientLive.ts"
import {
  makePrincipalAssetOverrideDecisionLoader,
  representationTargetDecisionKey,
  type PrincipalAssetOverrideDecisions,
  type PrincipalProviderAssetDecision,
  resolvePrincipalAssetId,
  resolveSystemAssetId,
} from "./PrincipalAssetOverrideDecisionLoader.ts"

const EXCHANGE_TYPES = new Set([
  "buy_fiat",
  "sell_fiat",
  "swap_crypto_to_crypto",
  "trade_other",
  "nft_buy",
  "nft_sell",
])

const ProviderAssetLegMetadata = Schema.Struct({
  providerAssetRowId: Schema.String.check(Schema.isUUID()),
})

const PROVIDER_ASSET_REVIEW_LAYER = "provider_asset_mapping"

const providerAssetRowIdFromMetadata = (metadata: unknown): string | null =>
  Option.getOrNull(
    Option.map(Schema.decodeUnknownOption(ProviderAssetLegMetadata)(metadata), (row) =>
      String(row.providerAssetRowId)
    )
  )

const observedOverrideTargetMatch = (
  value: string | null
): { readonly providerAssetRowId: string; readonly targetId: string } | null => {
  if (value === null) return null
  const separatorIndex = value.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null
  return {
    targetId: value.slice(0, separatorIndex),
    providerAssetRowId: value.slice(separatorIndex + 1),
  }
}

const reviewIncludesLayer = (matchedLayer: string | null, layer: string): boolean =>
  (matchedLayer ?? "")
    .split(",")
    .map((candidate) => candidate.trim())
    .includes(layer)

interface ProviderInputRow {
  readonly id: string
  readonly transactionId: string
  readonly sourceId: string
  readonly processingMode: "accounting_and_evidence" | "accounting_only" | "evidence_only" | "stale"
  readonly providerAssetRowId: string | null
  readonly direction: "inbound" | "outbound"
  readonly amount: string
  readonly observedAssetRepresentationId: string | null
  readonly observedOverrideTargetId: string | null
  readonly exactObservedTransferCount: number
  readonly exactProviderRowTransferCount: number
  readonly exactProviderRowRepresentationCount: number
  readonly metadataFreeExactLegCount: number
  readonly hasCurrentExactObservation: boolean
  readonly hasExactReconciledIdentity: boolean
  readonly matchingTransferCount: number
  readonly storedLegCount: number
  readonly exactStoredLegCount: number
  readonly mappedAssetId: string | null
  readonly inventoryAssetId: string | null
  readonly storedLegAssetId: string | null
  readonly needsReview: boolean | null
  readonly matchedLayer: string | null
}

type ProviderInputOutcome =
  | { readonly _tag: "ignored" }
  | { readonly _tag: "withheld"; readonly transactionId: string }
  | {
      readonly _tag: "blocked"
      readonly transactionId: string
      readonly eventId: AccountingEventId
      readonly assetId: string | null
      readonly providerAssetRowId: string | null
      readonly custodyUnitId: CustodyUnitId | undefined
      readonly codes: ReadonlyArray<FactualLedgerInputBlocker["code"]>
    }
  | {
      readonly _tag: "malformed_candidate"
      readonly transactionId: string
      readonly eventId: AccountingEventId
      readonly assetId: string | null
      readonly providerAssetRowId: string | null
      readonly custodyUnitId: CustodyUnitId | undefined
    }

const effectiveDecisionBlocker = ({
  effectiveDecision,
  fallbackAssetIds,
}: {
  readonly effectiveDecision: PrincipalAssetEffectiveDecision
  readonly fallbackAssetIds: ReadonlyArray<string | null | undefined>
}): {
  readonly assetId: string | null
  readonly codes: ReadonlyArray<FactualLedgerInputBlocker["code"]>
} | null => {
  if (effectiveDecision._tag !== "blocked") return null

  const assetId =
    effectiveDecision.identity._tag === "resolved"
      ? effectiveDecision.identity.assetId
      : (fallbackAssetIds.find((candidate): candidate is string => candidate != null) ?? null)

  return {
    assetId,
    codes: [
      ...(effectiveDecision.identity._tag === "unresolved"
        ? (["unresolved_identity"] as const)
        : []),
      ...effectiveDecision.technicalBlockers,
    ],
  }
}

const providerDecisionBlocker = ({
  decision,
  fallbackAssetIds,
}: {
  readonly decision: PrincipalProviderAssetDecision
  readonly fallbackAssetIds: ReadonlyArray<string | null | undefined>
}) =>
  effectiveDecisionBlocker({
    effectiveDecision: decision.effectiveDecision,
    fallbackAssetIds: [decision.effectiveAssetId, decision.systemAssetId, ...fallbackAssetIds],
  })

const classifyProviderInputRow = ({
  custodyUnitId,
  decision,
  hasAmbiguousStoredLegMatch,
  hasExactObservation,
  hasStoredLeg,
  exactObservationAssetId,
  exactObservationBlocker,
  isExactObservationExcluded,
  providerAssetRowId,
  row,
}: {
  readonly custodyUnitId: CustodyUnitId | undefined
  readonly decision: PrincipalProviderAssetDecision | undefined
  readonly hasAmbiguousStoredLegMatch: boolean
  readonly hasExactObservation: boolean
  readonly hasStoredLeg: boolean
  readonly exactObservationAssetId: string | null
  readonly exactObservationBlocker: ReturnType<typeof effectiveDecisionBlocker>
  readonly isExactObservationExcluded: boolean
  readonly providerAssetRowId: string | null
  readonly row: ProviderInputRow
}): ProviderInputOutcome => {
  if (row.processingMode === "evidence_only" || row.processingMode === "stale") {
    return { _tag: "ignored" }
  }
  const isMalformedMovement =
    !hasStoredLeg &&
    (hasAmbiguousStoredLegMatch ||
      (row.needsReview === true &&
        reviewIncludesLayer(row.matchedLayer, PROVIDER_ASSET_REVIEW_LAYER)))
  if (hasExactObservation) {
    if (decision?.systemInclusion === "excluded" || isExactObservationExcluded) {
      return { _tag: "withheld", transactionId: row.transactionId }
    }
    if (exactObservationBlocker !== null) {
      return {
        _tag: "blocked",
        transactionId: row.transactionId,
        eventId: AccountingEventId.make(row.id),
        assetId: exactObservationBlocker.assetId,
        providerAssetRowId,
        custodyUnitId,
        codes: exactObservationBlocker.codes,
      }
    }
    return isMalformedMovement
      ? {
          _tag: "malformed_candidate",
          transactionId: row.transactionId,
          eventId: AccountingEventId.make(row.id),
          assetId:
            exactObservationAssetId ??
            row.inventoryAssetId ??
            row.mappedAssetId ??
            row.storedLegAssetId ??
            decision?.systemAssetId ??
            decision?.effectiveAssetId ??
            null,
          providerAssetRowId,
          custodyUnitId,
        }
      : { _tag: "ignored" }
  }
  if (decision === undefined) {
    return providerAssetRowId === null && !hasStoredLeg && row.inventoryAssetId !== null
      ? {
          _tag: "malformed_candidate",
          transactionId: row.transactionId,
          eventId: AccountingEventId.make(row.id),
          assetId: row.inventoryAssetId,
          providerAssetRowId,
          custodyUnitId,
        }
      : { _tag: "ignored" }
  }
  if (decision.effectiveDecision._tag === "excluded") {
    return { _tag: "withheld", transactionId: row.transactionId }
  }

  const blocker = providerDecisionBlocker({
    decision,
    fallbackAssetIds: [
      row.inventoryAssetId,
      row.mappedAssetId,
      hasStoredLeg ? row.storedLegAssetId : null,
    ],
  })
  if (blocker !== null) {
    return {
      _tag: "blocked",
      transactionId: row.transactionId,
      eventId: AccountingEventId.make(row.id),
      assetId: blocker.assetId,
      providerAssetRowId,
      custodyUnitId,
      codes: blocker.codes,
    }
  }
  if (decision.effectiveDecision._tag !== "included") return { _tag: "ignored" }
  if (isMalformedMovement) {
    return {
      _tag: "malformed_candidate",
      transactionId: row.transactionId,
      eventId: AccountingEventId.make(row.id),
      assetId: decision.effectiveDecision.assetId,
      providerAssetRowId,
      custodyUnitId,
    }
  }

  return { _tag: "ignored" }
}

const blockerKey = (blocker: FactualLedgerInputBlocker): string =>
  [
    blocker.code,
    blocker.eventId,
    blocker.assetId,
    "providerAssetRowId" in blocker ? blocker.providerAssetRowId : null,
    blocker.custodyUnitId,
  ].join("\0")

const providerDecisionKey = ({
  providerAssetRowId,
  transactionId,
}: {
  readonly providerAssetRowId: string
  readonly transactionId: string
}): string => `${transactionId}\0${providerAssetRowId}`

const makeProviderInputBlocker = ({
  assetId,
  code,
  custodyUnitId,
  eventId,
  providerAssetRowId,
}: {
  readonly assetId: string | null
  readonly code: FactualLedgerInputBlocker["code"]
  readonly custodyUnitId: CustodyUnitId
  readonly eventId: AccountingEventId
  readonly providerAssetRowId: string
}): FactualLedgerInputBlocker =>
  assetId === null
    ? {
        code,
        eventId,
        assetId: null,
        providerAssetRowId,
        custodyUnitId,
        missingQuantity: null,
      }
    : {
        code,
        eventId,
        assetId,
        providerAssetRowId,
        custodyUnitId,
        missingQuantity: null,
      }

const makeStoredInputBlocker = ({
  assetId,
  code,
  custodyUnitId,
  eventId,
  providerAssetRowId,
}: {
  readonly assetId: string | null
  readonly code: FactualLedgerInputBlocker["code"]
  readonly custodyUnitId: CustodyUnitId
  readonly eventId: AccountingEventId
  readonly providerAssetRowId: string | null
}): FactualLedgerInputBlocker | null => {
  if (providerAssetRowId !== null) {
    return makeProviderInputBlocker({
      assetId,
      code,
      custodyUnitId,
      eventId,
      providerAssetRowId,
    })
  }
  if (assetId === null) return null

  return {
    code,
    eventId,
    assetId,
    custodyUnitId,
    missingQuantity: null,
  }
}

const aggregateProviderInputRows = ({
  custodyUnitIdBySource,
  decisions,
  reconciledProviderTransferIds,
  rows,
}: {
  readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly reconciledProviderTransferIds: ReadonlySet<string>
  readonly rows: ReadonlyArray<ProviderInputRow>
}) =>
  Effect.gen(function* () {
    const withheldTransactionIds = new Set<string>()
    const blockedProviderDecisionKeys = new Set<string>()
    const blockedProviderTransferIds = new Set<string>()
    const inputBlockerByKey = new Map<string, FactualLedgerInputBlocker>()
    const malformedCandidates: Array<
      Extract<ProviderInputOutcome, { _tag: "malformed_candidate" }>
    > = []
    for (const row of rows) {
      const decision =
        row.providerAssetRowId === null
          ? undefined
          : decisions.providerAssetDecisionById.get(row.providerAssetRowId)
      const exactObservationDecision =
        row.observedAssetRepresentationId !== null
          ? decisions.representationDecisionById.get(row.observedAssetRepresentationId)
          : row.observedOverrideTargetId === null
            ? undefined
            : decisions.representationDecisionByTargetProviderKey.get(
                representationTargetDecisionKey({
                  providerAssetRowId: row.providerAssetRowId,
                  targetId: row.observedOverrideTargetId,
                })
              )
      const isAccountingInput =
        row.processingMode === "accounting_and_evidence" || row.processingMode === "accounting_only"
      const hasUniqueMetadataFreeExactMatch =
        isAccountingInput &&
        row.metadataFreeExactLegCount === 1 &&
        row.exactObservedTransferCount === 1 &&
        row.storedLegCount === 0
      const hasAmbiguousMetadataFreeExactMatch =
        isAccountingInput && row.metadataFreeExactLegCount > 0 && !hasUniqueMetadataFreeExactMatch
      const hasAmbiguousMetadataLinkedExactMatch =
        isAccountingInput &&
        row.storedLegCount === row.matchingTransferCount &&
        ((row.exactProviderRowTransferCount > 0 &&
          row.exactProviderRowTransferCount !== row.matchingTransferCount) ||
          (row.exactProviderRowTransferCount === row.matchingTransferCount &&
            row.exactProviderRowRepresentationCount > 1))
      const hasAmbiguousStoredLegMatch =
        (isAccountingInput &&
          row.storedLegCount !== 0 &&
          row.storedLegCount !== row.matchingTransferCount) ||
        hasAmbiguousMetadataFreeExactMatch ||
        hasAmbiguousMetadataLinkedExactMatch
      const hasStoredLeg =
        !hasAmbiguousStoredLegMatch &&
        (reconciledProviderTransferIds.has(row.id) ||
          (isAccountingInput && row.storedLegCount === row.matchingTransferCount) ||
          hasUniqueMetadataFreeExactMatch)
      const outcome = classifyProviderInputRow({
        custodyUnitId: custodyUnitIdBySource.get(row.sourceId),
        decision,
        hasAmbiguousStoredLegMatch,
        hasExactObservation:
          row.hasCurrentExactObservation ||
          row.hasExactReconciledIdentity ||
          (isAccountingInput && row.exactStoredLegCount === row.matchingTransferCount),
        hasStoredLeg,
        exactObservationAssetId:
          exactObservationDecision?.effectiveDecision._tag === "included"
            ? exactObservationDecision.effectiveDecision.assetId
            : null,
        exactObservationBlocker:
          exactObservationDecision === undefined
            ? null
            : effectiveDecisionBlocker({
                effectiveDecision: exactObservationDecision.effectiveDecision,
                fallbackAssetIds: [
                  exactObservationDecision.systemAssetId,
                  row.inventoryAssetId,
                  row.mappedAssetId,
                  row.storedLegAssetId,
                ],
              }),
        isExactObservationExcluded: exactObservationDecision?.effectiveDecision._tag === "excluded",
        providerAssetRowId: row.providerAssetRowId,
        row,
      })
      if (outcome._tag === "ignored") continue
      if (outcome._tag === "withheld") {
        withheldTransactionIds.add(outcome.transactionId)
        continue
      }
      if (outcome._tag === "malformed_candidate") {
        malformedCandidates.push(outcome)
        continue
      }

      withheldTransactionIds.add(outcome.transactionId)
      blockedProviderTransferIds.add(String(outcome.eventId))
      if (outcome.providerAssetRowId !== null) {
        blockedProviderDecisionKeys.add(
          providerDecisionKey({
            providerAssetRowId: outcome.providerAssetRowId,
            transactionId: outcome.transactionId,
          })
        )
      }
      if (outcome.custodyUnitId === undefined) {
        return yield* new PersistenceError({
          operation: "factualLedgerRepository.load.inputBlockerLink",
          cause: `Provider transfer ${outcome.eventId} cannot link its blocker to a custody unit`,
        })
      }
      for (const code of outcome.codes) {
        const blocker = makeStoredInputBlocker({
          code,
          eventId: outcome.eventId,
          assetId: outcome.assetId,
          providerAssetRowId: outcome.providerAssetRowId,
          custodyUnitId: outcome.custodyUnitId,
        })
        if (blocker === null) {
          return yield* new PersistenceError({
            operation: "factualLedgerRepository.load.inputBlockerLink",
            cause: `Provider transfer ${outcome.eventId} has a blocked decision without an asset or provider target`,
          })
        }
        inputBlockerByKey.set(blockerKey(blocker), blocker)
      }
    }

    for (const candidate of malformedCandidates) {
      if (candidate.custodyUnitId === undefined) {
        return yield* new PersistenceError({
          operation: "factualLedgerRepository.load.inputBlockerLink",
          cause: `Provider transfer ${candidate.eventId} cannot link its malformed-movement blocker to a custody unit`,
        })
      }
      withheldTransactionIds.add(candidate.transactionId)
      const blocker = makeStoredInputBlocker({
        code: "malformed_movement",
        eventId: candidate.eventId,
        assetId: candidate.assetId,
        providerAssetRowId: candidate.providerAssetRowId,
        custodyUnitId: candidate.custodyUnitId,
      })
      if (blocker === null) {
        return yield* new PersistenceError({
          operation: "factualLedgerRepository.load.inputBlockerLink",
          cause: `Provider transfer ${candidate.eventId} has no asset or provider target for its malformed-movement blocker`,
        })
      }
      inputBlockerByKey.set(blockerKey(blocker), blocker)
    }

    return {
      blockedProviderDecisionKeys,
      blockedProviderTransferIds,
      inputBlockers: [...inputBlockerByKey.values()],
      withheldTransactionIds,
    }
  })

interface StoredAssetDecision {
  readonly effectiveAssetId: string | null
  readonly effectiveDecision: PrincipalAssetEffectiveDecision | undefined
  readonly effectiveRepresentationId: string | null
  readonly mayUseProviderFallback: boolean
  readonly providerDecision: PrincipalProviderAssetDecision | undefined
  readonly providerAssetRowId: string | null
  readonly status: "blocked" | "excluded" | "included" | "system"
}

const selectStoredAssetDecision = ({
  assetRepresentationId,
  decisions,
  hasExactProviderObservation,
  observedAssetRepresentationId,
  observedOverrideTargetId,
  observedProviderAssetRowId,
  providerAssetRowId,
}: {
  readonly assetRepresentationId: string | null
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly hasExactProviderObservation: boolean
  readonly observedAssetRepresentationId: string | null
  readonly observedOverrideTargetId: string | null
  readonly observedProviderAssetRowId: string | null
  readonly providerAssetRowId: string | null
}): StoredAssetDecision => {
  const decisionProviderAssetRowId = providerAssetRowId ?? observedProviderAssetRowId
  const providerDecision =
    decisionProviderAssetRowId === null
      ? undefined
      : decisions.providerAssetDecisionById.get(decisionProviderAssetRowId)
  const effectiveRepresentationId = assetRepresentationId ?? observedAssetRepresentationId
  const mayUseProviderFallback =
    effectiveRepresentationId === null &&
    observedOverrideTargetId === null &&
    !hasExactProviderObservation
  if (mayUseProviderFallback) {
    const effectiveDecision = providerDecision?.effectiveDecision
    return {
      effectiveAssetId: effectiveDecision?._tag === "included" ? effectiveDecision.assetId : null,
      effectiveDecision,
      effectiveRepresentationId,
      mayUseProviderFallback,
      providerDecision,
      providerAssetRowId: decisionProviderAssetRowId,
      status: effectiveDecision?._tag ?? "system",
    }
  }
  if (providerDecision?.systemInclusion === "excluded") {
    return {
      effectiveAssetId: null,
      effectiveDecision: providerDecision.effectiveDecision,
      effectiveRepresentationId,
      mayUseProviderFallback,
      providerDecision,
      providerAssetRowId: decisionProviderAssetRowId,
      status: "excluded",
    }
  }

  const effectiveDecision =
    effectiveRepresentationId === null
      ? observedOverrideTargetId === null
        ? undefined
        : decisions.representationDecisionByTargetProviderKey.get(
            representationTargetDecisionKey({
              providerAssetRowId: decisionProviderAssetRowId,
              targetId: observedOverrideTargetId,
            })
          )?.effectiveDecision
      : decisions.representationDecisionById.get(effectiveRepresentationId)?.effectiveDecision
  return {
    effectiveAssetId: effectiveDecision?._tag === "included" ? effectiveDecision.assetId : null,
    effectiveDecision,
    effectiveRepresentationId,
    mayUseProviderFallback,
    providerDecision,
    providerAssetRowId: decisionProviderAssetRowId,
    status: effectiveDecision?._tag ?? "system",
  }
}

const resolveStoredAssetIdentity = ({
  assetId,
  decisions,
  providerAssetRowId,
  selectedDecision,
}: {
  readonly assetId: string
  readonly decisions: PrincipalAssetOverrideDecisions
  readonly providerAssetRowId: string | null
  readonly selectedDecision: StoredAssetDecision
}): { readonly effectiveAssetId: string; readonly systemAssetId: string } => {
  const representationSystemAssetId = resolveSystemAssetId({
    decisions,
    assetId,
    assetRepresentationId: selectedDecision.effectiveRepresentationId,
  })
  const systemAssetId = selectedDecision.mayUseProviderFallback
    ? (selectedDecision.providerDecision?.systemAssetId ?? representationSystemAssetId)
    : representationSystemAssetId
  const effectiveAssetId =
    selectedDecision.effectiveAssetId ??
    resolvePrincipalAssetId({
      decisions,
      systemAssetId,
      assetRepresentationId: selectedDecision.effectiveRepresentationId,
      providerAssetRowId: selectedDecision.mayUseProviderFallback ? providerAssetRowId : null,
    })

  return { effectiveAssetId, systemAssetId }
}

const closeWithheldReconciledTransactions = ({
  pairs,
  withheldTransactionIds,
}: {
  readonly pairs: ReadonlyArray<{
    readonly canonicalTransactionId: string | null
    readonly providerTransactionId: string
  }>
  readonly withheldTransactionIds: Set<string>
}): void => {
  let changed = true
  while (changed) {
    changed = false
    for (const pair of pairs) {
      if (pair.canonicalTransactionId === null) continue
      if (
        !withheldTransactionIds.has(pair.providerTransactionId) &&
        !withheldTransactionIds.has(pair.canonicalTransactionId)
      ) {
        continue
      }
      const sizeBefore = withheldTransactionIds.size
      withheldTransactionIds.add(pair.providerTransactionId)
      withheldTransactionIds.add(pair.canonicalTransactionId)
      changed = changed || withheldTransactionIds.size !== sizeBefore
    }
  }
}

const acquisitionCause = (transactionType: string | null): AcquisitionCause => {
  if (transactionType === "gift_received") return "gift"
  if (transactionType === "airdrop") return "airdrop"
  if (transactionType === "mining_reward") return "mining_reward"
  if (transactionType === "staking_reward") return "staking_reward"
  if (transactionType === "payment_received") return "payment"
  if (EXCHANGE_TYPES.has(transactionType ?? "")) return "purchase"

  if (
    transactionType === "bounty" ||
    transactionType === "cashback" ||
    transactionType === "governance_reward" ||
    transactionType === "interest_received" ||
    transactionType === "masternode_reward" ||
    transactionType === "yield_farming_reward"
  ) {
    return "reward"
  }

  return "unknown"
}

const dispositionCause = ({
  kind,
  transactionType,
}: {
  readonly kind: "disposal" | "fee"
  readonly transactionType: string | null
}): DispositionCause => {
  if (kind === "fee") return "fee"
  if (transactionType === "gift_sent" || transactionType === "donation_sent") return "gift"
  if (transactionType === "payment_sent") return "payment"
  return EXCHANGE_TYPES.has(transactionType ?? "") ? "sale" : "unknown"
}

const decodeRequired = <S extends Schema.Constraint>({
  schema,
  input,
  operation,
}: {
  readonly schema: S
  readonly input: unknown
  readonly operation: string
}) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => new PersistenceError({ operation, cause }))
  )

const decodeValuationDecimal = (value: string): BigDecimal.BigDecimal | undefined =>
  Option.getOrUndefined(BigDecimal.fromString(value))

const validateReportingCurrency = (reportingCurrency: CurrencyCode) =>
  CURRENCIES_BY_CODE.has(reportingCurrency)
    ? Effect.succeed(reportingCurrency)
    : Effect.fail(
        new PersistenceError({
          operation: "factualLedgerRepository.load.reportingCurrency",
          cause: `Unsupported reporting currency: ${reportingCurrency}`,
        })
      )

const trimmedNonEmpty = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

const transactionReference = ({
  externalGroupId,
  externalId,
  transactionId,
}: {
  readonly externalGroupId: string | null
  readonly externalId: string | null
  readonly transactionId: string | null
}) => {
  for (const candidate of [externalGroupId, externalId, transactionId]) {
    const reference = trimmedNonEmpty(candidate)
    if (reference !== undefined) return reference
  }

  return undefined
}

const compareEvents = (left: AccountingEvent, right: AccountingEvent): number => {
  const timestampOrder = left.occurredAt.epochMillis - right.occurredAt.epochMillis
  return timestampOrder === 0 ? left.id.localeCompare(right.id) : timestampOrder
}

const utcDay = (date: Date): string => date.toISOString().slice(0, 10)

const utcDayStart = (day: string): Date =>
  DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T00:00:00.000Z`))

const compareValuationFacts = (left: ValuationFact, right: ValuationFact): number => {
  const eventOrder = left.eventId.localeCompare(right.eventId)
  if (eventOrder !== 0) return eventOrder
  if (left._tag === right._tag) return 0
  return left._tag === "observed_consideration" ? -1 : 1
}

const make = Effect.gen(function* () {
  const db = yield* drizzle
  const principalAssetOverrideDecisionLoader = yield* makePrincipalAssetOverrideDecisionLoader
  const feeTransactionTable = aliasedTable(schema.transactions, "fee_transaction")
  const providerTransactionTable = aliasedTable(schema.transactions, "provider_transaction")
  const canonicalTransactionTable = aliasedTable(schema.transactions, "canonical_transaction")
  const providerSourceTable = aliasedTable(schema.sources, "provider_source")
  const canonicalSourceTable = aliasedTable(schema.sources, "canonical_source")
  type LoadParams = Parameters<FactualLedgerRepositoryShape["load"]>[0]

  const loadProviderInputRows = ({ principalId }: Pick<LoadParams, "principalId">) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.providerTransfers.id,
          transactionId: schema.providerTransfers.transactionId,
          sourceId: schema.providerTransfers.sourceId,
          processingMode: schema.providerTransfers.processingMode,
          providerAssetRowId: schema.providerTransfers.providerAssetId,
          direction: schema.providerTransfers.direction,
          amount: schema.providerTransfers.amount,
          observedAssetRepresentationId: sql<string | null>`(
            select observed_representation.id
            from ${schema.assetRepresentations} observed_representation
            where observed_representation.blockchain_id =
                ${schema.providerTransfers.observedBlockchainId}
              and observed_representation.type =
                ${schema.providerTransfers.observedRepresentationType}
              and observed_representation.contract_address is not distinct from
                ${schema.providerTransfers.observedContractAddress}
              and observed_representation.mint_address is not distinct from
                ${schema.providerTransfers.observedMintAddress}
            limit 1
          )`,
          observedOverrideTargetId: sql<string | null>`(
            select observed_target.id
            from ${schema.principalAssetOverrideTargets} observed_target
            where observed_target.principal_id = ${principalId}
              and observed_target.target_kind = 'representation'
              and observed_target.blockchain_id = ${schema.providerTransfers.observedBlockchainId}
              and observed_target.representation_type =
                ${schema.providerTransfers.observedRepresentationType}
              and observed_target.contract_address is not distinct from
                ${schema.providerTransfers.observedContractAddress}
              and observed_target.mint_address is not distinct from
                ${schema.providerTransfers.observedMintAddress}
            limit 1
          )`,
          exactObservedTransferCount: sql<number>`(
            select count(*)::integer
            from ${schema.providerTransfers} exact_candidate
            inner join ${schema.assetRepresentations} candidate_representation
              on candidate_representation.blockchain_id = exact_candidate.observed_blockchain_id
              and candidate_representation.type = exact_candidate.observed_representation_type
              and candidate_representation.contract_address is not distinct from
                exact_candidate.observed_contract_address
              and candidate_representation.mint_address is not distinct from
                exact_candidate.observed_mint_address
            inner join ${schema.assetRepresentations} current_representation
              on current_representation.blockchain_id =
                ${schema.providerTransfers.observedBlockchainId}
              and current_representation.type =
                ${schema.providerTransfers.observedRepresentationType}
              and current_representation.contract_address is not distinct from
                ${schema.providerTransfers.observedContractAddress}
              and current_representation.mint_address is not distinct from
                ${schema.providerTransfers.observedMintAddress}
              and current_representation.asset_id = candidate_representation.asset_id
            where exact_candidate.transaction_id = ${schema.providerTransfers.transactionId}
              and exact_candidate.direction = ${schema.providerTransfers.direction}
              and abs(exact_candidate.amount) = abs(${schema.providerTransfers.amount})
              and exact_candidate.processing_mode in ('accounting_and_evidence', 'accounting_only')
          )`,
          exactProviderRowTransferCount: sql<number>`(
            select count(*)::integer
            from ${schema.providerTransfers} exact_provider_row_transfer
            where exact_provider_row_transfer.transaction_id =
                ${schema.providerTransfers.transactionId}
              and exact_provider_row_transfer.provider_asset_id =
                ${schema.providerTransfers.providerAssetId}
              and exact_provider_row_transfer.direction = ${schema.providerTransfers.direction}
              and abs(exact_provider_row_transfer.amount) = abs(${schema.providerTransfers.amount})
              and exact_provider_row_transfer.observed_representation_type is not null
              and exact_provider_row_transfer.processing_mode in
                ('accounting_and_evidence', 'accounting_only')
          )`,
          exactProviderRowRepresentationCount: sql<number>`(
            select count(distinct (
              exact_provider_row_transfer.observed_blockchain_id,
              exact_provider_row_transfer.observed_representation_type,
              exact_provider_row_transfer.observed_contract_address,
              exact_provider_row_transfer.observed_mint_address
            ))::integer
            from ${schema.providerTransfers} exact_provider_row_transfer
            where exact_provider_row_transfer.transaction_id =
                ${schema.providerTransfers.transactionId}
              and exact_provider_row_transfer.provider_asset_id =
                ${schema.providerTransfers.providerAssetId}
              and exact_provider_row_transfer.direction = ${schema.providerTransfers.direction}
              and abs(exact_provider_row_transfer.amount) = abs(${schema.providerTransfers.amount})
              and exact_provider_row_transfer.observed_representation_type is not null
              and exact_provider_row_transfer.processing_mode in
                ('accounting_and_evidence', 'accounting_only')
          )`,
          metadataFreeExactLegCount: sql<number>`(
            select count(*)::integer
            from ${schema.transactionLegs} exact_candidate_leg
            inner join ${schema.assetRepresentations} current_representation
              on current_representation.blockchain_id =
                ${schema.providerTransfers.observedBlockchainId}
              and current_representation.type =
                ${schema.providerTransfers.observedRepresentationType}
              and current_representation.contract_address is not distinct from
                ${schema.providerTransfers.observedContractAddress}
              and current_representation.mint_address is not distinct from
                ${schema.providerTransfers.observedMintAddress}
              and current_representation.asset_id = exact_candidate_leg.asset_id
            where exact_candidate_leg.transaction_id = ${schema.providerTransfers.transactionId}
              and exact_candidate_leg.metadata ->> 'providerAssetRowId' is null
              and abs(exact_candidate_leg.amount) = abs(${schema.providerTransfers.amount})
              and (
                (${schema.providerTransfers.direction} = 'inbound'
                  and exact_candidate_leg.kind in ('acquisition', 'income'))
                or (${schema.providerTransfers.direction} = 'outbound'
                  and exact_candidate_leg.kind in ('disposal', 'fee'))
              )
          )`,
          hasCurrentExactObservation: sql<boolean>`${schema.providerTransfers.observedRepresentationType} is not null`,
          hasExactReconciledIdentity: sql<boolean>`exists (
            select 1
            from ${schema.transferReconciliations} exact_reconciliation
            inner join ${schema.transfers} exact_canonical_transfer
              on exact_canonical_transfer.id = exact_reconciliation.canonical_transfer_id
            where exact_reconciliation.provider_transfer_id = ${schema.providerTransfers.id}
              and exact_reconciliation.principal_id = ${principalId}
              and exact_canonical_transfer.asset_representation_id is not null
              and (
                exact_reconciliation.status = 'approved'
                or (
                  exact_reconciliation.status = 'auto_applied'
                  and exact_reconciliation.deterministic = true
                )
              )
          )`,
          matchingTransferCount: sql<number>`(
            select count(*)::integer
            from ${schema.providerTransfers} matching_transfer
            where matching_transfer.transaction_id = ${schema.providerTransfers.transactionId}
              and matching_transfer.provider_asset_id is not distinct from
                ${schema.providerTransfers.providerAssetId}
              and matching_transfer.direction = ${schema.providerTransfers.direction}
              and abs(matching_transfer.amount) = abs(${schema.providerTransfers.amount})
              and matching_transfer.processing_mode in ('accounting_and_evidence', 'accounting_only')
          )`,
          storedLegCount: sql<number>`(
            select count(*)::integer
            from ${schema.transactionLegs} input_leg
            where input_leg.transaction_id = ${schema.providerTransfers.transactionId}
              and input_leg.metadata ->> 'providerAssetRowId' =
                ${schema.providerTransfers.providerAssetId}::text
              and abs(input_leg.amount) = abs(${schema.providerTransfers.amount})
              and (
                (${schema.providerTransfers.direction} = 'inbound'
                  and input_leg.kind in ('acquisition', 'income'))
                or (${schema.providerTransfers.direction} = 'outbound'
                  and input_leg.kind in ('disposal', 'fee'))
              )
          )`,
          exactStoredLegCount: sql<number>`(
            select count(*)::integer
            from ${schema.transactionLegs} exact_leg
            where exact_leg.transaction_id = ${schema.providerTransfers.transactionId}
              and exact_leg.metadata ->> 'providerAssetRowId' =
                ${schema.providerTransfers.providerAssetId}::text
              and exact_leg.asset_representation_id is not null
              and abs(exact_leg.amount) = abs(${schema.providerTransfers.amount})
              and (
                (${schema.providerTransfers.direction} = 'inbound'
                  and exact_leg.kind in ('acquisition', 'income'))
                or (${schema.providerTransfers.direction} = 'outbound'
                  and exact_leg.kind in ('disposal', 'fee'))
              )
          )`,
          mappedAssetId: schema.providerAssetMappings.canonicalAssetId,
          inventoryAssetId: sql<string | null>`(
            select input_movement.asset_id
            from ${schema.inventoryMovements} input_movement
            where input_movement.provider_transfer_id = ${schema.providerTransfers.id}
            order by input_movement.id
            limit 1
          )`,
          needsReview: schema.transactionReviews.needsReview,
          matchedLayer: schema.transactionReviews.matchedLayer,
          storedLegAssetId: sql<string | null>`(
            select input_leg.asset_id
            from ${schema.transactionLegs} input_leg
            where input_leg.transaction_id = ${schema.providerTransfers.transactionId}
              and input_leg.metadata ->> 'providerAssetRowId' =
                ${schema.providerTransfers.providerAssetId}::text
              and abs(input_leg.amount) = abs(${schema.providerTransfers.amount})
              and (
                (${schema.providerTransfers.direction} = 'inbound'
                  and input_leg.kind in ('acquisition', 'income'))
                or (${schema.providerTransfers.direction} = 'outbound'
                  and input_leg.kind in ('disposal', 'fee'))
              )
            order by input_leg.id
            limit 1
          )`,
        })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.transactions,
          and(
            eq(schema.providerTransfers.transactionId, schema.transactions.id),
            eq(schema.transactions.principalId, principalId)
          )
        )
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerTransfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .leftJoin(
          schema.providerAssetMappings,
          eq(
            schema.providerAssetMappings.providerAssetRowId,
            schema.providerTransfers.providerAssetId
          )
        )
        .leftJoin(
          schema.transactionReviews,
          eq(schema.transactionReviews.transactionId, schema.providerTransfers.transactionId)
        )
        .orderBy(asc(schema.providerTransfers.transactionId), asc(schema.providerTransfers.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.providerInputDecisions"))

      return rows
    })

  const loadLegEvents = ({
    blockedProviderDecisionKeys,
    custodyUnitIdBySource,
    decisions,
    initialWithheldTransactionIds,
    principalId,
    reconciledTransactionPairs,
    reconciledCanonicalTransferIds,
    reconciledProviderTransactionIds,
  }: Pick<LoadParams, "principalId"> & {
    readonly blockedProviderDecisionKeys: ReadonlySet<string>
    readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly initialWithheldTransactionIds: ReadonlySet<string>
    readonly reconciledTransactionPairs: ReadonlyArray<{
      readonly canonicalTransactionId: string | null
      readonly providerTransactionId: string
    }>
    readonly reconciledCanonicalTransferIds: ReadonlySet<string>
    readonly reconciledProviderTransactionIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transactionLegs.id,
          sourceId: schema.transactionLegs.sourceId,
          timestamp: schema.transactionLegs.timestamp,
          assetId: schema.transactionLegs.assetId,
          assetRepresentationId: schema.transactionLegs.assetRepresentationId,
          amount: schema.transactionLegs.amount,
          kind: schema.transactionLegs.kind,
          derivationRule: schema.transactionLegs.derivationRule,
          metadata: schema.transactionLegs.metadata,
          hasExactProviderObservation: sql<boolean>`exists (
            select 1
            from ${schema.providerTransfers} exact_transfer
            where exact_transfer.transaction_id = ${schema.transactions.id}
              and (
                exact_transfer.processing_mode in ('accounting_and_evidence', 'accounting_only')
                or (
                  exact_transfer.processing_mode = 'evidence_only'
                  and not exists (
                    select 1
                    from ${schema.providerTransfers} accounting_transfer
                    where accounting_transfer.transaction_id = exact_transfer.transaction_id
                      and accounting_transfer.provider_asset_id = exact_transfer.provider_asset_id
                      and accounting_transfer.direction = exact_transfer.direction
                      and abs(accounting_transfer.amount) = abs(exact_transfer.amount)
                      and accounting_transfer.processing_mode in
                        ('accounting_and_evidence', 'accounting_only')
                  )
                )
              )
              and exact_transfer.observed_representation_type is not null
              and exact_transfer.provider_asset_id::text =
                ${schema.transactionLegs.metadata} ->> 'providerAssetRowId'
              and abs(exact_transfer.amount) = abs(${schema.transactionLegs.amount})
              and (
                (exact_transfer.direction = 'inbound'
                  and ${schema.transactionLegs.kind} in ('acquisition', 'income'))
                or (exact_transfer.direction = 'outbound'
                  and ${schema.transactionLegs.kind} in ('disposal', 'fee'))
              )
          )`,
          hasAmbiguousEvidenceOnlyExactObservation: sql<boolean>`(
            ${schema.transactionLegs.metadata} ->> 'providerAssetRowId' is not null
            and not exists (
              select 1
              from ${schema.providerTransfers} accounting_transfer
              where accounting_transfer.transaction_id = ${schema.transactions.id}
                and accounting_transfer.provider_asset_id::text =
                  ${schema.transactionLegs.metadata} ->> 'providerAssetRowId'
                and abs(accounting_transfer.amount) = abs(${schema.transactionLegs.amount})
                and (
                  (accounting_transfer.direction = 'inbound'
                    and ${schema.transactionLegs.kind} in ('acquisition', 'income'))
                  or (accounting_transfer.direction = 'outbound'
                    and ${schema.transactionLegs.kind} in ('disposal', 'fee'))
                )
                and accounting_transfer.processing_mode in
                  ('accounting_and_evidence', 'accounting_only')
            )
            and (
              select count(*) filter (
                  where evidence_transfer.observed_representation_type is not null
                ) > 0
                and (
                  count(*) <> (
                    select count(*)
                    from ${schema.transactionLegs} matching_leg
                    where matching_leg.transaction_id = ${schema.transactions.id}
                      and matching_leg.metadata ->> 'providerAssetRowId' =
                        ${schema.transactionLegs.metadata} ->> 'providerAssetRowId'
                      and abs(matching_leg.amount) = abs(${schema.transactionLegs.amount})
                      and (
                        (${schema.transactionLegs.kind} in ('acquisition', 'income')
                          and matching_leg.kind in ('acquisition', 'income'))
                        or (${schema.transactionLegs.kind} in ('disposal', 'fee')
                          and matching_leg.kind in ('disposal', 'fee'))
                      )
                  )
                  or count(*) filter (
                    where evidence_transfer.observed_representation_type is not null
                  ) <> count(*)
                  or count(distinct (
                    evidence_transfer.observed_blockchain_id,
                    evidence_transfer.observed_representation_type,
                    evidence_transfer.observed_contract_address,
                    evidence_transfer.observed_mint_address
                  )) filter (
                    where evidence_transfer.observed_representation_type is not null
                  ) <> 1
                )
              from ${schema.providerTransfers} evidence_transfer
              where evidence_transfer.transaction_id = ${schema.transactions.id}
                and evidence_transfer.provider_asset_id::text =
                  ${schema.transactionLegs.metadata} ->> 'providerAssetRowId'
                and abs(evidence_transfer.amount) = abs(${schema.transactionLegs.amount})
                and evidence_transfer.processing_mode = 'evidence_only'
                and (
                  (evidence_transfer.direction = 'inbound'
                    and ${schema.transactionLegs.kind} in ('acquisition', 'income'))
                  or (evidence_transfer.direction = 'outbound'
                    and ${schema.transactionLegs.kind} in ('disposal', 'fee'))
                )
            )
          )`,
          observedAssetRepresentationId: sql<string | null>`(
            select min(observed_representation.id::text)::uuid
            from ${schema.providerTransfers} observed_transfer
            inner join ${schema.assetRepresentations} observed_representation
              on observed_representation.blockchain_id = observed_transfer.observed_blockchain_id
              and observed_representation.type = observed_transfer.observed_representation_type
              and observed_representation.contract_address is not distinct from
                observed_transfer.observed_contract_address
              and observed_representation.mint_address is not distinct from
                observed_transfer.observed_mint_address
            where observed_transfer.transaction_id = ${schema.transactions.id}
              and (
                observed_transfer.processing_mode in
                  ('accounting_and_evidence', 'accounting_only')
                or (
                  observed_transfer.processing_mode = 'evidence_only'
                  and not exists (
                    select 1
                    from ${schema.providerTransfers} accounting_transfer
                    where accounting_transfer.transaction_id = observed_transfer.transaction_id
                      and accounting_transfer.provider_asset_id =
                        observed_transfer.provider_asset_id
                      and accounting_transfer.direction = observed_transfer.direction
                      and abs(accounting_transfer.amount) = abs(observed_transfer.amount)
                      and accounting_transfer.processing_mode in
                        ('accounting_and_evidence', 'accounting_only')
                  )
                )
              )
              and (
                observed_transfer.provider_asset_id::text =
                  ${schema.transactionLegs.metadata} ->> 'providerAssetRowId'
                or (
                  ${schema.transactionLegs.metadata} ->> 'providerAssetRowId' is null
                  and observed_representation.asset_id = ${schema.transactionLegs.assetId}
                  and (
                    select count(*)
                    from ${schema.providerTransfers} metadata_free_transfer
                    inner join ${schema.assetRepresentations} metadata_free_representation
                      on metadata_free_representation.blockchain_id =
                        metadata_free_transfer.observed_blockchain_id
                      and metadata_free_representation.type =
                        metadata_free_transfer.observed_representation_type
                      and metadata_free_representation.contract_address is not distinct from
                        metadata_free_transfer.observed_contract_address
                      and metadata_free_representation.mint_address is not distinct from
                        metadata_free_transfer.observed_mint_address
                    where metadata_free_transfer.transaction_id = ${schema.transactions.id}
                      and metadata_free_representation.asset_id = ${schema.transactionLegs.assetId}
                      and abs(metadata_free_transfer.amount) = abs(${schema.transactionLegs.amount})
                      and metadata_free_transfer.direction = observed_transfer.direction
                      and metadata_free_transfer.processing_mode in
                        ('accounting_and_evidence', 'accounting_only')
                  ) = 1
                  and (
                    select count(*)
                    from ${schema.transactionLegs} metadata_free_leg
                    where metadata_free_leg.transaction_id = ${schema.transactions.id}
                      and metadata_free_leg.metadata ->> 'providerAssetRowId' is null
                      and metadata_free_leg.asset_id = ${schema.transactionLegs.assetId}
                      and abs(metadata_free_leg.amount) = abs(${schema.transactionLegs.amount})
                      and (
                        (observed_transfer.direction = 'inbound'
                          and metadata_free_leg.kind in ('acquisition', 'income'))
                        or (observed_transfer.direction = 'outbound'
                          and metadata_free_leg.kind in ('disposal', 'fee'))
                      )
                  ) = 1
                )
              )
              and (
                ${schema.transactionLegs.metadata} ->> 'providerAssetRowId' is null
                or (
                  select count(*)
                  from ${schema.providerTransfers} exact_provider_row_transfer
                  inner join ${schema.assetRepresentations} exact_provider_row_representation
                    on exact_provider_row_representation.blockchain_id =
                      exact_provider_row_transfer.observed_blockchain_id
                    and exact_provider_row_representation.type =
                      exact_provider_row_transfer.observed_representation_type
                    and exact_provider_row_representation.contract_address is not distinct from
                      exact_provider_row_transfer.observed_contract_address
                    and exact_provider_row_representation.mint_address is not distinct from
                      exact_provider_row_transfer.observed_mint_address
                  where exact_provider_row_transfer.transaction_id = ${schema.transactions.id}
                    and exact_provider_row_transfer.provider_asset_id =
                      observed_transfer.provider_asset_id
                    and exact_provider_row_transfer.direction = observed_transfer.direction
                    and abs(exact_provider_row_transfer.amount) = abs(observed_transfer.amount)
                    and exact_provider_row_transfer.processing_mode in
                      ('accounting_and_evidence', 'accounting_only')
                ) = (
                  select count(*)
                  from ${schema.providerTransfers} matching_provider_row_transfer
                  where matching_provider_row_transfer.transaction_id = ${schema.transactions.id}
                    and matching_provider_row_transfer.provider_asset_id =
                      observed_transfer.provider_asset_id
                    and matching_provider_row_transfer.direction = observed_transfer.direction
                    and abs(matching_provider_row_transfer.amount) = abs(observed_transfer.amount)
                    and matching_provider_row_transfer.processing_mode in
                      ('accounting_and_evidence', 'accounting_only')
                )
              )
              and abs(observed_transfer.amount) = abs(${schema.transactionLegs.amount})
              and (
                (observed_transfer.direction = 'inbound'
                  and ${schema.transactionLegs.kind} in ('acquisition', 'income'))
                or (observed_transfer.direction = 'outbound'
                  and ${schema.transactionLegs.kind} in ('disposal', 'fee'))
              )
            having count(distinct observed_representation.id) = 1
          )`,
          observedOverrideTargetMatch: sql<string | null>`(
            select concat(
              min(observed_target.id::text),
              ':',
              min(observed_transfer.provider_asset_id::text)
            )
            from ${schema.providerTransfers} observed_transfer
            inner join ${schema.principalAssetOverrideTargets} observed_target
              on observed_target.principal_id = ${principalId}
              and observed_target.target_kind = 'representation'
              and observed_target.blockchain_id = observed_transfer.observed_blockchain_id
              and observed_target.representation_type =
                observed_transfer.observed_representation_type
              and observed_target.contract_address is not distinct from
                observed_transfer.observed_contract_address
              and observed_target.mint_address is not distinct from
                observed_transfer.observed_mint_address
            where observed_transfer.transaction_id = ${schema.transactions.id}
              and (
                observed_transfer.processing_mode in
                  ('accounting_and_evidence', 'accounting_only')
                or (
                  observed_transfer.processing_mode = 'evidence_only'
                  and not exists (
                    select 1
                    from ${schema.providerTransfers} accounting_transfer
                    where accounting_transfer.transaction_id = observed_transfer.transaction_id
                      and accounting_transfer.provider_asset_id =
                        observed_transfer.provider_asset_id
                      and accounting_transfer.direction = observed_transfer.direction
                      and abs(accounting_transfer.amount) = abs(observed_transfer.amount)
                      and accounting_transfer.processing_mode in
                        ('accounting_and_evidence', 'accounting_only')
                  )
                )
              )
              and (
                (
                  ${schema.transactionLegs.metadata} ->> 'providerAssetRowId' is not null
                  and observed_transfer.provider_asset_id::text =
                    ${schema.transactionLegs.metadata} ->> 'providerAssetRowId'
                )
                or (
                  ${schema.transactionLegs.metadata} ->> 'providerAssetRowId' is null
                  and exists (
                    select 1
                    from ${schema.providerAssetMappings} observed_mapping
                    where observed_mapping.provider_asset_row_id =
                        observed_transfer.provider_asset_id
                      and observed_mapping.mapping_kind = 'asset'
                      and observed_mapping.canonical_asset_id = ${schema.transactionLegs.assetId}
                  )
                  and (
                    select count(*)
                    from ${schema.providerTransfers} metadata_free_transfer
                    inner join ${schema.providerAssetMappings} metadata_free_mapping
                      on metadata_free_mapping.provider_asset_row_id =
                        metadata_free_transfer.provider_asset_id
                      and metadata_free_mapping.mapping_kind = 'asset'
                      and metadata_free_mapping.canonical_asset_id =
                        ${schema.transactionLegs.assetId}
                    where metadata_free_transfer.transaction_id = ${schema.transactions.id}
                      and abs(metadata_free_transfer.amount) =
                        abs(${schema.transactionLegs.amount})
                      and metadata_free_transfer.direction = observed_transfer.direction
                      and metadata_free_transfer.processing_mode in
                        ('accounting_and_evidence', 'accounting_only')
                  ) = 1
                  and (
                    select count(*)
                    from ${schema.transactionLegs} metadata_free_leg
                    where metadata_free_leg.transaction_id = ${schema.transactions.id}
                      and metadata_free_leg.metadata ->> 'providerAssetRowId' is null
                      and metadata_free_leg.asset_id = ${schema.transactionLegs.assetId}
                      and abs(metadata_free_leg.amount) = abs(${schema.transactionLegs.amount})
                      and (
                        (observed_transfer.direction = 'inbound'
                          and metadata_free_leg.kind in ('acquisition', 'income'))
                        or (observed_transfer.direction = 'outbound'
                          and metadata_free_leg.kind in ('disposal', 'fee'))
                      )
                  ) = 1
                )
              )
              and abs(observed_transfer.amount) = abs(${schema.transactionLegs.amount})
              and (
                (observed_transfer.direction = 'inbound'
                  and ${schema.transactionLegs.kind} in ('acquisition', 'income'))
                or (observed_transfer.direction = 'outbound'
                  and ${schema.transactionLegs.kind} in ('disposal', 'fee'))
              )
            having count(distinct observed_target.id) = 1
              and count(distinct observed_transfer.provider_asset_id) = 1
          )`,
          sourceTransferId: schema.transactionLegs.sourceTransferId,
          transactionId: schema.transactions.id,
          externalId: schema.transactions.externalId,
          externalGroupId: schema.transactions.externalGroupId,
          transactionType: schema.transactions.transactionType,
          providerResourcePath: schema.transactions.providerResourcePath,
          transactionSourceRawRecordId: schema.transactions.sourceRawRecordId,
          providerFiatAmount: schema.transactions.providerFiatAmount,
          providerFiatCurrency: schema.transactions.providerFiatCurrency,
          feeTransactionId: feeTransactionTable.id,
          feeExternalId: feeTransactionTable.externalId,
          feeExternalGroupId: feeTransactionTable.externalGroupId,
        })
        .from(schema.transactionLegs)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transactionLegs.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .leftJoin(
          schema.transactions,
          and(
            eq(schema.transactionLegs.transactionId, schema.transactions.id),
            eq(schema.transactions.principalId, principalId),
            eq(schema.transactions.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .leftJoin(
          feeTransactionTable,
          and(
            eq(schema.transactionLegs.feeForTransactionId, feeTransactionTable.id),
            eq(feeTransactionTable.principalId, principalId),
            eq(feeTransactionTable.sourceId, schema.transactionLegs.sourceId)
          )
        )
        .where(eq(schema.transactionLegs.principalId, principalId))
        .orderBy(asc(schema.transactionLegs.timestamp), asc(schema.transactionLegs.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.legs"))

      const events: AccountingEvent[] = []
      const eventRows: Array<{
        readonly event: AccountingEvent
        readonly row: (typeof rows)[number]
      }> = []
      const eventCountByTransactionId = new Map<string, number>()
      const inputBlockerByKey = new Map<string, FactualLedgerInputBlocker>()
      const withheldTransactionIds = new Set(initialWithheldTransactionIds)
      const withheldLegIds = new Set<string>()
      const effectiveAssetByTransactionSystemAsset = new Map<string, string>()
      const isReconciledEconomicLeg = (row: (typeof rows)[number]) =>
        row.kind !== "fee" &&
        ((row.sourceTransferId !== null &&
          reconciledCanonicalTransferIds.has(row.sourceTransferId)) ||
          (row.sourceTransferId === null &&
            row.transactionId !== null &&
            reconciledProviderTransactionIds.has(row.transactionId)))

      for (const row of rows) {
        const providerAssetRowId = providerAssetRowIdFromMetadata(row.metadata)
        const observedTarget = observedOverrideTargetMatch(row.observedOverrideTargetMatch)
        const selectedDecision = selectStoredAssetDecision({
          assetRepresentationId: row.assetRepresentationId,
          decisions,
          hasExactProviderObservation: row.hasExactProviderObservation,
          observedAssetRepresentationId: row.observedAssetRepresentationId,
          observedOverrideTargetId: observedTarget?.targetId ?? null,
          observedProviderAssetRowId: observedTarget?.providerAssetRowId ?? null,
          providerAssetRowId,
        })
        if (selectedDecision.status === "excluded") {
          if (row.transactionId !== null) withheldTransactionIds.add(row.transactionId)
          else withheldLegIds.add(row.id)
          continue
        }
        if (row.hasAmbiguousEvidenceOnlyExactObservation) {
          if (row.transactionId !== null) withheldTransactionIds.add(row.transactionId)
          else withheldLegIds.add(row.id)
          const custodyUnitId = custodyUnitIdBySource.get(row.sourceId)
          if (custodyUnitId === undefined) {
            return yield* new PersistenceError({
              operation: "factualLedgerRepository.load.inputBlockerLink",
              cause: `Stored leg ${row.id} cannot link its ambiguous exact observation to a custody unit`,
            })
          }
          const effectiveDecision = selectedDecision.effectiveDecision
          const blockerAssetId =
            effectiveDecision?._tag === "included"
              ? effectiveDecision.assetId
              : effectiveDecision?._tag === "blocked" &&
                  effectiveDecision.identity._tag === "resolved"
                ? effectiveDecision.identity.assetId
                : row.assetId
          const inputBlocker = makeStoredInputBlocker({
            code: "malformed_movement",
            eventId: AccountingEventId.make(row.id),
            assetId: blockerAssetId,
            providerAssetRowId: selectedDecision.providerAssetRowId,
            custodyUnitId,
          })
          if (inputBlocker === null) {
            return yield* new PersistenceError({
              operation: "factualLedgerRepository.load.inputBlockerLink",
              cause: `Stored leg ${row.id} cannot link its ambiguous exact observation blocker`,
            })
          }
          inputBlockerByKey.set(blockerKey(inputBlocker), inputBlocker)
        }
        if (selectedDecision.status === "blocked") {
          if (row.transactionId === null) withheldLegIds.add(row.id)
          else withheldTransactionIds.add(row.transactionId)
          if (
            row.transactionId !== null &&
            providerAssetRowId !== null &&
            blockedProviderDecisionKeys.has(
              providerDecisionKey({ providerAssetRowId, transactionId: row.transactionId })
            )
          ) {
            continue
          }
          const blocker =
            selectedDecision.effectiveDecision === undefined
              ? null
              : effectiveDecisionBlocker({
                  effectiveDecision: selectedDecision.effectiveDecision,
                  fallbackAssetIds: [
                    selectedDecision.providerDecision?.effectiveAssetId,
                    selectedDecision.providerDecision?.systemAssetId,
                    row.assetId,
                  ],
                })
          const custodyUnitId = custodyUnitIdBySource.get(row.sourceId)
          if (blocker === null || custodyUnitId === undefined) {
            return yield* new PersistenceError({
              operation: "factualLedgerRepository.load.inputBlockerLink",
              cause: `Stored leg ${row.id} cannot link its blocker to a target and custody unit`,
            })
          }
          for (const code of blocker.codes) {
            const inputBlocker = makeStoredInputBlocker({
              code,
              eventId: AccountingEventId.make(row.id),
              assetId: blocker.assetId,
              providerAssetRowId: selectedDecision.providerAssetRowId,
              custodyUnitId,
            })
            if (inputBlocker === null) {
              return yield* new PersistenceError({
                operation: "factualLedgerRepository.load.inputBlockerLink",
                cause: `Stored leg ${row.id} has a blocked decision without an asset or provider target`,
              })
            }
            inputBlockerByKey.set(blockerKey(inputBlocker), inputBlocker)
          }
          continue
        }
        if (row.hasAmbiguousEvidenceOnlyExactObservation) continue
        if (row.transactionId === null) {
          continue
        }
        const { effectiveAssetId, systemAssetId } = resolveStoredAssetIdentity({
          assetId: row.assetId,
          decisions,
          providerAssetRowId,
          selectedDecision,
        })
        const identityKey = `${row.transactionId}\0${systemAssetId}`
        const earlierAssetId = effectiveAssetByTransactionSystemAsset.get(identityKey)
        if (earlierAssetId !== undefined && earlierAssetId !== effectiveAssetId) {
          withheldTransactionIds.add(row.transactionId)
          const custodyUnitId = custodyUnitIdBySource.get(row.sourceId)
          if (custodyUnitId === undefined) {
            return yield* new PersistenceError({
              operation: "factualLedgerRepository.load.inputBlockerLink",
              cause: `Stored leg ${row.id} cannot link its malformed-movement blocker to a custody unit`,
            })
          }
          const inputBlocker = {
            code: "malformed_movement",
            eventId: AccountingEventId.make(row.id),
            assetId: systemAssetId,
            ...(providerAssetRowId === null ? {} : { providerAssetRowId }),
            custodyUnitId,
            missingQuantity: null,
          } satisfies FactualLedgerInputBlocker
          inputBlockerByKey.set(blockerKey(inputBlocker), inputBlocker)
        } else {
          effectiveAssetByTransactionSystemAsset.set(identityKey, effectiveAssetId)
        }
      }

      closeWithheldReconciledTransactions({
        pairs: reconciledTransactionPairs,
        withheldTransactionIds,
      })

      for (const row of rows) {
        if (
          withheldLegIds.has(row.id) ||
          (row.transactionId !== null && withheldTransactionIds.has(row.transactionId))
        ) {
          continue
        }
        if (
          row.transactionId !== null &&
          row.kind !== "fee" &&
          !isReconciledEconomicLeg(row) &&
          row.derivationRule !== "internal_transfer_in" &&
          row.derivationRule !== "internal_transfer_out"
        ) {
          eventCountByTransactionId.set(
            row.transactionId,
            (eventCountByTransactionId.get(row.transactionId) ?? 0) + 1
          )
        }
      }

      for (const row of rows) {
        if (
          withheldLegIds.has(row.id) ||
          (row.transactionId !== null && withheldTransactionIds.has(row.transactionId)) ||
          isReconciledEconomicLeg(row) ||
          row.derivationRule === "internal_transfer_in" ||
          row.derivationRule === "internal_transfer_out"
        ) {
          continue
        }

        const reference =
          row.kind === "fee" && row.feeTransactionId !== null
            ? transactionReference({
                externalGroupId: row.feeExternalGroupId,
                externalId: row.feeExternalId,
                transactionId: row.feeTransactionId,
              })
            : transactionReference(row)
        const providerAssetRowId = providerAssetRowIdFromMetadata(row.metadata)
        const observedTarget = observedOverrideTargetMatch(row.observedOverrideTargetMatch)
        const selectedDecision = selectStoredAssetDecision({
          assetRepresentationId: row.assetRepresentationId,
          decisions,
          hasExactProviderObservation: row.hasExactProviderObservation,
          observedAssetRepresentationId: row.observedAssetRepresentationId,
          observedOverrideTargetId: observedTarget?.targetId ?? null,
          observedProviderAssetRowId: observedTarget?.providerAssetRowId ?? null,
          providerAssetRowId,
        })
        const { effectiveAssetId } = resolveStoredAssetIdentity({
          assetId: row.assetId,
          decisions,
          providerAssetRowId,
          selectedDecision,
        })
        const common = {
          id: row.id,
          occurredAt: { epochMillis: row.timestamp.getTime() },
          assetId: effectiveAssetId,
          quantity: row.amount,
          ...(reference === undefined ? {} : { transactionReference: reference }),
        }

        if (row.kind === "acquisition" || row.kind === "income") {
          const event = yield* decodeRequired({
            schema: AcquisitionEvent,
            input: {
              _tag: "acquisition",
              ...common,
              custodySourceId: row.sourceId,
              cause: acquisitionCause(row.transactionType),
            },
            operation: "factualLedgerRepository.load.event",
          })
          events.push(event)
          eventRows.push({ event, row })
          continue
        }

        const event = yield* decodeRequired({
          schema: DispositionEvent,
          input: {
            _tag: "disposition",
            ...common,
            custodySourceId: row.sourceId,
            cause: dispositionCause({ kind: row.kind, transactionType: row.transactionType }),
          },
          operation: "factualLedgerRepository.load.event",
        })
        events.push(event)
        eventRows.push({ event, row })
      }

      return {
        events,
        eventRows,
        eventCountByTransactionId,
        inputBlockers: [...inputBlockerByKey.values()],
        withheldTransactionIds,
      }
    })

  type LoadedLegEvents = Effect.Success<ReturnType<typeof loadLegEvents>>

  const loadCustodyMovementRows = ({ principalId }: Pick<LoadParams, "principalId">) =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({
          id: schema.transferReconciliations.id,
          providerTransferId: schema.providerTransfers.id,
          providerTransactionId: providerTransactionTable.id,
          canonicalTransferId: schema.transferReconciliations.canonicalTransferId,
          canonicalTransactionId: schema.transferReconciliations.canonicalTransactionId,
          providerDirection: schema.providerTransfers.direction,
          providerSourceId: providerTransactionTable.sourceId,
          canonicalSourceId: canonicalTransactionTable.sourceId,
          canonicalTimestamp: canonicalTransactionTable.timestamp,
          canonicalExternalId: canonicalTransactionTable.externalId,
          canonicalExternalGroupId: canonicalTransactionTable.externalGroupId,
          providerAssetRowId: schema.providerTransfers.providerAssetId,
          hasExactProviderObservation: sql<boolean>`${schema.providerTransfers.observedRepresentationType} is not null`,
          observedAssetRepresentationId: sql<string | null>`(
            select observed_representation.id
            from ${schema.assetRepresentations} observed_representation
            where observed_representation.blockchain_id =
                ${schema.providerTransfers.observedBlockchainId}
              and observed_representation.type =
                ${schema.providerTransfers.observedRepresentationType}
              and observed_representation.contract_address is not distinct from
                ${schema.providerTransfers.observedContractAddress}
              and observed_representation.mint_address is not distinct from
                ${schema.providerTransfers.observedMintAddress}
            limit 1
          )`,
          observedOverrideTargetId: sql<string | null>`(
            select observed_target.id
            from ${schema.principalAssetOverrideTargets} observed_target
            where observed_target.principal_id = ${principalId}
              and observed_target.target_kind = 'representation'
              and observed_target.blockchain_id = ${schema.providerTransfers.observedBlockchainId}
              and observed_target.representation_type =
                ${schema.providerTransfers.observedRepresentationType}
              and observed_target.contract_address is not distinct from
                ${schema.providerTransfers.observedContractAddress}
              and observed_target.mint_address is not distinct from
                ${schema.providerTransfers.observedMintAddress}
            limit 1
          )`,
          assetId: schema.transfers.assetId,
          assetRepresentationId: schema.transfers.assetRepresentationId,
          amount: schema.transfers.amount,
        })
        .from(schema.transferReconciliations)
        .innerJoin(
          schema.providerTransfers,
          eq(schema.transferReconciliations.providerTransferId, schema.providerTransfers.id)
        )
        .innerJoin(
          providerTransactionTable,
          and(
            eq(schema.providerTransfers.transactionId, providerTransactionTable.id),
            eq(schema.providerTransfers.sourceId, providerTransactionTable.sourceId)
          )
        )
        .innerJoin(
          schema.inventoryMovements,
          and(
            eq(schema.inventoryMovements.providerTransferId, schema.providerTransfers.id),
            eq(schema.inventoryMovements.transactionId, providerTransactionTable.id),
            eq(schema.inventoryMovements.sourceId, schema.providerTransfers.sourceId)
          )
        )
        .innerJoin(
          schema.transfers,
          eq(schema.transferReconciliations.canonicalTransferId, schema.transfers.id)
        )
        .innerJoin(
          canonicalTransactionTable,
          and(
            eq(schema.transferReconciliations.canonicalTransactionId, canonicalTransactionTable.id),
            eq(schema.transfers.sourceId, canonicalTransactionTable.sourceId)
          )
        )
        .innerJoin(
          providerSourceTable,
          and(
            eq(providerTransactionTable.sourceId, providerSourceTable.id),
            eq(providerSourceTable.principalId, principalId)
          )
        )
        .innerJoin(
          canonicalSourceTable,
          and(
            eq(canonicalTransactionTable.sourceId, canonicalSourceTable.id),
            eq(canonicalSourceTable.principalId, principalId)
          )
        )
        .where(
          and(
            eq(schema.transferReconciliations.principalId, principalId),
            eq(schema.inventoryMovements.principalId, principalId),
            eq(providerTransactionTable.principalId, principalId),
            eq(canonicalTransactionTable.principalId, principalId),
            eq(schema.transfers.principalId, principalId),
            eq(schema.inventoryMovements.purpose, "principal"),
            eq(schema.inventoryMovements.reconciliationStatus, "matched"),
            or(
              eq(schema.transferReconciliations.status, "approved"),
              and(
                eq(schema.transferReconciliations.status, "auto_applied"),
                eq(schema.transferReconciliations.deterministic, true)
              )
            )
          )
        )
        .orderBy(asc(schema.transferReconciliations.id))
        .pipe(wrapSqlError("factualLedgerRepository.load.custodyMovements"))

      return rows
    })

  type CustodyMovementRows = Effect.Success<ReturnType<typeof loadCustodyMovementRows>>

  const prepareCustodyMovements = ({
    blockedProviderTransferIds,
    custodyUnitIdBySource,
    decisions,
    rows,
  }: {
    readonly blockedProviderTransferIds: ReadonlySet<string>
    readonly custodyUnitIdBySource: ReadonlyMap<string, CustodyUnitId>
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly rows: CustodyMovementRows
  }) =>
    Effect.gen(function* () {
      const reconciledCanonicalTransferIds = new Set<string>()
      const reconciledProviderTransactionIds = new Set<string>()
      const decisionWithheldTransactionIds = new Set<string>()
      const inputBlockerByKey = new Map<string, FactualLedgerInputBlocker>()
      const seenCanonicalTransferIds = new Set<string>()
      for (const row of rows) {
        if (row.canonicalTransferId === null) continue
        if (seenCanonicalTransferIds.has(row.canonicalTransferId)) {
          return yield* new PersistenceError({
            operation: "factualLedgerRepository.load.duplicateCustodyMovement",
            cause: `Canonical transfer has multiple active reconciliations: ${row.canonicalTransferId}`,
          })
        }
        seenCanonicalTransferIds.add(row.canonicalTransferId)
        reconciledCanonicalTransferIds.add(row.canonicalTransferId)
        reconciledProviderTransactionIds.add(row.providerTransactionId)
        const selectedDecision = selectStoredAssetDecision({
          assetRepresentationId: row.assetRepresentationId,
          decisions,
          hasExactProviderObservation: row.hasExactProviderObservation,
          observedAssetRepresentationId: row.observedAssetRepresentationId,
          observedOverrideTargetId: row.observedOverrideTargetId,
          observedProviderAssetRowId: row.providerAssetRowId,
          providerAssetRowId: row.providerAssetRowId,
        })
        if (selectedDecision.status === "excluded" || selectedDecision.status === "blocked") {
          decisionWithheldTransactionIds.add(row.providerTransactionId)
          if (row.canonicalTransactionId !== null) {
            decisionWithheldTransactionIds.add(row.canonicalTransactionId)
          }
        }
        const providerBlockerAlreadyRecorded = blockedProviderTransferIds.has(
          row.providerTransferId
        )
        if (selectedDecision.status === "blocked" && !providerBlockerAlreadyRecorded) {
          const blocker =
            selectedDecision.effectiveDecision === undefined
              ? null
              : effectiveDecisionBlocker({
                  effectiveDecision: selectedDecision.effectiveDecision,
                  fallbackAssetIds: [
                    selectedDecision.providerDecision?.effectiveAssetId,
                    selectedDecision.providerDecision?.systemAssetId,
                    row.assetId,
                  ],
                })
          const custodyUnitId = custodyUnitIdBySource.get(row.providerSourceId)
          if (blocker === null || custodyUnitId === undefined) {
            return yield* new PersistenceError({
              operation: "factualLedgerRepository.load.inputBlockerLink",
              cause: `Custody movement ${row.id} cannot link its blocker to a target and custody unit`,
            })
          }
          for (const code of blocker.codes) {
            const inputBlocker = makeStoredInputBlocker({
              code,
              eventId: AccountingEventId.make(row.id),
              assetId: blocker.assetId,
              providerAssetRowId: row.providerAssetRowId,
              custodyUnitId,
            })
            if (inputBlocker === null) {
              return yield* new PersistenceError({
                operation: "factualLedgerRepository.load.inputBlockerLink",
                cause: `Custody movement ${row.id} has a blocked decision without an asset or provider target`,
              })
            }
            inputBlockerByKey.set(blockerKey(inputBlocker), inputBlocker)
          }
        }
      }

      return {
        decisionWithheldTransactionIds,
        inputBlockers: [...inputBlockerByKey.values()],
        reconciledCanonicalTransferIds,
        reconciledProviderTransactionIds,
      }
    })

  const makeCustodyMovementEvents = ({
    decisions,
    rows,
    withheldTransactionIds,
  }: {
    readonly decisions: PrincipalAssetOverrideDecisions
    readonly rows: CustodyMovementRows
    readonly withheldTransactionIds: ReadonlySet<string>
  }) =>
    Effect.gen(function* () {
      const events: AccountingEvent[] = []
      for (const row of rows) {
        if (
          row.canonicalTransferId === null ||
          withheldTransactionIds.has(row.providerTransactionId) ||
          (row.canonicalTransactionId !== null &&
            withheldTransactionIds.has(row.canonicalTransactionId))
        ) {
          continue
        }
        const selectedDecision = selectStoredAssetDecision({
          assetRepresentationId: row.assetRepresentationId,
          decisions,
          hasExactProviderObservation: row.hasExactProviderObservation,
          observedAssetRepresentationId: row.observedAssetRepresentationId,
          observedOverrideTargetId: row.observedOverrideTargetId,
          observedProviderAssetRowId: row.providerAssetRowId,
          providerAssetRowId: row.providerAssetRowId,
        })

        const reference = transactionReference({
          externalGroupId: row.canonicalExternalGroupId,
          externalId: row.canonicalExternalId,
          transactionId: row.canonicalTransactionId,
        })
        const fromCustodySourceId =
          row.providerDirection === "outbound" ? row.providerSourceId : row.canonicalSourceId
        const toCustodySourceId =
          row.providerDirection === "outbound" ? row.canonicalSourceId : row.providerSourceId

        events.push(
          yield* decodeRequired({
            schema: CustodyMovementEvent,
            input: {
              _tag: "custody_movement",
              id: row.id,
              occurredAt: { epochMillis: row.canonicalTimestamp.getTime() },
              assetId:
                selectedDecision.effectiveAssetId !== null
                  ? selectedDecision.effectiveAssetId
                  : resolvePrincipalAssetId({
                      decisions,
                      systemAssetId: row.assetId,
                      assetRepresentationId: row.assetRepresentationId,
                      providerAssetRowId: selectedDecision.mayUseProviderFallback
                        ? row.providerAssetRowId
                        : null,
                    }),
              quantity: row.amount,
              ...(reference === undefined ? {} : { transactionReference: reference }),
              fromCustodySourceId,
              toCustodySourceId,
            },
            operation: "factualLedgerRepository.load.event",
          })
        )
      }

      return events
    })

  const makeObservedValuationFacts = ({
    eventRows,
    eventCountByTransactionId,
    reportingCurrency,
  }: Pick<LoadedLegEvents, "eventRows" | "eventCountByTransactionId"> &
    Pick<LoadParams, "reportingCurrency">) =>
    Effect.gen(function* () {
      const valuationFacts: ValuationFact[] = []
      for (const { event, row } of eventRows) {
        if (
          row.kind !== "fee" &&
          row.transactionId !== null &&
          eventCountByTransactionId.get(row.transactionId) === 1 &&
          row.providerFiatAmount !== null &&
          row.providerFiatCurrency === reportingCurrency
        ) {
          const providerAmount = decodeValuationDecimal(row.providerFiatAmount)
          if (
            providerAmount === undefined ||
            row.providerFiatAmount.startsWith("-") ||
            BigDecimal.isNegative(providerAmount)
          ) {
            continue
          }

          const providerResourcePath = trimmedNonEmpty(row.providerResourcePath)
          const evidenceReference =
            providerResourcePath === undefined
              ? row.transactionSourceRawRecordId === null
                ? `transaction:${row.transactionId}`
                : `source_raw_record:${row.transactionSourceRawRecordId}`
              : providerResourcePath

          valuationFacts.push(
            yield* decodeRequired({
              schema: ObservedConsiderationFact,
              input: {
                _tag: "observed_consideration",
                eventId: event.id,
                amount: {
                  amount: row.providerFiatAmount,
                  currency: reportingCurrency,
                },
                evidenceReference,
              },
              operation: "factualLedgerRepository.load.observedConsideration",
            })
          )
        }
      }

      return valuationFacts
    })

  const loadPriceRows = ({
    events,
    reportingCurrency,
  }: {
    readonly events: ReadonlyArray<AccountingEvent>
  } & Pick<LoadParams, "reportingCurrency">) => {
    if (reportingCurrency !== "EUR") return Effect.succeed([])

    const eventAssetIds = [...new Set(events.map(({ assetId }) => assetId))]
    const eventDayStarts = [
      ...new Set(events.map((event) => utcDay(event.occurredAt.toDate()))),
    ].map(utcDayStart)

    return eventAssetIds.length === 0 || eventDayStarts.length === 0
      ? Effect.succeed([])
      : db
          .select({
            assetId: schema.assetPrices.assetId,
            timestamp: schema.assetPrices.timestamp,
            price: schema.assetPrices.price,
            source: schema.assetPrices.source,
          })
          .from(schema.assetPrices)
          .where(
            and(
              inArray(schema.assetPrices.assetId, eventAssetIds),
              eq(schema.assetPrices.currency, reportingCurrency),
              inArray(schema.assetPrices.timestamp, eventDayStarts)
            )
          )
          .orderBy(asc(schema.assetPrices.assetId), asc(schema.assetPrices.timestamp))
          .pipe(wrapSqlError("factualLedgerRepository.load.prices"))
  }

  type PriceRows = Effect.Success<ReturnType<typeof loadPriceRows>>

  const priceRowKey = ({ assetId, timestamp }: Pick<PriceRows[number], "assetId" | "timestamp">) =>
    `${assetId}:${utcDay(timestamp)}`

  const makePriceQuoteMap = (priceRows: PriceRows): ReadonlyMap<string, PriceRows[number]> => {
    const quotes = new Map<string, PriceRows[number]>()

    for (const row of priceRows) {
      const value = decodeValuationDecimal(row.price)
      if (
        value === undefined ||
        !BigDecimal.isPositive(value) ||
        row.source === null ||
        row.source === "" ||
        row.source !== row.source.trim()
      ) {
        continue
      }

      quotes.set(priceRowKey(row), row)
    }

    return quotes
  }

  const makeMarketValuationFacts = ({
    events,
    priceRows,
    reportingCurrency,
  }: {
    readonly events: ReadonlyArray<AccountingEvent>
    readonly priceRows: PriceRows
  } & Pick<LoadParams, "reportingCurrency">) =>
    Effect.gen(function* () {
      const valuationFacts: ValuationFact[] = []
      const quotes = makePriceQuoteMap(priceRows)

      for (const event of events) {
        const quote = quotes.get(
          priceRowKey({ assetId: event.assetId, timestamp: event.occurredAt.toDate() })
        )
        if (quote === undefined) continue

        valuationFacts.push(
          yield* decodeRequired({
            schema: MarketQuoteFact,
            input: {
              _tag: "market_quote",
              eventId: event.id,
              unitPrice: {
                amount: quote.price,
                currency: reportingCurrency,
              },
              quotedAt: { epochMillis: quote.timestamp.getTime() },
              source: quote.source,
            },
            operation: "factualLedgerRepository.load.marketQuote",
          })
        )
      }

      return valuationFacts
    })

  const load: FactualLedgerRepositoryShape["load"] = ({ principalId, reportingCurrency }) =>
    Effect.gen(function* () {
      const supportedReportingCurrency = yield* validateReportingCurrency(reportingCurrency)
      const providerAssetMetadataRows = yield* db
        .select({
          assetRepresentationId: schema.transactionLegs.assetRepresentationId,
          metadata: schema.transactionLegs.metadata,
        })
        .from(schema.transactionLegs)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.transactionLegs.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .where(eq(schema.transactionLegs.principalId, principalId))
        .pipe(wrapSqlError("factualLedgerRepository.load.providerAssetRows"))
      const transferRepresentationRows = yield* db
        .select({ assetRepresentationId: schema.transfers.assetRepresentationId })
        .from(schema.transfers)
        .where(eq(schema.transfers.principalId, principalId))
        .pipe(wrapSqlError("factualLedgerRepository.load.transferRepresentations"))
      const providerObservedRepresentationRows = yield* db
        .selectDistinct({ assetRepresentationId: schema.assetRepresentations.id })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerTransfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .innerJoin(
          schema.assetRepresentations,
          and(
            eq(
              schema.assetRepresentations.blockchainId,
              schema.providerTransfers.observedBlockchainId
            ),
            eq(
              schema.assetRepresentations.type,
              schema.providerTransfers.observedRepresentationType
            ),
            sql`${schema.assetRepresentations.contractAddress} is not distinct from
              ${schema.providerTransfers.observedContractAddress}`,
            sql`${schema.assetRepresentations.mintAddress} is not distinct from
              ${schema.providerTransfers.observedMintAddress}`
          )
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.providerObservedRepresentations"))
      const providerTransferAssetRows = yield* db
        .select({ providerAssetRowId: schema.providerTransfers.providerAssetId })
        .from(schema.providerTransfers)
        .innerJoin(
          schema.sources,
          and(
            eq(schema.providerTransfers.sourceId, schema.sources.id),
            eq(schema.sources.principalId, principalId)
          )
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.providerTransferAssets"))
      const providerAssetRowIds = [
        ...providerAssetMetadataRows.flatMap(({ metadata }) => {
          const providerAssetRowId = providerAssetRowIdFromMetadata(metadata)
          return providerAssetRowId === null ? [] : [providerAssetRowId]
        }),
        ...providerTransferAssetRows.flatMap(({ providerAssetRowId }) =>
          providerAssetRowId === null ? [] : [providerAssetRowId]
        ),
      ]
      const decisions = yield* principalAssetOverrideDecisionLoader.load({
        assetRepresentationIds: [
          ...providerAssetMetadataRows,
          ...transferRepresentationRows,
          ...providerObservedRepresentationRows,
        ].flatMap(({ assetRepresentationId }) =>
          assetRepresentationId === null ? [] : [assetRepresentationId]
        ),
        principalId,
        providerAssetRowIds,
      })
      const membershipRows = yield* db
        .select({
          custodyUnitId: schema.custodyUnitSources.custodyUnitId,
          sourceId: schema.custodyUnitSources.sourceId,
        })
        .from(schema.custodyUnitSources)
        .where(eq(schema.custodyUnitSources.principalId, principalId))
        .orderBy(
          asc(schema.custodyUnitSources.custodyUnitId),
          asc(schema.custodyUnitSources.sourceId)
        )
        .pipe(wrapSqlError("factualLedgerRepository.load.custodyUnitMembership"))
      const custodyUnitIdBySource = new Map(
        membershipRows.map(({ custodyUnitId, sourceId }) => [
          sourceId,
          CustodyUnitId.make(custodyUnitId),
        ])
      )
      const providerInputRows = yield* loadProviderInputRows({ principalId })
      const custodyMovementRows = yield* loadCustodyMovementRows({ principalId })
      const providerInputDecisions = yield* aggregateProviderInputRows({
        custodyUnitIdBySource,
        decisions,
        reconciledProviderTransferIds: new Set(
          custodyMovementRows.map(({ providerTransferId }) => providerTransferId)
        ),
        rows: providerInputRows,
      })
      const preparedCustodyMovements = yield* prepareCustodyMovements({
        blockedProviderTransferIds: providerInputDecisions.blockedProviderTransferIds,
        custodyUnitIdBySource,
        decisions,
        rows: custodyMovementRows,
      })
      const initialWithheldTransactionIds = new Set([
        ...providerInputDecisions.withheldTransactionIds,
        ...preparedCustodyMovements.decisionWithheldTransactionIds,
      ])
      closeWithheldReconciledTransactions({
        pairs: custodyMovementRows,
        withheldTransactionIds: initialWithheldTransactionIds,
      })
      const legEvents = yield* loadLegEvents({
        blockedProviderDecisionKeys: providerInputDecisions.blockedProviderDecisionKeys,
        custodyUnitIdBySource,
        decisions,
        initialWithheldTransactionIds,
        principalId,
        reconciledCanonicalTransferIds: preparedCustodyMovements.reconciledCanonicalTransferIds,
        reconciledProviderTransactionIds: preparedCustodyMovements.reconciledProviderTransactionIds,
        reconciledTransactionPairs: custodyMovementRows,
      })
      const custodyMovementEvents = yield* makeCustodyMovementEvents({
        decisions,
        rows: custodyMovementRows,
        withheldTransactionIds: legEvents.withheldTransactionIds,
      })
      const inputBlockerByKey = new Map(
        [
          ...providerInputDecisions.inputBlockers,
          ...preparedCustodyMovements.inputBlockers,
          ...legEvents.inputBlockers,
        ].map((blocker) => [blockerKey(blocker), blocker] as const)
      )
      const events = [...legEvents.events, ...custodyMovementEvents].sort(compareEvents)
      const valuationEvents = events.filter((event) => event._tag !== "custody_movement")
      const observedValuationFacts = yield* makeObservedValuationFacts({
        eventRows: legEvents.eventRows,
        eventCountByTransactionId: legEvents.eventCountByTransactionId,
        reportingCurrency: supportedReportingCurrency,
      })
      const priceRows = yield* loadPriceRows({
        events: valuationEvents,
        reportingCurrency: supportedReportingCurrency,
      })
      const marketValuationFacts = yield* makeMarketValuationFacts({
        events: valuationEvents,
        priceRows,
        reportingCurrency: supportedReportingCurrency,
      })
      const valuationFacts = [...observedValuationFacts, ...marketValuationFacts].sort(
        compareValuationFacts
      )

      const custodyUnitMembership = membershipRows.map(({ custodyUnitId, sourceId }) => ({
        custodyUnitId: CustodyUnitId.make(custodyUnitId),
        sourceId: SourceId.make(sourceId),
      }))

      return {
        events,
        inputBlockers: [...inputBlockerByKey.values()],
        valuationFacts,
        custodyUnitMembership,
        principalAssetOverrideRevision: decisions.revision,
      }
    })

  return FactualLedgerRepository.of({ load })
})

/** Live factual-ledger repository layer. */
export const FactualLedgerRepositoryLive = Layer.effect(FactualLedgerRepository, make)
