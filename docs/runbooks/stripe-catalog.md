# Stripe catalog runbook

Use this runbook when setting up a new Stripe environment or changing the products and prices used by TaxMaxi billing.

The catalog setup command is safe to rerun. It creates missing products and prices, updates mutable product fields, and replaces prices when immutable price fields change.

## Source of truth

The source of truth is `TAXMAXI_STRIPE_CATALOG` in [`packages/rest-api/src/services/StripeCatalog.ts`](../../packages/rest-api/src/services/StripeCatalog.ts).

Do not make an unrecorded catalog change only in the Stripe Dashboard. Change the catalog definition first, run its tests, and then reconcile Stripe.

## Stripe environments

The selected restricted key determines the Stripe environment that the command changes:

- Sandbox uses `STRIPE_SANDBOX_CATALOG_KEY` and requires an `rk_test_...` key.
- Production uses `STRIPE_PRODUCTION_CATALOG_KEY` and requires an `rk_live_...` key.

The `rk_test_` prefix does not identify a particular Stripe sandbox. Confirm that the key belongs to the intended TaxMaxi sandbox before running the command.

The API runtime key must belong to the same Stripe environment as the catalog it reads. If the catalog is created with one sandbox's key but `STRIPE_SECRET_KEY` belongs to another sandbox or test environment, `/v1/billing/catalog` will not find the prices.

The runtime key needs `Prices: Read` and `Products: Read` so the API can verify both sides of each catalog entry before showing a price or starting Checkout.

## Restricted key permissions

Create a separate restricted key for catalog setup with these permissions:

| Resource        | Permission |
| --------------- | ---------- |
| Products        | Write      |
| Prices          | Write      |
| Everything else | None       |

Do not use the runtime `STRIPE_SECRET_KEY` for catalog setup. Its permissions and lifecycle are different.

Store the selected keys in the 1Password Environment mounted at `apps/server/.env`:

```dotenv
STRIPE_SANDBOX_CATALOG_KEY=rk_test_...
STRIPE_PRODUCTION_CATALOG_KEY=rk_live_...
```

Keep `.env` files and key values out of Git.

## Reconcile a sandbox

Always test catalog changes in the intended Stripe sandbox first.

From the repository root, run:

```bash
mise x -- pnpm run stripe:catalog:setup
```

Choose `1` for sandbox. The command prints every product or price it creates, updates, activates, archives, or keeps.

Rerun the command once after it succeeds. A clean second run should keep every expected price and should not create another product or price.

## Reconcile production

Before changing production:

1. Verify the completed catalog in the sandbox.
2. Confirm that `STRIPE_PRODUCTION_CATALOG_KEY` belongs to the TaxMaxi live account.
3. Review the catalog change in code.

Run the same command:

```bash
mise x -- pnpm run stripe:catalog:setup
```

Choose `2`, then type `production` when prompted. Any other confirmation cancels without changing Stripe.

When a code change edits an existing catalog definition, deploy the code and run production catalog setup in one maintenance window. Exact runtime validation means billing can be briefly unavailable between those two steps. Run setup immediately after deployment, then verify `/v1/billing/catalog` before ending the window. Do not keep two catalog definitions in application code for rollout compatibility.

## Verify the result

Make sure the API server uses a runtime key from the same Stripe environment, then start or restart it so it reloads `STRIPE_SECRET_KEY`.

For local development, check the public catalog endpoint:

```bash
curl --fail --show-error http://localhost:4000/v1/billing/catalog
```

The response must contain one price for every item in `TAXMAXI_STRIPE_CATALOG`. Each price must have the expected lookup key, amount, currency, tax behavior, and billing interval.

Also open:

```text
http://localhost:3000/app/billing
```

The annual plan and transaction pack must show prices instead of `Price unavailable`.

For production, perform the same endpoint and billing-page checks against the deployed TaxMaxi URLs.

## Change the catalog

### Add a product and price

Add a new item to `TAXMAXI_STRIPE_CATALOG` with a unique, stable lookup key. Add or update runtime behavior and tests that use the new item, then run the sandbox and production reconciliation steps.

Do not reuse a lookup key for a different commercial offer.

### Change product details

Update names and descriptions in the catalog definition, then rerun the command. It updates the matching Stripe product, reapplies the TaxMaxi metadata and tax code, and reactivates the product if needed.

### Change a price

Stripe does not allow changing core fields on an existing price. When the amount, currency, tax behavior, product, or recurring interval changes, the command:

1. Creates a replacement price.
2. Transfers the lookup key to the replacement.
3. Archives the replaced price.

Past Stripe records can continue to reference an archived price.

### Remove a product or price

Removal is not automated. Deleting an item from `TAXMAXI_STRIPE_CATALOG` does not archive its existing Stripe product or price.

Treat removal as a separate code change. Remove runtime checkout paths first, add and test explicit archival behavior, verify it in the sandbox, and only then apply it to production. Do not delete Stripe objects referenced by subscriptions, invoices, payments, refunds, or disputes.

## Recover from a failed run

Rerun the same command with the same environment selection. Reconciliation and Stripe idempotency keys prevent completed create operations from being duplicated, and the command continues from the current catalog state.

If the command reports duplicate products or lookup keys, stop and resolve the duplicates in the selected Stripe environment before rerunning. Do not guess which duplicate should remain active.

If the API still reports an unavailable catalog after a successful run, check these items in order:

1. `STRIPE_SECRET_KEY` and the catalog setup key belong to the same Stripe environment.
2. The runtime key has `Prices: Read` permission.
3. The runtime key has `Products: Read` permission.
4. Every expected price is active and has the correct lookup key, exact amount, tax behavior, `per_unit` billing scheme, and no quantity transformation.
5. Annual prices recur yearly with licensed usage and no trial; top-up prices are one-time prices.
6. All prices use EUR and have a fixed unit amount.
7. Every expanded Product is active and has the expected name, description, tax code, and `taxmaxi_catalog_lookup_key` metadata.

The structured `Stripe catalog validation failed` log includes `validationReason`, `lookupKey`, and `priceId` when one specific Price or Product differs. Use those fields to locate the object in Stripe before rerunning setup.

## After setup

The webhook signing secret is separate from the catalog keys. Catalog reconciliation does not create or change webhook endpoints.

Catalog keys are powerful even though they are restricted. Revoke them after use if they are intended to be short-lived. The next operator can recreate them from the permission table in this runbook.
