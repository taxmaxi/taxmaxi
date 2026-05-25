import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { ActivityClassificationServiceLive } from "@my/sync-engine/layers"
import {
  ActivityEvidence,
  ActivityClassificationService,
  ActivityFacts,
} from "@my/sync-engine/services"

const classify = (facts: ActivityFacts) =>
  Effect.gen(function* () {
    const classifier = yield* ActivityClassificationService
    return yield* classifier.classifyActivity({ facts })
  }).pipe(Effect.provide(ActivityClassificationServiceLive), Effect.runPromise)

const evidencePayload = {
  signature: "5mSolanaFixtureSignature",
  balanceDeltas: [{ asset: "SOL", amount: "-0.01" }],
}

const solanaEvidence = [
  {
    kind: "provider_label",
    source: "helius-solana",
    summary: "Helius labelled the transaction as TRANSFER.",
    payload: { type: "TRANSFER" },
  },
  {
    kind: "balance_delta",
    source: "helius-solana.full-transaction",
    summary: "Principal SOL balance decreased by transfer amount plus fee.",
    payload: evidencePayload,
  },
] satisfies ReadonlyArray<typeof ActivityEvidence.Type>

const cexEvidence = [
  {
    kind: "cex_row",
    source: "coinbase.transaction",
    summary: "Coinbase row type is buy.",
    payload: { type: "buy", resourcePath: "/v2/accounts/account-1/transactions/tx-1" },
  },
] satisfies ReadonlyArray<typeof ActivityEvidence.Type>

describe("ActivityClassificationService", () => {
  it("returns the deterministic review-required fallback for unknown facts", async () => {
    const facts = new ActivityFacts({
      sourceKind: "unknown",
      providerKey: "fixture-provider",
      sourceId: "source-1",
      externalId: "activity-1",
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      providerActivityType: null,
      movements: [],
      cex: null,
      onchain: null,
      utxo: null,
      rawPayload: { id: "activity-1" },
      evidence: [],
    })

    await expect(classify(facts)).resolves.toEqual(
      expect.objectContaining({
        transactionType: "uncategorized",
        inventoryEffect: "unknown",
        taxTreatment: "requires_additional_rule_logic",
        confidence: "0.00",
        evidence: [],
        review: expect.objectContaining({
          reviewStatus: "needs_review",
          needsReview: true,
          matchedLayer: "activity_classification_fallback",
        }),
      })
    )
  })

  it("preserves evidence when constructing a fallback classification", async () => {
    const facts = Schema.decodeUnknownSync(ActivityFacts)({
      sourceKind: "solana",
      providerKey: "helius-solana",
      sourceId: "source-solana-1",
      externalId: "5mSolanaFixtureSignature",
      occurredAt: new Date("2026-01-02T00:00:00.000Z"),
      providerActivityType: "TRANSFER",
      movements: [],
      cex: null,
      onchain: null,
      utxo: null,
      rawPayload: { signature: "5mSolanaFixtureSignature" },
      evidence: solanaEvidence,
    })

    const result = await classify(facts)

    expect(result.evidence).toEqual(solanaEvidence)
  })

  it("accepts Solana-shaped activity facts without Solana-only result fields", async () => {
    const facts = Schema.decodeUnknownSync(ActivityFacts)({
      sourceKind: "solana",
      providerKey: "helius-solana",
      sourceId: "source-solana-2",
      externalId: "solana-signature-2",
      occurredAt: new Date("2026-01-03T00:00:00.000Z"),
      providerActivityType: "SWAP",
      movements: [
        {
          direction: "outbound",
          role: "principal",
          assetId: "asset-sol",
          assetSymbol: "SOL",
          amount: "-1.00",
          fiatAmount: null,
          fiatCurrency: null,
          address: "Wallet111111111111111111111111111111111111",
          accountRef: null,
          tokenId: null,
          metadata: { source: "preBalances" },
        },
        {
          direction: "inbound",
          role: "principal",
          assetId: null,
          assetSymbol: "USDC",
          amount: "150.00",
          fiatAmount: null,
          fiatCurrency: null,
          address: "Wallet111111111111111111111111111111111111",
          accountRef: null,
          tokenId: null,
          metadata: { source: "postTokenBalances" },
        },
      ],
      cex: null,
      onchain: {
        chainType: "solana",
        blockchainId: "solana",
        txHash: "solana-signature-2",
        blockNumber: "333",
        status: "succeeded",
        feePayer: "Wallet111111111111111111111111111111111111",
        entrypoints: [
          {
            kind: "program",
            id: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
            name: "Jupiter",
            metadata: { instructionName: "route" },
          },
        ],
        metadata: { slot: 333 },
      },
      utxo: null,
      rawPayload: { signature: "solana-signature-2" },
      evidence: solanaEvidence,
    })

    const result = await classify(facts)

    expect(result).not.toHaveProperty("solanaTransactionType")
    expect(result).not.toHaveProperty("signature")
    expect(result.transactionType).toBe("uncategorized")
    expect(result.evidence).toEqual(solanaEvidence)
  })

  it("accepts CEX-shaped activity facts without provider-specific result fields", async () => {
    const facts = Schema.decodeUnknownSync(ActivityFacts)({
      sourceKind: "cex",
      providerKey: "coinbase",
      sourceId: "source-cex-1",
      externalId: "coinbase-tx-1",
      occurredAt: new Date("2026-01-04T00:00:00.000Z"),
      providerActivityType: "buy",
      movements: [
        {
          direction: "inbound",
          role: "principal",
          assetId: "asset-btc",
          assetSymbol: "BTC",
          amount: "0.10",
          fiatAmount: "4000.00",
          fiatCurrency: "EUR",
          address: null,
          accountRef: "account-1",
          tokenId: null,
          metadata: { source: "coinbase.amount" },
        },
      ],
      cex: {
        cexName: "coinbase",
        externalAccountId: "account-1",
        externalOrderId: "order-1",
        externalFillId: "fill-1",
        venueSide: "buy",
        instrument: "BTC-EUR",
        rowType: "transaction",
        metadata: { resource: "transaction" },
      },
      onchain: null,
      utxo: null,
      rawPayload: { id: "coinbase-tx-1" },
      evidence: cexEvidence,
    })

    const result = await classify(facts)

    expect(result).not.toHaveProperty("coinbaseTransactionType")
    expect(result).not.toHaveProperty("venueSide")
    expect(result.transactionType).toBe("uncategorized")
    expect(result.evidence).toEqual(cexEvidence)
  })
})
