import { beforeEach, describe, expect, it } from "@effect/vitest"
import { JurisdictionCode, TaxYear } from "@my/core/accounting"
import { CurrencyCode } from "@my/core/currency"
import { PrincipalId } from "@my/core/ownership"
import { eq, inArray } from "drizzle-orm"
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
  TEST_EUR_REPRESENTATION_ID,
  TEST_USER_ID,
  makeIntegrationTestDatabaseContext,
  seedSyncEngineAssets,
  seedSyncEngineRepositoryFixture,
} from "../support/integration-test-kit.ts"

const PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000183")
const SOURCE_ID = "00000000-0000-4000-8000-000000000281"
const CANONICAL_SOURCE_ID = "00000000-0000-4000-8000-000000000282"
const PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000721"
const SECOND_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000722"
const THIRD_PROVIDER_ASSET_ID = "00000000-0000-4000-8000-000000000723"
const REPLACEMENT_ASSET_ID = "00000000-0000-4000-8000-000000000483"
const CHAINLESS_ASSET_ID = "00000000-0000-4000-8000-000000000484"
const OTHER_PRINCIPAL_ID = PrincipalId.make("00000000-0000-4000-8000-000000000185")
const OTHER_SOURCE_ID = "00000000-0000-4000-8000-000000000285"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000186"
const RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000921")
const SECOND_RUN_ID = CalculationRunId.make("00000000-0000-4000-8000-000000000922")
const EUR = CurrencyCode.make("EUR")

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_principal_override_application",
})

const runPg = context.runPg

const runFactualLedger = <A, E>(effect: Effect.Effect<A, E, FactualLedgerRepository>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: FactualLedgerRepositoryLive }))

const loadLedger = (principalId = PRINCIPAL_ID) =>
  runFactualLedger(
    Effect.flatMap(FactualLedgerRepository, (repository) =>
      repository.load({
        principalId,
        reportingCurrency: EUR,
      })
    )
  )

const CalculationRunServiceTestLive = CalculationRunServiceLive.pipe(
  Layer.provide(Layer.merge(CalculationRunRepositoryLive, FactualLedgerRepositoryLive))
)

const runCalculationService = <A, E>(effect: Effect.Effect<A, E, CalculationRunService>) =>
  Effect.runPromise(context.runWithLayer({ effect, layer: CalculationRunServiceTestLive }))

const recompute = (id = RUN_ID) =>
  runCalculationService(
    Effect.flatMap(CalculationRunService, (service) =>
      service.recompute({
        id,
        principalId: PRINCIPAL_ID,
        jurisdiction: JurisdictionCode.make("DE"),
        taxYear: TaxYear.make(2025),
        reportingCurrency: EUR,
        accountingChoices: [],
      })
    )
  )

const seedPolicyExcludedMovementWithUserInclusion = ({
  includeIdentityOverride = true,
  replacementInclusion = "included",
}: {
  readonly includeIdentityOverride?: boolean
  readonly replacementInclusion?: "included" | "excluded"
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z"))

    yield* db.insert(schema.providerAssets).values({
      id: PROVIDER_ASSET_ID,
      provider: "coinbase",
      providerAssetId: "policy-excluded-btc",
      currencyCode: "BTC",
      name: "Bitcoin",
      exponent: 8,
      providerType: "crypto",
      rawProviderPayload: { asset_id: "policy-excluded-btc" },
      evidenceRevision: 1,
      discoveredAt: occurredAt,
      retrievedAt: occurredAt,
    })
    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: PROVIDER_ASSET_ID,
      mappingKind: "asset",
      canonicalAssetId: TEST_BTC_ASSET_ID,
      mappingStatus: "excluded",
    })

    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: SOURCE_ID,
        externalId: "policy-excluded-transaction",
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        principalId: PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Failed to seed transaction")

    yield* db.insert(schema.providerTransfers).values({
      sourceId: SOURCE_ID,
      transactionId: transaction.id,
      externalId: "policy-excluded-provider-transfer",
      providerAssetId: PROVIDER_ASSET_ID,
      timestamp: occurredAt,
      direction: "inbound",
      processingMode: "accounting_and_evidence",
      fromAccountRef: "coinbase",
      toAccountRef: "principal",
      amount: "1",
    })
    yield* db.insert(schema.transactionLegs).values({
      sourceId: SOURCE_ID,
      externalId: "policy-excluded-leg",
      timestamp: occurredAt,
      principalId: PRINCIPAL_ID,
      assetId: TEST_BTC_ASSET_ID,
      amount: "1",
      kind: "acquisition",
      provenance: "deterministic",
      metadata: { providerAssetRowId: PROVIDER_ASSET_ID },
      transactionId: transaction.id,
    })

    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: PRINCIPAL_ID,
        targetKind: "provider_asset",
        providerAssetRowId: PROVIDER_ASSET_ID,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to seed override target")

    yield* db.insert(schema.principalAssetOverrides).values([
      ...(includeIdentityOverride
        ? [
            {
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "identity" as const,
              operation: "create" as const,
              inspectedSystemRevision: "policy-excluded-identity-v1",
              inspectedSystemIdentity: "unresolved" as const,
              replacementAssetId: TEST_BTC_ASSET_ID,
              actorUserId: TEST_USER_ID,
              reason: "Use the known economic asset for the excluded observation",
            },
          ]
        : []),
      {
        principalId: PRINCIPAL_ID,
        targetId: target.id,
        kind: "inclusion",
        operation: "create",
        inspectedSystemRevision: "policy-excluded-inclusion-v1",
        inspectedSystemInclusion: "excluded",
        replacementInclusion,
        actorUserId: TEST_USER_ID,
        reason: `Apply principal inclusion ${replacementInclusion}`,
      },
    ])
  })

const seedExactInclusion = ({
  replacementInclusion,
  isSpam,
}: {
  readonly replacementInclusion?: "included" | "excluded"
  readonly isSpam: boolean
}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-08T10:00:00.000Z"))
    yield* db
      .update(schema.assetRepresentations)
      .set({ isSpam })
      .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
    const [representation] = yield* db
      .select({
        blockchainId: schema.assetRepresentations.blockchainId,
        type: schema.assetRepresentations.type,
        contractAddress: schema.assetRepresentations.contractAddress,
        mintAddress: schema.assetRepresentations.mintAddress,
      })
      .from(schema.assetRepresentations)
      .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
    if (representation === undefined) return yield* Effect.die("Missing representation")
    const [transaction] = yield* db
      .insert(schema.transactions)
      .values({
        sourceId: SOURCE_ID,
        externalId: `exact-${replacementInclusion ?? "system"}`,
        timestamp: occurredAt,
        transactionType: "buy_fiat",
        principalId: PRINCIPAL_ID,
      })
      .returning({ id: schema.transactions.id })
    if (transaction === undefined) return yield* Effect.die("Failed to seed exact transaction")
    yield* db.insert(schema.transactionLegs).values([
      {
        sourceId: SOURCE_ID,
        externalId: `exact-${replacementInclusion ?? "system"}-targeted`,
        timestamp: occurredAt,
        principalId: PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        amount: "1",
        kind: "acquisition" as const,
        provenance: "deterministic" as const,
        transactionId: transaction.id,
      },
      {
        sourceId: SOURCE_ID,
        externalId: `exact-${replacementInclusion ?? "system"}-same-transaction`,
        timestamp: occurredAt,
        principalId: PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        amount: "2",
        kind: "acquisition" as const,
        provenance: "deterministic" as const,
        transactionId: transaction.id,
      },
    ])
    if (replacementInclusion === undefined) return

    const [target] = yield* db
      .insert(schema.principalAssetOverrideTargets)
      .values({
        principalId: PRINCIPAL_ID,
        targetKind: "representation",
        blockchainId: representation.blockchainId,
        representationType: representation.type,
        contractAddress: representation.contractAddress,
        mintAddress: representation.mintAddress,
      })
      .returning({ id: schema.principalAssetOverrideTargets.id })
    if (target === undefined) return yield* Effect.die("Failed to seed exact target")
    yield* db.insert(schema.principalAssetOverrides).values({
      principalId: PRINCIPAL_ID,
      targetId: target.id,
      kind: "inclusion",
      operation: "create",
      inspectedSystemRevision: `exact-inclusion-${replacementInclusion}`,
      inspectedSystemInclusion: isSpam ? "excluded" : "included",
      replacementInclusion,
      actorUserId: TEST_USER_ID,
      reason: `Use exact representation inclusion ${replacementInclusion}`,
    })
  })

const seedReconciledCustodyMovement = ({
  canonicalAssetRepresentationId = null,
  includeExactSibling = false,
  providerReplacementInclusion,
}: {
  readonly canonicalAssetRepresentationId?: string | null
  readonly includeExactSibling?: boolean
  readonly providerReplacementInclusion?: "excluded"
} = {}) =>
  Effect.gen(function* () {
    const db = yield* drizzle
    const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-09T12:00:00.000Z"))
    const [existingAccount] = yield* db
      .select({ cexId: schema.cexAccount.cexId })
      .from(schema.cexAccount)
      .where(eq(schema.cexAccount.principalId, PRINCIPAL_ID))
      .limit(1)
    if (existingAccount === undefined) return yield* Effect.die("Missing source account")
    const [canonicalAccount] = yield* db
      .insert(schema.cexAccount)
      .values({
        cexId: existingAccount.cexId,
        principalId: PRINCIPAL_ID,
        providerUserId: "custody-canonical-user",
        providerAccountId: "custody-canonical-account",
        accessToken: "test-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-03-04T10:00:00.000Z")),
        scopes: "wallet:accounts:read wallet:transactions:read",
      })
      .returning({ id: schema.cexAccount.id })
    if (canonicalAccount === undefined) return yield* Effect.die("Failed to seed canonical account")
    yield* db.insert(schema.sources).values({
      id: CANONICAL_SOURCE_ID,
      principalId: PRINCIPAL_ID,
      name: "Canonical custody source",
      providerKey: "coinbase",
      sourceableType: "cex",
      cexAccountId: canonicalAccount.id,
    })
    yield* db.insert(schema.providerAssets).values({
      id: SECOND_PROVIDER_ASSET_ID,
      provider: "coinbase",
      providerAssetId: "custody-sibling-btc",
      currencyCode: "BTC",
      name: "Bitcoin",
      exponent: 8,
      providerType: "crypto",
      rawProviderPayload: { asset_id: "custody-sibling-btc" },
      evidenceRevision: 1,
      discoveredAt: occurredAt,
      retrievedAt: occurredAt,
    })
    yield* db.insert(schema.providerAssetMappings).values({
      providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
      mappingKind: "asset",
      canonicalAssetId: TEST_BTC_ASSET_ID,
      mappingStatus: "approved",
    })
    const [providerTransaction, canonicalTransaction] = yield* db
      .insert(schema.transactions)
      .values([
        {
          sourceId: SOURCE_ID,
          externalId: "custody-sibling-provider",
          timestamp: occurredAt,
          transactionType: "internal_transfer" as const,
          principalId: PRINCIPAL_ID,
        },
        {
          sourceId: CANONICAL_SOURCE_ID,
          externalId: "custody-sibling-canonical",
          timestamp: occurredAt,
          transactionType: "internal_transfer" as const,
          principalId: PRINCIPAL_ID,
        },
      ])
      .returning({ id: schema.transactions.id })
    if (providerTransaction === undefined || canonicalTransaction === undefined) {
      return yield* Effect.die("Failed to seed custody transactions")
    }
    const [providerTransfer] = yield* db
      .insert(schema.providerTransfers)
      .values({
        sourceId: SOURCE_ID,
        transactionId: providerTransaction.id,
        externalId: "custody-sibling-provider-transfer",
        providerAssetId: SECOND_PROVIDER_ASSET_ID,
        timestamp: occurredAt,
        direction: "outbound",
        processingMode: "accounting_only",
        fromAccountRef: "principal",
        toAccountRef: "principal-destination",
        amount: "1",
      })
      .returning({ id: schema.providerTransfers.id })
    const [canonicalTransfer] = yield* db
      .insert(schema.transfers)
      .values({
        sourceId: CANONICAL_SOURCE_ID,
        principalId: PRINCIPAL_ID,
        externalId: "custody-sibling-canonical-transfer",
        timestamp: occurredAt,
        type: "cex",
        fromAccountRef: "principal",
        toAccountRef: "principal-destination",
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: canonicalAssetRepresentationId,
        amount: "1",
      })
      .returning({ id: schema.transfers.id })
    if (providerTransfer === undefined || canonicalTransfer === undefined) {
      return yield* Effect.die("Failed to seed custody transfers")
    }
    yield* db.insert(schema.inventoryMovements).values({
      principalId: PRINCIPAL_ID,
      sourceId: SOURCE_ID,
      transactionId: providerTransaction.id,
      providerTransferId: providerTransfer.id,
      assetId: TEST_BTC_ASSET_ID,
      assetRepresentationId: canonicalAssetRepresentationId,
      timestamp: occurredAt,
      direction: "outbound",
      purpose: "principal",
      taxTreatment: "non_taxable",
      reconciliationStatus: "matched",
      amount: "1",
    })
    yield* db.insert(schema.transferReconciliations).values({
      principalId: PRINCIPAL_ID,
      providerTransferId: providerTransfer.id,
      canonicalTransferId: canonicalTransfer.id,
      canonicalTransactionId: canonicalTransaction.id,
      status: "approved",
      matchReason: "T12a exact precedence fixture",
      deterministic: false,
    })
    if (includeExactSibling) {
      yield* db.insert(schema.transactionLegs).values({
        sourceId: CANONICAL_SOURCE_ID,
        externalId: "custody-sibling-excluded-leg",
        timestamp: occurredAt,
        principalId: PRINCIPAL_ID,
        assetId: TEST_BTC_ASSET_ID,
        assetRepresentationId: TEST_BTC_REPRESENTATION_ID,
        amount: "1",
        kind: "fee",
        provenance: "deterministic",
        transactionId: canonicalTransaction.id,
      })
    }
    if (providerReplacementInclusion !== undefined) {
      const [target] = yield* db
        .insert(schema.principalAssetOverrideTargets)
        .values({
          principalId: PRINCIPAL_ID,
          targetKind: "provider_asset",
          providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
        })
        .returning({ id: schema.principalAssetOverrideTargets.id })
      if (target === undefined) return yield* Effect.die("Failed to seed provider target")
      yield* db.insert(schema.principalAssetOverrides).values({
        principalId: PRINCIPAL_ID,
        targetId: target.id,
        kind: "inclusion",
        operation: "create",
        inspectedSystemRevision: "custody-provider-inclusion-v1",
        inspectedSystemInclusion: "included",
        replacementInclusion: providerReplacementInclusion,
        actorUserId: TEST_USER_ID,
        reason: "Prove exact identity takes precedence over provider inclusion",
      })
    }
  })

await Effect.runPromise(context.recreateTestDatabase())

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() =>
        runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
      )
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
    })
  )
)

describe("principal asset override application", () => {
  it.effect("lets a sound user inclusion reverse a provider policy exclusion", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))

      const ledger = yield* Effect.promise(() => loadLedger())

      expect(ledger.events).toHaveLength(1)
      expect(ledger.events[0]).toMatchObject({
        _tag: "acquisition",
        assetId: TEST_BTC_ASSET_ID,
        custodySourceId: SOURCE_ID,
      })
    })
  )

  it.effect(
    "keeps technical blockers beside an unrelated exact sibling and stores a partial run",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerAssets)
                .set({ exponent: null, providerType: "mystery" })
                .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
              yield* db
                .update(schema.transactionLegs)
                .set({ assetRepresentationId: TEST_BTC_REPRESENTATION_ID, metadata: {} })
                .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
            })
          )
        )

        const ledger = yield* Effect.promise(() => loadLedger())
        expect(ledger.events).toEqual([])
        expect(ledger.inputBlockers.map(({ code }) => code)).toEqual([
          "missing_decimals",
          "unsupported_asset_type",
        ])

        const result = yield* Effect.promise(() => recompute())
        expect(result.status).toBe("partial")

        const stored = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [run] = yield* db
                .select({ status: schema.calculationRuns.status })
                .from(schema.calculationRuns)
                .where(eq(schema.calculationRuns.id, RUN_ID))
              const blockers = yield* db
                .select({
                  code: schema.calculationRunBlockers.code,
                  assetId: schema.calculationRunBlockers.assetId,
                  providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
                })
                .from(schema.calculationRunBlockers)
                .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
                .orderBy(schema.calculationRunBlockers.sequence)
              return { run, blockers }
            })
          )
        )
        expect(stored.run?.status).toBe("partial")
        expect(stored.blockers).toEqual([
          {
            code: "missing_decimals",
            assetId: TEST_BTC_ASSET_ID,
            providerAssetRowId: PROVIDER_ASSET_ID,
          },
          {
            code: "unsupported_asset_type",
            assetId: TEST_BTC_ASSET_ID,
            providerAssetRowId: PROVIDER_ASSET_ID,
          },
        ])
      })
  )

  it.effect("stores a blocker found only through stored-leg provider metadata", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
            yield* db
              .delete(schema.providerTransfers)
              .where(eq(schema.providerTransfers.providerAssetId, PROVIDER_ASSET_ID))
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          assetId: TEST_BTC_ASSET_ID,
          providerAssetRowId: PROVIDER_ASSET_ID,
        }),
      ])

      const result = yield* Effect.promise(() => recompute())
      expect(result.status).toBe("partial")
    })
  )

  it.effect("keeps unresolved identity blocked when inclusion has no identity replacement", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(seedPolicyExcludedMovementWithUserInclusion({ includeIdentityOverride: false }))
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
            if (transaction === undefined) return yield* Effect.die("Missing transaction")
            yield* db
              .update(schema.providerAssetMappings)
              .set({ canonicalAssetId: null, mappingStatus: "pending_review" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null, providerType: "mystery" })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
            yield* db
              .delete(schema.transactionLegs)
              .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
            yield* db.insert(schema.transactionReviews).values({
              transactionId: transaction.id,
              principalId: PRINCIPAL_ID,
              reviewStatus: "needs_review",
              categorizationReason: "provider_asset_mapping: Asset mapping is unresolved.",
              matchedLayer: "provider_asset_mapping",
              needsReview: true,
            })
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T11:00:00.000Z"))
            const [unrelatedTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "unresolved-unrelated-transaction",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (unrelatedTransaction === undefined) {
              return yield* Effect.die("Failed to seed unrelated transaction")
            }
            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "unresolved-unrelated-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: unrelatedTransaction.id,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())

      expect(ledger.events).toHaveLength(1)
      expect(ledger.events[0]).toMatchObject({
        transactionReference: "unresolved-unrelated-transaction",
      })
      expect(ledger.inputBlockers.map(({ code }) => code)).toEqual([
        "unresolved_identity",
        "missing_decimals",
        "unsupported_asset_type",
      ])
      expect(ledger.inputBlockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unresolved_identity",
            assetId: null,
            providerAssetRowId: PROVIDER_ASSET_ID,
          }),
        ])
      )

      const result = yield* Effect.promise(() => recompute())
      expect(result.status).toBe("partial")
      const stored = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const blockers = yield* db
              .select({
                code: schema.calculationRunBlockers.code,
                assetId: schema.calculationRunBlockers.assetId,
                providerAssetRowId: schema.calculationRunBlockers.providerAssetRowId,
              })
              .from(schema.calculationRunBlockers)
              .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
              .orderBy(schema.calculationRunBlockers.sequence)
            return blockers
          })
        )
      )
      expect(stored.map(({ code }) => code)).toEqual(
        expect.arrayContaining([
          "unresolved_identity",
          "missing_decimals",
          "unsupported_asset_type",
        ])
      )
    })
  )

  it.effect("fails closed when a blocked movement cannot be linked to a run custody unit", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(seedPolicyExcludedMovementWithUserInclusion({ includeIdentityOverride: false }))
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .delete(schema.custodyUnitSources)
              .where(eq(schema.custodyUnitSources.principalId, PRINCIPAL_ID))
          })
        )
      )

      const result = yield* Effect.promise(() =>
        runFactualLedger(
          Effect.flatMap(FactualLedgerRepository, (repository) =>
            repository
              .load({ principalId: PRINCIPAL_ID, reportingCurrency: EUR })
              .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }))
          )
        )
      )
      expect(result).toMatchObject({
        _tag: "PersistenceError",
        operation: "factualLedgerRepository.load.inputBlockerLink",
      })
    })
  )

  it.effect("applies exact inclusion and withholds the whole transaction on exclusion", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(seedExactInclusion({ replacementInclusion: "included", isSpam: true }))
      )
      const included = yield* Effect.promise(() => loadLedger())
      expect(included.events).toHaveLength(2)
      expect(included.inputBlockers).toEqual([])
      expect(included.principalAssetOverrideRevision).toEqual([
        expect.objectContaining({
          kind: "inclusion",
          replacementInclusion: "included",
          target: expect.objectContaining({ _tag: "representation" }),
        }),
      ])

      yield* context.recreateTestDatabase()
      const fixture = yield* Effect.promise(() =>
        runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
      )
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(fixture)))
      yield* Effect.promise(() =>
        runPg(seedExactInclusion({ replacementInclusion: "excluded", isSpam: false }))
      )
      const excluded = yield* Effect.promise(() => loadLedger())
      expect(excluded.events).toEqual([])
      expect(excluded.inputBlockers).toEqual([])

      yield* context.recreateTestDatabase()
      const systemFixture = yield* Effect.promise(() =>
        runPg(seedSyncEngineRepositoryFixture({ principalId: PRINCIPAL_ID, sourceId: SOURCE_ID }))
      )
      yield* Effect.promise(() => runPg(seedSyncEngineAssets(systemFixture)))
      yield* Effect.promise(() => runPg(seedExactInclusion({ isSpam: true })))
      const systemExcluded = yield* Effect.promise(() => loadLedger())
      expect(systemExcluded.events).toEqual([])
      expect(systemExcluded.inputBlockers).toEqual([])
      expect(systemExcluded.principalAssetOverrideRevision).toEqual([])
    })
  )

  it.effect(
    "withholds a malformed transaction, stores its blocker, and continues unrelated facts",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-09T10:00:00.000Z"))
              const [blockedTransaction] = yield* db
                .select({ id: schema.transactions.id })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              if (blockedTransaction === undefined) {
                return yield* Effect.die("Missing blocked transaction")
              }
              yield* db.insert(schema.providerAssets).values({
                id: SECOND_PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "blocked-sibling-btc",
                currencyCode: "BTC",
                name: "Blocked Bitcoin sibling",
                exponent: null,
                providerType: "crypto",
                rawProviderPayload: { asset_id: "blocked-sibling-btc" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              })
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "approved",
              })
              yield* db
                .delete(schema.transactionLegs)
                .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
              yield* db.insert(schema.providerTransfers).values({
                sourceId: SOURCE_ID,
                transactionId: blockedTransaction.id,
                externalId: "sound-provider-transfer",
                providerAssetId: SECOND_PROVIDER_ASSET_ID,
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "2",
              })
              yield* db.insert(schema.transactionLegs).values({
                sourceId: SOURCE_ID,
                externalId: "sound-same-transaction-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "2",
                kind: "acquisition",
                provenance: "deterministic",
                metadata: { providerAssetRowId: SECOND_PROVIDER_ASSET_ID },
                transactionId: blockedTransaction.id,
              })
              yield* db.insert(schema.transactionReviews).values({
                transactionId: blockedTransaction.id,
                principalId: PRINCIPAL_ID,
                reviewStatus: "needs_review",
                categorizationReason: "Stored provider movement has no accounting leg",
                matchedLayer: "provider_asset_mapping",
                needsReview: true,
              })

              const [unrelatedTransaction] = yield* db
                .insert(schema.transactions)
                .values({
                  sourceId: SOURCE_ID,
                  externalId: "unrelated-transaction",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat",
                  providerFiatAmount: "100",
                  providerFiatCurrency: "EUR",
                  principalId: PRINCIPAL_ID,
                })
                .returning({ id: schema.transactions.id })
              if (unrelatedTransaction === undefined) {
                return yield* Effect.die("Failed to seed unrelated transaction")
              }
              yield* db.insert(schema.transactionLegs).values({
                sourceId: SOURCE_ID,
                externalId: "unrelated-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                transactionId: unrelatedTransaction.id,
              })
            })
          )
        )

        const ledger = yield* Effect.promise(() => loadLedger())
        expect(ledger.events.map(({ id }) => id)).toHaveLength(1)
        expect(ledger.events[0]).toMatchObject({ transactionReference: "unrelated-transaction" })
        expect(
          ledger.inputBlockers
            .map(({ code }) => code)
            .sort((left, right) => left.localeCompare(right))
        ).toEqual(["malformed_movement", "missing_decimals"])

        const result = yield* Effect.promise(() => recompute())
        expect(result.status).toBe("partial")
        const stored = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const blockers = yield* db
                .select({ code: schema.calculationRunBlockers.code })
                .from(schema.calculationRunBlockers)
                .where(eq(schema.calculationRunBlockers.runId, RUN_ID))
              const providerEvidence = yield* db
                .select({ id: schema.providerTransfers.id })
                .from(schema.providerTransfers)
                .innerJoin(
                  schema.transactions,
                  eq(schema.transactions.id, schema.providerTransfers.transactionId)
                )
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              const [review] = yield* db
                .select({ needsReview: schema.transactionReviews.needsReview })
                .from(schema.transactionReviews)
                .innerJoin(
                  schema.transactions,
                  eq(schema.transactions.id, schema.transactionReviews.transactionId)
                )
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              return { blockers, providerEvidence, review }
            })
          )
        )
        expect(
          stored.blockers.map(({ code }) => code).sort((left, right) => left.localeCompare(right))
        ).toEqual(["malformed_movement", "missing_decimals"])
        expect(stored.review).toEqual({ needsReview: true })
        expect(stored.providerEvidence).toHaveLength(2)
      })
  )

  it.effect("keeps a deleted provider-asset movement in malformed preflight", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z"))
            yield* db.insert(schema.providerAssets).values({
              id: PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "soon-deleted-provider-asset",
              currencyCode: "BTC",
              name: "Soon deleted provider asset",
              exponent: 8,
              providerType: "crypto",
              rawProviderPayload: { asset_id: "soon-deleted-provider-asset" },
              evidenceRevision: 1,
              discoveredAt: occurredAt,
              retrievedAt: occurredAt,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: PROVIDER_ASSET_ID,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              mappingStatus: "approved",
            })
            const [transaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: SOURCE_ID,
                externalId: "deleted-provider-asset-transaction",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (transaction === undefined) {
              return yield* Effect.die("Failed to seed provider transaction")
            }
            const [providerTransfer] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "deleted-provider-asset-transfer",
                providerAssetId: PROVIDER_ASSET_ID,
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "1",
              })
              .returning({ id: schema.providerTransfers.id })
            if (providerTransfer === undefined) {
              return yield* Effect.die("Failed to seed provider transfer")
            }
            yield* db.insert(schema.inventoryMovements).values({
              principalId: PRINCIPAL_ID,
              sourceId: SOURCE_ID,
              transactionId: transaction.id,
              providerTransferId: providerTransfer.id,
              assetId: TEST_BTC_ASSET_ID,
              timestamp: occurredAt,
              direction: "inbound",
              purpose: "principal",
              taxTreatment: "pending_review",
              reconciliationStatus: "needs_review",
              amount: "1",
            })
            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "deleted-provider-asset-sibling-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "2",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
            })
            yield* db
              .delete(schema.providerAssetMappings)
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .delete(schema.providerAssets)
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          assetId: TEST_BTC_ASSET_ID,
        }),
      ])
      const [blocker] = ledger.inputBlockers
      if (blocker === undefined) return yield* Effect.die("Missing malformed blocker")
      expect("providerAssetRowId" in blocker).toBe(false)
      const result = yield* Effect.promise(() => recompute())
      expect(result.status).toBe("partial")
    })
  )

  it.effect("does not label an unrelated classification review as a malformed movement", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
            if (transaction === undefined) return yield* Effect.die("Missing transaction")

            yield* db
              .delete(schema.transactionLegs)
              .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
            yield* db.insert(schema.transactionReviews).values({
              transactionId: transaction.id,
              principalId: PRINCIPAL_ID,
              reviewStatus: "needs_review",
              categorizationReason: "Transaction type needs user classification",
              matchedLayer: "coinbase_reference_mapping",
              needsReview: true,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("hashes factual blockers into the calculation input revision", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null, providerType: "mystery" })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
          })
        )
      )

      yield* Effect.promise(() => recompute(RUN_ID))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssets)
              .set({ providerType: "crypto" })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
          })
        )
      )
      yield* Effect.promise(() => recompute(SECOND_RUN_ID))

      const revisions = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            return yield* db
              .select({ revision: schema.calculationRuns.inputLedgerRevision })
              .from(schema.calculationRuns)
              .orderBy(schema.calculationRuns.id)
          })
        )
      )
      expect(revisions).toHaveLength(2)
      const contentHashes = revisions.map(({ revision }) => revision.split(":").at(-1))
      expect(contentHashes[0]).not.toBe(contentHashes[1])
    })
  )

  it.effect("reports a missing exact-observation leg instead of emitting its sibling", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
            if (representation === undefined || transaction === undefined) {
              return yield* Effect.die("Missing exact-observation fixture")
            }
            yield* db.insert(schema.assets).values({
              id: REPLACEMENT_ASSET_ID,
              name: "Exact malformed replacement asset",
              symbol: "EMR",
              type: "fungible",
            })
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                blockchainId: representation.blockchainId,
                representationType: representation.type,
                contractAddress: representation.contractAddress,
                mintAddress: representation.mintAddress,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to seed exact target")
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "exact-malformed-identity-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              replacementAssetId: REPLACEMENT_ASSET_ID,
              actorUserId: TEST_USER_ID,
              reason: "Use the exact identity for the missing accounting leg",
            })
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: representation.type,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: representation.mintAddress,
                observedDecimals: 8,
              })
              .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
            yield* db
              .delete(schema.transactionLegs)
              .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "exact-observation-sibling-leg",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z")),
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "2",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: transaction.id,
            })
            yield* db.insert(schema.transactionReviews).values({
              transactionId: transaction.id,
              principalId: PRINCIPAL_ID,
              reviewStatus: "needs_review",
              categorizationReason: "Stored exact movement has no accounting leg",
              matchedLayer: "provider_asset_mapping",
              needsReview: true,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          assetId: REPLACEMENT_ASSET_ID,
          providerAssetRowId: PROVIDER_ASSET_ID,
        }),
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.assetRepresentations)
              .set({ isSpam: true })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          })
        )
      )

      const excludedLedger = yield* Effect.promise(() => loadLedger())
      expect(excludedLedger.events).toEqual([])
      expect(excludedLedger.inputBlockers).toEqual([])
    })
  )

  it.effect("honors an exact exclusion while its stored leg awaits representation linkage", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing representation")

            yield* db
              .update(schema.assetRepresentations)
              .set({ isSpam: true })
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: representation.type,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: representation.mintAddress,
                observedDecimals: 8,
              })
              .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect(
    "does not borrow an evidence-only exact observation and fails closed when it is ambiguous",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [representation] = yield* db
                .select({
                  blockchainId: schema.assetRepresentations.blockchainId,
                  type: schema.assetRepresentations.type,
                  contractAddress: schema.assetRepresentations.contractAddress,
                  mintAddress: schema.assetRepresentations.mintAddress,
                })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
              const [transaction] = yield* db
                .select({
                  id: schema.transactions.id,
                  timestamp: schema.transactions.timestamp,
                })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              if (representation === undefined || transaction === undefined) {
                return yield* Effect.die("Missing evidence-only exact fixture")
              }

              yield* db.insert(schema.assets).values({
                id: REPLACEMENT_ASSET_ID,
                name: "Evidence-only replacement asset",
                symbol: "EOR",
                type: "fungible",
              })
              const [target] = yield* db
                .insert(schema.principalAssetOverrideTargets)
                .values({
                  principalId: PRINCIPAL_ID,
                  targetKind: "representation",
                  blockchainId: representation.blockchainId,
                  representationType: representation.type,
                  contractAddress: representation.contractAddress,
                  mintAddress: representation.mintAddress,
                })
                .returning({ id: schema.principalAssetOverrideTargets.id })
              if (target === undefined) return yield* Effect.die("Failed to seed exact target")
              yield* db.insert(schema.principalAssetOverrides).values({
                principalId: PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "evidence-only-exact-identity-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: REPLACEMENT_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Keep evidence-only observations out of accounting decisions",
              })
              yield* db
                .update(schema.providerAssetMappings)
                .set({ mappingStatus: "approved" })
                .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
              yield* db
                .update(schema.providerTransfers)
                .set({
                  processingMode: "evidence_only",
                  observedBlockchainId: representation.blockchainId,
                  observedRepresentationType: representation.type,
                  observedContractAddress: representation.contractAddress,
                  observedMintAddress: representation.mintAddress,
                  observedDecimals: 8,
                })
                .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
              yield* db.insert(schema.providerTransfers).values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "accounting-without-exact-observation",
                providerAssetId: PROVIDER_ASSET_ID,
                timestamp: transaction.timestamp,
                direction: "inbound",
                processingMode: "accounting_only",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "1",
              })
            })
          )
        )

        const ledger = yield* Effect.promise(() => loadLedger())
        expect(ledger.inputBlockers).toEqual([])
        expect(ledger.events).toEqual([
          expect.objectContaining({
            _tag: "acquisition",
            assetId: TEST_BTC_ASSET_ID,
            custodySourceId: SOURCE_ID,
          }),
        ])

        const ambiguousLegIds = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [transaction] = yield* db
                .select({
                  id: schema.transactions.id,
                  timestamp: schema.transactions.timestamp,
                })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              if (transaction === undefined) {
                return yield* Effect.die("Missing evidence-only transaction")
              }
              yield* db
                .delete(schema.providerTransfers)
                .where(
                  eq(schema.providerTransfers.externalId, "accounting-without-exact-observation")
                )
              yield* db.insert(schema.transactionLegs).values({
                sourceId: SOURCE_ID,
                externalId: "evidence-only-ambiguous-sibling-leg",
                timestamp: transaction.timestamp,
                principalId: PRINCIPAL_ID,
                assetId: TEST_BTC_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                metadata: { providerAssetRowId: PROVIDER_ASSET_ID },
                transactionId: transaction.id,
              })
              const legs = yield* db
                .select({ id: schema.transactionLegs.id })
                .from(schema.transactionLegs)
                .where(eq(schema.transactionLegs.transactionId, transaction.id))
              return legs.map(({ id }) => id).sort((left, right) => left.localeCompare(right))
            })
          )
        )

        const ambiguousLedger = yield* Effect.promise(() => loadLedger())
        expect(ambiguousLedger.events).toEqual([])
        expect(
          ambiguousLedger.inputBlockers
            .map(({ eventId }) => String(eventId))
            .sort((left, right) => left.localeCompare(right))
        ).toEqual(ambiguousLegIds)
        expect(
          ambiguousLedger.inputBlockers.every(
            ({ code, providerAssetRowId }) =>
              code === "malformed_movement" && providerAssetRowId === PROVIDER_ASSET_ID
          )
        ).toBe(true)

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [transaction] = yield* db
                .select({
                  id: schema.transactions.id,
                  timestamp: schema.transactions.timestamp,
                })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              const [representation] = yield* db
                .select({
                  blockchainId: schema.assetRepresentations.blockchainId,
                  type: schema.assetRepresentations.type,
                  contractAddress: schema.assetRepresentations.contractAddress,
                  mintAddress: schema.assetRepresentations.mintAddress,
                })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_EUR_REPRESENTATION_ID))
              if (transaction === undefined || representation === undefined) {
                return yield* Effect.die("Missing conflicting evidence-only fixture")
              }
              yield* db.insert(schema.providerTransfers).values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "conflicting-evidence-only-exact-observation",
                providerAssetId: PROVIDER_ASSET_ID,
                timestamp: transaction.timestamp,
                direction: "inbound",
                processingMode: "evidence_only",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "1",
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: representation.type,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: representation.mintAddress,
                observedDecimals: 2,
              })
            })
          )
        )

        const conflictingLedger = yield* Effect.promise(() => loadLedger())
        expect(conflictingLedger.events).toEqual([])
        expect(
          conflictingLedger.inputBlockers
            .map(({ eventId }) => String(eventId))
            .sort((left, right) => left.localeCompare(right))
        ).toEqual(ambiguousLegIds)

        const incompleteSiblingLegId = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .delete(schema.providerTransfers)
                .where(
                  eq(
                    schema.providerTransfers.externalId,
                    "conflicting-evidence-only-exact-observation"
                  )
                )
              yield* db
                .delete(schema.transactionLegs)
                .where(eq(schema.transactionLegs.externalId, "evidence-only-ambiguous-sibling-leg"))
              const [exactTransfer] = yield* db
                .select({
                  sourceId: schema.providerTransfers.sourceId,
                  transactionId: schema.providerTransfers.transactionId,
                  providerAssetId: schema.providerTransfers.providerAssetId,
                  timestamp: schema.providerTransfers.timestamp,
                  direction: schema.providerTransfers.direction,
                  amount: schema.providerTransfers.amount,
                })
                .from(schema.providerTransfers)
                .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
              const [leg] = yield* db
                .select({ id: schema.transactionLegs.id })
                .from(schema.transactionLegs)
                .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
              if (exactTransfer === undefined || leg === undefined) {
                return yield* Effect.die("Missing incomplete evidence sibling fixture")
              }
              yield* db.insert(schema.providerTransfers).values({
                sourceId: exactTransfer.sourceId,
                transactionId: exactTransfer.transactionId,
                externalId: "incomplete-evidence-only-sibling",
                providerAssetId: exactTransfer.providerAssetId,
                timestamp: exactTransfer.timestamp,
                direction: exactTransfer.direction,
                processingMode: "evidence_only",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: exactTransfer.amount,
              })
              return leg.id
            })
          )
        )

        const incompleteSiblingLedger = yield* Effect.promise(() => loadLedger())
        expect(incompleteSiblingLedger.events).toEqual([])
        expect(incompleteSiblingLedger.inputBlockers).toEqual([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: incompleteSiblingLegId,
            providerAssetRowId: PROVIDER_ASSET_ID,
          }),
        ])
      })
  )

  it.effect("uses a unique metadata-free pre-catalog exact identity", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing representation")

            yield* db.insert(schema.assets).values({
              id: REPLACEMENT_ASSET_ID,
              name: "Metadata-free replacement asset",
              symbol: "MFR",
              type: "fungible",
            })
            const [target] = yield* db
              .insert(schema.principalAssetOverrideTargets)
              .values({
                principalId: PRINCIPAL_ID,
                targetKind: "representation",
                blockchainId: representation.blockchainId,
                representationType: representation.type,
                contractAddress: representation.contractAddress,
                mintAddress: representation.mintAddress,
              })
              .returning({ id: schema.principalAssetOverrideTargets.id })
            if (target === undefined) return yield* Effect.die("Failed to seed exact target")
            yield* db.insert(schema.principalAssetOverrides).values({
              principalId: PRINCIPAL_ID,
              targetId: target.id,
              kind: "identity",
              operation: "create",
              inspectedSystemRevision: "metadata-free-exact-identity-v1",
              inspectedSystemIdentity: "resolved",
              inspectedSystemAssetId: TEST_BTC_ASSET_ID,
              replacementAssetId: REPLACEMENT_ASSET_ID,
              actorUserId: TEST_USER_ID,
              reason: "Use the unique exact identity before the catalog row exists",
            })
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: representation.type,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: representation.mintAddress,
                observedDecimals: 8,
              })
              .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
            yield* db
              .update(schema.transactionLegs)
              .set({ metadata: {} })
              .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
            yield* db
              .delete(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.inputBlockers).toEqual([])
      expect(ledger.events).toEqual([
        expect.objectContaining({
          _tag: "acquisition",
          assetId: REPLACEMENT_ASSET_ID,
          custodySourceId: SOURCE_ID,
        }),
      ])
    })
  )

  it.effect(
    "uses an exact identity replacement only for its provider movement while legs await linkage",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [representation] = yield* db
                .select({
                  blockchainId: schema.assetRepresentations.blockchainId,
                  type: schema.assetRepresentations.type,
                  contractAddress: schema.assetRepresentations.contractAddress,
                  mintAddress: schema.assetRepresentations.mintAddress,
                })
                .from(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
              if (representation === undefined) return yield* Effect.die("Missing representation")

              yield* db
                .update(schema.providerAssetMappings)
                .set({
                  mappingKind: "fiat",
                  canonicalAssetId: null,
                  canonicalFiatCurrency: "EUR",
                  mappingStatus: "excluded",
                })
                .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
              yield* db
                .update(schema.providerTransfers)
                .set({
                  observedBlockchainId: representation.blockchainId,
                  observedRepresentationType: representation.type,
                  observedContractAddress: representation.contractAddress,
                  observedMintAddress: representation.mintAddress,
                  observedDecimals: 8,
                })
                .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
              yield* db.insert(schema.assets).values([
                {
                  id: REPLACEMENT_ASSET_ID,
                  name: "Principal replacement asset",
                  symbol: "PRA",
                  type: "fungible",
                },
                {
                  id: CHAINLESS_ASSET_ID,
                  name: "Chainless sibling asset",
                  symbol: "CSA",
                  type: "fungible",
                },
              ])
              const [target] = yield* db
                .insert(schema.principalAssetOverrideTargets)
                .values({
                  principalId: PRINCIPAL_ID,
                  targetKind: "representation",
                  blockchainId: representation.blockchainId,
                  representationType: representation.type,
                  contractAddress: representation.contractAddress,
                  mintAddress: representation.mintAddress,
                })
                .returning({ id: schema.principalAssetOverrideTargets.id })
              if (target === undefined) return yield* Effect.die("Failed to seed exact target")
              yield* db.insert(schema.principalAssetOverrides).values({
                principalId: PRINCIPAL_ID,
                targetId: target.id,
                kind: "identity",
                operation: "create",
                inspectedSystemRevision: "exact-identity-v1",
                inspectedSystemIdentity: "resolved",
                inspectedSystemAssetId: TEST_BTC_ASSET_ID,
                replacementAssetId: REPLACEMENT_ASSET_ID,
                actorUserId: TEST_USER_ID,
                reason: "Use the principal's exact economic identity",
              })
              const excludedOccurredAt = DateTime.toDateUtc(
                DateTime.makeUnsafe("2025-02-07T10:01:00.000Z")
              )
              const [excludedTransaction] = yield* db
                .insert(schema.transactions)
                .values({
                  sourceId: SOURCE_ID,
                  externalId: "excluded-same-observation-transaction",
                  timestamp: excludedOccurredAt,
                  transactionType: "buy_fiat",
                  principalId: PRINCIPAL_ID,
                })
                .returning({ id: schema.transactions.id })
              if (excludedTransaction === undefined) {
                return yield* Effect.die("Failed to seed excluded observation transaction")
              }
              yield* db.insert(schema.providerAssets).values({
                id: THIRD_PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "excluded-same-observation",
                currencyCode: "BTC",
                name: "Excluded exact observation",
                exponent: 8,
                providerType: "crypto",
                rawProviderPayload: { asset_id: "excluded-same-observation" },
                evidenceRevision: 1,
                discoveredAt: excludedOccurredAt,
                retrievedAt: excludedOccurredAt,
              })
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: THIRD_PROVIDER_ASSET_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "excluded",
              })
              yield* db.insert(schema.providerTransfers).values({
                sourceId: SOURCE_ID,
                transactionId: excludedTransaction.id,
                externalId: "excluded-same-observation-transfer",
                providerAssetId: THIRD_PROVIDER_ASSET_ID,
                timestamp: excludedOccurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "1",
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: representation.type,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: representation.mintAddress,
                observedDecimals: 8,
              })
              yield* db
                .delete(schema.assetRepresentations)
                .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            })
          )
        )

        const exactLedger = yield* Effect.promise(() => loadLedger())
        expect(exactLedger.inputBlockers).toEqual([])
        expect(exactLedger.events).toEqual([
          expect.objectContaining({
            _tag: "acquisition",
            assetId: REPLACEMENT_ASSET_ID,
            custodySourceId: SOURCE_ID,
          }),
        ])

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({ observedDecimals: null })
                .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
            })
          )
        )
        const missingDecimalsLedger = yield* Effect.promise(() => loadLedger())
        expect(missingDecimalsLedger.events).toEqual([])
        expect(missingDecimalsLedger.inputBlockers).toEqual([
          expect.objectContaining({
            code: "missing_decimals",
            assetId: REPLACEMENT_ASSET_ID,
            providerAssetRowId: PROVIDER_ASSET_ID,
          }),
        ])
        const missingDecimalsResult = yield* Effect.promise(() => recompute(SECOND_RUN_ID))
        expect(missingDecimalsResult.status).toBe("partial")

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerTransfers)
                .set({ observedDecimals: 8 })
                .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
            })
          )
        )

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z"))
              const [transaction] = yield* db
                .select({ id: schema.transactions.id })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
              if (transaction === undefined) return yield* Effect.die("Missing sibling transaction")

              yield* db.insert(schema.providerAssets).values({
                id: SECOND_PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "chainless-sibling-btc",
                currencyCode: "BTC",
                name: "Bitcoin",
                exponent: null,
                providerType: "crypto",
                rawProviderPayload: { asset_id: "chainless-sibling-btc" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              })
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
                mappingKind: "asset",
                canonicalAssetId: CHAINLESS_ASSET_ID,
                mappingStatus: "approved",
              })
              yield* db.insert(schema.providerTransfers).values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "chainless-sibling-provider-transfer",
                providerAssetId: SECOND_PROVIDER_ASSET_ID,
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "evidence_only",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "1",
              })
              yield* db.insert(schema.transactionLegs).values({
                sourceId: SOURCE_ID,
                externalId: "chainless-sibling-leg",
                timestamp: occurredAt,
                principalId: PRINCIPAL_ID,
                assetId: CHAINLESS_ASSET_ID,
                amount: "1",
                kind: "acquisition",
                provenance: "deterministic",
                metadata: { providerAssetRowId: SECOND_PROVIDER_ASSET_ID },
                transactionId: transaction.id,
              })
            })
          )
        )

        const ledgerWithSibling = yield* Effect.promise(() => loadLedger())
        expect(ledgerWithSibling.events).toEqual([])
        expect(ledgerWithSibling.inputBlockers).toEqual([
          expect.objectContaining({
            code: "missing_decimals",
            assetId: CHAINLESS_ASSET_ID,
            providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
          }),
        ])
        const result = yield* Effect.promise(() => recompute())
        expect(result.status).toBe("partial")
      })
  )

  it.effect("ignores approved fiat mappings when classifying asset blockers", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-11T10:00:00.000Z"))
            yield* db.insert(schema.providerAssets).values({
              id: SECOND_PROVIDER_ASSET_ID,
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
              providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
              mappingKind: "fiat",
              canonicalFiatCurrency: "EUR",
              mappingStatus: "approved",
            })
            const [fiatTransaction, assetTransaction] = yield* db
              .insert(schema.transactions)
              .values([
                {
                  sourceId: SOURCE_ID,
                  externalId: "fiat-provider-transaction",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat" as const,
                  principalId: PRINCIPAL_ID,
                },
                {
                  sourceId: SOURCE_ID,
                  externalId: "fiat-unrelated-asset-transaction",
                  timestamp: occurredAt,
                  transactionType: "buy_fiat" as const,
                  principalId: PRINCIPAL_ID,
                },
              ])
              .returning({ id: schema.transactions.id })
            if (fiatTransaction === undefined || assetTransaction === undefined) {
              return yield* Effect.die("Failed to seed fiat fixture")
            }
            yield* db.insert(schema.providerTransfers).values({
              sourceId: SOURCE_ID,
              transactionId: fiatTransaction.id,
              externalId: "fiat-provider-transfer",
              providerAssetId: SECOND_PROVIDER_ASSET_ID,
              timestamp: occurredAt,
              direction: "outbound",
              processingMode: "accounting_and_evidence",
              fromAccountRef: "principal",
              toAccountRef: "coinbase",
              amount: "100",
            })
            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "fiat-unrelated-asset-leg",
              timestamp: occurredAt,
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              transactionId: assetTransaction.id,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toHaveLength(1)
      expect(ledger.events[0]).toMatchObject({
        transactionReference: "fiat-unrelated-asset-transaction",
      })
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("does not treat an incomplete provider observation as exact", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                contractAddress: schema.assetRepresentations.contractAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (representation === undefined) return yield* Effect.die("Missing representation")
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: null,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: null,
                observedDecimals: null,
              })
              .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          providerAssetRowId: PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("fails closed for indistinguishable repeated provider movements", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      const providerTransferIds = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
            if (transaction === undefined) return yield* Effect.die("Missing repeated transaction")
            const [repeated] = yield* db
              .insert(schema.providerTransfers)
              .values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "repeated-provider-transfer",
                providerAssetId: PROVIDER_ASSET_ID,
                timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z")),
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "coinbase",
                toAccountRef: "principal",
                amount: "1",
              })
              .returning({ id: schema.providerTransfers.id })
            if (repeated === undefined) return yield* Effect.die("Failed to seed repeated transfer")
            yield* db.insert(schema.transactionReviews).values({
              transactionId: transaction.id,
              principalId: PRINCIPAL_ID,
              reviewStatus: "needs_review",
              categorizationReason: "Repeated movements cannot be matched to one stored leg",
              matchedLayer: "provider_asset_mapping",
              needsReview: true,
            })
            const existing = yield* db
              .select({ id: schema.providerTransfers.id })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.transactionId, transaction.id))
            return existing.map(({ id }) => id).sort((left, right) => left.localeCompare(right))
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers.map(({ code }) => code)).toEqual([
        "malformed_movement",
        "malformed_movement",
      ])
      expect(
        ledger.inputBlockers
          .map(({ eventId }) => String(eventId))
          .sort((left, right) => left.localeCompare(right))
      ).toEqual(providerTransferIds)

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const representations = yield* db
              .select({
                id: schema.assetRepresentations.id,
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(
                inArray(schema.assetRepresentations.id, [
                  TEST_BTC_REPRESENTATION_ID,
                  TEST_EUR_REPRESENTATION_ID,
                ])
              )
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
            const btcRepresentation = representations.find(
              ({ id }) => id === TEST_BTC_REPRESENTATION_ID
            )
            const eurRepresentation = representations.find(
              ({ id }) => id === TEST_EUR_REPRESENTATION_ID
            )
            if (
              btcRepresentation === undefined ||
              eurRepresentation === undefined ||
              transaction === undefined
            ) {
              return yield* Effect.die("Missing repeated exact fixture")
            }

            yield* db
              .delete(schema.transactionReviews)
              .where(eq(schema.transactionReviews.transactionId, transaction.id))
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: btcRepresentation.blockchainId,
                observedRepresentationType: btcRepresentation.type,
                observedContractAddress: btcRepresentation.contractAddress,
                observedMintAddress: btcRepresentation.mintAddress,
                observedDecimals: 8,
              })
              .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: eurRepresentation.blockchainId,
                observedRepresentationType: eurRepresentation.type,
                observedContractAddress: eurRepresentation.contractAddress,
                observedMintAddress: eurRepresentation.mintAddress,
                observedDecimals: 2,
              })
              .where(eq(schema.providerTransfers.externalId, "repeated-provider-transfer"))
            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "repeated-metadata-linked-leg",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z")),
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              metadata: { providerAssetRowId: PROVIDER_ASSET_ID },
              transactionId: transaction.id,
            })
          })
        )
      )

      const partialExactLedger = yield* Effect.promise(() => loadLedger())
      expect(partialExactLedger.events).toEqual([])
      expect(
        partialExactLedger.inputBlockers
          .map(({ eventId }) => String(eventId))
          .sort((left, right) => left.localeCompare(right))
      ).toEqual(providerTransferIds)
    })
  )

  it.effect("fails closed for mixed and repeated metadata-free exact leg matches", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedPolicyExcludedMovementWithUserInclusion()))
      const providerTransferId = yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            const [transaction] = yield* db
              .select({ id: schema.transactions.id })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "policy-excluded-transaction"))
            const [providerTransfer] = yield* db
              .select({ id: schema.providerTransfers.id })
              .from(schema.providerTransfers)
              .where(eq(schema.providerTransfers.externalId, "policy-excluded-provider-transfer"))
            if (
              representation === undefined ||
              transaction === undefined ||
              providerTransfer === undefined
            ) {
              return yield* Effect.die("Missing metadata-free exact fixture")
            }

            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({
                observedBlockchainId: representation.blockchainId,
                observedRepresentationType: representation.type,
                observedContractAddress: representation.contractAddress,
                observedMintAddress: representation.mintAddress,
                observedDecimals: 8,
              })
              .where(eq(schema.providerTransfers.id, providerTransfer.id))
            yield* db.insert(schema.transactionLegs).values({
              sourceId: SOURCE_ID,
              externalId: "metadata-free-exact-sibling-leg",
              timestamp: DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-07T10:00:00.000Z")),
              principalId: PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              metadata: {},
              transactionId: transaction.id,
            })

            return providerTransfer.id
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: providerTransferId,
          providerAssetRowId: PROVIDER_ASSET_ID,
        }),
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.transactionLegs)
              .set({ metadata: {} })
              .where(eq(schema.transactionLegs.externalId, "policy-excluded-leg"))
          })
        )
      )

      const metadataFreeLedger = yield* Effect.promise(() => loadLedger())
      expect(metadataFreeLedger.events).toEqual([])
      expect(metadataFreeLedger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "malformed_movement",
          eventId: providerTransferId,
          providerAssetRowId: PROVIDER_ASSET_ID,
        }),
      ])
    })
  )

  it.effect("withholds a custody movement when an exact sibling excludes its transaction", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(seedExactInclusion({ replacementInclusion: "excluded", isSpam: false }))
      )
      yield* Effect.promise(() =>
        runPg(seedReconciledCustodyMovement({ includeExactSibling: true }))
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([])
    })
  )

  it.effect("keeps an exact sibling from suppressing a custody provider blocker", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runPg(seedReconciledCustodyMovement()))
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerTransaction] = yield* db
              .select({
                id: schema.transactions.id,
                timestamp: schema.transactions.timestamp,
              })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "custody-sibling-provider"))
            const [representation] = yield* db
              .select({
                blockchainId: schema.assetRepresentations.blockchainId,
                type: schema.assetRepresentations.type,
                contractAddress: schema.assetRepresentations.contractAddress,
                mintAddress: schema.assetRepresentations.mintAddress,
              })
              .from(schema.assetRepresentations)
              .where(eq(schema.assetRepresentations.id, TEST_BTC_REPRESENTATION_ID))
            if (providerTransaction === undefined || representation === undefined) {
              return yield* Effect.die("Missing custody exact-sibling fixture")
            }

            yield* db
              .update(schema.providerAssets)
              .set({ exponent: null })
              .where(eq(schema.providerAssets.id, SECOND_PROVIDER_ASSET_ID))
            yield* db
              .update(schema.providerTransfers)
              .set({ processingMode: "evidence_only" })
              .where(eq(schema.providerTransfers.externalId, "custody-sibling-provider-transfer"))
            yield* db.insert(schema.providerAssets).values({
              id: THIRD_PROVIDER_ASSET_ID,
              provider: "coinbase",
              providerAssetId: "custody-exact-sibling",
              currencyCode: "BTC",
              name: "Custody exact sibling",
              exponent: 8,
              providerType: "crypto",
              rawProviderPayload: { asset_id: "custody-exact-sibling" },
              evidenceRevision: 1,
              discoveredAt: providerTransaction.timestamp,
              retrievedAt: providerTransaction.timestamp,
            })
            yield* db.insert(schema.providerAssetMappings).values({
              providerAssetRowId: THIRD_PROVIDER_ASSET_ID,
              mappingKind: "asset",
              canonicalAssetId: TEST_BTC_ASSET_ID,
              mappingStatus: "approved",
            })
            yield* db.insert(schema.providerTransfers).values({
              sourceId: SOURCE_ID,
              transactionId: providerTransaction.id,
              externalId: "custody-exact-sibling-transfer",
              providerAssetId: THIRD_PROVIDER_ASSET_ID,
              timestamp: providerTransaction.timestamp,
              direction: "inbound",
              processingMode: "evidence_only",
              fromAccountRef: "external",
              toAccountRef: "principal",
              amount: "2",
              observedBlockchainId: representation.blockchainId,
              observedRepresentationType: representation.type,
              observedContractAddress: representation.contractAddress,
              observedMintAddress: representation.mintAddress,
              observedDecimals: 8,
            })
          })
        )
      )

      const ledger = yield* Effect.promise(() => loadLedger())
      expect(ledger.events).toEqual([])
      expect(ledger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
        }),
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerTransfers)
              .set({ processingMode: "accounting_only" })
              .where(eq(schema.providerTransfers.externalId, "custody-sibling-provider-transfer"))
          })
        )
      )
      const accountingLedger = yield* Effect.promise(() => loadLedger())
      expect(accountingLedger.events).toEqual([])
      expect(accountingLedger.inputBlockers).toEqual([
        expect.objectContaining({
          code: "missing_decimals",
          providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
        }),
      ])

      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            const [providerTransaction] = yield* db
              .select({
                id: schema.transactions.id,
                timestamp: schema.transactions.timestamp,
              })
              .from(schema.transactions)
              .where(eq(schema.transactions.externalId, "custody-sibling-provider"))
            if (providerTransaction === undefined) {
              return yield* Effect.die("Missing custody provider transaction")
            }
            yield* db
              .update(schema.providerTransfers)
              .set({ processingMode: "evidence_only" })
              .where(eq(schema.providerTransfers.externalId, "custody-sibling-provider-transfer"))
            yield* db.insert(schema.providerTransfers).values({
              sourceId: SOURCE_ID,
              transactionId: providerTransaction.id,
              externalId: "custody-accounting-same-provider-sibling",
              providerAssetId: SECOND_PROVIDER_ASSET_ID,
              timestamp: providerTransaction.timestamp,
              direction: "inbound",
              processingMode: "accounting_only",
              fromAccountRef: "external",
              toAccountRef: "principal",
              amount: "3",
            })
          })
        )
      )
      const mixedModeLedger = yield* Effect.promise(() => loadLedger())
      expect(mixedModeLedger.events).toEqual([])
      expect(mixedModeLedger.inputBlockers).toHaveLength(2)
      expect(
        mixedModeLedger.inputBlockers.every(
          ({ code, providerAssetRowId }) =>
            code === "missing_decimals" && providerAssetRowId === SECOND_PROVIDER_ASSET_ID
        )
      ).toBe(true)
    })
  )

  it.effect(
    "does not mark a reconciled custody movement malformed for an excluded provider sibling",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runPg(seedReconciledCustodyMovement()))
        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-09T12:00:00.000Z"))
              const [transaction] = yield* db
                .select({ id: schema.transactions.id })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "custody-sibling-provider"))
              if (transaction === undefined)
                return yield* Effect.die("Missing provider transaction")

              yield* db.insert(schema.providerAssets).values({
                id: PROVIDER_ASSET_ID,
                provider: "coinbase",
                providerAssetId: "excluded-custody-sibling",
                currencyCode: "ETH",
                name: "Excluded custody sibling",
                exponent: 18,
                providerType: "crypto",
                rawProviderPayload: { asset_id: "excluded-custody-sibling" },
                evidenceRevision: 1,
                discoveredAt: occurredAt,
                retrievedAt: occurredAt,
              })
              yield* db.insert(schema.providerAssetMappings).values({
                providerAssetRowId: PROVIDER_ASSET_ID,
                mappingKind: "asset",
                canonicalAssetId: TEST_BTC_ASSET_ID,
                mappingStatus: "excluded",
              })
              yield* db.insert(schema.providerTransfers).values({
                sourceId: SOURCE_ID,
                transactionId: transaction.id,
                externalId: "excluded-custody-sibling-transfer",
                providerAssetId: PROVIDER_ASSET_ID,
                timestamp: occurredAt,
                direction: "inbound",
                processingMode: "accounting_and_evidence",
                fromAccountRef: "external",
                toAccountRef: "principal",
                amount: "2",
              })
              yield* db.insert(schema.transactionReviews).values({
                transactionId: transaction.id,
                principalId: PRINCIPAL_ID,
                reviewStatus: "needs_review",
                categorizationReason: "Excluded sibling needs provider review",
                matchedLayer: "provider_asset_mapping",
                needsReview: true,
              })
            })
          )
        )

        const ledger = yield* Effect.promise(() => loadLedger())
        expect(ledger.events).toEqual([])
        expect(ledger.inputBlockers).toEqual([])

        const result = yield* Effect.promise(() => recompute())
        expect(result.status).toBe("complete")

        const reconciledProviderTransferId = yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              const [providerTransfer] = yield* db
                .select({ id: schema.providerTransfers.id })
                .from(schema.providerTransfers)
                .where(eq(schema.providerTransfers.externalId, "custody-sibling-provider-transfer"))
              const [canonicalTransaction] = yield* db
                .select({ id: schema.transactions.id })
                .from(schema.transactions)
                .where(eq(schema.transactions.externalId, "custody-sibling-canonical"))
              if (providerTransfer === undefined || canonicalTransaction === undefined) {
                return yield* Effect.die("Missing reconciliation fixture")
              }
              yield* db
                .update(schema.inventoryMovements)
                .set({ transactionId: canonicalTransaction.id })
                .where(eq(schema.inventoryMovements.providerTransferId, providerTransfer.id))
              return providerTransfer.id
            })
          )
        )

        const ineligibleLedger = yield* Effect.promise(() => loadLedger())
        expect(ineligibleLedger.events).toEqual([])
        expect(ineligibleLedger.inputBlockers).toEqual([
          expect.objectContaining({
            code: "malformed_movement",
            eventId: reconciledProviderTransferId,
            providerAssetRowId: SECOND_PROVIDER_ASSET_ID,
          }),
        ])

        const ineligibleResult = yield* Effect.promise(() => recompute(SECOND_RUN_ID))
        expect(ineligibleResult.status).toBe("partial")
      })
  )

  it.effect(
    "gives an exact reconciled transfer precedence over a principal provider exclusion",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          runPg(
            seedReconciledCustodyMovement({
              canonicalAssetRepresentationId: TEST_BTC_REPRESENTATION_ID,
              providerReplacementInclusion: "excluded",
            })
          )
        )

        const principalExcluded = yield* Effect.promise(() => loadLedger())
        expect(principalExcluded.events).toHaveLength(1)
        expect(principalExcluded.events[0]).toMatchObject({
          _tag: "custody_movement",
          assetId: TEST_BTC_ASSET_ID,
        })

        yield* Effect.promise(() =>
          runPg(
            Effect.gen(function* () {
              const db = yield* drizzle
              yield* db
                .update(schema.providerAssetMappings)
                .set({ mappingStatus: "excluded" })
                .where(
                  eq(schema.providerAssetMappings.providerAssetRowId, SECOND_PROVIDER_ASSET_ID)
                )
            })
          )
        )

        const globallyExcluded = yield* Effect.promise(() => loadLedger())
        expect(globallyExcluded.events).toEqual([])
        expect(globallyExcluded.inputBlockers).toEqual([])
      })
  )

  it.effect("keeps an exclusion principal-scoped and emits no technical blocker", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        runPg(seedPolicyExcludedMovementWithUserInclusion({ replacementInclusion: "excluded" }))
      )
      yield* Effect.promise(() =>
        runPg(
          Effect.gen(function* () {
            const db = yield* drizzle
            yield* db
              .update(schema.providerAssetMappings)
              .set({ mappingStatus: "approved" })
              .where(eq(schema.providerAssetMappings.providerAssetRowId, PROVIDER_ASSET_ID))
            yield* seedSyncEngineRepositoryFixture({
              userId: OTHER_USER_ID,
              principalId: OTHER_PRINCIPAL_ID,
              sourceId: OTHER_SOURCE_ID,
            })
            const occurredAt = DateTime.toDateUtc(DateTime.makeUnsafe("2025-02-10T10:00:00.000Z"))
            const [otherTransaction] = yield* db
              .insert(schema.transactions)
              .values({
                sourceId: OTHER_SOURCE_ID,
                externalId: "other-principal-transaction",
                timestamp: occurredAt,
                transactionType: "buy_fiat",
                principalId: OTHER_PRINCIPAL_ID,
              })
              .returning({ id: schema.transactions.id })
            if (otherTransaction === undefined) {
              return yield* Effect.die("Failed to seed other principal transaction")
            }
            yield* db.insert(schema.providerTransfers).values({
              sourceId: OTHER_SOURCE_ID,
              transactionId: otherTransaction.id,
              externalId: "other-principal-provider-transfer",
              providerAssetId: PROVIDER_ASSET_ID,
              timestamp: occurredAt,
              direction: "inbound",
              processingMode: "accounting_and_evidence",
              fromAccountRef: "coinbase",
              toAccountRef: "other-principal",
              amount: "1",
            })
            yield* db.insert(schema.transactionLegs).values({
              sourceId: OTHER_SOURCE_ID,
              externalId: "other-principal-leg",
              timestamp: occurredAt,
              principalId: OTHER_PRINCIPAL_ID,
              assetId: TEST_BTC_ASSET_ID,
              amount: "1",
              kind: "acquisition",
              provenance: "deterministic",
              metadata: { providerAssetRowId: PROVIDER_ASSET_ID },
              transactionId: otherTransaction.id,
            })
          })
        )
      )

      const principalLedger = yield* Effect.promise(() => loadLedger())
      const otherLedger = yield* Effect.promise(() => loadLedger(OTHER_PRINCIPAL_ID))
      expect(principalLedger.events).toEqual([])
      expect(principalLedger.inputBlockers).toEqual([])
      expect(otherLedger.events).toHaveLength(1)
      expect(otherLedger.inputBlockers).toEqual([])
    })
  )
})
