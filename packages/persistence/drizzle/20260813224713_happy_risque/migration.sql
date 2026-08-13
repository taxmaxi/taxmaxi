CREATE TABLE "billing_payment_reversals" (
	"payment_reference" text,
	"reversal_group" text,
	"reversed_amount" integer NOT NULL,
	"payment_amount" integer NOT NULL,
	"event_reference" text NOT NULL,
	"event_created_at" timestamp NOT NULL,
	"terminal" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payment_reversals_pkey" PRIMARY KEY("payment_reference","reversal_group")
);
--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "stripe_customer_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "annual_checkout_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "annual_checkout_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "subscription_sync_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "last_subscription_event_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "payment_reference" text;--> statement-breakpoint
ALTER TABLE "billing_accounts" ALTER COLUMN "stripe_customer_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "billing_accounts_stripe_customer_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_stripe_customer_unique" ON "billing_accounts" ("stripe_customer_id") WHERE "stripe_customer_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_billing_payment_reversals_payment_reference" ON "billing_payment_reversals" ("payment_reference");--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_payment_reference" ON "credit_ledger" ("payment_reference");