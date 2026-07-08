import { createFileRoute, redirect } from "@tanstack/react-router"

import { ContentContainer } from "#/components/content-container"
import { Logo } from "#/components/logo"
import { PageShell } from "#/components/page-shell"
import { Heading, Text } from "#/components/ui/typography"
import { getAuthStatus } from "#/server-functions/auth"
import { m } from "#/paraglide/messages"

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
    <PageShell as="main" tone="default" className="min-h-screen">
      <ContentContainer width="lg" className="py-6">
        <div className="mb-12">
          <Logo size="small" />
        </div>

        <section className="max-w-2xl">
          <Heading as="h1" size="display">
            {m["app.title"]()}
          </Heading>
          <Text className="mt-4" size="bodyLg" tone="muted">
            {m["app.description"]()}
          </Text>
        </section>
      </ContentContainer>
    </PageShell>
  )
}
