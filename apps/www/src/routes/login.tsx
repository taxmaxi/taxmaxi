import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "#/components/auth-page"

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      {
        name: "robots",
        content: "noindex",
      },
    ],
  }),
  component: RouteComponent,
})

function RouteComponent() {
  return <AuthPage mode="login" />
}
