import { describe, expect, it } from "vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  INSUFFICIENT_CITED_BASIS_TEXT,
  LegalReferenceRepository,
  type LegalCitationReference,
  type LegalReferenceRepositoryShape,
  LegalReferenceService,
  LegalReferenceServiceLive,
} from "../../src/legal/index.ts"

const ruleSet = {
  id: "ruleset-de-2025-03-06",
  version: "de-crypto-income-tax-v2025-03-06",
  name: "DE Crypto Income Tax Ruleset (BMF 2025-03-06)",
}

const makeClause = ({
  clauseKey,
  heading,
  summary,
  clauseText,
  randnummer,
}: {
  clauseKey: string
  heading: string | null
  summary: string | null
  clauseText: string
  randnummer: string
}): LegalCitationReference => ({
  clauseKey,
  sectionCode: "II.5.b",
  heading,
  randnummer,
  summary,
  clauseText,
  source: {
    sourceKey: "de-bmf-krypto-2025-03-06",
    title: "Einzelfragen zur ertragsteuerrechtlichen Behandlung von Kryptowerten",
    shortTitle: "BMF 2025-03-06",
    sourceType: "administrative_guidance",
    authority: "Bundesministerium der Finanzen",
    publishedAt: new Date("2025-03-06T00:00:00.000Z"),
    sourceUrl:
      "https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte-bmf-schreiben.pdf",
  },
})

const relevantSwapClause = makeClause({
  clauseKey: "DE.BMF.2025-03-06.RN54",
  heading: "Anschaffung und Veraeusserung",
  randnummer: "54",
  summary: "Krypto-zu-Krypto-Tausch ist steuerlich relevant.",
  clauseText:
    "Tausch gegen Fiat, Waren, Dienstleistungen oder andere Kryptowerte ist ein Veraeusserungsvorgang.",
})

const holdingPeriodClause = makeClause({
  clauseKey: "DE.BMF.2025-03-06.RN53",
  heading: "Private Veraeusserungsgeschaefte",
  randnummer: "53",
  summary: "Einjahresfrist fuer section 23 EStG ist zentral.",
  clauseText:
    "Private Gewinne sind steuerbar, wenn zwischen Anschaffung und Veraeusserung nicht mehr als ein Jahr liegt.",
})

const stakingClause = makeClause({
  clauseKey: "DE.BMF.2025-03-06.RN48",
  heading: "Einkuenfte aus passivem Staking",
  randnummer: "48",
  summary: "Staking-Ertraege sind regelmaessig sonstige Einkuenfte.",
  clauseText:
    "Passives Staking unterliegt in der Regel der Besteuerung nach section 22 number 3 EStG.",
})

const createRepository = (): LegalReferenceRepositoryShape => ({
  getRuleSet: ({ version }) =>
    Effect.succeed(version === undefined || version === ruleSet.version ? ruleSet : null),
  getReferencesForTransactionTypeWithRuleSet: ({ transactionTypeKey, ruleSetVersion }) =>
    Effect.succeed({
      ruleSet: ruleSetVersion === undefined || ruleSetVersion === ruleSet.version ? ruleSet : null,
      references:
        transactionTypeKey === "swap_crypto_to_crypto"
          ? [
              {
                ruleId: "rule-swap",
                ruleKey: "de.private.section23.disposal-within-one-year",
                title: "Private Veraeusserung innerhalb der Haltefrist",
                description: "Krypto-Tausch ist ein Veraeusserungsvorgang.",
                scope: "private_disposal",
                outcomeCategory: "section23",
                machineReadable: {
                  domain: "private_disposal",
                  oneYearWindow: true,
                },
                relevance: 1,
                citations: [holdingPeriodClause, relevantSwapClause, stakingClause],
              },
              {
                ruleId: "rule-wallet-fifo",
                ruleKey: "de.private.section23.wallet-fifo-method",
                title: "Walletbezogene FiFo-/Methodenkonsistenz",
                description: "Walletbezogene Verbrauchsreihenfolge muss konsistent bleiben.",
                scope: "lot_selection",
                outcomeCategory: "valuation_method",
                machineReadable: {
                  domain: "lot_selection",
                  walletScoped: true,
                },
                relevance: 0.9,
                citations: [
                  makeClause({
                    clauseKey: "DE.BMF.2025-03-06.RN61",
                    heading: "Verwendungsreihenfolge",
                    randnummer: "61",
                    summary: "FiFo ist erlaubt, wenn Einzelzuordnung nicht moeglich ist.",
                    clauseText:
                      "Mangels Einzelzuordnung kann fuer Wertermittlung FiFo als Vereinfachung verwendet werden.",
                  }),
                ],
              },
            ]
          : [],
    }),
  getClauseCorpusForRuleSet: ({ ruleSetVersion }) =>
    Effect.succeed({
      ruleSet: ruleSetVersion === undefined || ruleSetVersion === ruleSet.version ? ruleSet : null,
      clauses: [stakingClause, holdingPeriodClause, relevantSwapClause],
    }),
})

const runWithService = <A>(effect: Effect.Effect<A, unknown, LegalReferenceService>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        LegalReferenceServiceLive.pipe(
          Layer.provide(Layer.succeed(LegalReferenceRepository, createRepository()))
        )
      )
    )
  )

describe("LegalReferenceService", () => {
  it("ranks question-level clauses for a known DE swap question", async () => {
    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* LegalReferenceService
        return yield* service.getRelevantClausesForQuestion({
          question: "Ist ein Tausch von ETH in einen anderen Coin steuerpflichtig?",
          jurisdictionCode: "DE",
          maxClauses: 2,
        })
      })
    )

    expect(result.ruleSet?.version).toBe(ruleSet.version)
    expect(result.insufficiencyText).toBeNull()
    expect(result.references).toHaveLength(2)
    expect(result.references[0]?.clauseKey).toBe("DE.BMF.2025-03-06.RN54")
    expect(
      result.references.every((reference) =>
        /^DE\.BMF\.2025-03-06\.RN[0-9A-Z]+$/.test(reference.clauseKey)
      )
    ).toBe(true)
  })

  it("returns insufficiency text when no relevant clause is found", async () => {
    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* LegalReferenceService
        return yield* service.getRelevantClausesForQuestion({
          question: "Blorptax quantum toaster carry rule for Martian NFTs?",
          jurisdictionCode: "DE",
          maxClauses: 5,
        })
      })
    )

    expect(result.ruleSet?.version).toBe(ruleSet.version)
    expect(result.references).toEqual([])
    expect(result.insufficiencyText).toBe(INSUFFICIENT_CITED_BASIS_TEXT)
  })

  it("bounds transaction-type references and citations deterministically", async () => {
    const result = await runWithService(
      Effect.gen(function* () {
        const service = yield* LegalReferenceService
        return yield* service.getReferencesForTransactionTypeWithRuleSet({
          transactionTypeKey: "swap_crypto_to_crypto",
          jurisdictionCode: "DE",
          maxReferences: 1,
          maxCitationsPerReference: 2,
        })
      })
    )

    expect(result.ruleSet?.version).toBe(ruleSet.version)
    expect(result.references).toHaveLength(1)
    expect(result.references[0]?.ruleKey).toBe("de.private.section23.disposal-within-one-year")
    expect(result.references[0]?.citations).toHaveLength(2)
    expect(result.references[0]?.citations.map((citation) => citation.clauseKey)).toEqual([
      "DE.BMF.2025-03-06.RN53",
      "DE.BMF.2025-03-06.RN54",
    ])
  })
})
