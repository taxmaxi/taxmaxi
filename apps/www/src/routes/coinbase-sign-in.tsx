import { createFileRoute, redirect } from "@tanstack/react-router"

import { prepareCoinbaseSignIn } from "#/server-functions/auth"

export const Route = createFileRoute("/coinbase-sign-in")({
  head: () => ({
    meta: [
      {
        name: "robots",
        content: "noindex",
      },
    ],
  }),
  beforeLoad: async () => {
    const { redirectUrl } = await prepareCoinbaseSignIn()

    throw redirect({
      href: redirectUrl,
    })
  },
  component: () => null,
})
