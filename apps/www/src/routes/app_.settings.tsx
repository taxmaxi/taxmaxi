import { createFileRoute, redirect } from "@tanstack/react-router"
import { CheckCircle2, KeyRound, Mail } from "lucide-react"
import type { Account } from "taxmaxi"
import { isTaxMaxiUnauthorizedError } from "taxmaxi"

import { AccountMenu } from "#/components/account-menu"
import { AppHeader } from "#/components/app-header"
import { PageShell } from "#/components/page-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card"
import { useAppLogout } from "#/hooks/use-app-logout"
import { m } from "#/paraglide/messages"
import { getLocale } from "#/paraglide/runtime"
import { clearAuthSessionCookie, getAuthStatus } from "#/server-functions/auth"

export const Route = createFileRoute("/app_/settings")({
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()
    if (!isAuthenticated) throw redirect({ to: "/login" })
  },
  loader: async ({ context }) => {
    try {
      return await context.taxmaxi().auth.account()
    } catch (error) {
      if (!isTaxMaxiUnauthorizedError(error)) throw error
      await clearAuthSessionCookie()
      throw redirect({ to: "/login" })
    }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const account = Route.useLoaderData()
  const onLogout = useAppLogout()

  return <SettingsPageContent account={account} onLogout={onLogout} />
}

const providerLabel = (provider: Account["loginMethods"][number]["provider"]): string => {
  switch (provider) {
    case "local":
      return m["app.settings.providers.local"]()
    case "google":
      return m["app.settings.providers.google"]()
    case "coinbase":
      return m["app.settings.providers.coinbase"]()
  }
}

const formatLinkedAt = (linkedAt: string): string =>
  new Intl.DateTimeFormat(getLocale(), {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(linkedAt))

export function SettingsPageContent({
  account,
  onLogout,
}: {
  readonly account: Account
  readonly onLogout: () => Promise<void>
}) {
  return (
    <PageShell
      as="main"
      tone="marketing"
      className="relative isolate min-h-screen w-full overflow-x-clip bg-[var(--app-page-fallback)] text-marketing-text"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 [background:var(--app-page-background)]"
      />
      <div className="relative">
        <AppHeader>
          <AccountMenu onLogout={onLogout} />
        </AppHeader>

        <section className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 pt-32 pb-16 sm:px-8">
          <header className="flex max-w-2xl flex-col gap-3">
            <p className="text-sm font-medium text-marketing-accent">
              {m["app.settings.eyebrow"]()}
            </p>
            <h1 className="font-display text-4xl tracking-[-0.045em] sm:text-5xl">
              {m["app.settings.title"]()}
            </h1>
            <p className="max-w-[65ch] leading-7 text-marketing-muted">
              {m["app.settings.description"]()}
            </p>
          </header>

          <Card>
            <CardHeader>
              <CardTitle>{m["app.settings.accountEmail"]()}</CardTitle>
              <CardDescription>{m["app.settings.accountEmailDescription"]()}</CardDescription>
            </CardHeader>
            <CardContent>
              <label className="flex max-w-xl flex-col gap-2" htmlFor="account-email">
                <span className="text-sm font-medium">{m["app.settings.accountEmail"]()}</span>
                <span className="relative">
                  <Mail
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    aria-readonly="true"
                    className="h-11 w-full rounded-xl border border-border bg-muted/50 pr-3 pl-10 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                    id="account-email"
                    readOnly
                    type="email"
                    value={account.account.email}
                  />
                </span>
              </label>
            </CardContent>
          </Card>

          <section aria-labelledby="login-methods-heading" className="flex flex-col gap-4">
            <header className="flex flex-col gap-1">
              <h2 className="font-display text-2xl" id="login-methods-heading">
                {m["app.settings.loginMethods"]()}
              </h2>
              <p className="text-marketing-muted">{m["app.settings.loginMethodsDescription"]()}</p>
            </header>

            <div className="grid gap-4 md:grid-cols-2">
              {account.loginMethods.map((loginMethod) => (
                <Card key={loginMethod.id}>
                  <CardHeader>
                    <div className="flex items-start gap-3">
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted text-foreground">
                        <KeyRound aria-hidden="true" className="size-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <CardTitle>
                          <h3>{providerLabel(loginMethod.provider)}</h3>
                        </CardTitle>
                        <CardDescription>
                          {m["app.settings.linked"]({
                            date: formatLinkedAt(loginMethod.linkedAt),
                          })}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {m["app.settings.providerEmail"]()}
                      </span>
                      <span className="break-all text-sm">
                        {loginMethod.providerEmail ?? m["app.settings.noProviderEmail"]()}
                      </span>
                    </div>
                    {loginMethod.isCurrentSession ? (
                      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                        <CheckCircle2 aria-hidden="true" className="size-3.5" />
                        {m["app.settings.currentSession"]()}
                      </span>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        </section>
      </div>
    </PageShell>
  )
}
