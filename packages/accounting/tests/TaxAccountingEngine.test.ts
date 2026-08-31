import { describe, expect, it } from "@effect/vitest"
import {
  AccountingChoice,
  AccountingEvent,
  AccountingQuantity,
  CustodyUnitMembership,
  JurisdictionCode,
  TaxYear,
  ValuationFact,
  type AccountingEvent as AccountingEventType,
  type CustodyUnitMembership as CustodyUnitMembershipType,
  type ValuationFact as ValuationFactType,
} from "@my/core/accounting"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { calculate } from "../src/index.ts"

const decodeChoice = Schema.decodeUnknownSync(AccountingChoice)
const decodeEvent = Schema.decodeUnknownSync(AccountingEvent)
const decodeCustodyUnitMembership = Schema.decodeUnknownSync(CustodyUnitMembership)
const decodeValuationFact = Schema.decodeUnknownSync(ValuationFact)
const encodeQuantity = Schema.encodeSync(AccountingQuantity)

const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SOURCE_ONE = "11111111-1111-4111-8111-111111111111"
const SOURCE_TWO = "22222222-2222-4222-8222-222222222222"
const GROUPED_CUSTODY_UNIT = "22222222-2222-4222-8222-333333333333"
const ACQUISITION_ONE = "33333333-3333-4333-8333-333333333333"
const ACQUISITION_TWO = "44444444-4444-4444-8444-444444444444"
const DISPOSITION = "55555555-5555-4555-8555-555555555555"

const choices = [
  decodeChoice({
    _tag: "accounting_method",
    id: "66666666-6666-4666-8666-666666666666",
    jurisdiction: "DE",
    method: "fifo",
    recordedAt: { epochMillis: 1 },
    actor: "test",
    evidence: "fixture",
  }),
  decodeChoice({
    _tag: "inventory_scope",
    id: "77777777-7777-4777-8777-777777777777",
    jurisdiction: "DE",
    scope: "per_custody_unit",
    recordedAt: { epochMillis: 1 },
    actor: "test",
    evidence: "fixture",
  }),
]

const runCalculation = ({
  ledger,
  valuationFacts,
  custodyUnitMemberships = [],
}: {
  readonly ledger: ReadonlyArray<AccountingEventType>
  readonly valuationFacts: ReadonlyArray<ValuationFactType>
  readonly custodyUnitMemberships?: ReadonlyArray<CustodyUnitMembershipType>
}) =>
  calculate({
    ledger,
    custodyUnitMemberships,
    jurisdiction: JurisdictionCode.make("DE"),
    taxYear: TaxYear.make(1970),
    accountingChoices: choices,
    valuationFacts,
  })

describe("calculate", () => {
  it.effect("sorts the ledger and matches same-unit lots FIFO", () =>
    Effect.gen(function* () {
      const olderAtSameTime = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const newerAtSameTime = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_TWO,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "sale",
      })

      const result = yield* runCalculation({
        ledger: [disposition, newerAtSameTime, olderAtSameTime],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "30", currency: "EUR" },
            evidenceReference: "older",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_TWO,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "newer",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "80", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(result.processedEventIds).toEqual([ACQUISITION_ONE, ACQUISITION_TWO, DISPOSITION])
      expect(
        result.allocations.map((allocation) => ({
          acquisitionEventId: allocation.acquisitionEventId,
          quantity: encodeQuantity(allocation.quantity),
          costBasis: allocation.costBasis?.format(),
        }))
      ).toEqual([
        { acquisitionEventId: ACQUISITION_ONE, quantity: "1", costBasis: "30" },
        { acquisitionEventId: ACQUISITION_TWO, quantity: "1", costBasis: "10" },
      ])
      expect(
        result.realizedResults.map((realized) => ({
          acquisitionEventId: realized.acquisitionEventId,
          proceeds: realized.proceeds.format(),
          gainLoss: realized.gainLoss.format(),
          treatmentCodes: realized.treatmentCodes,
        }))
      ).toEqual([
        {
          acquisitionEventId: ACQUISITION_ONE,
          proceeds: "40",
          gainLoss: "10",
          treatmentCodes: ["de.taxable_private_disposal"],
        },
        {
          acquisitionEventId: ACQUISITION_TWO,
          proceeds: "40",
          gainLoss: "30",
          treatmentCodes: ["de.taxable_private_disposal"],
        },
      ])
      expect(result.derivedLots).toHaveLength(1)
      expect(result.derivedLots[0]).toMatchObject({
        acquisitionEventId: ACQUISITION_TWO,
        custodyUnitId: SOURCE_ONE,
      })
      const remainingLot = result.derivedLots[0]

      if (remainingLot === undefined) {
        return expect.fail("expected one remaining lot")
      }

      expect(encodeQuantity(remainingLot.remainingQuantity)).toBe("1")
      expect(result).toMatchObject({
        status: "complete",
        jurisdiction: "DE",
        taxYear: 1970,
        inventoryScope: "per_custody_unit",
        blockers: [],
        incomeResults: [],
      })
    })
  )

  it.effect("matches inventory across sources recorded in one custody unit", () =>
    Effect.gen(function* () {
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "sale",
      })

      const result = yield* runCalculation({
        ledger: [acquisition, disposition],
        custodyUnitMemberships: [
          decodeCustodyUnitMembership({
            sourceId: SOURCE_ONE,
            custodyUnitId: GROUPED_CUSTODY_UNIT,
          }),
          decodeCustodyUnitMembership({
            sourceId: SOURCE_TWO,
            custodyUnitId: GROUPED_CUSTODY_UNIT,
          }),
        ],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "25", currency: "EUR" },
            evidenceReference: "buy",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "40", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(result.status).toBe("complete")
      expect(result.allocations).toHaveLength(1)
      expect(result.allocations[0]?.custodyUnitId).toBe(GROUPED_CUSTODY_UNIT)
      expect(result.blockers).toEqual([])
    })
  )

  it.effect("carries acquisition basis across a per-unit custody movement", () =>
    Effect.gen(function* () {
      const movementId = "88888888-8888-4888-8888-888888888888"
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const movement = decodeEvent({
        _tag: "custody_movement",
        id: movementId,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        fromCustodySourceId: SOURCE_ONE,
        toCustodySourceId: SOURCE_TWO,
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "sale",
      })

      const result = yield* runCalculation({
        ledger: [disposition, movement, acquisition],
        valuationFacts: [
          decodeValuationFact({
            _tag: "market_quote",
            eventId: ACQUISITION_ONE,
            unitPrice: { amount: "10", currency: "EUR" },
            quotedAt: { epochMillis: 1_000 },
            source: "fixture",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "30", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(result.realizedResults).toHaveLength(1)
      expect(result.realizedResults[0]).toMatchObject({
        acquisitionEventId: ACQUISITION_ONE,
        dispositionEventId: DISPOSITION,
      })
      expect(result.realizedResults[0]?.costBasis.format()).toBe("10")
      expect(result.realizedResults[0]?.gainLoss.format()).toBe("20")
      expect(result.derivedLots).toHaveLength(1)
      expect(result.derivedLots[0]).toMatchObject({
        acquisitionEventId: ACQUISITION_ONE,
        custodyUnitId: SOURCE_ONE,
      })
      const sourceLot = result.derivedLots[0]

      if (sourceLot === undefined) {
        return expect.fail("expected one source lot")
      }

      expect(encodeQuantity(sourceLot.remainingQuantity)).toBe("1")
      expect(result.explanationTrace.map((entry) => entry.code)).toEqual([
        "fifo_lot_created",
        "fifo_basis_carried",
        "fifo_disposition_matched",
      ])
      const movementTrace = result.explanationTrace.find(
        (entry) => entry.code === "fifo_basis_carried"
      )
      const dispositionTrace = result.explanationTrace.find(
        (entry) => entry.code === "fifo_disposition_matched"
      )

      if (movementTrace === undefined || dispositionTrace === undefined) {
        return expect.fail("expected movement and disposition explanations")
      }

      expect(
        movementTrace.matches.map((match) => ({
          acquisitionEventId: match.acquisitionEventId,
          quantity: encodeQuantity(match.quantity),
        }))
      ).toEqual([{ acquisitionEventId: ACQUISITION_ONE, quantity: "1" }])
      expect(
        dispositionTrace.matches.map((match) => ({
          acquisitionEventId: match.acquisitionEventId,
          quantity: encodeQuantity(match.quantity),
        }))
      ).toEqual([{ acquisitionEventId: ACQUISITION_ONE, quantity: "1" }])
    })
  )

  it.effect("inserts moved lots by original acquisition order", () =>
    Effect.gen(function* () {
      const movementId = "88888888-8888-4888-8888-888888888888"
      const olderSourceLot = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const newerDestinationLot = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_TWO,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "purchase",
      })
      const movement = decodeEvent({
        _tag: "custody_movement",
        id: movementId,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "1",
        fromCustodySourceId: SOURCE_ONE,
        toCustodySourceId: SOURCE_TWO,
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 4_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "sale",
      })
      const result = yield* runCalculation({
        ledger: [disposition, movement, newerDestinationLot, olderSourceLot],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: "older-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_TWO,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "newer-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "30", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(result.realizedResults[0]).toMatchObject({
        acquisitionEventId: ACQUISITION_ONE,
      })
      expect(result.realizedResults[0]?.costBasis.format()).toBe("10")
      expect(result.derivedLots[0]).toMatchObject({
        acquisitionEventId: ACQUISITION_TWO,
        custodyUnitId: SOURCE_TWO,
      })
    })
  )

  it.effect("keeps FIFO quantities when an acquisition basis is missing", () =>
    Effect.gen(function* () {
      const acquisitionWithoutBasis = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const acquisitionWithBasis = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_TWO,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "sale",
      })

      const result = yield* runCalculation({
        ledger: [disposition, acquisitionWithBasis, acquisitionWithoutBasis],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_TWO,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "known-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "100", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(
        result.allocations.map((allocation) => ({
          acquisitionEventId: allocation.acquisitionEventId,
          quantity: encodeQuantity(allocation.quantity),
          costBasis: allocation.costBasis?.format() ?? null,
        }))
      ).toEqual([
        { acquisitionEventId: ACQUISITION_ONE, quantity: "1", costBasis: null },
        { acquisitionEventId: ACQUISITION_TWO, quantity: "1", costBasis: "20" },
      ])
      expect(result.realizedResults).toHaveLength(1)
      expect(result.realizedResults[0]?.acquisitionEventId).toBe(ACQUISITION_TWO)
      expect(result.realizedResults[0]?.proceeds.format()).toBe("50")
      expect(result.realizedResults[0]?.gainLoss.format()).toBe("30")
      expect(result.blockers.map((blocker) => blocker.code)).toEqual(["missing_valuation"])
      expect(result.status).toBe("partial")
      expect(result.derivedLots).toEqual([])
    })
  )

  it.effect("blocks unknown causes without dropping their factual quantities", () =>
    Effect.gen(function* () {
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "unknown",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "unknown",
      })

      const result = yield* runCalculation({
        ledger: [disposition, acquisition],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: "acquisition",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "disposition",
          }),
        ],
      })

      expect(result.blockers.map((blocker) => [blocker.eventId, blocker.code])).toEqual([
        [ACQUISITION_ONE, "unknown_cause"],
        [DISPOSITION, "unknown_cause"],
      ])
      expect(result.allocations).toHaveLength(1)
      expect(result.derivedLots).toEqual([])
      expect(result.status).toBe("partial")
    })
  )

  it.effect("blocks an inventory suffix after shortage while unrelated keys continue", () =>
    Effect.gen(function* () {
      const firstShortage = "88888888-8888-4888-8888-888888888888"
      const laterAcquisition = "99999999-9999-4999-8999-999999999999"
      const blockedDisposition = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
      const unrelatedAcquisition = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
      const unrelatedDisposition = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"
      const ledger = [
        decodeEvent({
          _tag: "disposition",
          id: blockedDisposition,
          occurredAt: { epochMillis: 3_000 },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ONE,
          cause: "sale",
        }),
        decodeEvent({
          _tag: "acquisition",
          id: laterAcquisition,
          occurredAt: { epochMillis: 2_000 },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ONE,
          cause: "purchase",
        }),
        decodeEvent({
          _tag: "disposition",
          id: firstShortage,
          occurredAt: { epochMillis: 1_000 },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ONE,
          cause: "sale",
        }),
        decodeEvent({
          _tag: "acquisition",
          id: unrelatedAcquisition,
          occurredAt: { epochMillis: 1_500 },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_TWO,
          cause: "purchase",
        }),
        decodeEvent({
          _tag: "disposition",
          id: unrelatedDisposition,
          occurredAt: { epochMillis: 2_500 },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_TWO,
          cause: "sale",
        }),
      ]
      const valuationFacts = ledger
        .filter((event) => event._tag !== "custody_movement")
        .map((event) =>
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: event.id,
            amount: { amount: event._tag === "acquisition" ? "10" : "20", currency: "EUR" },
            evidenceReference: `valuation:${event.id}`,
          })
        )

      const result = yield* runCalculation({ ledger, valuationFacts })

      expect(result.blockers.map((blocker) => [blocker.eventId, blocker.code])).toEqual([
        [firstShortage, "inventory_shortage"],
        [blockedDisposition, "blocked_inventory_suffix"],
      ])
      expect(result.realizedResults.map((realized) => realized.dispositionEventId)).toEqual([
        unrelatedDisposition,
      ])
      expect(result.derivedLots).toHaveLength(1)
      expect(result.derivedLots[0]).toMatchObject({
        acquisitionEventId: laterAcquisition,
        custodyUnitId: SOURCE_ONE,
      })
      const remainingLot = result.derivedLots[0]

      if (remainingLot === undefined) {
        return expect.fail("expected one remaining lot")
      }

      expect(encodeQuantity(remainingLot.remainingQuantity)).toBe("1")
    })
  )

  it.effect("blocks both per-unit suffixes after a custody-movement shortage", () =>
    Effect.gen(function* () {
      const movementId = "88888888-8888-4888-8888-888888888888"
      const destinationAcquisition = "99999999-9999-4999-8999-999999999999"
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const movement = decodeEvent({
        _tag: "custody_movement",
        id: movementId,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "2",
        fromCustodySourceId: SOURCE_ONE,
        toCustodySourceId: SOURCE_TWO,
      })
      const laterAcquisition = decodeEvent({
        _tag: "acquisition",
        id: destinationAcquisition,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "purchase",
      })
      const blockedDisposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 4_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "sale",
      })
      const result = yield* runCalculation({
        ledger: [blockedDisposition, laterAcquisition, movement, acquisition],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: "source-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: destinationAcquisition,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "destination-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "30", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(result.blockers.map((blocker) => [blocker.eventId, blocker.code])).toEqual([
        [movementId, "movement_shortage"],
        [DISPOSITION, "blocked_inventory_suffix"],
      ])
      expect(result.realizedResults).toEqual([])
      expect(
        result.derivedLots.map((lot) => ({
          acquisitionEventId: lot.acquisitionEventId,
          custodyUnitId: lot.custodyUnitId,
          remainingQuantity: encodeQuantity(lot.remainingQuantity),
        }))
      ).toEqual([
        {
          acquisitionEventId: ACQUISITION_ONE,
          custodyUnitId: SOURCE_TWO,
          remainingQuantity: "1",
        },
        {
          acquisitionEventId: destinationAcquisition,
          custodyUnitId: SOURCE_TWO,
          remainingQuantity: "1",
        },
      ])
    })
  )

  it.effect("rejects broken and cyclic accounting-choice histories", () =>
    Effect.gen(function* () {
      const methodChoice = choices[0]

      if (methodChoice === undefined) {
        return expect.fail("method choice fixture is missing")
      }

      const broken = yield* calculate({
        ledger: [],
        custodyUnitMemberships: [],
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(1970),
        accountingChoices: [
          methodChoice,
          decodeChoice({
            _tag: "inventory_scope",
            id: "88888888-8888-4888-8888-888888888888",
            jurisdiction: "DE",
            scope: "per_custody_unit",
            recordedAt: { epochMillis: 2 },
            actor: "test",
            evidence: "fixture",
            supersedesChoiceId: "99999999-9999-4999-8999-999999999999",
          }),
        ],
        valuationFacts: [],
      }).pipe(Effect.flip)
      const cyclic = yield* calculate({
        ledger: [],
        custodyUnitMemberships: [],
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(1970),
        accountingChoices: [
          methodChoice,
          decodeChoice({
            _tag: "inventory_scope",
            id: "88888888-8888-4888-8888-888888888888",
            jurisdiction: "DE",
            scope: "per_custody_unit",
            recordedAt: { epochMillis: 2 },
            actor: "test",
            evidence: "fixture",
            supersedesChoiceId: "99999999-9999-4999-8999-999999999999",
          }),
          decodeChoice({
            _tag: "inventory_scope",
            id: "99999999-9999-4999-8999-999999999999",
            jurisdiction: "DE",
            scope: "whole_taxpayer",
            recordedAt: { epochMillis: 1 },
            actor: "test",
            evidence: "fixture",
            supersedesChoiceId: "88888888-8888-4888-8888-888888888888",
          }),
        ],
        valuationFacts: [],
      }).pipe(Effect.flip)

      expect(broken).toMatchObject({
        _tag: "AccountingChoiceResolutionError",
        choiceKind: "inventory_scope",
        reason: "broken_supersession",
      })
      expect(cyclic).toMatchObject({
        _tag: "AccountingChoiceResolutionError",
        choiceKind: "inventory_scope",
        reason: "cycle",
      })
    })
  )

  it.effect("prefers observed consideration and blocks ambiguous winning facts", () =>
    Effect.gen(function* () {
      const observedWinner = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const ambiguous = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_TWO,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const result = yield* runCalculation({
        ledger: [ambiguous, observedWinner],
        valuationFacts: [
          decodeValuationFact({
            _tag: "market_quote",
            eventId: ACQUISITION_ONE,
            unitPrice: { amount: "99", currency: "EUR" },
            quotedAt: { epochMillis: 1_000 },
            source: "market",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "provider",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_TWO,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: "provider-a",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_TWO,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "provider-b",
          }),
        ],
      })

      expect(result.derivedLots.map((lot) => lot.costBasisPerUnit?.format() ?? null)).toEqual([
        "10",
        null,
      ])
      expect(result.blockers.map((blocker) => [blocker.eventId, blocker.code])).toEqual([
        [ACQUISITION_TWO, "ambiguous_valuation"],
      ])
      expect(result.explanationTrace).toContainEqual(
        expect.objectContaining({
          eventId: ACQUISITION_ONE,
          code: "fifo_lot_created",
          valuationKind: "observed_consideration",
        })
      )
    })
  )

  it.effect("rejects whole-taxpayer scope before processing the ledger", () =>
    Effect.gen(function* () {
      const movementId = "88888888-8888-4888-8888-888888888888"
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const movement = decodeEvent({
        _tag: "custody_movement",
        id: movementId,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "9",
        fromCustodySourceId: SOURCE_ONE,
        toCustodySourceId: SOURCE_TWO,
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_TWO,
        cause: "sale",
      })
      const error = yield* calculate({
        ledger: [disposition, movement, acquisition],
        custodyUnitMemberships: [],
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(1970),
        accountingChoices: [
          decodeChoice({
            _tag: "accounting_method",
            id: "66666666-6666-4666-8666-666666666666",
            jurisdiction: "DE",
            method: "fifo",
            recordedAt: { epochMillis: 1 },
            actor: "test",
            evidence: "fixture",
          }),
          decodeChoice({
            _tag: "inventory_scope",
            id: "77777777-7777-4777-8777-777777777777",
            jurisdiction: "DE",
            scope: "whole_taxpayer",
            recordedAt: { epochMillis: 1 },
            actor: "test",
            evidence: "fixture",
          }),
        ],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: "basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: "IllegalAccountingChoiceError",
        jurisdiction: "DE",
        choiceKind: "inventory_scope",
        value: "whole_taxpayer",
      })
    })
  )

  it.effect("blocks mismatched valuation currencies once while consuming all FIFO quantities", () =>
    Effect.gen(function* () {
      const firstAcquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const secondAcquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_TWO,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "sale",
      })
      const result = yield* runCalculation({
        ledger: [disposition, secondAcquisition, firstAcquisition],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "10", currency: "USD" },
            evidenceReference: "first-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_TWO,
            amount: { amount: "20", currency: "USD" },
            evidenceReference: "second-basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "40", currency: "EUR" },
            evidenceReference: "sale",
          }),
        ],
      })

      expect(result.allocations).toHaveLength(2)
      expect(result.realizedResults).toEqual([])
      expect(result.blockers.map((blocker) => blocker.code)).toEqual([
        "valuation_currency_mismatch",
      ])
      expect(result.derivedLots).toEqual([])
    })
  )

  it.effect("continues FIFO after a disposition with missing proceeds", () =>
    Effect.gen(function* () {
      const unvaluedDisposition = "88888888-8888-4888-8888-888888888888"
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ONE,
        occurredAt: { epochMillis: 1_000 },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ONE,
        cause: "purchase",
      })
      const missingProceeds = decodeEvent({
        _tag: "disposition",
        id: unvaluedDisposition,
        occurredAt: { epochMillis: 2_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "sale",
      })
      const valuedDisposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION,
        occurredAt: { epochMillis: 3_000 },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ONE,
        cause: "sale",
      })
      const result = yield* runCalculation({
        ledger: [valuedDisposition, missingProceeds, acquisition],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: ACQUISITION_ONE,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "basis",
          }),
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: DISPOSITION,
            amount: { amount: "30", currency: "EUR" },
            evidenceReference: "later-sale",
          }),
        ],
      })

      expect(result.allocations.map((allocation) => allocation.dispositionEventId)).toEqual([
        unvaluedDisposition,
        DISPOSITION,
      ])
      expect(result.realizedResults.map((realized) => realized.dispositionEventId)).toEqual([
        DISPOSITION,
      ])
      expect(result.realizedResults[0]?.gainLoss.format()).toBe("20")
      expect(result.blockers.map((blocker) => [blocker.eventId, blocker.code])).toEqual([
        [unvaluedDisposition, "missing_valuation"],
      ])
      expect(result.derivedLots).toEqual([])
    })
  )

  it.effect("defaults missing choices and rejects multiple-active or illegal choices", () =>
    Effect.gen(function* () {
      const baseInput = {
        ledger: [],
        custodyUnitMemberships: [],
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(1970),
        valuationFacts: [],
      }
      const defaults = yield* calculate({ ...baseInput, accountingChoices: [] })
      const multiple = yield* calculate({
        ...baseInput,
        accountingChoices: [
          ...choices,
          decodeChoice({
            _tag: "accounting_method",
            id: "88888888-8888-4888-8888-888888888888",
            jurisdiction: "DE",
            method: "fifo",
            recordedAt: { epochMillis: 2 },
            actor: "test",
            evidence: "second active method",
          }),
        ],
      }).pipe(Effect.flip)
      const unsupported = yield* calculate({
        ...baseInput,
        accountingChoices: [
          decodeChoice({
            _tag: "accounting_method",
            id: "88888888-8888-4888-8888-888888888888",
            jurisdiction: "DE",
            method: "average_cost",
            recordedAt: { epochMillis: 2 },
            actor: "test",
            evidence: "new method",
            supersedesChoiceId: "66666666-6666-4666-8666-666666666666",
          }),
          ...choices,
        ],
      }).pipe(Effect.flip)

      expect(defaults).toMatchObject({
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
        appliedChoiceIds: [],
      })
      expect(multiple).toMatchObject({
        _tag: "AccountingChoiceResolutionError",
        choiceKind: "accounting_method",
        reason: "multiple_active",
      })
      expect(unsupported).toMatchObject({
        _tag: "IllegalAccountingChoiceError",
        jurisdiction: "DE",
        choiceKind: "accounting_method",
        value: "average_cost",
      })
    })
  )
})
