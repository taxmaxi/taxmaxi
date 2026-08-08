DROP INDEX "idx_transactions_source_timestamp";--> statement-breakpoint
CREATE INDEX "idx_transactions_source_timestamp" ON "transactions" ("source_id","timestamp","id");--> statement-breakpoint
DROP INDEX "idx_transactions_principal_timestamp";--> statement-breakpoint
CREATE INDEX "idx_transactions_principal_timestamp" ON "transactions" ("principal_id","timestamp","id");