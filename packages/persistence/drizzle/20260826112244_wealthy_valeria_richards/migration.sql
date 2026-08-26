ALTER TABLE "transactions" ADD COLUMN "provider_fiat_amount" numeric;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "provider_fiat_currency" text;--> statement-breakpoint
CREATE INDEX "idx_provider_transfers_provider_asset" ON "provider_transfers" ("provider_asset_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_provider_fiat_complete" CHECK (("provider_fiat_amount" is null) = ("provider_fiat_currency" is null));--> statement-breakpoint
UPDATE "transactions"
SET "provider_fiat_amount" = ("metadata" -> 'nativeAmount' ->> 'amount')::numeric,
    "provider_fiat_currency" = upper("metadata" -> 'nativeAmount' ->> 'currency')
WHERE ("metadata" -> 'nativeAmount' ->> 'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND ("metadata" -> 'nativeAmount' ->> 'currency') IS NOT NULL;
