CREATE TYPE "calculation_run_inventory_scope" AS ENUM('per_custody_unit', 'whole_taxpayer');--> statement-breakpoint
CREATE TYPE "calculation_run_status" AS ENUM('pending', 'running', 'complete', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "calculation_run_allocations" (
	"run_id" uuid,
	"principal_id" uuid NOT NULL,
	"sequence" integer,
	"acquisition_event_id" uuid NOT NULL,
	"disposition_event_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"custody_unit_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"disposed_at" timestamp with time zone NOT NULL,
	"quantity" numeric(355,255) NOT NULL,
	"cost_basis" numeric(355,255),
	CONSTRAINT "calculation_run_allocations_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "calculation_run_allocations_sequence_non_negative" CHECK ("sequence" >= 0),
	CONSTRAINT "calculation_run_allocations_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "calculation_run_blockers" (
	"run_id" uuid,
	"principal_id" uuid NOT NULL,
	"sequence" integer,
	"code" text NOT NULL,
	"event_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"custody_unit_id" uuid NOT NULL,
	"missing_quantity" numeric(355,255),
	CONSTRAINT "calculation_run_blockers_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "calculation_run_blockers_sequence_non_negative" CHECK ("sequence" >= 0),
	CONSTRAINT "calculation_run_blockers_missing_quantity_positive" CHECK ("missing_quantity" is null or "missing_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "calculation_run_custody_unit_sources" (
	"run_id" uuid,
	"principal_id" uuid NOT NULL,
	"custody_unit_id" uuid NOT NULL,
	"source_id" uuid,
	CONSTRAINT "calculation_run_custody_unit_sources_pkey" PRIMARY KEY("run_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "calculation_run_custody_units" (
	"run_id" uuid,
	"principal_id" uuid,
	"custody_unit_id" uuid,
	CONSTRAINT "calculation_run_custody_units_pkey" PRIMARY KEY("run_id","principal_id","custody_unit_id")
);
--> statement-breakpoint
CREATE TABLE "calculation_run_derived_lots" (
	"run_id" uuid,
	"principal_id" uuid NOT NULL,
	"sequence" integer,
	"acquisition_event_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"custody_unit_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"remaining_quantity" numeric(355,255) NOT NULL,
	"cost_basis_per_unit" numeric(355,255),
	CONSTRAINT "calculation_run_derived_lots_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "calculation_run_derived_lots_sequence_non_negative" CHECK ("sequence" >= 0),
	CONSTRAINT "calculation_run_derived_lots_quantity_positive" CHECK ("remaining_quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "calculation_run_explanation_entries" (
	"run_id" uuid,
	"sequence" integer,
	"event_id" uuid NOT NULL,
	"code" text NOT NULL,
	"valuation_kind" text,
	"matches" jsonb NOT NULL,
	CONSTRAINT "calculation_run_explanation_entries_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "calculation_run_explanations_sequence_non_negative" CHECK ("sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "calculation_run_income_results" (
	"run_id" uuid,
	"sequence" integer,
	"event_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"quantity" numeric(355,255) NOT NULL,
	"value" numeric(355,255) NOT NULL,
	"treatment_codes" jsonb NOT NULL,
	CONSTRAINT "calculation_run_income_results_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "calculation_run_income_sequence_non_negative" CHECK ("sequence" >= 0),
	CONSTRAINT "calculation_run_income_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "calculation_run_realized_results" (
	"run_id" uuid,
	"sequence" integer,
	"acquisition_event_id" uuid NOT NULL,
	"disposition_event_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"disposed_at" timestamp with time zone NOT NULL,
	"quantity" numeric(355,255) NOT NULL,
	"cost_basis" numeric(355,255) NOT NULL,
	"proceeds" numeric(355,255) NOT NULL,
	"gain_loss" numeric(355,255) NOT NULL,
	"treatment_codes" jsonb NOT NULL,
	CONSTRAINT "calculation_run_realized_results_pkey" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "calculation_run_realized_sequence_non_negative" CHECK ("sequence" >= 0),
	CONSTRAINT "calculation_run_realized_quantity_positive" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "active_calculation_runs" (
	"principal_id" uuid,
	"jurisdiction" text,
	"tax_year" integer,
	"reporting_currency" text,
	"run_id" uuid NOT NULL CONSTRAINT "active_calculation_runs_run_unique" UNIQUE,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "active_calculation_runs_pkey" PRIMARY KEY("principal_id","jurisdiction","tax_year","reporting_currency")
);
--> statement-breakpoint
CREATE TABLE "calculation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"jurisdiction" text NOT NULL,
	"tax_year" integer NOT NULL,
	"reporting_currency" text NOT NULL,
	"engine_version" text NOT NULL,
	"rule_set_version" text NOT NULL,
	"input_ledger_revision" text NOT NULL,
	"valuation_revision" text NOT NULL,
	"status" "calculation_run_status" DEFAULT 'pending'::"calculation_run_status" NOT NULL,
	"accounting_method" text,
	"inventory_scope" "calculation_run_inventory_scope",
	"applied_choice_ids" jsonb NOT NULL,
	"applied_rules" jsonb NOT NULL,
	"processed_event_ids" jsonb NOT NULL,
	"failure_code" text,
	"failure_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calculation_runs_id_principal_unique" UNIQUE("id","principal_id"),
	CONSTRAINT "calculation_runs_id_scope_unique" UNIQUE("id","principal_id","jurisdiction","tax_year","reporting_currency"),
	CONSTRAINT "calculation_runs_tax_year_positive" CHECK ("tax_year" > 0),
	CONSTRAINT "calculation_runs_result_policy_present" CHECK (("status" in ('complete', 'partial') and "accounting_method" is not null and "inventory_scope" is not null) or ("status" not in ('complete', 'partial'))),
	CONSTRAINT "calculation_runs_completion_time_consistent" CHECK (("status" in ('complete', 'partial', 'failed')) = ("completed_at" is not null)),
	CONSTRAINT "calculation_runs_failure_consistent" CHECK (("status" = 'failed' and "failure_code" is not null) or ("status" <> 'failed' and "failure_code" is null and "failure_message" is null))
);
--> statement-breakpoint
CREATE TABLE "custody_unit_sources" (
	"principal_id" uuid NOT NULL,
	"custody_unit_id" uuid NOT NULL,
	"source_id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custody_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custody_units_id_principal_unique" UNIQUE("id","principal_id")
);
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_id_principal_unique" UNIQUE("id","principal_id");--> statement-breakpoint
INSERT INTO "custody_units" ("id", "principal_id")
SELECT "id", "principal_id"
FROM "sources";--> statement-breakpoint
INSERT INTO "custody_unit_sources" ("principal_id", "custody_unit_id", "source_id")
SELECT "principal_id", "id", "id"
FROM "sources";--> statement-breakpoint
CREATE FUNCTION "create_default_custody_unit_for_source"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "custody_units" ("id", "principal_id")
	VALUES (NEW."id", NEW."principal_id");

	INSERT INTO "custody_unit_sources" ("principal_id", "custody_unit_id", "source_id")
	VALUES (NEW."principal_id", NEW."id", NEW."id");

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sources_create_default_custody_unit"
AFTER INSERT ON "sources"
FOR EACH ROW
EXECUTE FUNCTION "create_default_custody_unit_for_source"();--> statement-breakpoint
CREATE FUNCTION "move_custody_unit_with_source_principal"() RETURNS trigger AS $$
BEGIN
	UPDATE "custody_units"
	SET "principal_id" = NEW."principal_id", "updated_at" = now()
	WHERE "id" = (
		SELECT "custody_unit_id"
		FROM "custody_unit_sources"
		WHERE "source_id" = NEW."id"
	);

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "sources_move_custody_unit_principal"
AFTER UPDATE OF "principal_id" ON "sources"
FOR EACH ROW
WHEN (OLD."principal_id" IS DISTINCT FROM NEW."principal_id")
EXECUTE FUNCTION "move_custody_unit_with_source_principal"();--> statement-breakpoint
CREATE INDEX "idx_calculation_run_allocations_disposition" ON "calculation_run_allocations" ("run_id","disposition_event_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_blockers_code" ON "calculation_run_blockers" ("run_id","code");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_custody_unit_sources_unit" ON "calculation_run_custody_unit_sources" ("run_id","custody_unit_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_custody_units_unit" ON "calculation_run_custody_units" ("custody_unit_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_derived_lots_inventory" ON "calculation_run_derived_lots" ("run_id","custody_unit_id","asset_id","acquired_at");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_explanations_event" ON "calculation_run_explanation_entries" ("run_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_income_event" ON "calculation_run_income_results" ("run_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_run_realized_disposition" ON "calculation_run_realized_results" ("run_id","disposition_event_id");--> statement-breakpoint
CREATE INDEX "idx_calculation_runs_principal_scope_created" ON "calculation_runs" ("principal_id","jurisdiction","tax_year","reporting_currency","created_at");--> statement-breakpoint
CREATE INDEX "idx_calculation_runs_status" ON "calculation_runs" ("status");--> statement-breakpoint
CREATE INDEX "idx_custody_unit_sources_unit" ON "custody_unit_sources" ("custody_unit_id");--> statement-breakpoint
CREATE INDEX "idx_custody_units_principal" ON "custody_units" ("principal_id");--> statement-breakpoint
ALTER TABLE "calculation_run_allocations" ADD CONSTRAINT "calculation_run_allocations_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "calculation_run_allocations" ADD CONSTRAINT "calculation_run_allocations_run_unit_fk" FOREIGN KEY ("run_id","principal_id","custody_unit_id") REFERENCES "calculation_run_custody_units"("run_id","principal_id","custody_unit_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_blockers" ADD CONSTRAINT "calculation_run_blockers_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "calculation_run_blockers" ADD CONSTRAINT "calculation_run_blockers_run_unit_fk" FOREIGN KEY ("run_id","principal_id","custody_unit_id") REFERENCES "calculation_run_custody_units"("run_id","principal_id","custody_unit_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_custody_unit_sources" ADD CONSTRAINT "calculation_run_custody_unit_sources_run_unit_fk" FOREIGN KEY ("run_id","principal_id","custody_unit_id") REFERENCES "calculation_run_custody_units"("run_id","principal_id","custody_unit_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_custody_units" ADD CONSTRAINT "calculation_run_custody_units_Q9ITPf35Fzmm_fkey" FOREIGN KEY ("custody_unit_id") REFERENCES "custody_units"("id");--> statement-breakpoint
ALTER TABLE "calculation_run_custody_units" ADD CONSTRAINT "calculation_run_custody_units_run_principal_fk" FOREIGN KEY ("run_id","principal_id") REFERENCES "calculation_runs"("id","principal_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_derived_lots" ADD CONSTRAINT "calculation_run_derived_lots_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "calculation_run_derived_lots" ADD CONSTRAINT "calculation_run_derived_lots_run_unit_fk" FOREIGN KEY ("run_id","principal_id","custody_unit_id") REFERENCES "calculation_run_custody_units"("run_id","principal_id","custody_unit_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_explanation_entries" ADD CONSTRAINT "calculation_run_explanation_entries_iCKqeKBo8pXT_fkey" FOREIGN KEY ("run_id") REFERENCES "calculation_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_income_results" ADD CONSTRAINT "calculation_run_income_results_run_id_calculation_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "calculation_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_income_results" ADD CONSTRAINT "calculation_run_income_results_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "calculation_run_realized_results" ADD CONSTRAINT "calculation_run_realized_results_rx0Xsoiio9B4_fkey" FOREIGN KEY ("run_id") REFERENCES "calculation_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_run_realized_results" ADD CONSTRAINT "calculation_run_realized_results_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "active_calculation_runs" ADD CONSTRAINT "active_calculation_runs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "active_calculation_runs" ADD CONSTRAINT "active_calculation_runs_matching_scope_fk" FOREIGN KEY ("run_id","principal_id","jurisdiction","tax_year","reporting_currency") REFERENCES "calculation_runs"("id","principal_id","jurisdiction","tax_year","reporting_currency") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "calculation_runs" ADD CONSTRAINT "calculation_runs_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custody_unit_sources" ADD CONSTRAINT "custody_unit_sources_unit_principal_fk" FOREIGN KEY ("custody_unit_id","principal_id") REFERENCES "custody_units"("id","principal_id") ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "custody_unit_sources" ADD CONSTRAINT "custody_unit_sources_source_principal_fk" FOREIGN KEY ("source_id","principal_id") REFERENCES "sources"("id","principal_id") ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "custody_units" ADD CONSTRAINT "custody_units_principal_id_principals_id_fkey" FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE CASCADE;
