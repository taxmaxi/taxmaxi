import type { SourceSyncIslandItem, SourceSyncStatus } from "#/components/source-sync-island"
import { cn } from "#/lib/utils"

export type SourceSyncMockScenario = "live" | SourceSyncStatus | "multiple"

export const SOURCE_SYNC_MOCKS_ENABLED =
  import.meta.env.VITE_ENABLED_MOCKS?.includes("source-sync-island") &&
  import.meta.env.DEV &&
  import.meta.env.MODE !== "test"

export const SOURCE_SYNC_MOCK_SCENARIOS: Record<
  Exclude<SourceSyncMockScenario, "live">,
  ReadonlyArray<SourceSyncIslandItem>
> = {
  queued: [{ id: "mock-coinbase", progress: 0, sourceName: "Coinbase", status: "queued" }],
  running: [
    {
      id: "mock-coinbase",
      fetchedRecords: 24,
      normalizedRecords: 21,
      progress: 18,
      sourceName: "Coinbase",
      status: "running",
    },
  ],
  completed: [
    {
      failedRecords: 0,
      id: "mock-coinbase",
      fetchedRecords: 284,
      normalizedRecords: 284,
      progress: 100,
      sourceName: "Coinbase",
      status: "completed",
    },
  ],
  failed: [
    {
      failedRecords: 5,
      id: "mock-coinbase",
      fetchedRecords: 104,
      message: "Coinbase stopped responding. Your fetched records are safe.",
      normalizedRecords: 99,
      progress: 100,
      sourceName: "Coinbase",
      status: "failed",
    },
  ],
  credit_required: [
    {
      failedRecords: 0,
      id: "mock-coinbase",
      fetchedRecords: 104,
      message: "Add credits and run sync again to continue.",
      normalizedRecords: 82,
      progress: 100,
      sourceName: "Coinbase",
      status: "credit_required",
    },
  ],
  multiple: [
    {
      id: "mock-coinbase",
      fetchedRecords: 24,
      normalizedRecords: 21,
      progress: 18,
      sourceName: "Coinbase",
      status: "running",
    },
    { id: "mock-kraken", progress: 0, sourceName: "Kraken", status: "queued" },
    {
      id: "mock-phantom",
      fetchedRecords: 57,
      normalizedRecords: 52,
      progress: 0,
      sourceName: "Phantom",
      status: "running",
    },
  ],
}

const OPTIONS: ReadonlyArray<{ label: string; value: SourceSyncMockScenario }> = [
  { label: "Live", value: "live" },
  { label: "Queued", value: "queued" },
  { label: "Syncing", value: "running" },
  { label: "Synced", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Needs credits", value: "credit_required" },
  { label: "+2", value: "multiple" },
]

export function SourceSyncMockControls({
  onScenarioChange,
  scenario,
}: {
  onScenarioChange: (scenario: SourceSyncMockScenario) => void
  scenario: SourceSyncMockScenario
}) {
  return (
    <aside className="fixed left-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 rounded-2xl border border-white/10 bg-black/90 p-2 font-interface text-white shadow-2xl backdrop-blur-xl">
      <p className="px-2 pt-1 pb-2 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-white/45">
        Sync island mock
      </p>
      <div aria-label="Sync island mock state" className="flex flex-wrap gap-1" role="group">
        {OPTIONS.map((option) => {
          const selected = option.value === scenario

          return (
            <button
              aria-pressed={selected}
              className={cn(
                "min-h-11 rounded-full px-3 text-xs font-medium outline-none transition-[background-color,color] duration-150 focus-visible:ring-1 focus-visible:ring-white/70",
                selected
                  ? "bg-white text-black"
                  : "text-white/60 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-white/10 [@media(hover:hover)_and_(pointer:fine)]:hover:text-white"
              )}
              key={option.value}
              onClick={() => onScenarioChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
