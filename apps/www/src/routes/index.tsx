import { createFileRoute } from "@tanstack/react-router"
import type { BillingCatalog } from "taxmaxi"
import { LandingPage } from "#/components/landing-page"

export const loadPublicBillingCatalog = async (
  loadCatalog: () => Promise<BillingCatalog>,
  timeoutMs = 1_000
): Promise<BillingCatalog | null> =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs)

    void loadCatalog().then(
      (catalog) => {
        clearTimeout(timeout)
        resolve(catalog)
      },
      () => {
        clearTimeout(timeout)
        resolve(null)
      }
    )
  })

export const Route = createFileRoute("/")({
  loader: ({ context }) => loadPublicBillingCatalog(context.taxmaxi().billing.catalog),
  component: RouteComponent,
})

function RouteComponent() {
  const billingCatalog = Route.useLoaderData()
  return <LandingPage billingCatalog={billingCatalog} />
}
