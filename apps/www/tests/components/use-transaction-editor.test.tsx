// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaxMaxi, type Account, type TransactionOverrideCurrent } from "taxmaxi"
import { queryKeys } from "#/integrations/taxmaxi/queries"
import {
  transactionPriceTotal,
  useTransactionDraftGuard,
  useTransactionEditor,
} from "#/components/use-transaction-editor"
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
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})
function setup(current = currentPrice()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  client.setQueryData(queryKeys.account(), account())
  const taxmaxi = new TaxMaxi({ apiKey: "", baseUrl: "https://editor.example.test" })
  vi.spyOn(taxmaxi.transactionOverrides, "getCurrent").mockResolvedValue(current)
  const create = vi.spyOn(taxmaxi.transactionOverrides, "create").mockResolvedValue({
    context: current.context,
    overrideId: LEAF,
    sourceId: TARGET,
    processingJobId: TARGET,
  })
  const replace = vi.spyOn(taxmaxi.transactionOverrides, "replace").mockResolvedValue({
    context: current.context,
    overrideId: LEAF,
    sourceId: TARGET,
    processingJobId: TARGET,
  })
  const withdraw = vi.spyOn(taxmaxi.transactionOverrides, "withdraw").mockResolvedValue({
    context: current.context,
    overrideId: LEAF,
    sourceId: TARGET,
    processingJobId: TARGET,
  })
  const onSaved = vi.fn()
  const hook = renderHook(
    () => {
      const guard = useTransactionDraftGuard()
      return {
        guard,
        editor: useTransactionEditor({
          taxmaxi,
          targetId: TARGET,
          taxYear: 2025,
          guard,
          onSaved,
          onUnauthorized: vi.fn(),
        }),
      }
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    }
  )
  return { ...hook, client, taxmaxi, create, replace, withdraw, onSaved }
}
describe("exact movement price editing", () => {
  it("cancels an old account's pending discard without resetting the next account's draft", async () => {
    const { result, client } = setup(currentPrice(true))
    await waitFor(() => expect(result.current.editor.loading).toBe(false))
    act(() => result.current.editor.change({ amount: "99.00" }))
    const navigate = vi.fn()
    act(() => result.current.guard.run(navigate))
    expect(result.current.guard.pending).toBe(true)
    act(() => client.setQueryData(queryKeys.account(), account("next-user")))
    await waitFor(() => expect(result.current.editor.loading).toBe(false))
    expect(result.current.guard.pending).toBe(false)
    act(() => result.current.editor.change({ amount: "88.00" }))
    act(() => result.current.guard.resolve(true))
    expect(result.current.editor.draft.amount).toBe("88.00")
    expect(result.current.guard.isDirty()).toBe(true)
    expect(navigate).not.toHaveBeenCalled()
  })

  it("resets a discarded draft even when the requested action does nothing", async () => {
    const { result } = setup(currentPrice(true))
    await waitFor(() => expect(result.current.editor.loading).toBe(false))
    act(() => result.current.editor.change({ amount: "99.00", reason: "Changed" }))
    act(() => result.current.guard.run(() => {}))
    act(() => result.current.guard.resolve(true))
    expect(result.current.editor.draft.amount).toBe("25.00")
    expect(result.current.editor.draft.reason).toBe("Receipt total")
    expect(result.current.guard.isDirty()).toBe(false)
    act(() => result.current.editor.change({ amount: "88.00" }))
    act(() => result.current.guard.run(() => {}))
    expect(result.current.guard.pending).toBe(true)
    act(() => result.current.guard.resolve(false))
    expect(result.current.editor.draft.amount).toBe("88.00")
  })

  it("allows withdrawal of an active price after custody incompatibility but rejects new prices", async () => {
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
    const test = setup(custody)
    await waitFor(() => expect(test.result.current.editor.loading).toBe(false))
    expect(test.result.current.editor.eligible).toBe(false)
    expect(test.result.current.editor.canWithdraw).toBe(true)
    await act(async () => {
      await test.result.current.editor.submit()
    })
    expect(test.replace).not.toHaveBeenCalled()
    await act(async () => {
      await test.result.current.editor.submit(true)
    })
    expect(test.withdraw).toHaveBeenCalledWith({
      targetId: TARGET,
      withdrawal: {
        kind: "price",
        expectedLeafId: LEAF,
        expectedSystemRevision: "current-system",
        reason: "Receipt total",
      },
    })
  })
  it("does not invent inspection facts to withdraw a disappeared target", async () => {
    const current = currentPrice(true)
    const test = setup({ ...current, context: { ...current.context, current: null } })
    await waitFor(() => expect(test.result.current.editor.loading).toBe(false))
    expect(test.result.current.editor.canWithdraw).toBe(false)
    await act(async () => {
      await test.result.current.editor.submit(true)
    })
    expect(test.withdraw).not.toHaveBeenCalled()
  })

  it.each([
    ["12.50", "2", "unit_price", "25.00"],
    ["25.00", "2", "total_value", "25.00"],
    ["0", "2", "unit_price", "0"],
    ["0.000000000000000001", "2e-18", "unit_price", "0.000000000000000000000000000000000002"],
    ["1", "3", "total_value", "1"],
    ["1e2", "2", "unit_price", null],
    ["-1", "2", "total_value", null],
  ] as const)("keeps exact total for %s × %s (%s)", (amount, quantity, mode, expected) => {
    expect(transactionPriceTotal({ amount, quantity, mode })).toBe(expected)
  })
  it("submits the exact unit mode and current revision once during double save", async () => {
    const test = setup()
    await waitFor(() => expect(test.result.current.editor.loading).toBe(false))
    let accept: (() => void) | undefined
    test.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = () =>
            resolve({
              context: currentPrice().context,
              overrideId: LEAF,
              sourceId: TARGET,
              processingJobId: TARGET,
            })
        })
    )
    act(() => test.result.current.editor.change({ mode: "unit_price", amount: "12.50" }))
    let first: Promise<boolean> | undefined
    act(() => {
      first = test.result.current.editor.submit()
      void test.result.current.editor.submit()
    })
    expect(test.create).toHaveBeenCalledTimes(1)
    expect(test.create).toHaveBeenCalledWith({
      targetId: TARGET,
      override: {
        expectedLeafId: null,
        expectedSystemRevision: "current-system",
        reason: "I am correcting the EUR value of this movement.",
        input: { _tag: "price", input: { _tag: "unit_price", amount: "12.50", currency: "EUR" } },
      },
    })
    await act(async () => {
      accept?.()
      await first
    })
    expect(test.onSaved).toHaveBeenCalledTimes(1)
  })
  it("keeps draft on failure and separates accepted save from refresh failure", async () => {
    const test = setup()
    await waitFor(() => expect(test.result.current.editor.loading).toBe(false))
    act(() => test.result.current.editor.change({ mode: "unit_price", amount: "12.50" }))
    test.create.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      await test.result.current.editor.submit()
    })
    expect(test.result.current.editor.draft.amount).toBe("12.50")
    expect(test.result.current.guard.isDirty()).toBe(true)
    vi.spyOn(test.client, "invalidateQueries").mockRejectedValue(new Error("refresh offline"))
    await act(async () => {
      await test.result.current.editor.submit()
    })
    expect(test.onSaved).toHaveBeenCalledTimes(1)
    expect(test.result.current.guard.isDirty()).toBe(false)
    expect(test.result.current.editor.error).toBeNull()
  })
  it.each([false, true])(
    "uses current active leaf for replace or withdrawal (%s)",
    async (withdraw) => {
      const test = setup(currentPrice(true))
      await waitFor(() => expect(test.result.current.editor.loading).toBe(false))
      expect(test.result.current.editor.draft.amount).toBe("25.00")
      await act(async () => {
        await test.result.current.editor.submit(withdraw)
      })
      expect(withdraw ? test.withdraw : test.replace).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: TARGET,
          [withdraw ? "withdrawal" : "replacement"]: expect.objectContaining({
            expectedLeafId: LEAF,
            expectedSystemRevision: "current-system",
          }),
        })
      )
      expect(test.create).not.toHaveBeenCalled()
    }
  )
  it("does not close or refresh the next account on late accepted save", async () => {
    const test = setup()
    await waitFor(() => expect(test.result.current.editor.loading).toBe(false))
    let accept: (() => void) | undefined
    test.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = () =>
            resolve({
              context: currentPrice().context,
              overrideId: LEAF,
              sourceId: TARGET,
              processingJobId: TARGET,
            })
        })
    )
    act(() => test.result.current.editor.change({ amount: "25" }))
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = test.result.current.editor.submit()
    })
    act(() => test.client.setQueryData(queryKeys.account(), account("next-user")))
    const invalidate = vi.spyOn(test.client, "invalidateQueries")
    await act(async () => {
      accept?.()
      await pending
    })
    expect(test.onSaved).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })
  it("uses one keep/discard decision and refuses duplicate exits or leaving during save", async () => {
    const { result } = renderHook(() => useTransactionDraftGuard())
    act(() => result.current.update({ dirty: true, saving: false }))
    let decision: Promise<boolean> | undefined
    act(() => {
      decision = result.current.request()
    })
    expect(result.current.pending).toBe(true)
    await expect(result.current.request()).resolves.toBe(false)
    act(() => result.current.resolve(false))
    await expect(decision).resolves.toBe(false)
    act(() => {
      decision = result.current.request()
    })
    act(() => result.current.resolve(true))
    await expect(decision).resolves.toBe(true)
    act(() => result.current.update({ dirty: true, saving: true }))
    await expect(result.current.request()).resolves.toBe(false)
  })
})
