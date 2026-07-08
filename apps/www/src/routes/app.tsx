import { createFileRoute, redirect } from "@tanstack/react-router"

import { TaxDashboard } from "#/components/dashboard/TaxDashboard"
import { PageShell } from "#/components/page-shell"
import { getAuthStatus } from "#/server-functions/auth"

export const Route = createFileRoute("/app")({
  beforeLoad: async () => {
    const { isAuthenticated } = await getAuthStatus()

    if (!isAuthenticated) {
      throw redirect({
        to: "/login",
      })
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <PageShell as="main" tone="default" data-page="app">
      <TaxDashboard />
    </PageShell>
  )
}
