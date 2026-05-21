import { useTaxMaxiX402Client } from "#/integrations/taxmaxi/useTaxMaxi"
import type { WalletConnector } from "@solana/client"
import { useWalletConnection } from "@solana/react-hooks"
import { createFileRoute } from "@tanstack/react-router"
import { useCallback } from "react"

export const Route = createFileRoute("/")({ component: App })

function App() {
  const walletConnection = useWalletConnection()
  const taxMaxiX402Client = useTaxMaxiX402Client()

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
    try {
      const walletAddress = walletConnection.wallet?.account.address
      if (!walletAddress) {
        throw new Error("Wallet address not found")
      }
      await taxMaxiX402Client?.sources.create({
        type: "onchain",
        walletAddress,
        name: walletConnection.wallet.connector.name,
      })
    } catch (error) {
      console.error(error)
    }
  }, [walletConnection])

  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in relative overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="pointer-events-none absolute -left-20 -top-24 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(79,184,178,0.32),transparent_66%)]" />
        <div className="pointer-events-none absolute -bottom-20 -right-20 h-56 w-56 rounded-full bg-[radial-gradient(circle,rgba(47,106,74,0.18),transparent_66%)]" />
        <p className="island-kicker mb-3">TanStack Start Base Template</p>
        <h1 className="display-title mb-5 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
          Solana Tax Calculator
        </h1>
        <p className="mb-8 max-w-2xl text-base text-[var(--sea-ink-soft)] sm:text-lg">
          Pay for requests to the TaxMaxi API via x402. Connect your wallet to get started.
        </p>
        {!walletConnection.isReady ? (
          <p className="text-sm text-[var(--sea-ink-soft)]">Loading wallets...</p>
        ) : !walletConnection.connected ? (
          <div className="flex flex-wrap gap-3">
            {walletConnection.connectors.map((connector) => (
              <button
                key={connector.id}
                className="flex items-center gap-2 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
                disabled={walletConnection.connecting}
                onClick={() => handleConnect(connector)}
              >
                <img src={connector.icon} alt={connector.name} className="w-4 h-4" />
                {connector.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-[var(--sea-ink-soft)]">
              Connected to {walletConnection.currentConnector?.name}:{" "}
              {walletConnection.wallet?.account.address}
            </p>
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-2 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
                onClick={handleCalculateTax}
              >
                Calculate tax
              </button>
              <button
                className="flex items-center gap-2 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] no-underline transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)]"
                onClick={walletConnection.disconnect}
              >
                disconnect
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Type-Safe Routing", "Routes and links stay in sync across every page."],
          ["Server Functions", "Call server code from your UI without creating API boilerplate."],
          ["Streaming by Default", "Ship progressively rendered responses for faster experiences."],
          ["Tailwind Native", "Design quickly with utility-first styling and reusable tokens."],
        ].map(([title, desc], index) => (
          <article
            key={title}
            className="island-shell feature-card rise-in rounded-2xl p-5"
            style={{ animationDelay: `${index * 90 + 80}ms` }}
          >
            <h2 className="mb-2 text-base font-semibold text-[var(--sea-ink)]">{title}</h2>
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">{desc}</p>
          </article>
        ))}
      </section>

      <section className="island-shell mt-8 rounded-2xl p-6">
        <p className="island-kicker mb-2">Quick Start</p>
        <ul className="m-0 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
          <li>
            Edit <code>src/routes/index.tsx</code> to customize the home page.
          </li>
          <li>
            Update <code>src/components/Header.tsx</code> and <code>src/components/Footer.tsx</code>{" "}
            for brand links.
          </li>
          <li>
            Add routes in <code>src/routes</code> and tweak visual tokens in{" "}
            <code>src/styles.css</code>.
          </li>
        </ul>
      </section>
    </main>
  )
}
