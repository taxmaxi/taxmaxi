// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { TaxMaxi, type Account, type TransactionOverrideCurrent } from "taxmaxi"
import { queryKeys } from "#/integrations/taxmaxi/queries"
import { useTransactionDraftGuard, useTransactionEditor } from "#/components/use-transaction-editor"
import { TransactionEditor } from "#/components/transaction-editor"
const TARGET = "00000000-0000-4000-8000-000000000001"
const USER = "00000000-0000-4000-8000-000000000002"
const LEAF = "00000000-0000-4000-8000-000000000003"
function currentPrice(active = false, quantity = "2"): TransactionOverrideCurrent {
  const target = {
    principalId: TARGET,
    sourceId: TARGET,
    sourceRecordKey: "buy-2",
    componentKey: "amount",
  }
  const facts = {
    target,
    systemRevision: "current-system",
    quantity,
    economicAssetId: TARGET,
    direction: "inbound" as const,
    structure: "ownership_change" as const,
  }
  const system = {
    occurredAt: "2025-01-01T00:00:00.000Z",
    legKind: "acquisition" as const,
    recordedFiatAmount: null,
    recordedFiatCurrency: null,
    transactionType: null,
    providerTransactionType: null,
    derivationRule: null,
    feeForSourceRecordKey: null,
  }
  const record = {
    id: LEAF,
    principalId: TARGET,
    sourceId: TARGET,
    targetId: TARGET,
    kind: "price" as const,
    operation: "create" as const,
    inspectedFacts: facts,
    inspectedSystem: system,
    inspectedValuationEvidence: { reportingCurrency: "EUR", facts: [] },
    input: {
      _tag: "price" as const,
      input: { _tag: "total_value" as const, amount: "25.00", currency: "EUR" },
    },
    actorUserId: USER,
    reason: "Receipt total",
    supersedesOverrideId: null,
    recordedAt: "2025-01-01T00:00:00.000Z",
  }
  const stream = {
    leaf: null,
    active: null,
    stale: false,
    application: "inactive" as const,
    applicationProblem: null,
    resolvedPrice: null,
    replay: { status: "not_scheduled" as const, processingJobId: null, followUpJobId: null },
    coverage: null,
    coverageStatus: "not_requested" as const,
  }
  return {
    context: {
      targetId: TARGET,
      target,
      current: {
        legId: TARGET,
        transactionId: TARGET,
        facts,
        system,
        valuationEvidence: { reportingCurrency: "EUR", facts: [] },
      },
      price: { leaf: active ? record : null, active: active ? record : null },
      classification: { leaf: null, active: null },
      history: active ? [record] : [],
    },
    scope: { jurisdiction: "DE", taxYear: 2025, reportingCurrency: "EUR" },
    inputs: {
      targetId: TARGET,
      current: null,
      currentOutcome: "included",
      system: { event: null, valuationFacts: [] },
      effective: { event: null, valuationFacts: [] },
      corrections: [],
    },
    price: { ...stream, leaf: active ? record : null, active: active ? record : null },
    classification: stream,
    validClassificationInputs: [],
  }
}
const account = (id = USER): Account => ({
  account: {
    id,
    email: "test@example.com",
    displayName: "Test",
    role: "member",
    emailVerified: true,
    welcomeSeenAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
  loginMethods: [],
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it("keeps failed form input and focus, then saves exact total with editable reason", async () => {
  const client = new QueryClient()
  client.setQueryData(queryKeys.account(), account())
  const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://form.example.test" })
  vi.spyOn(taxmaxi.transactionOverrides, "getCurrent").mockResolvedValue(currentPrice())
  const create = vi
    .spyOn(taxmaxi.transactionOverrides, "create")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      context: currentPrice().context,
      overrideId: LEAF,
      sourceId: TARGET,
      processingJobId: TARGET,
    })
  const onSaved = vi.fn()
  function Form() {
    const guard = useTransactionDraftGuard()
    const editor = useTransactionEditor({
      targetId: TARGET,
      taxYear: 2025,
      taxmaxi,
      guard,
      onSaved,
      onUnauthorized: vi.fn(),
    })
    return <TransactionEditor editor={editor} guard={guard} />
  }
  render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>
  )
  const amount = await screen.findByLabelText("Total value (EUR)")
  fireEvent.change(amount, { target: { value: "25.00" } })
  fireEvent.change(screen.getByLabelText("Factual reason"), {
    target: { value: "Receipt confirms EUR 25.00" },
  })
  amount.focus()
  fireEvent.submit(screen.getByRole("form", { name: "Correct price" }))
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(screen.getByDisplayValue("25.00")).toBe(amount)
  expect(document.activeElement).toBe(amount)
  fireEvent.submit(screen.getByRole("form", { name: "Correct price" }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(create).toHaveBeenLastCalledWith({
    targetId: TARGET,
    override: {
      expectedLeafId: null,
      expectedSystemRevision: "current-system",
      reason: "Receipt confirms EUR 25.00",
      input: { _tag: "price", input: { _tag: "total_value", amount: "25.00", currency: "EUR" } },
    },
  })
  client.clear()
})
it("keeps a repeating total authoritative and validates without sending an invalid value", async () => {
  const client = new QueryClient()
  client.setQueryData(queryKeys.account(), account())
  const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://form.example.test" })
  vi.spyOn(taxmaxi.transactionOverrides, "getCurrent").mockResolvedValue(currentPrice(false, "3"))
  const create = vi.spyOn(taxmaxi.transactionOverrides, "create")
  function Form() {
    const guard = useTransactionDraftGuard()
    const editor = useTransactionEditor({
      targetId: TARGET,
      taxYear: 2025,
      taxmaxi,
      guard,
      onSaved: vi.fn(),
      onUnauthorized: vi.fn(),
    })
    return <TransactionEditor editor={editor} guard={guard} />
  }
  render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>
  )
  fireEvent.change(await screen.findByLabelText("Total value (EUR)"), { target: { value: "1" } })
  expect(screen.getByText("Movement total: 1 EUR")).toBeTruthy()
  fireEvent.change(screen.getByLabelText("Total value (EUR)"), { target: { value: "-1" } })
  fireEvent.submit(screen.getByRole("form", { name: "Correct price" }))
  expect(await screen.findByRole("alert")).toBeTruthy()
  expect(create).not.toHaveBeenCalled()
  client.clear()
})

it("keeps reason and withdrawal enabled when a current movement becomes custody", async () => {
  const client = new QueryClient()
  client.setQueryData(queryKeys.account(), account())
  const current = currentPrice(true)
  if (!current.context.current) throw new Error("Missing current fixture")
  const custody: TransactionOverrideCurrent = {
    ...current,
    context: {
      ...current.context,
      current: {
        ...current.context.current,
        facts: { ...current.context.current.facts, structure: "custody" },
      },
    },
  }
  const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://form.example.test" })
  vi.spyOn(taxmaxi.transactionOverrides, "getCurrent").mockResolvedValue(custody)
  const withdraw = vi.spyOn(taxmaxi.transactionOverrides, "withdraw").mockResolvedValue({
    context: custody.context,
    overrideId: LEAF,
    sourceId: TARGET,
    processingJobId: TARGET,
  })
  function Form() {
    const guard = useTransactionDraftGuard()
    const editor = useTransactionEditor({
      targetId: TARGET,
      taxYear: 2025,
      taxmaxi,
      guard,
      onSaved: vi.fn(),
      onUnauthorized: vi.fn(),
    })
    return <TransactionEditor editor={editor} guard={guard} />
  }
  render(
    <QueryClientProvider client={client}>
      <Form />
    </QueryClientProvider>
  )
  expect(await screen.findByLabelText("Total value (EUR)")).toHaveProperty("disabled", true)
  expect(screen.getByRole("button", { name: "Save correction" })).toHaveProperty("disabled", true)
  expect(screen.getByLabelText("Factual reason")).toHaveProperty("disabled", false)
  fireEvent.change(screen.getByLabelText("Factual reason"), {
    target: { value: "Withdraw outdated valuation" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Withdraw price correction" }))
  await waitFor(() => expect(withdraw).toHaveBeenCalledTimes(1))
  client.clear()
})
