// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import * as DateTime from "effect/DateTime"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  AssetCatalogAsset,
  AssetExceptionDecisionInput,
  AssetExceptionDetail,
  AssetExceptionPreview,
} from "taxmaxi"

import type { AssetExceptionActions } from "#/components/asset-catalog-context"
import type { TaxMaxiAssetException } from "#/components/asset-catalog-model"
import { AssetExceptionReview } from "#/components/asset-exception-review"

const OBSERVATION_ID = "00000000-0000-4000-8000-000000000801"
const POLICY_DECISION_ID = "00000000-0000-4000-8000-000000000802"
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000803"
const OBSERVED_MINT = "8MC94Z2XbTrkDZV9At7xJMbyTkRLoyPxBtka31Mt6Usf"

const detail = {
  providerAssetRowId: OBSERVATION_ID,
  provider: "helius-solana",
  providerAssetId: OBSERVED_MINT,
  naturalKey: `solana:mint:${OBSERVED_MINT}`,
  currencyCode: "MLDAO",
  name: "Melea Initiative",
  exponent: 0,
  providerType: "spl-token",
  rawProviderPayload: { id: OBSERVED_MINT, symbol: "MLDAO" },
  evidenceRevision: 1,
  policyRevision: "2026-08-21.jupiter-banned-exclusion.1",
  activeDecisionRevision: POLICY_DECISION_ID,
  reviewStatus: "unresolved",
  policyOutput: { outcome: "pending", reason: "display_collision" },
  activeDecision: {
    id: POLICY_DECISION_ID,
    status: "active",
    supersedesDecisionId: null,
    outcome: "pending",
    claim: null,
    rationale: null,
    reason: "display_collision",
    assetId: null,
    assetRepresentationId: null,
    actorId: "system:asset-resolution-policy",
    policyRevision: "2026-08-21.jupiter-banned-exclusion.1",
    evidenceRevision: 1,
    evidenceSnapshotIds: [EVIDENCE_ID],
    createdAt: DateTime.makeUnsafe("2026-08-24T09:54:00.000Z"),
  },
  decisionHistory: [
    {
      id: POLICY_DECISION_ID,
      status: "active",
      supersedesDecisionId: null,
      outcome: "pending",
      claim: null,
      rationale: null,
      reason: "display_collision",
      assetId: null,
      assetRepresentationId: null,
      actorId: "system:asset-resolution-policy",
      policyRevision: "2026-08-21.jupiter-banned-exclusion.1",
      evidenceRevision: 1,
      evidenceSnapshotIds: [EVIDENCE_ID],
      createdAt: DateTime.makeUnsafe("2026-08-24T09:54:00.000Z"),
    },
  ],
  evidence: [
    {
      id: EVIDENCE_ID,
      authority: "chain",
      claimKind: "chain_fact",
      sourceLocator: `taxmaxi://provider-assets/${OBSERVATION_ID}/observed-representations`,
      retrievedAt: DateTime.makeUnsafe("2026-08-24T09:53:00.000Z"),
      evidenceRevision: 1,
      decodedClaim: {
        blockchain: "solana",
        type: "token",
        contractAddress: null,
        mintAddress: OBSERVED_MINT,
        decimals: 0,
      },
      rawPayload: [
        {
          blockchainName: "solana",
          representationType: "token",
          contractAddress: null,
          mintAddress: OBSERVED_MINT,
          decimals: 0,
        },
      ],
    },
  ],
  impact: {
    blockedReports: 1,
    affectedPrincipals: 1,
    affectedTransactions: 4,
    affectedSources: 1,
    affectedTransactionValueEur: null,
  },
  rematerialization: {
    status: "complete",
    affectedSourceCount: 0,
    failedSourceCount: 0,
    lastFailureAt: null,
    failureCode: null,
  },
} satisfies AssetExceptionDetail

const exception = {
  providerAssetRowId: OBSERVATION_ID,
  provider: "helius-solana",
  providerAssetId: OBSERVED_MINT,
  naturalKey: `solana:mint:${OBSERVED_MINT}`,
  currencyCode: "MLDAO",
  name: "Melea Initiative",
  reason: "display_collision",
  severity: "medium",
  oldestAt: DateTime.makeUnsafe("2026-08-24T09:53:00.000Z"),
} satisfies TaxMaxiAssetException

const conflictingAsset = {
  id: "00000000-0000-4000-8000-000000000804",
  name: "Melea Initiative",
  symbol: "MLDAO",
  type: "fungible",
  coingeckoCoinId: null,
  logoUrl: null,
  representations: [
    {
      id: "00000000-0000-4000-8000-000000000805",
      blockchainId: "solana",
      blockchainName: "solana",
      blockchainChainType: "solana",
      blockchainChainId: null,
      blockchainExplorerUrl: "https://explorer.solana.com",
      blockchainLogoUrl: null,
      type: "token",
      contractAddress: null,
      mintAddress: "ac2bb14wpyQ85JLoiLK1U2SE76CsAobPw1uGR4PkDi",
      decimals: 0,
      logoUrl: null,
      metadata: null,
    },
  ],
} satisfies AssetCatalogAsset

const makePreview = (input: AssetExceptionDecisionInput): AssetExceptionPreview => ({
  claim: input.claim,
  decisionAction: "initial",
  resultingAssetId: null,
  assetOutcome: input.claim._tag === "identity" ? "create" : "none",
  representationOutcome: input.claim._tag === "identity" ? "create" : "none",
  supersededDecision: detail.activeDecision,
  impact: detail.impact,
  rematerializationSourceCount: 1,
  evidenceRevision: detail.evidenceRevision,
  activeDecisionRevision: detail.activeDecisionRevision,
})

const makeActions = (): AssetExceptionActions => ({
  get: vi.fn(async () => detail),
  preview: vi.fn(async (input) => makePreview(input)),
  searchAssets: vi.fn(async () => ({
    assets: [conflictingAsset],
    page: { nextCursor: null, hasMore: false },
  })),
  submit: vi.fn(async () => detail),
})

const renderReview = (actions: AssetExceptionActions = makeActions()) => {
  const onDetailChange = vi.fn()
  render(
    <AssetExceptionReview
      actions={actions}
      detail={detail}
      exception={exception}
      onDetailChange={onDetailChange}
      stale={false}
    />
  )
  return { actions, onDetailChange }
}

afterEach(cleanup)

describe("AssetExceptionReview", () => {
  it("renders one review request and hides empty lookup and rebuild states", () => {
    renderReview()

    expect(screen.queryByText("Exact observation lookup")).toBeNull()
    expect(screen.queryByText("System policy paused the observation")).toBeNull()
    expect(screen.getAllByText("Review requested")).toHaveLength(1)
    expect(screen.queryByText(/Data rebuild/)).toBeNull()
    expect(screen.queryByText(/Affected data updated/)).toBeNull()
    expect(screen.getByText("Needs decision")).toBeTruthy()
    expect(screen.getAllByText("Display identity collision")).toHaveLength(2)
  })

  it("blocks a conflicting attachment before preview and offers safe alternatives", async () => {
    const actions = makeActions()
    renderReview(actions)

    fireEvent.click(screen.getByRole("radio", { name: /Attach to existing asset/ }))

    const unavailable = await screen.findByRole("region", { name: "Attachment unavailable" })
    expect(within(unavailable).getByText("No compatible existing asset found")).toBeTruthy()
    expect(within(unavailable).getByText(OBSERVED_MINT)).toBeTruthy()
    expect(within(unavailable).getByText("ac2bb14wpyQ85JLoiLK1U2SE76CsAobPw1uGR4PkDi")).toBeTruthy()
    expect(screen.queryByLabelText("Search catalog assets")).toBeNull()
    await waitFor(() => {
      expect(screen.queryByText("Representation that will be recorded")).toBeNull()
      expect(screen.queryByRole("textbox", { name: "Rationale" })).toBeNull()
      expect(screen.queryByRole("button", { name: "Review attachment" })).toBeNull()
    })
    expect(actions.preview).not.toHaveBeenCalled()

    fireEvent.click(within(unavailable).getByRole("button", { name: "Create as new asset" }))
    expect(
      screen.getByRole("radio", { name: /Attach to existing asset/ }).matches(":disabled")
    ).toBe(true)
    expect(screen.getByText("Representation that will be recorded")).toBeTruthy()
    expect(screen.queryByRole("textbox", { name: "Blockchain" })).toBeNull()
  })

  it("previews a structured exclusion without requiring a duplicate note", async () => {
    const actions = makeActions()
    const { onDetailChange } = renderReview(actions)

    fireEvent.click(screen.getByRole("radio", { name: /Exclude from reports/ }))

    expect(screen.getByText("Why it will be excluded")).toBeTruthy()
    expect(screen.getByText("Spam or impersonation")).toBeTruthy()
    expect(screen.queryByRole("textbox", { name: "Rationale" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Review exclusion" }))

    await waitFor(() => expect(actions.preview).toHaveBeenCalledOnce())
    expect(actions.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        claim: { _tag: "exclusion", reason: "confirmed_spam" },
        rationale: null,
      })
    )
    const preview = screen.getByRole("region", { name: "Decision preview" })
    expect(within(preview).getByText("Ready to exclude MLDAO from reports")).toBeTruthy()
    expect(within(preview).getByText("Spam or impersonation")).toBeTruthy()
    expect(
      within(preview).getByText(
        "1 affected data source will be reprocessed so reports reflect this decision."
      )
    ).toBeTruthy()
    expect(within(preview).getByRole("button", { name: "Confirm exclusion" })).toBeTruthy()
    expect(within(preview).queryByText("First decision")).toBeNull()
    expect(within(preview).queryByText("Sources to rebuild")).toBeNull()
    expect(within(preview).queryByText("none")).toBeNull()

    fireEvent.click(within(preview).getByRole("button", { name: "Confirm exclusion" }))
    await waitFor(() => expect(actions.submit).toHaveBeenCalledOnce())
    expect(actions.submit).toHaveBeenCalledWith({
      id: OBSERVATION_ID,
      claim: { _tag: "exclusion", reason: "confirmed_spam" },
      evidenceRevision: 1,
      activeDecisionRevision: POLICY_DECISION_ID,
      evidenceSnapshotIds: [EVIDENCE_ID],
      rationale: null,
      expectedResultingAssetId: null,
      expectedAssetOutcome: "none",
      expectedRepresentationOutcome: "none",
    })
    expect(onDetailChange).toHaveBeenCalledWith(detail)
    expect(
      screen.getByText("Decision accepted. Rebuilding affected data is now tracked separately.")
    ).toBeTruthy()
  })
})
