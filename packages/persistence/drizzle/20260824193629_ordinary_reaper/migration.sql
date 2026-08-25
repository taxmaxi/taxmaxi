CREATE TABLE "wallet_name_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"namespace" text NOT NULL,
	"name" text NOT NULL,
	"resolved_address" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_name_cache_namespace_name_idx" ON "wallet_name_cache" ("namespace","name");