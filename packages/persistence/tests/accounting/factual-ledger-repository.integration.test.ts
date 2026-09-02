import { beforeEach, describe, expect, it } from "@effect/vitest"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { eq } from "drizzle-orm"
import * as BigDecimal from "effect/BigDecimal"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { FactualLedgerRepositoryLive } from "../../src/layers/FactualLedgerRepositoryLive.ts"
import { drizzle } from "../../src/layers/PgClientLive.ts"
import { schema } from "../../src/schema/index.ts"
import { FactualLedgerRepository } from "../../src/services/FactualLedgerRepository.ts"
import {
  TEST_BTC_ASSET_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const TEST_CUSTODY_SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const TEST_DESTINATION_SOURCE_ID = "00000000-0000-4000-8000-000000000282"
const TEST_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000184"
const OTHER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000185")
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000283"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_factual_ledger_repo",
})

const runPg = context.runPg

const runRepository = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const loadFactualLedgerInCurrency = (reportingCurrency: CurrencyCode) =>
  runRepository(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({
        principalId: TEST_PRINCIPAL_ID,
        reportingCurrency,
      })
    )
  )

const loadFactualLedger = () => loadFactualLedgerInCurrency(CurrencyCode.make("EUR"))

const loadFactualLedgerError = (reportingCurrency = CurrencyCode.make("EUR")) =>
  runRepository(
    Effect.flip(
      Effect.flatMap(FactualLedgerRepository, (repository) =>
        repository.load({
          principalId: TEST_PRINCIPAL_ID,
          reportingCurrency,
        })
      )
    )
  )

const seedCexSource = ({
  sourceId,
  fixtureName,
}: {
  readonly sourceId: string
  readonly fixtureName: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [existingAccount] = yield* db
      .select({ cexId: schema.cexAccount.cexId })
      .from(schema.cexAccount)
      .where(eq(schema.cexAccount.principalId, TEST_PRINCIPAL_ID))
      .limit(1)

    if (existingAccount === undefined) {
      return yield* Effect.die("Missing source account fixture")
    }

    const [account] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: existingAccount.cexId,
        principalId: TEST_PRINCIPAL_ID,
        providerUserId: `${fixtureName}-user`,
        providerAccountId: `${fixtureName}-account`,
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-04T10:00:00.000Z")),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })

    if (account === undefined) {
      return yield* Effect.die(`Failed to create account for ${fixtureName}`)
    }

    yield* db.insert(schema.sources).values({
      id: sourceId,
      principalId: TEST_PRINCIPAL_ID,
      name: fixtureName,
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: account.id,
    })
  })

const seedCustodyReconciliation = ({
  reconciliationId,
  fixtureName,
  providerSourceId,
  canonicalSourceId,
  providerTimestamp,
  canonicalTimestamp,
  direction,
  amount,
  canonicalAmount,
  reconciliationStatus,
  status,
  deterministic,
  providerTransferSourceId,
  inventorySourceId,
  canonicalTransferSourceId,
}: {
  readonly reconciliationId: string
  readonly fixtureName: string
  readonly providerSourceId: string
  readonly canonicalSourceId: string
  readonly providerTimestamp: Date
  readonly canonicalTimestamp: Date
  readonly direction: "inbound" | "outbound"
  readonly amount: string
  readonly canonicalAmount?: string
  readonly reconciliationStatus: "matched" | "unmatched"
  readonly status: "approved" | "auto_applied" | "pending"
  readonly deterministic: boolean
  readonly providerTransferSourceId?: string
  readonly inventorySourceId?: string
  readonly canonicalTransferSourceId?: string
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const [providerTransaction, canonicalTransaction] = yield* db
      .insert(schema.transactions)
      .values([
        {
          sourceId: providerSourceId,
          externalId: `${fixtureName}-provider-transaction`,
          timestamp: providerTimestamp,
          transactionType: "internal_transfer",
          principalId: TEST_PRINCIPAL_ID,
        },
        {
          sourceId: canonicalSourceId,
          externalId: `${fixtureName}-canonical-transaction`,
          timestamp: canonicalTimestamp,
          transactionType: "internal_transfer",
          principalId: TEST_PRINCIPAL_ID,
        },
      ])
      .returning({ id: schema.transactions.id })

    if (providerTransaction === undefined || canonicalTransaction === undefined) {
      return yield* Effect.die(`Failed to create transactions for ${fixtureName}`)
    }

    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: providerTransferSourceId ?? providerSourceId,
        transactionId: providerTransaction.id,
        externalId: `${fixtureName}-provider-transfer`,
        timestamp: providerTimestamp,
        direction,
        processingMode: "accounting_only",
        fromAccountRef: "own:origin",
        toAccountRef: "own:destination",
        amount,
      })
      .returning({ id: schema.providerTransfers.id })
    const [canonicalTransfer] = yield* db
      .insert(schema.transfers)
      .values({
        sourceId: canonicalTransferSourceId ?? canonicalSourceId,
        principalId: TEST_PRINCIPAL_ID,
        externalId: `${fixtureName}-canonical-transfer`,
        timestamp: canonicalTimestamp,
        type: "cex",
        fromAccountRef: "own:origin",
        toAccountRef: "own:destination",
        assetId: TEST_BTC_ASSET_ID,
        amount: canonicalAmount ?? amount,
      })
      .returning({ id: schema.transfers.id })

    if (providerTransfer === undefined || canonicalTransfer === undefined) {
      return yield* Effect.die(`Failed to create transfers for ${fixtureName}`)
    }

    yield* db.insert(schema.inventoryMovements).values({
      principalId: TEST_PRINCIPAL_ID,
      sourceId: inventorySourceId ?? providerSourceId,
      transactionId: providerTransaction.id,
      providerTransferId: providerTransfer.id,
      assetId: TEST_BTC_ASSET_ID,
      timestamp: providerTimestamp,
      direction,
      purpose: "principal",
      taxTreatment: "non_taxable",
      reconciliationStatus,
      amount,
    })
    yield* db.insert(schema.transferReconciliations).values({
      id: reconciliationId,
      principalId: TEST_PRINCIPAL_ID,
      providerTransferId: providerTransfer.id,
      canonicalTransferId: canonicalTransfer.id,
      canonicalTransactionId: canonicalTransaction.id,
      status,
      matchReason: `${fixtureName} integration fixture`,
      confidence: status === "pending" ? "0.5" : "1",
      deterministic,
    })

    return {
      providerTransactionId: providerTransaction.id,
      canonicalTransactionId: canonicalTransaction.id,
    }
  })

await Effect.runPromise(context.recreateTestDatabase())

describe("FactualLedgerRepositoryLive", () => {
  beforeEach(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* context.recreateTestDatabase()
        const fixture = yield* Effect.promise(() =>
          runPg(
            seedSyncEngineRepositoryFixture({
              principalId: TEST_PRINCIPAL_ID,
              sourceId: TEST_CUSTODY_SOURCE_ID,
            })
          )
        )
        yield* Effect.promise(() =>
          runPg(
            seedSyncEngineAssets({
              baseBlockchainId: fixture.baseBlockchainId,
              bitcoinBlockchainId: fixture.bitcoinBlockchainId,
            })
          )
        )
      })
    )
  )

  it.effect("loads stored legs as a deterministically ordered factual ledger", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [purchaseTransaction, saleTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-purchase",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "factual-ledger-sale",
                  timestamp: occurredAt,
                  transactionType: "sell_fiat",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (purchaseTransaction === undefined || saleTransaction === undefined) {
              return yield* Effect.die("Failed to create factual ledger transactions")
            }

            yield* db.insert(schema.transactionLegs).values([
              {
                id: "10000000-0000-4000-8000-000000000002",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "factual-ledger-purchase-leg",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1.25",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: purchaseTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000001",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "factual-ledger-sale-leg",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.5",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: saleTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000003",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "factual-ledger-sale-acquisition-leg",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.75",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: saleTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000004",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "factual-ledger-purchase-disposition-leg",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.25",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: purchaseTransaction.id,
              },
            ])
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(
        result.events.map((event) => ({
          id: event.id,
          type: event._tag,
          cause: event._tag === "custody_movement" ? null : event.cause,
          transactionReference: event.transactionReference,
        }))
      ).toEqual([
        {
          id: "10000000-0000-4000-8000-000000000001",
          type: "disposition",
          cause: "sale",
          transactionReference: "factual-ledger-sale",
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          type: "acquisition",
          cause: "purchase",
          transactionReference: "factual-ledger-purchase",
        },
        {
          id: "10000000-0000-4000-8000-000000000003",
          type: "acquisition",
          cause: "purchase",
          transactionReference: "factual-ledger-sale",
        },
        {
          id: "10000000-0000-4000-8000-000000000004",
          type: "disposition",
          cause: "sale",
          transactionReference: "factual-ledger-purchase",
        },
      ])
      expect(
        BigDecimal.equals(
          result.events[0]?.quantity ?? BigDecimal.fromBigInt(0n),
          BigDecimal.fromStringUnsafe("0.5")
        )
      ).toBe(true)
      expect(
        BigDecimal.equals(
          result.events[1]?.quantity ?? BigDecimal.fromBigInt(0n),
          BigDecimal.fromStringUnsafe("1.25")
        )
      ).toBe(true)
      expect(result.valuationFacts).toEqual([])
    })
  )

  it.effect("links a fee disposition to the operation it paid for", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [operation, feeTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "paid-operation",
                  timestamp: occurredAt,
                  transactionType: "swap_crypto_to_crypto",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "fee-transaction",
                  timestamp: occurredAt,
                  transactionType: "gas_fee",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (operation === undefined || feeTransaction === undefined) {
              return yield* Effect.die("Failed to create fee transaction fixtures")
            }

            yield* db.insert(schema.transactionLegs).values({
              id: "10000000-0000-4000-8000-000000000005",
              sourceId: TEST_CUSTODY_SOURCE_ID,
              externalId: "paid-operation-fee-leg",
              timestamp: occurredAt,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "0.01",
              kind: "fee",
              provenance: "deterministic",
              transactionId: feeTransaction.id,
              feeForTransactionId: operation.id,
            })
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toEqual([
        expect.objectContaining({
          _tag: "disposition",
          cause: "fee",
          transactionReference: "paid-operation",
        }),
      ])
    })
  )

  it.effect("fails non-positive leg quantities through the repository error channel", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T11:00:00.000Z"))

      for (const [id, amount] of [
        ["10000000-0000-4000-8000-000000000006", "0"],
        ["10000000-0000-4000-8000-000000000007", "-1"],
      ] as const) {
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.insert(schema.transactionLegs).values({
                id,
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: `invalid-quantity-${amount}`,
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount,
                kind: "acquisition",
                provenance: "deterministic",
              })
            })
          )
        )

        const error = yield* Effect.promise(() => loadFactualLedgerError())
        expect(error).toMatchObject({
          _tag: "PersistenceError",
          operation: "factualLedgerRepository.load.event",
        })

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db.delete(schema.transactionLegs).where(eq(schema.transactionLegs.id, id))
            })
          )
        )
      }
    })
  )

  it.effect("fails a zero canonical-transfer quantity through the repository error channel", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T12:00:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T12:02:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Zero-quantity destination source",
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000008",
              fixtureName: "zero-quantity-custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "1",
              canonicalAmount: "0",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
          })
        )
      )

      const error = yield* Effect.promise(() => loadFactualLedgerError())
      expect(error).toMatchObject({
        _tag: "PersistenceError",
        operation: "factualLedgerRepository.load.event",
      })
    })
  )

  it.effect("rejects an unsupported reporting currency through the repository error channel", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-04T13:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "unsupported-reporting-currency",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerFiatAmount: "100",
                providerFiatCurrency: "NOK",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })

            if (transaction === undefined) {
              return yield* Effect.die("Failed to create unsupported-currency transaction")
            }

            yield* db.insert(schema.transactionLegs).values({
              id: "10000000-0000-4000-8000-000000000009",
              sourceId: TEST_CUSTODY_SOURCE_ID,
              externalId: "unsupported-reporting-currency-leg",
              timestamp: occurredAt,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
            })
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: occurredAt,
              price: "50",
              currency: "NOK",
              source: "unsupported-currency-feed",
            })
          })
        )
      )

      const error = yield* Effect.promise(() => loadFactualLedgerError(CurrencyCode.make("NOK")))
      expect(error).toMatchObject({
        _tag: "PersistenceError",
        operation: "factualLedgerRepository.load.reportingCurrency",
      })
    })
  )

  it.effect("does not adapt transaction or source facts owned by another principal", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-05T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            const [
              foreignSourceTransaction,
              foreignTransactionOnOwnedSource,
              mismatchedSourceTransaction,
              mismatchedFeeTarget,
            ] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "foreign-source-transaction",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "900",
                  providerFiatCurrency: "EUR",
                  principalId: OTHER_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "foreign-transaction-on-owned-source",
                  timestamp: occurredAt,
                  transactionType: "sell_fiat",
                  providerFiatAmount: "800",
                  providerFiatCurrency: "EUR",
                  principalId: OTHER_PRINCIPAL_ID,
                },
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "same-principal-transaction-on-foreign-source",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "700",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: OTHER_SOURCE_ID,
                  externalId: "same-principal-fee-target-on-foreign-source",
                  timestamp: occurredAt,
                  transactionType: "swap_crypto_to_crypto",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (
              foreignSourceTransaction === undefined ||
              foreignTransactionOnOwnedSource === undefined ||
              mismatchedSourceTransaction === undefined ||
              mismatchedFeeTarget === undefined
            ) {
              return yield* Effect.die("Failed to create cross-principal transactions")
            }

            yield* db.insert(schema.transactionLegs).values([
              {
                id: "10000000-0000-4000-8000-000000000040",
                sourceId: OTHER_SOURCE_ID,
                externalId: "foreign-source-leg",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: foreignSourceTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000041",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "owned-source-leg",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "2",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: foreignTransactionOnOwnedSource.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000042",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "owned-source-leg-with-other-source-transaction",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "3",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: mismatchedSourceTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000043",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "owned-source-fee-leg-with-foreign-source-target",
                timestamp: occurredAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.01",
                kind: "fee",
                provenance: "deterministic",
                feeForTransactionId: mismatchedFeeTarget.id,
              },
            ])
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toEqual([
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000041",
          _tag: "disposition",
          cause: "unknown",
        }),
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000042",
          _tag: "acquisition",
          cause: "unknown",
        }),
        expect.objectContaining({
          id: "10000000-0000-4000-8000-000000000043",
          _tag: "disposition",
          cause: "fee",
        }),
      ])
      expect(result.events.map(({ transactionReference }) => transactionReference)).toEqual([
        undefined,
        undefined,
        undefined,
      ])
      expect(result.valuationFacts).toEqual([])
    })
  )

  it.effect("keeps provider consideration separate from the exact daily market quote", () =>
    Effect.gen(function* () {
      const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T10:00:00.000Z"))
      const historicalQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2020-01-01T09:00:00.000Z"))
      const dailyQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T00:00:00.000Z"))
      const intradayQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T09:40:00.000Z"))
      const invalidQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T09:50:00.000Z"))
      const negativeQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T09:55:00.000Z"))
      const laterQuoteAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-03T11:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalGroupId: "   ",
                externalId: "  factual-ledger-valued-purchase  ",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                providerResourcePath: "  /v2/transactions/valued-purchase  ",
                providerFiatAmount: "1250.50",
                providerFiatCurrency: "EUR",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })

            if (transaction === undefined) {
              return yield* Effect.die("Failed to create valued factual ledger transaction")
            }

            yield* db.insert(schema.transactionLegs).values({
              id: "10000000-0000-4000-8000-000000000010",
              sourceId: TEST_CUSTODY_SOURCE_ID,
              externalId: "factual-ledger-valued-purchase-leg",
              timestamp: occurredAt,
              principalId: TEST_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "2",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
              fiatAmount: "999.00",
              fiatCurrency: "EUR",
            })
            yield* db.insert(schema.assetPrices).values([
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: historicalQuoteAt,
                price: "99999",
                currency: "EUR",
                source: "unused-historical-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: dailyQuoteAt,
                price: "600.25",
                currency: "EUR",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: dailyQuoteAt,
                price: "700.25",
                currency: "USD",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: intradayQuoteAt,
                price: "650.75",
                currency: "EUR",
                source: "intraday-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: invalidQuoteAt,
                price: "NaN",
                currency: "EUR",
                source: "invalid-market-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: negativeQuoteAt,
                price: "-1",
                currency: "EUR",
                source: "negative-market-feed",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: laterQuoteAt,
                price: "700.50",
                currency: "EUR",
                source: "future-market-feed",
              },
            ])
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events[0]?.transactionReference).toBe("factual-ledger-valued-purchase")

      expect(
        result.valuationFacts.map((fact) =>
          fact._tag === "observed_consideration"
            ? {
                type: fact._tag,
                eventId: fact.eventId,
                amount: fact.amount.format(),
                evidenceReference: fact.evidenceReference,
              }
            : {
                type: fact._tag,
                eventId: fact.eventId,
                unitPrice: fact.unitPrice.format(),
                quotedAt: fact.quotedAt.toISOString(),
                source: fact.source,
              }
        )
      ).toEqual([
        {
          type: "observed_consideration",
          eventId: "10000000-0000-4000-8000-000000000010",
          amount: "1250.5",
          evidenceReference: "/v2/transactions/valued-purchase",
        },
        {
          type: "market_quote",
          eventId: "10000000-0000-4000-8000-000000000010",
          unitPrice: "600.25",
          quotedAt: "2025-02-03T00:00:00.000Z",
          source: "coingecko",
        },
      ])

      const usdResult = yield* Effect.promise(() =>
        loadFactualLedgerInCurrency(CurrencyCode.make("USD"))
      )

      expect(usdResult.valuationFacts).toEqual([])
    })
  )

  it.effect("preserves valid quote sources exactly and omits unusable sources", () =>
    Effect.gen(function* () {
      const quoteFixtures = [
        {
          id: "10000000-0000-4000-8000-000000000050",
          day: "2025-05-01",
          source: null,
        },
        {
          id: "10000000-0000-4000-8000-000000000051",
          day: "2025-05-02",
          source: "",
        },
        {
          id: "10000000-0000-4000-8000-000000000052",
          day: "2025-05-03",
          source: " padded-source ",
        },
        {
          id: "10000000-0000-4000-8000-000000000053",
          day: "2025-05-04",
          source: "exact-source",
        },
      ] as const

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "quote-source-validation",
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-05-01T10:00:00.000Z")),
                transactionType: "buy_fiat",
                principalId: TEST_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })

            if (transaction === undefined) {
              return yield* Effect.die("Failed to create quote-source transaction")
            }

            yield* db.insert(schema.transactionLegs).values(
              quoteFixtures.map(({ day, id }) => ({
                id,
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: `quote-source-leg-${day}`,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T10:00:00.000Z`)),
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition" as const,
                provenance: "deterministic" as const,
                transactionId: transaction.id,
              }))
            )
            yield* db.insert(schema.assetPrices).values(
              quoteFixtures.map(({ day, source }) => ({
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(`${day}T00:00:00.000Z`)),
                price: "100",
                currency: "EUR",
                source,
              }))
            )
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.valuationFacts).toHaveLength(1)
      expect(result.valuationFacts[0]).toMatchObject({
        _tag: "market_quote",
        eventId: "10000000-0000-4000-8000-000000000053",
        source: "exact-source",
      })
    })
  )

  it.effect("omits unusable provider money and exact daily quotes", () =>
    Effect.gen(function* () {
      const negativeAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T10:00:00.000Z"))
      const ambiguousAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T10:00:00.000Z"))
      const invalidAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T10:00:00.000Z"))

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [negativeTransaction, ambiguousTransaction, invalidTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "negative-provider-money",
                  timestamp: negativeAt,
                  transactionType: "sell_fiat",
                  providerFiatAmount: "-100",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "ambiguous-provider-money",
                  timestamp: ambiguousAt,
                  transactionType: "swap_crypto_to_crypto",
                  providerFiatAmount: "500",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
                {
                  sourceId: TEST_CUSTODY_SOURCE_ID,
                  externalId: "invalid-provider-money",
                  timestamp: invalidAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "NaN",
                  providerFiatCurrency: "EUR",
                  principalId: TEST_PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })

            if (
              negativeTransaction === undefined ||
              ambiguousTransaction === undefined ||
              invalidTransaction === undefined
            ) {
              return yield* Effect.die("Failed to create provider-money fixtures")
            }

            yield* db.insert(schema.transactionLegs).values([
              {
                id: "10000000-0000-4000-8000-000000000030",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "negative-provider-money-leg",
                timestamp: negativeAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: negativeTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000031",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "ambiguous-provider-money-out",
                timestamp: ambiguousAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: ambiguousTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000032",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "ambiguous-provider-money-in",
                timestamp: ambiguousAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "2",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: ambiguousTransaction.id,
              },
              {
                id: "10000000-0000-4000-8000-000000000033",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "invalid-provider-money-leg",
                timestamp: invalidAt,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: invalidTransaction.id,
              },
            ])
            yield* db.insert(schema.assetPrices).values([
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-01T00:00:00.000Z")),
                price: "-1",
                currency: "EUR",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-02T00:00:00.000Z")),
                price: "0",
                currency: "EUR",
                source: "coingecko",
              },
              {
                assetId: TEST_BTC_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-04-03T00:00:00.000Z")),
                price: "NaN",
                currency: "EUR",
                source: "coingecko",
              },
            ])
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toHaveLength(4)
      expect(result.valuationFacts).toEqual([])
    })
  )

  it.effect("adapts only finalized custody reconciliations in provider direction", () =>
    Effect.gen(function* () {
      const providerTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T10:00:00.000Z"))
      const canonicalTimestamp = DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T10:02:00.000Z"))
      const inboundProviderTimestamp = DateTime.toDateUtc(
        DateTime.makeUnsafe("2025-03-04T11:00:00.000Z")
      )
      const inboundCanonicalTimestamp = DateTime.toDateUtc(
        DateTime.makeUnsafe("2025-03-04T11:02:00.000Z")
      )

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* seedCexSource({
              sourceId: TEST_DESTINATION_SOURCE_ID,
              fixtureName: "Destination custody source",
            })
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })

            const finalized = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000020",
              fixtureName: "custody",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp,
              canonicalTimestamp,
              direction: "outbound",
              amount: "0.75",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            const finalizedInbound = yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000023",
              fixtureName: "custody-inbound",
              providerSourceId: TEST_DESTINATION_SOURCE_ID,
              canonicalSourceId: TEST_CUSTODY_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "inbound",
              amount: "0.5",
              reconciliationStatus: "matched",
              status: "auto_applied",
              deterministic: true,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000024",
              fixtureName: "custody-pending",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.25",
              reconciliationStatus: "unmatched",
              status: "pending",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000025",
              fixtureName: "custody-foreign-provider-transfer-source",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              providerTransferSourceId: OTHER_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.125",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000026",
              fixtureName: "custody-foreign-inventory-source",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              inventorySourceId: OTHER_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.125",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* seedCustodyReconciliation({
              reconciliationId: "10000000-0000-4000-8000-000000000027",
              fixtureName: "custody-foreign-canonical-transfer-source",
              providerSourceId: TEST_CUSTODY_SOURCE_ID,
              canonicalSourceId: TEST_DESTINATION_SOURCE_ID,
              canonicalTransferSourceId: OTHER_SOURCE_ID,
              providerTimestamp: inboundProviderTimestamp,
              canonicalTimestamp: inboundCanonicalTimestamp,
              direction: "outbound",
              amount: "0.125",
              reconciliationStatus: "matched",
              status: "approved",
              deterministic: false,
            })
            yield* db.insert(schema.transactionLegs).values([
              {
                id: "10000000-0000-4000-8000-000000000017",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "custody-provider-disposition-leg",
                timestamp: providerTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.75",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: finalized.providerTransactionId,
              },
              {
                id: "10000000-0000-4000-8000-000000000018",
                sourceId: TEST_DESTINATION_SOURCE_ID,
                externalId: "custody-canonical-acquisition-leg",
                timestamp: canonicalTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.75",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: finalized.canonicalTransactionId,
              },
              {
                id: "10000000-0000-4000-8000-000000000019",
                sourceId: TEST_DESTINATION_SOURCE_ID,
                externalId: "custody-inbound-provider-acquisition-leg",
                timestamp: inboundProviderTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.5",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: finalizedInbound.providerTransactionId,
              },
              {
                id: "10000000-0000-4000-8000-000000000016",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "custody-inbound-canonical-disposition-leg",
                timestamp: inboundCanonicalTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.5",
                kind: "disposal",
                provenance: "deterministic",
                transactionId: finalizedInbound.canonicalTransactionId,
              },
              {
                id: "10000000-0000-4000-8000-000000000021",
                sourceId: TEST_CUSTODY_SOURCE_ID,
                externalId: "custody-internal-out-leg",
                timestamp: providerTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.75",
                kind: "disposal",
                provenance: "deterministic",
                derivationRule: "internal_transfer_out",
                transactionId: finalized.providerTransactionId,
              },
              {
                id: "10000000-0000-4000-8000-000000000022",
                sourceId: TEST_DESTINATION_SOURCE_ID,
                externalId: "custody-internal-in-leg",
                timestamp: canonicalTimestamp,
                principalId: TEST_PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "0.75",
                kind: "acquisition",
                provenance: "deterministic",
                derivationRule: "internal_transfer_in",
                transactionId: finalized.canonicalTransactionId,
              },
            ])
            yield* db.insert(schema.assetPrices).values({
              assetId: TEST_BTC_ASSET_ID,
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-03-04T00:00:00.000Z")),
              price: "50000",
              currency: "EUR",
              source: "coingecko",
            })
          })
        )
      )

      const result = yield* Effect.promise(loadFactualLedger)

      expect(result.events).toHaveLength(2)
      expect(result.events[0]).toMatchObject({
        _tag: "custody_movement",
        id: "10000000-0000-4000-8000-000000000020",
        assetId: TEST_BTC_ASSET_ID,
        fromCustodySourceId: TEST_CUSTODY_SOURCE_ID,
        toCustodySourceId: TEST_DESTINATION_SOURCE_ID,
        transactionReference: "custody-canonical-transaction",
      })
      expect(result.events[0]?.occurredAt.toISOString()).toBe("2025-03-04T10:02:00.000Z")
      expect(
        BigDecimal.equals(
          result.events[0]?.quantity ?? BigDecimal.fromBigInt(0n),
          BigDecimal.fromStringUnsafe("0.75")
        )
      ).toBe(true)
      expect(result.events[1]).toMatchObject({
        _tag: "custody_movement",
        id: "10000000-0000-4000-8000-000000000023",
        assetId: TEST_BTC_ASSET_ID,
        fromCustodySourceId: TEST_CUSTODY_SOURCE_ID,
        toCustodySourceId: TEST_DESTINATION_SOURCE_ID,
        transactionReference: "custody-inbound-canonical-transaction",
      })
      expect(result.events[1]?.occurredAt.toISOString()).toBe("2025-03-04T11:02:00.000Z")
      expect(result.valuationFacts).toEqual([])
    })
  )
})
