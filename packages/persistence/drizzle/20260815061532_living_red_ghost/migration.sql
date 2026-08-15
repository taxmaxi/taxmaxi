CREATE TYPE "billing_subscription_status" AS ENUM('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused');--> statement-breakpoint
CREATE TYPE "credit_entry_kind" AS ENUM('annual_grant', 'top_up', 'transaction_usage', 'manual_adjustment');--> statement-breakpoint
CREATE TABLE "billing_accounts" (
	"user_id" uuid PRIMARY KEY,
	"stripe_customer_id" text,
	"stripe_customer_generation" integer DEFAULT 0 NOT NULL,
	"annual_checkout_generation" integer DEFAULT 0 NOT NULL,
	"annual_checkout_expires_at" timestamp,
	"annual_checkout_price_id" text,
	"subscription_sync_generation" integer DEFAULT 0 NOT NULL,
	"stripe_subscription_id" text,
	"subscription_status" "billing_subscription_status",
	"current_period_end" timestamp,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"last_subscription_event_created_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_payment_reversals" (
	"payment_reference" text,
	"reversal_group" text,
	"loss_reference" text NOT NULL,
	"reversed_amount" integer NOT NULL,
	"payment_amount" integer NOT NULL,
	"event_reference" text NOT NULL,
	"event_created_at" timestamp NOT NULL,
	"stripe_invoice_id" text,
	"terminal" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payment_reversals_pkey" PRIMARY KEY("payment_reference","reversal_group")
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"kind" "credit_entry_kind" NOT NULL,
	"reference" text NOT NULL,
	"payment_reference" text,
	"payment_amount" integer,
	"stripe_invoice_id" text,
	"replay_reservation_id" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_delta_non_zero" CHECK ("delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY,
	"type" text NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_stripe_customer_unique" ON "billing_accounts" ("stripe_customer_id") WHERE "stripe_customer_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_accounts_stripe_subscription_unique" ON "billing_accounts" ("stripe_subscription_id") WHERE "stripe_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_billing_payment_reversals_payment_reference" ON "billing_payment_reversals" ("payment_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_reference_unique" ON "credit_ledger" ("reference");--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_user_id" ON "credit_ledger" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_payment_reference" ON "credit_ledger" ("payment_reference");--> statement-breakpoint
CREATE INDEX "idx_credit_ledger_expires_at" ON "credit_ledger" ("expires_at");--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD CONSTRAINT "billing_accounts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;