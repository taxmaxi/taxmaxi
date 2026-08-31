DELETE FROM "calculation_runs";--> statement-breakpoint
ALTER TABLE "calculation_run_income_results" ADD COLUMN "source_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_run_realized_results" ADD COLUMN "source_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_run_realized_results" ADD COLUMN "allocation_sequence" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_run_income_results" ADD CONSTRAINT "calculation_run_income_results_run_source_fk" FOREIGN KEY ("run_id","source_id") REFERENCES "calculation_run_custody_unit_sources"("run_id","source_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_realized_results" ADD CONSTRAINT "calculation_run_realized_results_run_source_fk" FOREIGN KEY ("run_id","source_id") REFERENCES "calculation_run_custody_unit_sources"("run_id","source_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_realized_results" ADD CONSTRAINT "calculation_run_realized_results_run_allocation_fk" FOREIGN KEY ("run_id","allocation_sequence") REFERENCES "calculation_run_allocations"("run_id","sequence") ON DELETE CASCADE;
