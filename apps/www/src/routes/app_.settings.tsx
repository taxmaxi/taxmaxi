import { createFileRoute, redirect } from "@tanstack/react-router"
import { CheckCircle2, CircleAlert, Mail, Settings } from "lucide-react"
import { useCallback } from "react"
import type { Account } from "taxmaxi"
import { isTaxMaxiUnauthorizedError } from "taxmaxi"

import { AppFocusSurface } from "#/components/app-focus-surface"
import { appPanelClassName } from "#/components/app-workspace"
import { Badge } from "#/components/ui/badge"
import CoinbaseIcon from "#/components/ui/logos/coinbase/coinbase-app.svg"
import GoogleLogo from "#/components/ui/logos/google.svg"
import { Text } from "#/components/ui/typography"
import { cn } from "#/lib/utils"
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
  const navigate = Route.useNavigate()
  const onClose = useCallback(() => {
    void navigate({ to: "/app" })
  }, [navigate])

  return <SettingsPageContent account={account} onClose={onClose} />
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

const unavailableReasonDescription = (
  reason: Account["loginMethods"][number]["unavailableReason"]
): string | null => {
  switch (reason) {
    case "provider_disabled":
      return m["app.settings.unavailableReasons.providerDisabled"]()
    case "email_unverified":
      return m["app.settings.unavailableReasons.emailUnverified"]()
    case null:
      return null
  }
}

export function SettingsPageContent({
  account,
  onClose,
}: {
  readonly account: Account
  readonly onClose: () => void
}) {
  return (
    <AppFocusSurface
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
      closeLabel={m["app.settings.close"]()}
      icon={<Settings aria-hidden="true" className="size-4" />}
      onClose={onClose}
      subtitle={m["app.settings.title"]()}
      title={m["app.settings.eyebrow"]()}
      titleId="settings-title"
    >
      <div className="mx-auto flex w-full max-w-xl flex-col gap-8 px-4 py-6 sm:px-5 sm:py-8">
        <Text className="max-w-[65ch]" size="bodySm" tone="muted">
          {m["app.settings.description"]()}
        </Text>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">{m["app.settings.accountEmail"]()}</h2>
            <p className="text-sm text-muted-foreground">
              {m["app.settings.accountEmailDescription"]()}
            </p>
          </div>
          <div className={cn(appPanelClassName, "px-4 py-3")}>
            <p className="break-all text-sm">{account.account.email}</p>
          </div>
        </section>

        <section aria-labelledby="login-methods-heading" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium" id="login-methods-heading">
              {m["app.settings.loginMethods"]()}
            </h2>
            <p className="text-sm text-muted-foreground">
              {m["app.settings.loginMethodsDescription"]()}
            </p>
          </div>

          <ul className="flex flex-col gap-3">
            {account.loginMethods.map((loginMethod) => (
              <li key={loginMethod.id}>
                <LoginMethodRow loginMethod={loginMethod} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppFocusSurface>
  )
}

function LoginMethodRow({
  loginMethod,
}: {
  readonly loginMethod: Account["loginMethods"][number]
}) {
  const unavailableDescription = unavailableReasonDescription(loginMethod.unavailableReason)

  return (
    <article className={cn(appPanelClassName, "p-4")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted">
            <LoginMethodIcon provider={loginMethod.provider} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-medium">{providerLabel(loginMethod.provider)}</h3>
            <p className="text-sm text-muted-foreground">
              {m["app.settings.linked"]({
                date: formatLinkedAt(loginMethod.linkedAt),
              })}
            </p>
            <p className="text-sm">
              <span className="sr-only">{m["app.settings.providerEmail"]()}: </span>
              <span className="break-all">
                {loginMethod.providerEmail ?? m["app.settings.noProviderEmail"]()}
              </span>
            </p>
            {unavailableDescription === null ? null : (
              <p className="text-sm text-muted-foreground">{unavailableDescription}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {loginMethod.isCurrentSession ? (
            <Badge variant="secondary">
              <CheckCircle2 data-icon="inline-start" />
              {m["app.settings.currentSession"]()}
            </Badge>
          ) : null}
          {loginMethod.isAvailable ? null : (
            <Badge variant="destructive">
              <CircleAlert data-icon="inline-start" />
              {m["app.settings.unavailable"]()}
            </Badge>
          )}
        </div>
      </div>
    </article>
  )
}

function LoginMethodIcon({
  provider,
}: {
  readonly provider: Account["loginMethods"][number]["provider"]
}) {
  switch (provider) {
    case "google":
      return <img alt="" className="size-4" src={GoogleLogo} />
    case "coinbase":
      return <img alt="" className="size-4" src={CoinbaseIcon} />
    case "local":
      return <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
  }
}
