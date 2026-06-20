import { useAnonPaidSources } from "#/integrations/taxmaxi/useAnonPaidSources"
import { useTaxMaxiX402Client } from "#/integrations/taxmaxi/useTaxMaxi"
import type { WalletConnector } from "@solana/client"
import { useWalletConnection } from "@solana/react-hooks"
import { createFileRoute } from "@tanstack/react-router"
import { CheckCircle2, KeyRound, Link2, Loader2, RefreshCcw, Wallet } from "lucide-react"
import { useCallback, useState } from "react"
import { type AnonSourceHandle, type AnonSourceSyncJob, type SourceCreate } from "taxmaxi"

export const Route = createFileRoute("/")({ component: App })

const buttonClassName =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)] focus-visible:ring-2 focus-visible:ring-[var(--lagoon-deep)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"

const secondaryButtonClassName =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] transition hover:bg-[var(--link-bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--lagoon-deep)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong. Try again."

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))

const formatNullableCount = (value: number | null): string => (value === null ? "-" : `${value}`)

const getLatestJob = (jobs: readonly AnonSourceSyncJob[]): AnonSourceSyncJob | null =>
  jobs[0] ?? null

const statusClassName = (status: AnonSourceSyncJob["status"]): string => {
  switch (status) {
    case "completed":
      return "border-[color-mix(in_oklab,var(--palm)_42%,transparent)] bg-[color-mix(in_oklab,var(--palm)_10%,transparent)] text-[var(--palm)]"
    case "failed":
      return "border-[color-mix(in_oklab,var(--destructive)_42%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_10%,transparent)] text-[var(--destructive)]"
    case "running":
      return "border-[rgba(50,143,151,0.34)] bg-[rgba(79,184,178,0.14)] text-[var(--lagoon-deep)]"
    case "queued":
      return "border-[var(--line)] bg-[var(--surface)] text-[var(--sea-ink-soft)]"
  }
}

function SourceCard({
  isLoadingJobs,
  jobs,
  source,
}: {
  readonly isLoadingJobs: boolean
  readonly jobs: readonly AnonSourceSyncJob[]
  readonly source: AnonSourceHandle
}) {
  const latestJob = getLatestJob(jobs)

  return (
    <article className="rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-[var(--sea-ink)]">{source.chainType} wallet</p>
          <p className="mt-1 break-all font-mono text-xs text-[var(--sea-ink-soft)]">
            {source.walletAddress}
          </p>
        </div>
        <p className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink-soft)]">
          {source.jurisdiction} {source.year}
        </p>
      </div>
      <p className="mt-3 break-all font-mono text-xs text-[var(--sea-ink-soft)]">
        request {source.requestId}
      </p>

      <div className="mt-4 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold text-[var(--sea-ink)]">Sync progress</p>
          {latestJob === null ? (
            <span className="inline-flex min-h-7 items-center rounded-full border border-[var(--line)] px-3 text-xs font-semibold text-[var(--sea-ink-soft)]">
              {isLoadingJobs ? "Loading" : "No job"}
            </span>
          ) : (
            <span
              className={`inline-flex min-h-7 items-center rounded-full border px-3 text-xs font-semibold ${statusClassName(latestJob.status)}`}
            >
              {latestJob.status}
            </span>
          )}
        </div>

        {latestJob === null ? (
          <div className="mt-3 h-2 rounded-full bg-[var(--line)]" />
        ) : (
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-[var(--sea-ink-soft)]">Imported</dt>
              <dd className="mt-1 font-mono font-semibold text-[var(--sea-ink)]">
                {formatNullableCount(latestJob.importedRecords)}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--sea-ink-soft)]">Normalized</dt>
              <dd className="mt-1 font-mono font-semibold text-[var(--sea-ink)]">
                {formatNullableCount(latestJob.normalizedRecords)}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--sea-ink-soft)]">Failed</dt>
              <dd className="mt-1 font-mono font-semibold text-[var(--sea-ink)]">
                {formatNullableCount(latestJob.failedRecords)}
              </dd>
            </div>
          </dl>
        )}

        {latestJob?.message === null || latestJob === null ? null : (
          <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">{latestJob.message}</p>
        )}
      </div>
    </article>
  )
}

function App() {
  const walletConnection = useWalletConnection()
  const taxMaxiX402Client = useTaxMaxiX402Client()
  const {
    error: anonSourcesError,
    isLoadingJobs,
    isLoadingSources,
    load: loadAnonPaidSources,
    sourceJobsById,
    sources: anonSources,
  } = useAnonPaidSources({ wallet: walletConnection.wallet })
  const [fallbackClaim, setFallbackClaim] = useState<SourceCreate["claim"]>(null)
  const [isCreatingSource, setIsCreatingSource] = useState(false)
  const [createSourceMessage, setCreateSourceMessage] = useState<string | null>(null)

  const handleConnect = useCallback(
    async (connector: WalletConnector) => {
      try {
        await walletConnection.connect(connector.id)
      } catch (error) {
        console.error(error)
      }
    },
    [walletConnection]
  )

  const handleCalculateTax = useCallback(async () => {
    setCreateSourceMessage(null)
    try {
      const walletAddress = walletConnection.wallet?.account.address
      if (!walletAddress) {
        throw new Error("Wallet address not found")
      }
      if (taxMaxiX402Client === null) {
        throw new Error("TaxMaxi client is not ready")
      }

      setIsCreatingSource(true)
      const response = await taxMaxiX402Client.sources.create({
        type: "onchain",
        walletAddress,
        name: walletConnection.wallet.connector.name,
      })
      setFallbackClaim(response.claim)
      const loaded = await loadAnonPaidSources({ restoreWithWallet: false, showLoading: true })
      setCreateSourceMessage(
        loaded.sourceCount > 0
          ? "Source created. Anonymous session is active in this browser."
          : "Source created. Use the anonymous source claim token to recover this paid source."
      )
    } catch (error) {
      setCreateSourceMessage(getErrorMessage(error))
    } finally {
      setIsCreatingSource(false)
    }
  }, [loadAnonPaidSources, taxMaxiX402Client, walletConnection])

  const handleListClaimableSources = useCallback(async () => {
    await loadAnonPaidSources({ restoreWithWallet: true, showLoading: true })
  }, [loadAnonPaidSources])

  const walletAddress = walletConnection.wallet?.account.address

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
        <p className="island-kicker mb-3">TaxMaxi x402</p>
        <h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
          Solana Tax Calculator
        </h1>
        <p className="mb-8 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
          Pay for anonymous source creation, then track the paid source in this browser. Sign with
          the payer wallet only when restoring access on another device.
        </p>
        {!walletConnection.isReady ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">Loading wallets...</p>
        ) : !walletConnection.connected ? (
          <div className="flex flex-wrap gap-3">
            {walletConnection.connectors.map((connector) => (
              <button
                key={connector.id}
                className={buttonClassName}
                disabled={walletConnection.connecting}
                onClick={() => handleConnect(connector)}
                type="button"
              >
                <img src={connector.icon} alt="" className="h-4 w-4" />
                {connector.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
              <Wallet className="h-4 w-4" aria-hidden="true" />
              <span>
                Connected to {walletConnection.currentConnector?.name}: {walletAddress}
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={buttonClassName}
                disabled={isCreatingSource}
                onClick={handleCalculateTax}
                type="button"
              >
                {isCreatingSource ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                )}
                Calculate tax
              </button>
              <button
                className={secondaryButtonClassName}
                onClick={walletConnection.disconnect}
                type="button"
              >
                Disconnect
              </button>
            </div>
            {createSourceMessage !== null ? (
              <p className="flex items-center gap-2 text-sm text-[var(--sea-ink-soft)]">
                <CheckCircle2 className="h-4 w-4 text-[var(--palm)]" aria-hidden="true" />
                {createSourceMessage}
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.78fr)]">
        <div className="island-shell rounded-2xl p-6">
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="island-kicker mb-2">Anonymous recovery</p>
              <h2 className="text-xl font-bold text-[var(--sea-ink)]">Claimable paid sources</h2>
            </div>
            <button
              className={secondaryButtonClassName}
              disabled={isLoadingSources}
              onClick={handleListClaimableSources}
              type="button"
            >
              {isLoadingSources ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCcw className="h-4 w-4" aria-hidden="true" />
              )}
              Refresh
            </button>
          </div>

          {isLoadingSources ? (
            <div className="space-y-3" aria-busy="true">
              {[0, 1, 2].map((item) => (
                <div
                  className="h-24 animate-pulse rounded-xl border border-[var(--line)] bg-[var(--surface-strong)]"
                  key={item}
                />
              ))}
            </div>
          ) : anonSourcesError !== null ? (
            <div className="rounded-xl border border-[color-mix(in_oklab,var(--destructive)_34%,transparent)] bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)] p-4">
              <p className="text-sm font-semibold text-[var(--sea-ink)]">
                Could not load claimable sources
              </p>
              <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">{anonSourcesError}</p>
            </div>
          ) : anonSources.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--line)] p-6 text-center">
              <Link2
                className="mx-auto mb-3 h-8 w-8 text-[var(--lagoon-deep)]"
                aria-hidden="true"
              />
              <p className="text-sm font-semibold text-[var(--sea-ink)]">No sources loaded yet</p>
              <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
                Create a paid source or restore the anon session with the payer wallet.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {anonSources.map((source) => (
                <SourceCard
                  isLoadingJobs={isLoadingJobs}
                  jobs={sourceJobsById[source.sourceId] ?? []}
                  key={`${source.requestId}-${source.sourceId}`}
                  source={source}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="island-shell rounded-2xl p-6">
          <p className="island-kicker mb-2">Fallback recovery</p>
          <h2 className="mb-5 text-xl font-bold text-[var(--sea-ink)]">anonymous source claim token</h2>
          {fallbackClaim === null ? (
            <div className="rounded-xl border border-dashed border-[var(--line)] p-5">
              <p className="text-sm font-semibold text-[var(--sea-ink)]">No claim token shown</p>
              <p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
                New anonymous source creation responses show a CLI/manual claim token here only for
                the current page session.
              </p>
            </div>
          ) : (
            <article className="rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
              <p className="mb-3 text-xs text-[var(--sea-ink-soft)]">
                Expires {formatDate(fallbackClaim.expiresAt)}
              </p>
              <dl className="space-y-2 text-xs">
                <div>
                  <dt className="font-semibold text-[var(--sea-ink)]">Request ID</dt>
                  <dd className="font-mono text-[var(--sea-ink-soft)]">
                    {fallbackClaim.requestId}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-[var(--sea-ink)]">Claim token</dt>
                  <dd className="font-mono text-[var(--sea-ink-soft)]">
                    {fallbackClaim.claimToken}
                  </dd>
                </div>
              </dl>
            </article>
          )}
        </aside>
      </section>
    </main>
  )
}
