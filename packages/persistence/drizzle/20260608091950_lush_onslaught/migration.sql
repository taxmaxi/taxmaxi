ALTER TABLE "blockchains" ALTER COLUMN "chain_type" SET DATA TYPE text USING "chain_type"::text;--> statement-breakpoint
DROP TYPE "chain_type";