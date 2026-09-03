import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CalculationRunRepositoryLive } from "../../src/layers/CalculationRunRepositoryLive.ts"
import { CalculationRunServiceLive } from "../../src/layers/CalculationRunServiceLive.ts"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { CalculationRunId } from "../../src/services/CalculationRunRepository.ts"
import { CalculationRunService } from "../../src/services/CalculationRunService.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  TEST_BTC_REPRESENTATION_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const SOURCE_USE_ID = "00000000-0000-4000-8000-000000000291"
const REPLACEMENT_ASSET_ID = "00000000-0000-4000-8000-000000000483"
const INCLUDED_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000721"
const BLOCKED_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000722"
const UNRESOLVED_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000723"
const EUR = CurrencyCode.make("EUR")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_override_application",
})

const runPg = context.runPg

const runFactualLedger = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const loadLedger = () =>
  runFactualLedger(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({ principalId: PRINCIPAL_ID, reportingCurrency: EUR })
    )
  )

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const recompute = (id: string) =>
  Effect.runPromise(
    context.runWithLayer({
      effect: Effect.flatMap(CalculationRunService, (service) =>
        service.recompute({
          id: CalculationRunId.make(id),
          principalId: PRINCIPAL_ID,
          jurisdiction: JurisdictionCode.make("DE"),
          taxYear: TaxYear.make(2025),
          reportingCurrency: EUR,
          accountingChoices: [],
        })
      ),
      layer: CalculationRunServiceTestLive,
    })
  )

const createOverride = ({
  kind,
  providerAssetRowId,
  replacementAssetId,
  replacementInclusion,
}: {
  readonly kind: "identity" | "inclusion"
  readonly providerAssetRowId: string
  readonly replacementAssetId?: string
  readonly replacementInclusion?: "included" | "excluded"
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: PRINCIPAL_ID,
        targetKind: "provider_asset",
        providerAssetRowId,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to create override target")

    yield* db.insert(schema.principalAssetOverrides).values({
      principalId: PRINCIPAL_ID,
      targetId: target.id,
      kind,
      operation: "create",
      inspectedSystemRevision: `application-${providerAssetRowId}-${kind}`,
      inspectedSystemIdentity: kind === "identity" ? "unresolved" : undefined,
      inspectedSystemInclusion: kind === "inclusion" ? "included" : undefined,
      replacementAssetId,
      replacementInclusion,
      actorUserId: TEST_USER_ID,
      reason: "Exercise the fact adapter override decision",
    })
  })

const seedProviderAsset = ({
  canonicalAssetId = TEST_BTC_ASSET_ID,
  exponent = 8,
  id,
  mappingStatus = "approved",
}: {
  readonly canonicalAssetId?: string | null
  readonly exponent?: number | null
  readonly id: string
  readonly mappingStatus?: "approved" | "excluded"
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z"))
    yield* db.insert(schema.providerAssets).values({
      id,
      provider: "coinbase",
      providerAssetId: `application-${id}`,
      currencyCode: "APP",
      name: "Application asset",
      exponent,
      providerType: "crypto",
      rawProviderPayload: { asset_id: id },
      evidenceRevision: 1,
      discoveredAt: occurredAt,
      retrievedAt: occurredAt,
    })
    if (canonicalAssetId === null) return

    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: id,
      mappingKind: "asset",
      canonicalAssetId,
      mappingStatus,
    })
  })

const seedProviderTransaction = ({
  externalId,
  inventoryAssetId = TEST_BTC_ASSET_ID,
  legId,
  providerAssetRowId,
  sourceRepresentationUseId,
}: {
  readonly externalId: string
  readonly inventoryAssetId?: string | null
  readonly legId?: string
  readonly providerAssetRowId: string
  readonly sourceRepresentationUseId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z"))
    const [rawRecord] = yield* db
      .insert(schema.sourceRecordsRaw)
      .values({
        sourceId: SOURCE_ID,
        provider: "coinbase",
        recordType: "transaction",
        externalRecordId: `${externalId}-raw`,
        occurredAt,
        payload: { id: externalId },
      })
      .returning({ id: schema.sourceRecordsRaw.id })
    if (rawRecord === undefined) return yield* Effect.die("Failed to create raw record")
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        externalId,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        principalId: PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Failed to create transaction")

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        transactionId: transaction.id,
        externalId: `${externalId}-provider-transfer`,
        providerAssetId: providerAssetRowId,
        sourceRepresentationUseId,
        timestamp: occurredAt,
        direction: "inbound",
        processingMode: "accounting_and_evidence",
        fromAccountRef: "provider",
        toAccountRef: "principal",
        amount: "1",
      })
      .returning({ id: schema.providerTransfers.id })
    if (providerTransfer === undefined) return yield* Effect.die("Failed to create provider fact")

    if (inventoryAssetId !== null) {
      yield* db.insert(schema.inventoryMovements).values({
        principalId: PRINCIPAL_ID,
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        transactionId: transaction.id,
        providerTransferId: providerTransfer.id,
        assetId: inventoryAssetId,
        timestamp: occurredAt,
        direction: "inbound",
        purpose: "principal",
        taxTreatment: "taxable",
        reconciliationStatus: "unmatched",
        amount: "1",
      })
    }

    if (legId !== undefined) {
      yield* db.insert(schema.transactionLegs).values({
        id: legId,
        sourceId: SOURCE_ID,
        sourceRawRecordId: rawRecord.id,
        externalId: `${externalId}-leg`,
        timestamp: occurredAt,
        principalId: PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        sourceRepresentationUseId,
        providerAssetRowId,
        amount: "1",
        kind: "acquisition",
        provenance: "deterministic",
        transactionId: transaction.id,
      })
    }

    return { providerTransferId: providerTransfer.id, transactionId: transaction.id }
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("principal asset override application", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        const fixture = yield* Effect.promise(() =>
          runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
        )
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineAssets({
              baseBlockchainId: fixture.baseBlockchainId,
              bitcoinBlockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [representation] = yield* db
                .select({
                  blockchainId: schema.assetRepresentations.blockchainId,
                  representationType: schema.assetRepresentations.type,
                  contractAddress: schema.assetRepresentations.contractAddress,
                  mintAddress: schema.assetRepresentations.mintAddress,
                })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
              if (representation === undefined) return yield* Effect.die("Missing representation")
              yield* db.insert(schema.sourceRepresentationUses).values({
                id: SOURCE_USE_ID,
                sourceId: SOURCE_ID,
                ...representation,
              })
              yield* db.insert(schema.assets).values({
                id: REPLACEMENT_ASSET_ID,
                name: "Principal replacement",
                symbol: "REPLACEMENT",
                type: "fungible",
              })
            })
          )
        )
      })
    )
  )

  it.effect("uses only the target recorded on each provider fact", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "identity",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              replacementAssetId: REPLACEMENT_ASSET_ID,
            })
            yield* seedProviderTransaction({
              externalId: "selected-provider-row",
              legId: "10000000-0000-4000-8000-000000000101",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
            yield* seedProviderTransaction({
              externalId: "same-shaped-provider-row",
              legId: "10000000-0000-4000-8000-000000000102",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            })
          })
        )
      )

      const storedTargets = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({
                providerAssetRowId: schema.transactionLegs.providerAssetRowId,
                sourceRepresentationUseId: schema.transactionLegs.sourceRepresentationUseId,
              })
              .from(schema.transactionLegs)
          })
        )
      )
      expect(storedTargets).toEqual(
        expect.arrayContaining([
          {
            providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            sourceRepresentationUseId: null,
          },
          {
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            sourceRepresentationUseId: null,
          },
        ])
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(
        Object.fromEntries(
          ledger.events.map((event) => [event.transactionReference, event.assetId])
        )
      ).toEqual({
        "selected-provider-row": REPLACEMENT_ASSET_ID,
        "same-shaped-provider-row": TEST_BTC_ASSET_ID,
      })
    })
  )

  it.effect("does not borrow provider identity for an exact-linked fact", () =>
    Effect.gen(function* () {
      const legId = "10000000-0000-4000-8000-000000000112"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "identity",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              replacementAssetId: REPLACEMENT_ASSET_ID,
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:30:00.000Z"))
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({
                sourceId: SOURCE_ID,
                blockchainId: representation.blockchainId,
                representationType: "token",
                contractAddress: "0x2222222222222222222222222222222222222222",
              })
              .returning({ id: schema.sourceRepresentationUses.id })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "exact-with-provider-identity",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (sourceUse === undefined || transaction === undefined) {
              return yield* Effect.die("Failed to create exact-link fixture")
            }
            yield* db.insert(schema.transactionLegs).values({
              id: legId,
              sourceId: SOURCE_ID,
              externalId: "exact-with-provider-identity-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              sourceRepresentationUseId: sourceUse.id,
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "unresolved_identity",
          eventId: legId,
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("uses exact catalog metadata instead of provider technical metadata", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            yield* seedProviderTransaction({
              externalId: "exact-catalog-metadata",
              legId: "10000000-0000-4000-8000-000000000115",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              sourceRepresentationUseId: SOURCE_USE_ID,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000115",
          assetId: TEST_BTC_ASSET_ID,
        }),
      ])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("keeps a Solana asset review partial until replay creates facts", () =>
    Effect.gen(function* () {
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:45:00.000Z"))
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const exactCoordinates = {
              blockchainId: representation.blockchainId,
              representationType: "token" as const,
              contractAddress: "0x3333333333333333333333333333333333333333",
            }
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({ sourceId: SOURCE_ID, ...exactCoordinates })
              .returning({ id: schema.sourceRepresentationUses.id })
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                ...exactCoordinates,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (sourceUse === undefined || target === undefined) {
              return yield* Effect.die("Failed to create pre-catalog exact target")
            }
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "solana-review-v1",
              inspectedSystemIdentity: "unresolved",
              replacementAssetId: REPLACEMENT_ASSET_ID,
              actorUserId: TEST_USER_ID,
              reason: "Resolve the exact Solana representation before replay",
            })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "solana-review-before-replay",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            const [providerTransfer] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "solana-review-provider-transfer",
                providerAssetId: INCLUDED_PROVIDER_ASSET_ID,
                sourceRepresentationUseId: sourceUse.id,
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "external",
                toAccountRef: "principal",
                amount: "1",
              })
              .returning({ id: schema.providerTransfers.id })
            if (providerTransfer === undefined) {
              return yield* Effect.die("Failed to create provider transfer")
            }
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              transactionId: transaction.id,
              sourceId: SOURCE_ID,
            })
            yield* db.insert(schema.transactionReviews).values({
              principalId: PRINCIPAL_ID,
              transactionId: transaction.id,
              needsReview: true,
              matchedLayer: "solana_asset_mapping",
            })
            return providerTransfer.id
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: providerTransferId,
            assetId: REPLACEMENT_ASSET_ID,
            providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("withholds the whole transaction when one recorded target is excluded", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "inclusion",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              replacementInclusion: "excluded",
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:00:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "atomic-exclusion",
                timestamp: occurredAt,
                transactionType: "swap_crypto_to_crypto",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values([
              {
                sourceId: SOURCE_ID,
                externalId: "atomic-exclusion-disposal",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                amount: "1",
                kind: "disposal" as const,
                provenance: "deterministic" as const,
                transactionId: transaction.id,
              },
              {
                sourceId: SOURCE_ID,
                externalId: "atomic-exclusion-acquisition",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                amount: "2",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                transactionId: transaction.id,
              },
            ])
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("blocks a fiat-linked accounting leg and its sibling", () =>
    Effect.gen(function* () {
      const fiatLegId = "10000000-0000-4000-8000-000000000116"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:05:00.000Z"))
            yield* db.insert(schema.providerAssets).values({
              id: INCLUDED_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "fiat-linked-accounting-leg",
              currencyCode: "EUR",
              name: "Euro",
              exponent: 2,
              providerType: "fiat",
              rawProviderPayload: { asset_id: "fiat-linked-accounting-leg" },
              evidenceRevision: 1,
              discoveredAt: occurredAt,
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              mappingKind: "fiat",
              canonicalFiatCurrency: "EUR",
              mappingStatus: "approved",
            })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "fiat-linked-accounting-transaction",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values([
              {
                id: fiatLegId,
                sourceId: SOURCE_ID,
                externalId: "fiat-linked-accounting-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                amount: "1",
                kind: "disposal" as const,
                provenance: "deterministic" as const,
                transactionId: transaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000117",
                sourceId: SOURCE_ID,
                externalId: "fiat-linked-crypto-sibling",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                sourceRepresentationUseId: SOURCE_USE_ID,
                amount: "1",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                transactionId: transaction.id,
              },
            ])
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: fiatLegId,
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("preflights a suppressed internal-transfer leg before its sibling", () =>
    Effect.gen(function* () {
      const internalLegId = "10000000-0000-4000-8000-000000000118"
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:10:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "blocked-internal-transfer-transaction",
                timestamp: occurredAt,
                transactionType: "internal_transfer",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values([
              {
                id: internalLegId,
                sourceId: SOURCE_ID,
                externalId: "blocked-internal-transfer-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                amount: "1",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                derivationRule: "internal_transfer_in" as const,
                transactionId: transaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000119",
                sourceId: SOURCE_ID,
                externalId: "internal-transfer-sibling",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                sourceRepresentationUseId: SOURCE_USE_ID,
                amount: "1",
                kind: "disposal" as const,
                provenance: "deterministic" as const,
                transactionId: transaction.id,
              },
            ])
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          eventId: internalLegId,
          providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("withholds a fee transaction and the operation it paid for together", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "inclusion",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              replacementInclusion: "excluded",
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:15:00.000Z"))
            const [operation] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "fee-atomic-operation",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            const [feeTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "fee-atomic-fee",
                timestamp: occurredAt,
                transactionType: "gas_fee",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (operation === undefined || feeTransaction === undefined) {
              return yield* Effect.die("Failed to create fee transaction fixtures")
            }
            yield* db.insert(schema.transactionLegs).values([
              {
                id: "10000000-0000-4000-8000-000000000110",
                sourceId: SOURCE_ID,
                externalId: "fee-atomic-operation-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                sourceRepresentationUseId: SOURCE_USE_ID,
                amount: "1",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                transactionId: operation.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000111",
                sourceId: SOURCE_ID,
                externalId: "fee-atomic-fee-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                amount: "0.01",
                kind: "fee" as const,
                provenance: "deterministic" as const,
                transactionId: feeTransaction.id,
                feeForTransactionId: operation.id,
              },
            ])
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("withholds a transactionless fee with its excluded operation", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            yield* createOverride({
              kind: "inclusion",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              replacementInclusion: "excluded",
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:20:00.000Z"))
            const [operation] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "transactionless-fee-operation",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (operation === undefined) return yield* Effect.die("Failed to create operation")
            yield* db.insert(schema.transactionLegs).values([
              {
                id: "10000000-0000-4000-8000-000000000113",
                sourceId: SOURCE_ID,
                externalId: "transactionless-fee-operation-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
                amount: "1",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                transactionId: operation.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000114",
                sourceId: SOURCE_ID,
                externalId: "transactionless-fee-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                sourceRepresentationUseId: SOURCE_USE_ID,
                amount: "0.01",
                kind: "fee" as const,
                provenance: "deterministic" as const,
                feeForTransactionId: operation.id,
              },
            ])
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("lets exact inclusion reverse representation spam but not global exclusion", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:30:00.000Z"))
            yield* db
              .update(schema.assetRepresentations)
              .set({ isSpam: true })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "exact-inclusion",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            yield* db.insert(schema.transactionLegs).values({
              id: "10000000-0000-4000-8000-000000000106",
              sourceId: SOURCE_ID,
              externalId: "exact-inclusion-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              sourceRepresentationUseId: SOURCE_USE_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
            })
          })
        )
      )
      expect((yield* Effect.promise(loadLedger)).events).toEqual([])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                representationType: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing representation")
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                ...representation,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to create target")
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "inclusion",
              operation: "create",
              inspectedSystemRevision: "exact-inclusion-v1",
              inspectedSystemInclusion: "excluded",
              replacementInclusion: "included",
              actorUserId: TEST_USER_ID,
              reason: "Include this exact representation for the principal",
            })
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events.map(({ id }) => id)).toEqual(["10000000-0000-4000-8000-000000000106"])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: INCLUDED_PROVIDER_ASSET_ID,
              mappingStatus: "excluded",
            })
            const db = yield* drizzle
            yield* db
              .update(schema.transactionLegs)
              .set({ providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID })
              .where(eq(schema.transactionLegs.id, "10000000-0000-4000-8000-000000000106"))
          })
        )
      )

      expect((yield* Effect.promise(loadLedger)).events).toEqual([])
    })
  )

  it.effect("handles pre-catalog, deleted, and fiat targets only through recorded links", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T11:45:00.000Z"))
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const exactCoordinates = {
              blockchainId: representation.blockchainId,
              representationType: "token" as const,
              contractAddress: "0x1111111111111111111111111111111111111111",
            }
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({ sourceId: SOURCE_ID, ...exactCoordinates })
              .returning({ id: schema.sourceRepresentationUses.id })
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                ...exactCoordinates,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (sourceUse === undefined || target === undefined) {
              return yield* Effect.die("Failed to create pre-catalog target")
            }
            const [identityOverride] = yield* db
              .insert(schema.principalAssetOverrides)
              .values({
                principalId: PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "pre-catalog-v1",
                inspectedSystemIdentity: "unresolved",
                replacementAssetId: REPLACEMENT_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Resolve an exact representation before the global catalog",
              })
              .returning({ id: schema.principalAssetOverrides.id })
            if (identityOverride === undefined) {
              return yield* Effect.die("Failed to create pre-catalog override")
            }
            const [preCatalogTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "pre-catalog-exact",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (preCatalogTransaction === undefined) {
              return yield* Effect.die("Failed to create pre-catalog transaction")
            }
            yield* db.insert(schema.transactionLegs).values({
              id: "10000000-0000-4000-8000-000000000107",
              sourceId: SOURCE_ID,
              externalId: "pre-catalog-exact-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: REPLACEMENT_ASSET_ID,
              sourceRepresentationUseId: sourceUse.id,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: preCatalogTransaction.id,
            })

            yield* db.insert(schema.providerAssets).values({
              id: INCLUDED_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "fiat-eur",
              currencyCode: "EUR",
              name: "Euro",
              exponent: 2,
              providerType: "fiat",
              rawProviderPayload: { asset_id: "fiat-eur" },
              evidenceRevision: 1,
              discoveredAt: occurredAt,
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              mappingKind: "fiat",
              canonicalFiatCurrency: "EUR",
              mappingStatus: "approved",
            })
            const fiat = yield* seedProviderTransaction({
              externalId: "ignored-fiat-provider-fact",
              inventoryAssetId: null,
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
            yield* db.insert(schema.transactionLegs).values({
              id: "10000000-0000-4000-8000-000000000109",
              sourceId: SOURCE_ID,
              externalId: "crypto-sibling-of-fiat-evidence",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              sourceRepresentationUseId: SOURCE_USE_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: fiat.transactionId,
            })

            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID })
            const deleted = yield* seedProviderTransaction({
              externalId: "deleted-provider-row",
              legId: "10000000-0000-4000-8000-000000000108",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            })
            yield* db
              .delete(schema.providerAssetMappings)
              .where(eq(schema.providerAssetMappings.providerAssetRowId, BLOCKED_PROVIDER_ASSET_ID))
            yield* db
              .delete(schema.providerAssets)
              .where(eq(schema.providerAssets.id, BLOCKED_PROVIDER_ASSET_ID))
            return {
              deletedProviderTransferId: deleted.providerTransferId,
              preCatalogOverrideId: identityOverride.id,
              preCatalogTargetId: target.id,
            }
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000107",
          assetId: REPLACEMENT_ASSET_ID,
        }),
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000109",
          assetId: TEST_BTC_ASSET_ID,
        }),
      ])
      expect(ledger.inputBlockers.filter(({ code }) => code === "malformed_movement")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventId: ids.deletedProviderTransferId }),
          expect.objectContaining({ eventId: "10000000-0000-4000-8000-000000000108" }),
        ])
      )
      expect(
        ledger.inputBlockers.some(
          (blocker) =>
            "providerAssetRowId" in blocker &&
            blocker.providerAssetRowId === INCLUDED_PROVIDER_ASSET_ID
        )
      ).toBe(false)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: ids.preCatalogTargetId,
              kind: "identity",
              operation: "withdraw",
              inspectedSystemRevision: "pre-catalog-v1",
              inspectedSystemIdentity: "unresolved",
              actorUserId: TEST_USER_ID,
              reason: "Return the pre-catalog target to its unresolved system identity",
              supersedesOverrideId: ids.preCatalogOverrideId,
            })
          })
        )
      )

      const withdrawnLedger = yield* Effect.promise(loadLedger)
      expect(withdrawnLedger.events.map(({ id }) => id)).toEqual([
        "10000000-0000-4000-8000-000000000109",
      ])
      expect(withdrawnLedger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unresolved_identity",
            eventId: "10000000-0000-4000-8000-000000000107",
            assetId: REPLACEMENT_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("turns unresolved, technically blocked, and linkless facts into typed blockers", () =>
    Effect.gen(function* () {
      const targets = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const missingDecimals = yield* seedProviderTransaction({
              externalId: "missing-decimals",
              legId: "10000000-0000-4000-8000-000000000103",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
            })
            const unresolved = yield* seedProviderTransaction({
              externalId: "unresolved-provider-row",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T12:00:00.000Z"))
            const [rawRecord] = yield* db
              .insert(schema.sourceRecordsRaw)
              .values({
                sourceId: SOURCE_ID,
                provider: "coinbase",
                recordType: "transaction",
                externalRecordId: "linkless-leg",
                occurredAt,
                payload: { id: "linkless-leg" },
              })
              .returning({ id: schema.sourceRecordsRaw.id })
            if (rawRecord === undefined) return yield* Effect.die("Failed to create raw record")
            const [linkless] = yield* db
              .insert(schema.transactionLegs)
              .values({
                id: "10000000-0000-4000-8000-000000000104",
                sourceId: SOURCE_ID,
                sourceRawRecordId: rawRecord.id,
                externalId: "linkless-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
              })
              .returning({ id: schema.transactionLegs.id })
            if (linkless === undefined) return yield* Effect.die("Failed to create linkless leg")
            return { linkless, missingDecimals, unresolved }
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: targets.linkless.id,
            assetId: TEST_BTC_ASSET_ID,
          }),
          expect.objectContaining({
            code: "missing_decimals",
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
          }),
          expect.objectContaining({
            code: "unresolved_identity",
            assetId: null,
            providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("preflights a finalized reconciliation that lacks a canonical transfer", () =>
    Effect.gen(function* () {
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: BLOCKED_PROVIDER_ASSET_ID, exponent: null })
            const db = yield* drizzle
            const [representation] = yield* db
              .select({ blockchainId: schema.assetRepresentations.blockchainId })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing blockchain")
            const [sourceUse] = yield* db
              .insert(schema.sourceRepresentationUses)
              .values({
                sourceId: SOURCE_ID,
                blockchainId: representation.blockchainId,
                representationType: "token",
                contractAddress: "0x3333333333333333333333333333333333333333",
              })
              .returning({ id: schema.sourceRepresentationUses.id })
            if (sourceUse === undefined) return yield* Effect.die("Failed to create source use")
            const fact = yield* seedProviderTransaction({
              externalId: "incomplete-finalized-reconciliation",
              providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
              sourceRepresentationUseId: sourceUse.id,
            })
            yield* db.insert(schema.transferReconciliations).values({
              principalId: PRINCIPAL_ID,
              providerTransferId: fact.providerTransferId,
              canonicalTransactionId: fact.transactionId,
              status: "approved",
              matchReason: "Incomplete approved fixture",
            })
            return fact.providerTransferId
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "missing_decimals",
            eventId: providerTransferId,
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
          }),
          expect.objectContaining({
            code: "unresolved_identity",
            eventId: providerTransferId,
            providerAssetRowId: BLOCKED_PROVIDER_ASSET_ID,
          }),
        ])
      )
    })
  )

  it.effect("returns a blocker for a review-only provider use behind evidence", () =>
    Effect.gen(function* () {
      const transactionId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T12:15:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "review-only-provider-use",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) {
              return yield* Effect.die("Failed to create review-only transaction")
            }
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
              transactionId: transaction.id,
              sourceId: SOURCE_ID,
            })
            yield* db.insert(schema.providerTransfers).values({
              sourceId: SOURCE_ID,
              transactionId: transaction.id,
              externalId: "review-only-evidence",
              providerAssetId: UNRESOLVED_PROVIDER_ASSET_ID,
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "evidence_only",
              fromAccountRef: "provider",
              toAccountRef: "principal",
              amount: "1",
            })
            yield* db.insert(schema.transactionReviews).values({
              principalId: PRINCIPAL_ID,
              transactionId: transaction.id,
              needsReview: true,
              matchedLayer: "provider_asset_mapping",
            })
            return transaction.id
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "unresolved_identity",
          eventId: transactionId,
          assetId: null,
          providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("does not let a sibling leg suppress an open provider use", () =>
    Effect.gen(function* () {
      const ids = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T12:30:00.000Z"))
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "open-use-with-sibling-leg",
                timestamp: occurredAt,
                transactionType: "trade_other",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) return yield* Effect.die("Failed to create transaction")
            const [leg] = yield* db
              .insert(schema.transactionLegs)
              .values({
                sourceId: SOURCE_ID,
                externalId: "open-use-sibling-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: transaction.id,
              })
              .returning({ id: schema.transactionLegs.id })
            if (leg === undefined) return yield* Effect.die("Failed to create sibling leg")
            yield* db.insert(schema.providerAssetTransactionUses).values({
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
              transactionId: transaction.id,
              sourceId: SOURCE_ID,
            })
            yield* db.insert(schema.transactionReviews).values({
              principalId: PRINCIPAL_ID,
              transactionId: transaction.id,
              needsReview: true,
              matchedLayer: "provider_asset_mapping",
            })
            return { legId: leg.id, transactionId: transaction.id }
          })
        )
      )

      const ledger = yield* Effect.promise(loadLedger)
      expect(ledger.events.some(({ id }) => id === ids.legId)).toBe(false)
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: ids.transactionId,
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("fails instead of reporting complete when deletion erases every blocker link", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            yield* seedProviderTransaction({
              externalId: "deleted-targetless-provider-row",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            const db = yield* drizzle
            yield* db
              .delete(schema.providerAssets)
              .where(eq(schema.providerAssets.id, UNRESOLVED_PROVIDER_ASSET_ID))
          })
        )
      )

      yield* Effect.promise(() =>
        expect(loadLedger()).rejects.toMatchObject({
          operation: "factualLedgerRepository.load.unaddressableBlocker",
        })
      )
    })
  )

  it.effect("stores adapter blockers on a partial calculation run", () =>
    Effect.gen(function* () {
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({
              id: UNRESOLVED_PROVIDER_ASSET_ID,
              canonicalAssetId: null,
            })
            const fact = yield* seedProviderTransaction({
              externalId: "partial-run-unresolved",
              inventoryAssetId: null,
              providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
            })
            return fact.providerTransferId
          })
        )
      )

      yield* Effect.promise(() => recompute("00000000-0000-4000-8000-000000000921"))
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [run] = yield* db
              .select({ status: schema.calculationRuns.status })
              .from(schema.calculationRuns)
              .where(eq(schema.calculationRuns.id, "00000000-0000-4000-8000-000000000921"))
            const blockers = yield* db
              .select({
                code: schema.calculationRunBlockers.code,
                eventId: schema.calculationRunBlockers.eventId,
                assetId: schema.calculationRunBlockers.assetId,
                providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
              })
              .from(schema.calculationRunBlockers)
              .where(
                eq(schema.calculationRunBlockers.runId, "00000000-0000-4000-8000-000000000921")
              )
            return { blockers, run }
          })
        )
      )

      expect(stored.run?.status).toBe("partial")
      expect(stored.blockers).toEqual([
        {
          code: "unresolved_identity",
          eventId: providerTransferId,
          assetId: null,
          providerAssetRowId: UNRESOLVED_PROVIDER_ASSET_ID,
        },
      ])
    })
  )

  it.effect("changes the factual hash when a no-op override record is added", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedProviderAsset({ id: INCLUDED_PROVIDER_ASSET_ID })
            yield* seedProviderTransaction({
              externalId: "revision-provider-fact",
              legId: "10000000-0000-4000-8000-000000000105",
              providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            })
          })
        )
      )
      yield* Effect.promise(() => recompute("00000000-0000-4000-8000-000000000922"))

      yield* Effect.promise(() =>
        runPg(
          createOverride({
            kind: "inclusion",
            providerAssetRowId: INCLUDED_PROVIDER_ASSET_ID,
            replacementInclusion: "included",
          })
        )
      )
      yield* Effect.promise(() => recompute("00000000-0000-4000-8000-000000000923"))

      const revisions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ revision: schema.calculationRuns.inputLedgerRevision })
              .from(schema.calculationRuns)
          })
        )
      )
      const hashes = revisions.map(({ revision }) => revision.split(":").at(-1))
      expect(hashes).toHaveLength(2)
      expect(hashes[0]).not.toBe(hashes[1])
    })
  )
})
