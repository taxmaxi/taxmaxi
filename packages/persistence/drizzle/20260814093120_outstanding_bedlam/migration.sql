ALTER TABLE "billing_payment_reversals" ADD COLUMN "loss_reference" text;--> statement-breakpoint
UPDATE "billing_payment_reversals" SET "loss_reference" = "reversal_group";--> statement-breakpoint
ALTER TABLE "billing_payment_reversals" ALTER COLUMN "loss_reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_payment_reversals" ADD COLUMN "stripe_invoice_id" text;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "payment_amount" integer;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD COLUMN "stripe_invoice_id" text;
