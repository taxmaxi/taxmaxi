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
import { AssetExceptionDetailPane } from "#/components/asset-exception-detail"
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
  currentConclusionRevision: "no_current_conclusion",
  currentPolicyEvaluationRevision: POLICY_DECISION_ID,
  reviewStatus: "unresolved",
  currentConclusion: null,
  currentPolicyEvaluation: {
    id: POLICY_DECISION_ID,
    supersedesConclusionId: null,
    isCurrentConclusion: false,
    isCurrentPolicyEvaluation: true,
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
      supersedesConclusionId: null,
      isCurrentConclusion: false,
      isCurrentPolicyEvaluation: true,
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
    affectedCalculations: 0,
    existingGeneratedReportSnapshots: 0,
    affectedTransactionValueEur: null,
  },
  rematerialization: {
    status: "complete",
    affectedSourceCount: 0,
    pendingSourceCount: 0,
    runningSourceCount: 0,
    completedSourceCount: 0,
    failedSourceCount: 0,
    retryingSourceCount: 0,
    remainingSourceCount: 0,
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
  supersededConclusion: detail.currentConclusion,
  impact: detail.impact,
  rematerializationSourceCount: 1,
  evidenceRevision: detail.evidenceRevision,
  currentConclusionRevision: detail.currentConclusionRevision,
  currentPolicyEvaluationRevision: detail.currentPolicyEvaluationRevision,
})

const makeActions = (): AssetExceptionActions => ({
  get: vi.fn(async () => detail),
  lookup: vi.fn(async () => detail),
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
  it("opens a settled observation by its provider identity", async () => {
    const actions = makeActions()
    render(<AssetExceptionDetailPane actions={actions} />)

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "coinbase" } })
    fireEvent.change(screen.getByLabelText("Provider observation ID"), {
      target: { value: "btc" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Look up" }))

    await waitFor(() =>
      expect(actions.lookup).toHaveBeenCalledWith({ provider: "coinbase", providerAssetId: "btc" })
    )
    expect(await screen.findByText("Melea Initiative · helius-solana")).toBeTruthy()
  })

  it("opens a settled observation by its provider natural key", async () => {
    const actions = makeActions()
    render(<AssetExceptionDetailPane actions={actions} />)

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "coinbase" } })
    fireEvent.change(screen.getByLabelText("Natural key"), {
      target: { value: "currency_code:BTC" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Look up" }))

    await waitFor(() =>
      expect(actions.lookup).toHaveBeenCalledWith({
        provider: "coinbase",
        naturalKey: "currency_code:BTC",
      })
    )
  })

  it("requires a provider and exactly one lookup identifier", () => {
    const actions = makeActions()
    render(<AssetExceptionDetailPane actions={actions} />)

    fireEvent.click(screen.getByRole("button", { name: "Look up" }))
    expect(
      screen.getByText("Enter a provider and exactly one observation ID or natural key.")
    ).toBeTruthy()
    expect(actions.lookup).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "coinbase" } })
    fireEvent.change(screen.getByLabelText("Provider observation ID"), {
      target: { value: "btc" },
    })
    fireEvent.change(screen.getByLabelText("Natural key"), {
      target: { value: "currency_code:BTC" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Look up" }))

    expect(
      screen.getByText("Enter a provider and exactly one observation ID or natural key.")
    ).toBeTruthy()
    expect(actions.lookup).not.toHaveBeenCalled()
  })

  it("shows a lookup failure and keeps the form available", async () => {
    const actions: AssetExceptionActions = {
      ...makeActions(),
      lookup: vi.fn(async () => Promise.reject(new Error("lookup failed"))),
    }
    render(<AssetExceptionDetailPane actions={actions} />)

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "coinbase" } })
    fireEvent.change(screen.getByLabelText("Provider observation ID"), {
      target: { value: "missing" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Look up" }))

    expect(await screen.findByText("The reviewed observation could not be opened.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Look up" })).toBeTruthy()
    expect(screen.getByLabelText("Provider observation ID")).toHaveProperty("value", "missing")
  })

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

  it("shows the settled conclusion, later policy request, and rebuild progress separately", () => {
    const conclusionId = "00000000-0000-4000-8000-000000000806"
    const currentConclusion = {
      id: conclusionId,
      supersedesConclusionId: null,
      isCurrentConclusion: true,
      isCurrentPolicyEvaluation: false,
      outcome: "excluded" as const,
      claim: { _tag: "exclusion" as const, reason: "confirmed_spam" as const },
      rationale: "Confirmed by an administrator.",
      reason: "confirmed_spam",
      assetId: null,
      assetRepresentationId: null,
      actorId: "admin:test",
      policyRevision: "human.1",
      evidenceRevision: 1,
      evidenceSnapshotIds: [EVIDENCE_ID],
      createdAt: DateTime.makeUnsafe("2026-08-24T10:00:00.000Z"),
    }
    const splitDetail = {
      ...detail,
      evidenceRevision: 2,
      currentConclusionRevision: conclusionId,
      currentConclusion,
      decisionHistory: [currentConclusion, ...detail.decisionHistory],
      rematerialization: {
        status: "operator_attention" as const,
        affectedSourceCount: 5,
        pendingSourceCount: 1,
        runningSourceCount: 1,
        completedSourceCount: 2,
        failedSourceCount: 1,
        retryingSourceCount: 1,
        remainingSourceCount: 3,
        lastFailureAt: DateTime.makeUnsafe("2026-08-24T10:05:00.000Z"),
        failureCode: "replay_failed",
      },
    } satisfies AssetExceptionDetail

    render(
      <AssetExceptionReview
        actions={makeActions()}
        detail={splitDetail}
        exception={exception}
        onDetailChange={vi.fn()}
        stale={false}
      />
    )

    expect(screen.getByText("Excluded")).toBeTruthy()
    expect(screen.getByText("Review requested")).toBeTruthy()
    expect(screen.getByText("Data update needs attention")).toBeTruthy()
    expect(
      screen.getByText("3 remaining · 2 complete · 1 running · 1 queued · 1 retrying · 1 failed")
    ).toBeTruthy()
  })

  it("keeps settled detail visible after its exception leaves the queue", async () => {
    const conclusionId = "00000000-0000-4000-8000-000000000807"
    const currentConclusion = {
      id: conclusionId,
      supersedesConclusionId: null,
      isCurrentConclusion: true,
      isCurrentPolicyEvaluation: true,
      outcome: "excluded" as const,
      claim: { _tag: "exclusion" as const, reason: "confirmed_spam" as const },
      rationale: "Confirmed by an administrator.",
      reason: "confirmed_spam",
      assetId: null,
      assetRepresentationId: null,
      actorId: "admin:test",
      policyRevision: "human.1",
      evidenceRevision: 1,
      evidenceSnapshotIds: [EVIDENCE_ID],
      createdAt: DateTime.makeUnsafe("2026-08-24T10:00:00.000Z"),
    }
    const settledDetail = {
      ...detail,
      currentConclusionRevision: conclusionId,
      currentPolicyEvaluationRevision: conclusionId,
      reviewStatus: "excluded" as const,
      currentConclusion,
      currentPolicyEvaluation: currentConclusion,
      decisionHistory: [currentConclusion],
      rematerialization: {
        status: "pending" as const,
        affectedSourceCount: 1,
        pendingSourceCount: 1,
        runningSourceCount: 0,
        completedSourceCount: 0,
        failedSourceCount: 0,
        retryingSourceCount: 0,
        remainingSourceCount: 1,
        lastFailureAt: null,
        failureCode: null,
      },
    } satisfies AssetExceptionDetail
    const actions: AssetExceptionActions = {
      ...makeActions(),
      get: vi.fn(async () => settledDetail),
    }
    const view = render(<AssetExceptionDetailPane actions={actions} exception={exception} />)

    expect(await screen.findByText("Data update queued")).toBeTruthy()
    view.rerender(<AssetExceptionDetailPane actions={actions} />)

    expect(screen.getByText("Melea Initiative · helius-solana")).toBeTruthy()
    expect(screen.getByText("Data update queued")).toBeTruthy()
  })

  it("blocks a conflicting attachment before preview and offers safe alternatives", async () => {
    const actions = makeActions()
    renderReview(actions)

    fireEvent.click(screen.getByRole("radio", { name: /Attach to existing asset/ }))

    const unavailable = await screen.findByRole("region", { name: "Attachment unavailable" })
    expect(within(unavailable).getByText("No compatible existing asset found")).toBeTruthy()
    expect(within(unavailable).getByText(OBSERVED_MINT)).toBeTruthy()
    expect(within(unavailable).getByText("ac2bb14wpyQ85JLoiLK1U2SE76CsAobPw1uGR4PkDi")).toBeTruthy()
    // The search stays available so the reviewer can refine or retry even
    // though every current candidate is ineligible.
    expect(screen.getByLabelText("Search catalog assets")).toBeTruthy()
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
      currentConclusionRevision: "no_current_conclusion",
      currentPolicyEvaluationRevision: POLICY_DECISION_ID,
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

  it("refreshes the detail and clears the preview after a stale decision conflict", async () => {
    const actions: AssetExceptionActions = {
      ...makeActions(),
      submit: vi.fn(async () => {
        throw {
          _tag: "AssetStaleRevisionError",
          code: "stale_revision",
          evidenceRevision: 2,
          currentConclusionRevision: "no_current_conclusion",
          currentPolicyEvaluationRevision: POLICY_DECISION_ID,
        }
      }),
    }
    const { onDetailChange } = renderReview(actions)

    fireEvent.click(screen.getByRole("radio", { name: /Exclude from reports/ }))
    fireEvent.click(screen.getByRole("button", { name: "Review exclusion" }))
    await waitFor(() => expect(actions.preview).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole("button", { name: "Confirm exclusion" }))

    // The stale preview cannot be retried; the latest detail is fetched so
    // the next preview starts from the current revisions.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Evidence, the current conclusion, or the policy evaluation changed. Detail was refreshed; preview again."
        )
      ).toBeTruthy()
    )
    expect(actions.get).toHaveBeenCalledWith(OBSERVATION_ID)
    expect(onDetailChange).toHaveBeenCalledWith(detail)
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Decision preview" })).toBeNull()
    )
  })
})
