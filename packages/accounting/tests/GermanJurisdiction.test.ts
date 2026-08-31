import { describe, expect, it } from "@effect/vitest"
import {
  AccountingChoice,
  AccountingEvent,
  JurisdictionCode,
  TaxYear,
  ValuationFact,
  type AccountingChoice as AccountingChoiceType,
  type AccountingEvent as AccountingEventType,
  type ValuationFact as ValuationFactType,
} from "@my/core/accounting"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { calculate } from "../src/index.ts"

const decodeChoice = Schema.decodeUnknownSync(AccountingChoice)
const decodeEvent = Schema.decodeUnknownSync(AccountingEvent)
const decodeValuationFact = Schema.decodeUnknownSync(ValuationFact)

const ASSET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const SOURCE_ID = "11111111-1111-4111-8111-111111111111"
const ACQUISITION_ID = "22222222-2222-4222-8222-222222222222"
const DISPOSITION_ID = "33333333-3333-4333-8333-333333333333"

const calculateGerman = ({
  ledger = [],
  accountingChoices = [],
  valuationFacts = [],
  taxYear = 2025,
}: {
  readonly ledger?: ReadonlyArray<AccountingEventType>
  readonly accountingChoices?: ReadonlyArray<AccountingChoiceType>
  readonly valuationFacts?: ReadonlyArray<ValuationFactType>
  readonly taxYear?: number
} = {}) =>
  calculate({
    ledger,
    custodyUnitMemberships: [],
    jurisdiction: JurisdictionCode.make("DE"),
    taxYear: TaxYear.make(taxYear),
    accountingChoices,
    valuationFacts,
  })

const calculateDisposalTreatment = ({
  acquiredAt,
  disposedAt,
  cause = "sale",
}: {
  readonly acquiredAt: string
  readonly disposedAt: string
  readonly cause?: "payment" | "sale"
}) =>
  calculateGerman({
    ledger: [
      decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ID,
        occurredAt: { epochMillis: Date.parse(acquiredAt) },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause: "purchase",
      }),
      decodeEvent({
        _tag: "disposition",
        id: DISPOSITION_ID,
        occurredAt: { epochMillis: Date.parse(disposedAt) },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause,
      }),
    ],
    valuationFacts: [
      decodeValuationFact({
        _tag: "observed_consideration",
        eventId: ACQUISITION_ID,
        amount: { amount: "10", currency: "EUR" },
        evidenceReference: "purchase",
      }),
      decodeValuationFact({
        _tag: "observed_consideration",
        eventId: DISPOSITION_ID,
        amount: { amount: "20", currency: "EUR" },
        evidenceReference: "sale",
      }),
    ],
  })

describe("German private-assets jurisdiction", () => {
  it.effect("uses the German FIFO and per-custody-unit defaults", () =>
    Effect.gen(function* () {
      const result = yield* calculateGerman()

      expect(result).toMatchObject({
        status: "complete",
        jurisdiction: "DE",
        taxYear: 2025,
        ruleSetVersion: "de-crypto-income-tax-v2025-03-06",
        accountingMethod: "fifo",
        inventoryScope: "per_custody_unit",
        appliedChoiceIds: [],
      })
      expect(result.appliedRules).toEqual([
        "engine.event_order.occurred_at_then_id",
        "engine.inventory.fifo",
        "engine.inventory.per_custody_unit",
        "de.private.section23.disposal-within-one-year",
        "de.private.section23.wallet-fifo-method",
        "de.private.section22.staking-income",
      ])
    })
  )

  it.effect("records the exact legal German choices it applies", () =>
    Effect.gen(function* () {
      const methodChoiceId = "66666666-6666-4666-8666-666666666666"
      const scopeChoiceId = "77777777-7777-4777-8777-777777777777"
      const result = yield* calculateGerman({
        accountingChoices: [
          decodeChoice({
            _tag: "accounting_method",
            id: methodChoiceId,
            jurisdiction: "DE",
            method: "fifo",
            recordedAt: { epochMillis: 1 },
            actor: "test",
            evidence: "fixture",
          }),
          decodeChoice({
            _tag: "inventory_scope",
            id: scopeChoiceId,
            jurisdiction: "DE",
            scope: "per_custody_unit",
            recordedAt: { epochMillis: 2 },
            actor: "test",
            evidence: "fixture",
          }),
        ],
      })

      expect(result.appliedChoiceIds).toEqual([methodChoiceId, scopeChoiceId])
    })
  )

  it.effect("rejects a jurisdiction without an engine module", () =>
    Effect.gen(function* () {
      const error = yield* calculate({
        ledger: [],
        custodyUnitMemberships: [],
        jurisdiction: JurisdictionCode.make("US"),
        taxYear: TaxYear.make(2025),
        accountingChoices: [],
        valuationFacts: [],
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: "UnsupportedJurisdictionError",
        jurisdiction: "US",
      })
    })
  )

  it.effect("rejects a whole-taxpayer inventory choice for German private assets", () =>
    Effect.gen(function* () {
      const error = yield* calculateGerman({
        accountingChoices: [
          decodeChoice({
            _tag: "inventory_scope",
            id: "11111111-1111-4111-8111-111111111111",
            jurisdiction: "DE",
            scope: "whole_taxpayer",
            recordedAt: { epochMillis: 1 },
            actor: "test",
            evidence: "fixture",
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

  it.effect("rejects a non-FIFO accounting choice for German private assets", () =>
    Effect.gen(function* () {
      const error = yield* calculateGerman({
        accountingChoices: [
          decodeChoice({
            _tag: "accounting_method",
            id: "11111111-1111-4111-8111-111111111111",
            jurisdiction: "DE",
            method: "lifo",
            recordedAt: { epochMillis: 1 },
            actor: "test",
            evidence: "fixture",
          }),
        ],
      }).pipe(Effect.flip)

      expect(error).toMatchObject({
        _tag: "IllegalAccountingChoiceError",
        jurisdiction: "DE",
        choiceKind: "accounting_method",
        value: "lifo",
      })
    })
  )

  it.effect("selects German-year results and closing inventory in Europe/Berlin", () =>
    Effect.gen(function* () {
      const acquisitionId = "22222222-2222-4222-8222-222222222222"
      const priorYearDispositionId = "33333333-3333-4333-8333-333333333333"
      const targetYearDispositionId = "44444444-4444-4444-8444-444444444444"
      const followingYearDispositionId = "55555555-5555-4555-8555-555555555555"
      const ledger = [
        decodeEvent({
          _tag: "acquisition",
          id: acquisitionId,
          occurredAt: { epochMillis: Date.parse("2024-01-01T00:00:00.000Z") },
          assetId: ASSET_ID,
          quantity: "3",
          custodySourceId: SOURCE_ID,
          cause: "purchase",
        }),
        decodeEvent({
          _tag: "disposition",
          id: priorYearDispositionId,
          occurredAt: { epochMillis: Date.parse("2024-12-31T22:30:00.000Z") },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ID,
          cause: "sale",
        }),
        decodeEvent({
          _tag: "disposition",
          id: targetYearDispositionId,
          occurredAt: { epochMillis: Date.parse("2024-12-31T23:30:00.000Z") },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ID,
          cause: "sale",
        }),
        decodeEvent({
          _tag: "disposition",
          id: followingYearDispositionId,
          occurredAt: { epochMillis: Date.parse("2025-12-31T23:30:00.000Z") },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ID,
          cause: "sale",
        }),
      ]
      const valuationFacts = ledger.map((event) =>
        decodeValuationFact({
          _tag: "observed_consideration",
          eventId: event.id,
          amount: { amount: event._tag === "acquisition" ? "30" : "20", currency: "EUR" },
          evidenceReference: `valuation:${event.id}`,
        })
      )
      const result = yield* calculateGerman({ ledger, valuationFacts })

      expect(result.processedEventIds).toEqual([
        acquisitionId,
        priorYearDispositionId,
        targetYearDispositionId,
      ])
      expect(result.allocations.map((allocation) => allocation.dispositionEventId)).toEqual([
        targetYearDispositionId,
      ])
      expect(result.realizedResults.map((realized) => realized.dispositionEventId)).toEqual([
        targetYearDispositionId,
      ])
      expect(result.derivedLots).toHaveLength(1)
      expect(result.derivedLots[0]?.remainingQuantity.value).toBe(1n)
    })
  )

  it.effect("uses German civil-day boundaries for the one-year holding period", () =>
    Effect.gen(function* () {
      const scenarios = [
        {
          acquiredAt: "2024-03-01T08:00:00+01:00",
          disposedAt: "2025-03-01T23:59:59+01:00",
          treatmentCode: "de.taxable_private_disposal",
        },
        {
          acquiredAt: "2024-03-01T08:00:00+01:00",
          disposedAt: "2025-03-02T00:00:00+01:00",
          treatmentCode: "de.tax_free_holding_period",
        },
        {
          acquiredAt: "2024-02-29T12:00:00+01:00",
          disposedAt: "2025-03-01T00:00:00+01:00",
          treatmentCode: "de.tax_free_holding_period",
        },
        {
          acquiredAt: "2024-03-31T12:00:00+02:00",
          disposedAt: "2025-03-31T23:59:59+02:00",
          treatmentCode: "de.taxable_private_disposal",
        },
        {
          acquiredAt: "2024-03-31T12:00:00+02:00",
          disposedAt: "2025-04-01T00:00:00+02:00",
          treatmentCode: "de.tax_free_holding_period",
        },
      ] as const

      for (const scenario of scenarios) {
        const result = yield* calculateDisposalTreatment(scenario)

        expect(result.realizedResults[0]?.treatmentCodes).toEqual([scenario.treatmentCode])
      }
    })
  )

  it.effect("treats payment proceeds like sale and crypto-exchange proceeds", () =>
    Effect.gen(function* () {
      const result = yield* calculateDisposalTreatment({
        acquiredAt: "2025-01-01T12:00:00+01:00",
        disposedAt: "2025-06-01T12:00:00+02:00",
        cause: "payment",
      })

      expect(result.realizedResults[0]?.treatmentCodes).toEqual(["de.taxable_private_disposal"])
    })
  )

  it.effect("reports proven passive staking income at its German-year value", () =>
    Effect.gen(function* () {
      const event = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-06-01T12:00:00.000+02:00") },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ID,
        cause: "passive_staking_reward",
      })
      const result = yield* calculateGerman({
        ledger: [event],
        valuationFacts: [
          decodeValuationFact({
            _tag: "market_quote",
            eventId: ACQUISITION_ID,
            unitPrice: { amount: "12.50", currency: "EUR" },
            quotedAt: event.occurredAt,
            source: "fixture",
          }),
        ],
      })

      expect(result.incomeResults).toHaveLength(1)
      expect(result.incomeResults[0]).toMatchObject({
        eventId: ACQUISITION_ID,
        assetId: ASSET_ID,
        occurredAt: event.occurredAt,
        quantity: event.quantity,
        treatmentCodes: ["de.taxable_income_section22_3_staking"],
      })
      expect(result.incomeResults[0]?.value.format()).toBe("25")
      expect(result.derivedLots[0]?.costBasisPerUnit?.format()).toBe("12.5")
    })
  )

  it.effect("requires a value before reporting passive staking income", () =>
    Effect.gen(function* () {
      const result = yield* calculateGerman({
        ledger: [
          decodeEvent({
            _tag: "acquisition",
            id: ACQUISITION_ID,
            occurredAt: { epochMillis: Date.parse("2025-06-01T12:00:00.000+02:00") },
            assetId: ASSET_ID,
            quantity: "2",
            custodySourceId: SOURCE_ID,
            cause: "passive_staking_reward",
          }),
        ],
      })

      expect(result.incomeResults).toEqual([])
      expect(result.blockers.map(({ code }) => code)).toEqual(["missing_valuation"])
      expect(result.derivedLots[0]?.costBasisPerUnit).toBeNull()
    })
  )

  it.effect("blocks ambiguous German acquisition causes without inventing income or basis", () =>
    Effect.gen(function* () {
      const cases = [
        ["staking_reward", "de.staking_activity_classification_required"],
        ["mining_reward", "de.mining_activity_classification_required"],
        ["airdrop", "de.airdrop_classification_required"],
        ["reward", "de.reward_classification_required"],
        ["payment", "de.payment_income_classification_required"],
        ["gift", "de.gift_acquisition_basis_required"],
      ] as const
      const ledger = cases.map(([cause], index) =>
        decodeEvent({
          _tag: "acquisition",
          id: `22222222-2222-4222-8222-2222222222${String(index).padStart(2, "0")}`,
          occurredAt: { epochMillis: Date.parse(`2025-06-0${index + 1}T12:00:00.000+02:00`) },
          assetId: ASSET_ID,
          quantity: "1",
          custodySourceId: SOURCE_ID,
          cause,
        })
      )
      const valuationFacts = ledger.map((event) =>
        decodeValuationFact({
          _tag: "observed_consideration",
          eventId: event.id,
          amount: { amount: "10", currency: "EUR" },
          evidenceReference: `valuation:${event.id}`,
        })
      )
      const result = yield* calculateGerman({ ledger, valuationFacts })

      expect(result.blockers.map(({ code }) => code)).toEqual(cases.map(([, code]) => code))
      expect(result.incomeResults).toEqual([])
      expect(result.derivedLots).toHaveLength(cases.length)
      expect(result.derivedLots.every((lot) => lot.costBasisPerUnit === null)).toBe(true)
    })
  )

  it.effect("allocates gift and fee dispositions factually but blocks German results", () =>
    Effect.gen(function* () {
      const giftId = "33333333-3333-4333-8333-333333333333"
      const feeId = "44444444-4444-4444-8444-444444444444"
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-01-01T12:00:00.000+01:00") },
        assetId: ASSET_ID,
        quantity: "2",
        custodySourceId: SOURCE_ID,
        cause: "purchase",
      })
      const result = yield* calculateGerman({
        ledger: [
          acquisition,
          decodeEvent({
            _tag: "disposition",
            id: giftId,
            occurredAt: { epochMillis: Date.parse("2025-02-01T12:00:00.000+01:00") },
            assetId: ASSET_ID,
            quantity: "1",
            custodySourceId: SOURCE_ID,
            cause: "gift",
            transactionReference: "gift-transfer",
          }),
          decodeEvent({
            _tag: "disposition",
            id: feeId,
            occurredAt: { epochMillis: Date.parse("2025-03-01T12:00:00.000+01:00") },
            assetId: ASSET_ID,
            quantity: "1",
            custodySourceId: SOURCE_ID,
            cause: "fee",
            transactionReference: "linked-operation",
          }),
        ],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: acquisition.id,
            amount: { amount: "20", currency: "EUR" },
            evidenceReference: "purchase",
          }),
        ],
      })

      expect(result.allocations.map(({ dispositionEventId }) => dispositionEventId)).toEqual([
        giftId,
        feeId,
      ])
      expect(result.realizedResults).toEqual([])
      expect(result.blockers.map(({ code }) => code)).toEqual([
        "de.gift_disposition_classification_required",
        "de.fee_allocation_required",
      ])
    })
  )

  it.effect("preserves the T09 unknown-cause blocker without adding a German duplicate", () =>
    Effect.gen(function* () {
      const event = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-06-01T12:00:00.000+02:00") },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause: "unknown",
      })
      const result = yield* calculateGerman({
        ledger: [event],
        valuationFacts: [
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: event.id,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: "known-value",
          }),
        ],
      })

      expect(result.blockers.map(({ code }) => code)).toEqual(["unknown_cause"])
      expect(result.derivedLots[0]?.costBasisPerUnit?.format()).toBe("10")
    })
  )

  it.effect("preserves a factual unknown-disposition result without a German treatment", () =>
    Effect.gen(function* () {
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-01-01T12:00:00.000+01:00") },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause: "purchase",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-06-01T12:00:00.000+02:00") },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause: "unknown",
      })
      const result = yield* calculateGerman({
        ledger: [acquisition, disposition],
        valuationFacts: [acquisition, disposition].map((event) =>
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: event.id,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: `valuation:${event.id}`,
          })
        ),
      })

      expect(result.allocations.map(({ dispositionEventId }) => dispositionEventId)).toEqual([
        DISPOSITION_ID,
      ])
      expect(result.realizedResults).toHaveLength(1)
      expect(result.realizedResults[0]?.treatmentCodes).toEqual([])
      expect(result.blockers.map(({ code }) => code)).toEqual(["unknown_cause"])
    })
  )

  it.effect("preserves a factual result from unknown acquisition without German treatment", () =>
    Effect.gen(function* () {
      const acquisition = decodeEvent({
        _tag: "acquisition",
        id: ACQUISITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-01-01T12:00:00.000+01:00") },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause: "unknown",
      })
      const disposition = decodeEvent({
        _tag: "disposition",
        id: DISPOSITION_ID,
        occurredAt: { epochMillis: Date.parse("2025-06-01T12:00:00.000+02:00") },
        assetId: ASSET_ID,
        quantity: "1",
        custodySourceId: SOURCE_ID,
        cause: "sale",
      })
      const result = yield* calculateGerman({
        ledger: [acquisition, disposition],
        valuationFacts: [acquisition, disposition].map((event) =>
          decodeValuationFact({
            _tag: "observed_consideration",
            eventId: event.id,
            amount: { amount: "10", currency: "EUR" },
            evidenceReference: `valuation:${event.id}`,
          })
        ),
      })

      expect(result.realizedResults).toHaveLength(1)
      expect(result.realizedResults[0]?.treatmentCodes).toEqual([])
      expect(result.blockers.map(({ code }) => code)).toEqual(["unknown_cause"])
    })
  )
})
