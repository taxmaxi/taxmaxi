import { createFileRoute } from "@tanstack/react-router"
import type { BillingCatalog } from "taxmaxi"
import { LandingPage } from "#/components/landing-page"

export const loadPublicBillingCatalog = async (
  loadCatalog: () => Promise<BillingCatalog>
): Promise<BillingCatalog | null> => {
  try {
    return await loadCatalog()
  } catch {
    return null
  }
}

export const Route = createFileRoute("/")({
  loader: ({ context }) => loadPublicBillingCatalog(context.taxmaxi().billing.catalog),
  component: RouteComponent,
})

function RouteComponent() {
  const billingCatalog = Route.useLoaderData()
  return <LandingPage billingCatalog={billingCatalog} />
}
