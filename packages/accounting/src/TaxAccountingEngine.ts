/**
 * Stateless tax-accounting engine over a factual ledger.
 *
 * @module accounting/TaxAccountingEngine
 */

import {
  AccountingMethodId,
  CustodyUnitId,
  multiplyByQuantity,
  prorate,
  type AccountingChoice,
  type AccountingChoiceId,
  type AccountingEvent,
  type AccountingEventId,
  type AccountingMethodChoice,
  type AccountingQuantity,
  type AcquisitionEvent,
  type CustodyMovementEvent,
  type DispositionEvent,
  type InventoryScope,
  type InventoryScopeChoice,
  type JurisdictionCode,
  type MarketQuoteFact,
  type ObservedConsiderationFact,
  type TaxYear,
  type ValuationFact,
} from "@my/core/accounting"
import { divide, MonetaryAmount, round, subtract } from "@my/core/shared/values/MonetaryAmount"
import type { Timestamp } from "@my/core/shared/values/Timestamp"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { allocateFifoQuantity } from "./FifoLotMatcher.ts"

const ENGINE_VERSION = "1"
const STRUCTURAL_RULE_SET_VERSION = "structural-v1"

type ChoiceKind = AccountingChoice["_tag"]

/** A required structural accounting choice could not be resolved. */
export class AccountingChoiceResolutionError extends Schema.TaggedError<AccountingChoiceResolutionError>()(
  "AccountingChoiceResolutionError",
  {
    choiceKind: Schema.Literals(["accounting_method", "inventory_scope"]),
    reason: Schema.Literals(["missing", "multiple_active", "broken_supersession", "cycle"]),
  }
) {}

/** The selected accounting method is not implemented by this engine version. */
export class UnsupportedAccountingMethodError extends Schema.TaggedError<UnsupportedAccountingMethodError>()(
  "UnsupportedAccountingMethodError",
  { method: Schema.String }
) {}

/** Failures caused by invalid structural engine configuration. */
export type TaxAccountingError = AccountingChoiceResolutionError | UnsupportedAccountingMethodError

/** One factual quantity match between an acquisition and a disposition. */
export interface FactualFifoAllocation {
  readonly acquisitionEventId: AccountingEventId
  readonly dispositionEventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly acquiredAt: Timestamp
  readonly disposedAt: Timestamp
  readonly quantity: AccountingQuantity
  readonly costBasis: MonetaryAmount | null
}

/** Factual money proved for one fully valued FIFO allocation. */
export interface RealizedResult {
  readonly acquisitionEventId: AccountingEventId
  readonly dispositionEventId: AccountingEventId
  readonly assetId: string
  readonly acquiredAt: Timestamp
  readonly disposedAt: Timestamp
  readonly quantity: AccountingQuantity
  readonly costBasis: MonetaryAmount
  readonly proceeds: MonetaryAmount
  readonly gainLoss: MonetaryAmount
  readonly treatmentCodes: ReadonlyArray<string>
}

/** One remaining acquisition lot after the supplied ledger is processed. */
export interface DerivedLot {
  readonly acquisitionEventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly acquiredAt: Timestamp
  readonly remainingQuantity: AccountingQuantity
  readonly costBasisPerUnit: MonetaryAmount | null
}

/** Machine-readable fact that kept the structural result from being complete. */
export interface TaxAccountingBlocker {
  readonly code:
    | "unknown_cause"
    | "missing_valuation"
    | "ambiguous_valuation"
    | "valuation_currency_mismatch"
    | "inventory_shortage"
    | "movement_shortage"
    | "blocked_inventory_suffix"
  readonly eventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity: AccountingQuantity | null
}

/** Jurisdiction-neutral income result shape populated by a jurisdiction module. */
export interface IncomeResult {
  readonly eventId: AccountingEventId
  readonly assetId: string
  readonly occurredAt: Timestamp
  readonly quantity: AccountingQuantity
  readonly value: MonetaryAmount
  readonly treatmentCodes: ReadonlyArray<string>
}

/** Quantity taken from one acquisition by an explained engine step. */
export interface ExplanationMatch {
  readonly acquisitionEventId: AccountingEventId
  readonly quantity: AccountingQuantity
}

/** One deterministic machine-readable explanation entry. */
export interface ExplanationEntry {
  readonly sequence: number
  readonly eventId: AccountingEventId
  readonly code: string
  readonly valuationKind: ValuationFact["_tag"] | null
  readonly matches: ReadonlyArray<ExplanationMatch>
}

/** Complete structural output of one pure engine invocation. */
export interface TaxAccountingResult {
  readonly status: "complete" | "partial"
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly engineVersion: string
  readonly ruleSetVersion: string
  readonly accountingMethod: AccountingMethodId
  readonly inventoryScope: InventoryScope
  readonly appliedChoiceIds: ReadonlyArray<AccountingChoiceId>
  readonly appliedRules: ReadonlyArray<string>
  readonly processedEventIds: ReadonlyArray<AccountingEventId>
  readonly allocations: ReadonlyArray<FactualFifoAllocation>
  readonly realizedResults: ReadonlyArray<RealizedResult>
  readonly incomeResults: ReadonlyArray<IncomeResult>
  readonly derivedLots: ReadonlyArray<DerivedLot>
  readonly blockers: ReadonlyArray<TaxAccountingBlocker>
  readonly explanationTrace: ReadonlyArray<ExplanationEntry>
}

/** Inputs to the pure tax-accounting engine. */
export interface CalculateInput {
  readonly ledger: ReadonlyArray<AccountingEvent>
  readonly jurisdiction: JurisdictionCode
  readonly taxYear: TaxYear
  readonly accountingChoices: ReadonlyArray<AccountingChoice>
  readonly valuationFacts: ReadonlyArray<ValuationFact>
}

interface EngineLot extends DerivedLot {
  readonly id: string
}

interface EngineState {
  readonly inventories: Map<string, EngineLot[]>
  readonly allocations: FactualFifoAllocation[]
  readonly realizedResults: RealizedResult[]
  readonly blockers: TaxAccountingBlocker[]
  readonly explanationTrace: ExplanationEntry[]
  readonly blockedInventoryKeys: Set<string>
}

interface ValuationSelection {
  readonly _tag: "selected"
  readonly total: MonetaryAmount
  readonly kind: ValuationFact["_tag"]
}

interface MissingValuation {
  readonly _tag: "missing"
}

interface AmbiguousValuation {
  readonly _tag: "ambiguous"
}

type ValuationResolution = ValuationSelection | MissingValuation | AmbiguousValuation

const compareEvents = (left: AccountingEvent, right: AccountingEvent): number => {
  const timeDifference = left.occurredAt.epochMillis - right.occurredAt.epochMillis

  return timeDifference === 0 ? left.id.localeCompare(right.id) : timeDifference
}

type ChoiceByKind<Kind extends ChoiceKind> = Extract<AccountingChoice, { readonly _tag: Kind }>

const hasChoiceKind = <Kind extends ChoiceKind>(
  choice: AccountingChoice,
  choiceKind: Kind
): choice is ChoiceByKind<Kind> => choice._tag === choiceKind

const resolveChoice = <Kind extends ChoiceKind>({
  choices,
  jurisdiction,
  choiceKind,
}: {
  readonly choices: ReadonlyArray<AccountingChoice>
  readonly jurisdiction: JurisdictionCode
  readonly choiceKind: Kind
}): Effect.Effect<ChoiceByKind<Kind>, AccountingChoiceResolutionError> => {
  const relevant = choices.filter(
    (choice): choice is ChoiceByKind<Kind> =>
      hasChoiceKind(choice, choiceKind) && choice.jurisdiction === jurisdiction
  )
  const choiceById = new Map(relevant.map((choice) => [choice.id, choice]))

  for (const choice of relevant) {
    if (choice.supersedesChoiceId !== undefined && !choiceById.has(choice.supersedesChoiceId)) {
      return Effect.fail(
        new AccountingChoiceResolutionError({
          choiceKind,
          reason: "broken_supersession",
        })
      )
    }

    const visited = new Set<AccountingChoiceId>()
    let current: ChoiceByKind<Kind> | undefined = choice

    while (current !== undefined) {
      if (visited.has(current.id)) {
        return Effect.fail(
          new AccountingChoiceResolutionError({
            choiceKind,
            reason: "cycle",
          })
        )
      }

      visited.add(current.id)
      current =
        current.supersedesChoiceId === undefined
          ? undefined
          : choiceById.get(current.supersedesChoiceId)
    }
  }

  const supersededIds = new Set(
    relevant.flatMap((choice) =>
      choice.supersedesChoiceId === undefined ? [] : [choice.supersedesChoiceId]
    )
  )
  const active = relevant.filter((choice) => !supersededIds.has(choice.id))

  const resolved = active[0]

  return active.length === 1 && resolved !== undefined
    ? Effect.succeed(resolved)
    : Effect.fail(
        new AccountingChoiceResolutionError({
          choiceKind,
          reason: active.length === 0 ? "missing" : "multiple_active",
        })
      )
}

const selectValuation = ({
  event,
  valuationFacts,
}: {
  readonly event: AccountingEvent
  readonly valuationFacts: ReadonlyArray<ValuationFact>
}): ValuationResolution => {
  const facts = valuationFacts.filter((fact) => fact.eventId === event.id)
  const observed = facts.filter(
    (fact): fact is ObservedConsiderationFact => fact._tag === "observed_consideration"
  )

  if (observed.length > 1) {
    return { _tag: "ambiguous" }
  }

  const observedFact = observed[0]

  if (observedFact !== undefined) {
    return {
      _tag: "selected",
      total: observedFact.amount,
      kind: observedFact._tag,
    }
  }

  const quotes = facts.filter((fact): fact is MarketQuoteFact => fact._tag === "market_quote")

  if (quotes.length > 1) {
    return { _tag: "ambiguous" }
  }

  const quote = quotes[0]

  return quote === undefined
    ? { _tag: "missing" }
    : {
        _tag: "selected",
        total: multiplyByQuantity(quote.unitPrice, event.quantity),
        kind: quote._tag,
      }
}

const inventoryKey = ({
  assetId,
  custodyUnitId,
  inventoryScope,
}: {
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly inventoryScope: InventoryScope
}): string => (inventoryScope === "whole_taxpayer" ? assetId : `${assetId}:${custodyUnitId}`)

const makeCustodyUnitId = (sourceId: string): CustodyUnitId => CustodyUnitId.make(sourceId)

const compareLots = (left: EngineLot, right: EngineLot): number => {
  const timeDifference = left.acquiredAt.epochMillis - right.acquiredAt.epochMillis

  if (timeDifference !== 0) {
    return timeDifference
  }

  const eventDifference = left.acquisitionEventId.localeCompare(right.acquisitionEventId)

  return eventDifference === 0 ? left.id.localeCompare(right.id) : eventDifference
}

const sortLots = (lots: ReadonlyArray<EngineLot>): EngineLot[] => [...lots].sort(compareLots)

const toDerivedLots = (inventories: ReadonlyMap<string, ReadonlyArray<EngineLot>>): DerivedLot[] =>
  [...inventories.values()]
    .flat()
    .filter((lot) => lot.remainingQuantity.value !== 0n)
    .map(({ id: _id, ...lot }) => lot)

const appendExplanation = ({
  state,
  eventId,
  code,
  valuationKind,
  matches = [],
}: {
  readonly state: EngineState
  readonly eventId: AccountingEventId
  readonly code: string
  readonly valuationKind: ValuationFact["_tag"] | null
  readonly matches?: ReadonlyArray<ExplanationMatch>
}): void => {
  state.explanationTrace.push({
    sequence: state.explanationTrace.length,
    eventId,
    code,
    valuationKind,
    matches,
  })
}

const appendBlocker = ({
  state,
  code,
  eventId,
  assetId,
  custodyUnitId,
  missingQuantity = null,
  valuationKind = null,
  matches = [],
}: {
  readonly state: EngineState
  readonly code: TaxAccountingBlocker["code"]
  readonly eventId: AccountingEventId
  readonly assetId: string
  readonly custodyUnitId: CustodyUnitId
  readonly missingQuantity?: AccountingQuantity | null
  readonly valuationKind?: ValuationFact["_tag"] | null
  readonly matches?: ReadonlyArray<ExplanationMatch>
}): void => {
  state.blockers.push({ code, eventId, assetId, custodyUnitId, missingQuantity })
  appendExplanation({
    state,
    eventId,
    code: `blocker.${code}`,
    valuationKind,
    matches,
  })
}

const appendValuationBlocker = ({
  state,
  event,
  custodyUnitId,
  valuationResolution,
}: {
  readonly state: EngineState
  readonly event: AcquisitionEvent | DispositionEvent
  readonly custodyUnitId: CustodyUnitId
  readonly valuationResolution: MissingValuation | AmbiguousValuation
}): void =>
  appendBlocker({
    state,
    code: valuationResolution._tag === "ambiguous" ? "ambiguous_valuation" : "missing_valuation",
    eventId: event.id,
    assetId: event.assetId,
    custodyUnitId,
  })

const processCustodyMovement = ({
  event,
  inventoryScope,
  state,
}: {
  readonly event: CustodyMovementEvent
  readonly inventoryScope: InventoryScope
  readonly state: EngineState
}): void => {
  if (inventoryScope === "whole_taxpayer") {
    appendExplanation({
      state,
      eventId: event.id,
      code: "pooled_custody_movement",
      valuationKind: null,
    })
    return
  }

  const sourceUnitId = makeCustodyUnitId(event.fromCustodySourceId)
  const destinationUnitId = makeCustodyUnitId(event.toCustodySourceId)
  const sourceKey = inventoryKey({
    assetId: event.assetId,
    custodyUnitId: sourceUnitId,
    inventoryScope,
  })
  const destinationKey = inventoryKey({
    assetId: event.assetId,
    custodyUnitId: destinationUnitId,
    inventoryScope,
  })

  if (state.blockedInventoryKeys.has(sourceKey)) {
    appendBlocker({
      state,
      code: "blocked_inventory_suffix",
      eventId: event.id,
      assetId: event.assetId,
      custodyUnitId: sourceUnitId,
    })
    state.blockedInventoryKeys.add(destinationKey)
    return
  }

  const sourceLots = state.inventories.get(sourceKey) ?? []
  const movementMatch = allocateFifoQuantity({
    lots: sourceLots,
    quantity: event.quantity,
  })
  const remainingById = new Map(
    movementMatch.allocations.map((allocation) => [allocation.lot.id, allocation.remainingQuantity])
  )
  state.inventories.set(
    sourceKey,
    sourceLots.map((lot) => ({
      ...lot,
      remainingQuantity: remainingById.get(lot.id) ?? lot.remainingQuantity,
    }))
  )
  const destinationLots = movementMatch.allocations.map((allocation, index) => ({
    ...allocation.lot,
    id: `${allocation.lot.id}:${event.id}:${index}`,
    custodyUnitId: destinationUnitId,
    remainingQuantity: allocation.matchedQuantity,
  }))
  state.inventories.set(
    destinationKey,
    sortLots([...(state.inventories.get(destinationKey) ?? []), ...destinationLots])
  )
  const matches = movementMatch.allocations.map((allocation) => ({
    acquisitionEventId: allocation.lot.acquisitionEventId,
    quantity: allocation.matchedQuantity,
  }))

  if (movementMatch.shortage !== null) {
    appendBlocker({
      state,
      code: "movement_shortage",
      eventId: event.id,
      assetId: event.assetId,
      custodyUnitId: sourceUnitId,
      missingQuantity: movementMatch.shortage,
      matches,
    })
    state.blockedInventoryKeys.add(sourceKey)
    state.blockedInventoryKeys.add(destinationKey)
  }

  appendExplanation({
    state,
    eventId: event.id,
    code: "fifo_basis_carried",
    valuationKind: null,
    matches,
  })
}

const processAcquisition = ({
  event,
  custodyUnitId,
  inventoryKey,
  valuationResolution,
  state,
}: {
  readonly event: AcquisitionEvent
  readonly custodyUnitId: CustodyUnitId
  readonly inventoryKey: string
  readonly valuationResolution: ValuationResolution
  readonly state: EngineState
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const valuation = valuationResolution._tag === "selected" ? valuationResolution : null
    const costBasisPerUnit =
      valuation === null
        ? null
        : Option.getOrNull(yield* Effect.option(divide(valuation.total, event.quantity)))
    const lot: EngineLot = {
      id: event.id,
      acquisitionEventId: event.id,
      assetId: event.assetId,
      custodyUnitId,
      acquiredAt: event.occurredAt,
      remainingQuantity: event.quantity,
      costBasisPerUnit,
    }

    state.inventories.set(
      inventoryKey,
      sortLots([...(state.inventories.get(inventoryKey) ?? []), lot])
    )

    if (valuationResolution._tag !== "selected") {
      appendValuationBlocker({
        state,
        event,
        custodyUnitId,
        valuationResolution,
      })
    }

    appendExplanation({
      state,
      eventId: event.id,
      code: "fifo_lot_created",
      valuationKind: valuation?.kind ?? null,
    })
  })

const processDisposition = ({
  event,
  custodyUnitId,
  inventoryKey,
  valuationResolution,
  state,
}: {
  readonly event: DispositionEvent
  readonly custodyUnitId: CustodyUnitId
  readonly inventoryKey: string
  readonly valuationResolution: ValuationResolution
  readonly state: EngineState
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const valuation = valuationResolution._tag === "selected" ? valuationResolution : null

    if (state.blockedInventoryKeys.has(inventoryKey)) {
      appendBlocker({
        state,
        code: "blocked_inventory_suffix",
        eventId: event.id,
        assetId: event.assetId,
        custodyUnitId,
        valuationKind: valuation?.kind ?? null,
      })
      return
    }

    const lots = state.inventories.get(inventoryKey) ?? []
    const match = allocateFifoQuantity({
      lots,
      quantity: event.quantity,
    })
    const remainingById = new Map(
      match.allocations.map((allocation) => [allocation.lot.id, allocation.remainingQuantity])
    )
    state.inventories.set(
      inventoryKey,
      lots.map((lot) => ({
        ...lot,
        remainingQuantity: remainingById.get(lot.id) ?? lot.remainingQuantity,
      }))
    )
    const matches = match.allocations.map((allocation) => ({
      acquisitionEventId: allocation.lot.acquisitionEventId,
      quantity: allocation.matchedQuantity,
    }))

    if (valuationResolution._tag !== "selected") {
      appendValuationBlocker({
        state,
        event,
        custodyUnitId,
        valuationResolution,
      })
    }

    if (match.shortage !== null) {
      appendBlocker({
        state,
        code: "inventory_shortage",
        eventId: event.id,
        assetId: event.assetId,
        custodyUnitId,
        missingQuantity: match.shortage,
        valuationKind: valuation?.kind ?? null,
        matches,
      })
      state.blockedInventoryKeys.add(inventoryKey)
    }

    let currencyMismatchBlocked = false

    for (const matchAllocation of match.allocations) {
      const lot = matchAllocation.lot
      const costBasis =
        lot.costBasisPerUnit === null
          ? null
          : round(multiplyByQuantity(lot.costBasisPerUnit, matchAllocation.matchedQuantity), 8)

      state.allocations.push({
        acquisitionEventId: lot.acquisitionEventId,
        dispositionEventId: event.id,
        assetId: event.assetId,
        custodyUnitId,
        acquiredAt: lot.acquiredAt,
        disposedAt: event.occurredAt,
        quantity: matchAllocation.matchedQuantity,
        costBasis,
      })
      const proceeds =
        valuation === null
          ? null
          : Option.getOrNull(
              yield* Effect.option(
                prorate({
                  total: valuation.total,
                  part: matchAllocation.matchedQuantity,
                  whole: event.quantity,
                  scale: 8,
                })
              )
            )

      if (costBasis === null || proceeds === null) {
        continue
      }

      const gainLoss = yield* Effect.result(subtract(proceeds, costBasis))

      if (Result.isFailure(gainLoss)) {
        if (!currencyMismatchBlocked) {
          appendBlocker({
            state,
            code: "valuation_currency_mismatch",
            eventId: event.id,
            assetId: event.assetId,
            custodyUnitId,
            valuationKind: valuation?.kind ?? null,
            matches: [
              {
                acquisitionEventId: lot.acquisitionEventId,
                quantity: matchAllocation.matchedQuantity,
              },
            ],
          })
          currencyMismatchBlocked = true
        }
        continue
      }

      state.realizedResults.push({
        acquisitionEventId: lot.acquisitionEventId,
        dispositionEventId: event.id,
        assetId: event.assetId,
        acquiredAt: lot.acquiredAt,
        disposedAt: event.occurredAt,
        quantity: matchAllocation.matchedQuantity,
        costBasis,
        proceeds,
        gainLoss: gainLoss.success,
        treatmentCodes: [],
      })
    }

    appendExplanation({
      state,
      eventId: event.id,
      code: "fifo_disposition_matched",
      valuationKind: valuation?.kind ?? null,
      matches,
    })
  })

/** Calculate a complete deterministic structural result without external services. */
export const calculate = ({
  ledger,
  jurisdiction,
  taxYear,
  accountingChoices,
  valuationFacts,
}: CalculateInput): Effect.Effect<TaxAccountingResult, TaxAccountingError, never> =>
  Effect.gen(function* () {
    const methodChoice: AccountingMethodChoice = yield* resolveChoice({
      choices: accountingChoices,
      jurisdiction,
      choiceKind: "accounting_method",
    })
    const scopeChoice: InventoryScopeChoice = yield* resolveChoice({
      choices: accountingChoices,
      jurisdiction,
      choiceKind: "inventory_scope",
    })

    if (methodChoice.method !== "fifo") {
      return yield* new UnsupportedAccountingMethodError({ method: methodChoice.method })
    }

    const orderedLedger = [...ledger].sort(compareEvents)
    const state: EngineState = {
      inventories: new Map(),
      allocations: [],
      realizedResults: [],
      blockers: [],
      explanationTrace: [],
      blockedInventoryKeys: new Set(),
    }

    for (const event of orderedLedger) {
      if (event._tag === "custody_movement") {
        processCustodyMovement({ event, inventoryScope: scopeChoice.scope, state })
        continue
      }

      const custodyUnitId = makeCustodyUnitId(event.custodySourceId)
      const key = inventoryKey({
        assetId: event.assetId,
        custodyUnitId,
        inventoryScope: scopeChoice.scope,
      })
      const valuationResolution = selectValuation({ event, valuationFacts })
      const valuation = valuationResolution._tag === "selected" ? valuationResolution : null

      if (event.cause === "unknown") {
        appendBlocker({
          state,
          code: "unknown_cause",
          eventId: event.id,
          assetId: event.assetId,
          custodyUnitId,
          valuationKind: valuation?.kind ?? null,
        })
      }

      if (event._tag === "acquisition") {
        yield* processAcquisition({
          event,
          custodyUnitId,
          inventoryKey: key,
          valuationResolution,
          state,
        })
        continue
      }

      yield* processDisposition({
        event,
        custodyUnitId,
        inventoryKey: key,
        valuationResolution,
        state,
      })
    }

    return {
      status: state.blockers.length === 0 ? "complete" : "partial",
      jurisdiction,
      taxYear,
      engineVersion: ENGINE_VERSION,
      ruleSetVersion: STRUCTURAL_RULE_SET_VERSION,
      accountingMethod: methodChoice.method,
      inventoryScope: scopeChoice.scope,
      appliedChoiceIds: [methodChoice.id, scopeChoice.id],
      appliedRules: [
        "engine.event_order.occurred_at_then_id",
        "engine.inventory.fifo",
        `engine.inventory.${scopeChoice.scope}`,
      ],
      processedEventIds: orderedLedger.map((event) => event.id),
      allocations: state.allocations,
      realizedResults: state.realizedResults,
      incomeResults: [],
      derivedLots: toDerivedLots(state.inventories),
      blockers: state.blockers,
      explanationTrace: state.explanationTrace,
    }
  })
