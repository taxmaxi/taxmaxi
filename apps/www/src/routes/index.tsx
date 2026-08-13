import { createFileRoute } from "@tanstack/react-router"
import { LandingPage } from "#/components/landing-page"

export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    try {
      return await context.taxmaxi().billing.catalog()
    } catch {
      return null
    }
  },
  component: RouteComponent,
})

function RouteComponent() {
  const billingCatalog = Route.useLoaderData()
  return <LandingPage billingCatalog={billingCatalog} />
}
