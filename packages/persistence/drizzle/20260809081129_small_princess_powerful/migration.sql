CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "idx_assets_symbol_search" ON "assets" USING gin ("symbol" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_sources_name_search" ON "sources" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_reviews_principal_status_transaction" ON "transaction_reviews" ("principal_id","review_status","transaction_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_external_id_search" ON "transactions" USING gin ("external_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_external_group_search" ON "transactions" USING gin ("external_group_id" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_transactions_provider_description_search" ON "transactions" USING gin ("provider_description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_types_key_search" ON "transaction_types" USING gin ("type_key" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_transaction_types_label_en_search" ON "transaction_types" USING gin ("label_en" gin_trgm_ops);
