/**
 * StripeCatalog - TaxMaxi product, price, and restricted-key definitions.
 *
 * @module StripeCatalog
 */

export const TAXMAXI_ANNUAL_LOOKUP_KEY = "taxmaxi_annual_10k_eur"
export const TAXMAXI_TOP_UP_LOOKUP_KEY = "taxmaxi_topup_1k_eur"
export const TAXMAXI_PROFESSIONAL_ANNUAL_LOOKUP_KEY = "taxmaxi_professional_annual_100k_eur"
export const TAXMAXI_PROFESSIONAL_MATTER_LOOKUP_KEY = "taxmaxi_professional_matter_annual_10k_eur"
export const TAXMAXI_PROFESSIONAL_TOP_UP_LOOKUP_KEY = "taxmaxi_professional_topup_20k_eur"
export const TAXMAXI_ENTERPRISE_PILOT_LOOKUP_KEY = "taxmaxi_enterprise_pilot_eur"

export const STRIPE_CATALOG_PRODUCT_METADATA_KEY = "taxmaxi_catalog_lookup_key"
export const TAXMAXI_STRIPE_TAX_CODE = "txcd_10000000"

export interface TaxMaxiStripeCatalogItem {
  readonly lookupKey: string
  readonly name: string
  readonly description: string
  readonly currency: "eur"
  readonly unitAmount: number
  readonly taxBehavior: "inclusive" | "exclusive"
  readonly recurringInterval: "year" | null
}

/** The complete catalog required by the TaxMaxi billing API. */
export const TAXMAXI_STRIPE_CATALOG: ReadonlyArray<TaxMaxiStripeCatalogItem> = [
  {
    lookupKey: TAXMAXI_ANNUAL_LOOKUP_KEY,
    name: "TaxMaxi Annual",
    description: "10,000 processed transactions per contract year.",
    currency: "eur",
    unitAmount: 15_900,
    taxBehavior: "inclusive",
    recurringInterval: "year",
  },
  {
    lookupKey: TAXMAXI_TOP_UP_LOOKUP_KEY,
    name: "1,000 Additional Transactions",
    description: "1,000 additional processed transactions.",
    currency: "eur",
    unitAmount: 2_000,
    taxBehavior: "inclusive",
    recurringInterval: null,
  },
  {
    lookupKey: TAXMAXI_PROFESSIONAL_ANNUAL_LOOKUP_KEY,
    name: "TaxMaxi Professional Annual",
    description: "3 users, 10 client matters, and 100,000 transactions per contract year.",
    currency: "eur",
    unitAmount: 159_000,
    taxBehavior: "exclusive",
    recurringInterval: "year",
  },
  {
    lookupKey: TAXMAXI_PROFESSIONAL_MATTER_LOOKUP_KEY,
    name: "TaxMaxi Professional Additional Matter",
    description: "One additional client matter with 10,000 transactions per contract year.",
    currency: "eur",
    unitAmount: 14_900,
    taxBehavior: "exclusive",
    recurringInterval: "year",
  },
  {
    lookupKey: TAXMAXI_PROFESSIONAL_TOP_UP_LOOKUP_KEY,
    name: "20,000 Additional Professional Transactions",
    description: "20,000 additional transactions shared across the professional workspace.",
    currency: "eur",
    unitAmount: 20_000,
    taxBehavior: "exclusive",
    recurringInterval: null,
  },
  {
    lookupKey: TAXMAXI_ENTERPRISE_PILOT_LOOKUP_KEY,
    name: "TaxMaxi Enterprise Pilot",
    description: "A bounded paid pilot for one team and one agreed workflow.",
    currency: "eur",
    unitAmount: 500_000,
    taxBehavior: "exclusive",
    recurringInterval: null,
  },
]

export interface StripeRestrictedKeyPermission {
  readonly resource: string
  readonly access: "read" | "write"
}

/** Permissions for the short-lived key used by the catalog setup command. */
export const STRIPE_CATALOG_SETUP_KEY_PERMISSIONS: ReadonlyArray<StripeRestrictedKeyPermission> = [
  { resource: "Products", access: "write" },
  { resource: "Prices", access: "write" },
]

/** Least-privilege permissions used by the running TaxMaxi API. */
export const STRIPE_RUNTIME_KEY_PERMISSIONS: ReadonlyArray<StripeRestrictedKeyPermission> = [
  { resource: "Customers", access: "write" },
  { resource: "Checkout Sessions", access: "write" },
  { resource: "Customer Portal", access: "write" },
  { resource: "Prices", access: "read" },
  { resource: "Products", access: "read" },
  { resource: "Subscriptions", access: "read" },
  { resource: "Invoices", access: "read" },
  { resource: "Charges and Refunds", access: "read" },
  { resource: "Payment Disputes", access: "read" },
  { resource: "Payment Records", access: "read" },
]
