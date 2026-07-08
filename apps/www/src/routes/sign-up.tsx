import { createFileRoute } from "@tanstack/react-router"

import { AuthPage } from "#/components/auth-page"

export const Route = createFileRoute("/sign-up")({
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
  return <AuthPage mode="sign-up" />
}
