CREATE TYPE "address_type" AS ENUM('evm', 'solana', 'bitcoin');--> statement-breakpoint
CREATE TYPE "asset_type" AS ENUM('native', 'token', 'nft');--> statement-breakpoint
CREATE TYPE "chain_type" AS ENUM('evm', 'solana', 'bitcoin', 'cardano', 'other');--> statement-breakpoint
CREATE TYPE "auth_provider_type" AS ENUM('local', 'google', 'coinbase');--> statement-breakpoint
CREATE TYPE "oauth_intent" AS ENUM('login', 'link');--> statement-breakpoint
CREATE TYPE "oauth_state_status" AS ENUM('pending', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "job_mode" AS ENUM('sync', 'replay');--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "provider_asset_mapping_kind" AS ENUM('asset', 'fiat');--> statement-breakpoint
CREATE TYPE "provider_inventory_effect" AS ENUM('acquisition', 'disposal', 'income', 'internal_transfer', 'non_inventory', 'unknown');--> statement-breakpoint
CREATE TYPE "provider_mapping_status" AS ENUM('approved', 'pending_review', 'rejected');--> statement-breakpoint
CREATE TYPE "provider_resolution_strategy" AS ENUM('static', 'amount_sign', 'venue_side', 'amount_sign_fee', 'no_leg');--> statement-breakpoint
CREATE TYPE "provider_tax_treatment" AS ENUM('taxable_by_default', 'non_taxable_by_default', 'requires_additional_rule_logic');--> statement-breakpoint
CREATE TYPE "provider_transfer_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "sourceable_type" AS ENUM('onchain', 'cex', 'dex');--> statement-breakpoint
CREATE TYPE "sync_run_item_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "sync_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'partially_failed');--> statement-breakpoint
CREATE TYPE "leg_kind" AS ENUM('acquisition', 'disposal', 'income', 'fee');--> statement-breakpoint
CREATE TYPE "leg_provenance" AS ENUM('deterministic', 'rule', 'ai', 'manual');--> statement-breakpoint
CREATE TYPE "review_status" AS ENUM('auto_applied', 'needs_review', 'approved', 'changed');--> statement-breakpoint
CREATE TYPE "transaction_venue_type" AS ENUM('cex', 'dex');--> statement-breakpoint
CREATE TYPE "transfer_reconciliation_status" AS ENUM('pending', 'needs_review', 'approved', 'rejected', 'auto_applied');--> statement-breakpoint
CREATE TYPE "transfer_type" AS ENUM('erc20', 'erc721', 'erc1155', 'internal', 'native', 'spl', 'utxo', 'cex', 'dex', 'fiat', 'funding', 'reward', 'fee');--> statement-breakpoint
CREATE TYPE "user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"address" text NOT NULL,
	"type" "address_type" NOT NULL,
	"name" text NOT NULL,
	"ens_name" text,
	"user_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "addresses_address_user_id_unique" UNIQUE("address","user_id")
);
--> statement-breakpoint
CREATE TABLE "asset_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"asset_id" uuid NOT NULL,
	"timestamp" timestamp NOT NULL,
	"price" numeric(36,18) NOT NULL,
	"currency" text NOT NULL,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "unique_asset_price_idx" UNIQUE("asset_id","timestamp","currency")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"blockchain_id" uuid NOT NULL,
	"contract_address" text,
	"name" text NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"logo_url" text,
	"type" "asset_type" DEFAULT 'token'::"asset_type" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"is_spam" boolean DEFAULT false NOT NULL,
	CONSTRAINT "unique_token_idx" UNIQUE("blockchain_id","contract_address")
);
--> statement-breakpoint
CREATE TABLE "blockchains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL UNIQUE,
	"chain_type" "chain_type" NOT NULL,
	"chain_id" integer,
	"native_asset_symbol" text NOT NULL,
	"explorer_url" text,
	"logo_url" text,
	"coingecko_platform_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cex_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"cex_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_user_id" text,
	"provider_account_id" text,
	"access_token" text,
	"expires_at" timestamp,
	"refresh_token" text,
	"scopes" text,
	"api_key" text,
	"api_secret" text,
	"credentials_updated_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cex" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL UNIQUE,
	"website" text NOT NULL,
	"logo_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disposal_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"disposal_leg_id" uuid NOT NULL,
	"fifo_lot_id" uuid NOT NULL,
	"matched_amount" numeric(100,30) NOT NULL,
	"cost_basis" numeric(36,8) NOT NULL,
	"proceeds" numeric(36,8) NOT NULL,
	"gain_loss" numeric(36,8) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"email" text NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fifo_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"source_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"acquired_at" timestamp NOT NULL,
	"original_amount" numeric(100,30) NOT NULL,
	"remaining_amount" numeric(100,30) NOT NULL,
	"cost_basis_per_token" numeric(36,18) NOT NULL,
	"cost_basis_currency" text NOT NULL,
	"source_leg_id" uuid NOT NULL,
	"source_leg_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"provider" "auth_provider_type" NOT NULL,
	"provider_id" text NOT NULL,
	"password_hash" text,
	"provider_data" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jurisdiction_rule_set_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"rule_set_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "jurisdiction_rule_set_rules_unique" UNIQUE("rule_set_id","rule_id")
);
--> statement-breakpoint
CREATE TABLE "jurisdiction_rule_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"jurisdiction_code" text NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"effective_from" timestamp NOT NULL,
	"effective_to" timestamp,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "jurisdiction_rule_sets_jurisdiction_version_unique" UNIQUE("jurisdiction_code","version")
);
--> statement-breakpoint
CREATE TABLE "legal_clauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"clause_key" text NOT NULL CONSTRAINT "legal_clauses_clause_key_unique" UNIQUE,
	"section_code" text,
	"heading" text,
	"randnummer" text NOT NULL,
	"clause_text" text NOT NULL,
	"summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legal_clauses_source_randnummer_unique" UNIQUE("source_id","randnummer")
);
--> statement-breakpoint
CREATE TABLE "legal_rule_citations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"rule_id" uuid NOT NULL,
	"clause_id" uuid NOT NULL,
	"citation_order" integer DEFAULT 0 NOT NULL,
	"quote" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "legal_rule_citations_rule_clause_unique" UNIQUE("rule_id","clause_id")
);
--> statement-breakpoint
CREATE TABLE "legal_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"rule_key" text NOT NULL CONSTRAINT "legal_rules_rule_key_unique" UNIQUE,
	"jurisdiction_code" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"scope" text NOT NULL,
	"outcome_category" text NOT NULL,
	"machine_readable" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_key" text NOT NULL CONSTRAINT "legal_sources_source_key_unique" UNIQUE,
	"jurisdiction_code" text NOT NULL,
	"source_type" text NOT NULL,
	"authority" text NOT NULL,
	"title" text NOT NULL,
	"short_title" text,
	"language" text DEFAULT 'de' NOT NULL,
	"source_url" text,
	"published_at" timestamp NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_to" timestamp,
	"checksum_sha256" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_type_legal_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"transaction_type_key" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"relevance" numeric(3,2) DEFAULT '1.00' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_type_legal_rules_unique" UNIQUE("transaction_type_key","rule_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY,
	"intent" "oauth_intent" NOT NULL,
	"provider" "auth_provider_type" NOT NULL,
	"user_id" uuid,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "oauth_state_status" DEFAULT 'pending'::"oauth_state_status" NOT NULL,
	"session_token" text,
	"status_message" text,
	"completed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"user_id" uuid,
	"mode" "job_mode" DEFAULT 'sync'::"job_mode" NOT NULL,
	"status" "job_status" DEFAULT 'pending'::"job_status" NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"queued_at" timestamp,
	"started_at" timestamp,
	"heartbeat_at" timestamp,
	"completed_at" timestamp,
	"next_retry_at" timestamp,
	"error_message" text,
	"progress_details" jsonb,
	"queue_name" text,
	"queue_job_id" text,
	"worker_id" text,
	"checkpoint_external_id" text,
	"checkpoint_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_attempt_count_non_negative" CHECK ("attempt_count" >= 0),
	CONSTRAINT "processing_jobs_max_attempts_positive" CHECK ("max_attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_asset_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_asset_row_id" uuid NOT NULL,
	"mapping_kind" "provider_asset_mapping_kind" NOT NULL,
	"canonical_asset_id" uuid,
	"canonical_asset_symbol" text,
	"canonical_fiat_currency" text,
	"mapping_status" "provider_mapping_status" DEFAULT 'pending_review'::"provider_mapping_status" NOT NULL,
	"reviewer_notes" text,
	"source_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_asset_mappings_kind_requires_target" CHECK ((
        "mapping_kind" = 'asset'
        and ("canonical_asset_id" is not null or "canonical_asset_symbol" is not null)
      ) or (
        "mapping_kind" = 'fiat'
        and "canonical_fiat_currency" is not null
      ) or "mapping_status" in ('pending_review', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "provider_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider" text NOT NULL,
	"provider_asset_id" text,
	"natural_key" text,
	"currency_code" text NOT NULL,
	"name" text,
	"exponent" integer,
	"provider_type" text,
	"raw_provider_payload" jsonb,
	"discovered_at" timestamp DEFAULT now() NOT NULL,
	"retrieved_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_assets_identity_requires_key" CHECK ("provider_asset_id" is not null or "natural_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "provider_transaction_type_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider" text NOT NULL,
	"provider_transaction_type" text NOT NULL,
	"description" text,
	"source_url" text,
	"retrieved_at" timestamp NOT NULL,
	"raw_source_payload" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_transaction_type_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider" text NOT NULL,
	"provider_transaction_type" text NOT NULL,
	"transaction_type_key" text,
	"inventory_effect" "provider_inventory_effect" NOT NULL,
	"tax_treatment" "provider_tax_treatment" NOT NULL,
	"resolution_strategy" "provider_resolution_strategy" NOT NULL,
	"paired_record_required" boolean DEFAULT false NOT NULL,
	"mapping_status" "provider_mapping_status" DEFAULT 'pending_review'::"provider_mapping_status" NOT NULL,
	"reviewer_notes" text,
	"source_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_transaction_type_mappings_pending_review_allows_null_key" CHECK ("mapping_status" in ('pending_review', 'rejected') or "transaction_type_key" is not null)
);
--> statement-breakpoint
CREATE TABLE "provider_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid,
	"transaction_id" uuid NOT NULL,
	"external_id" text,
	"external_group_id" text,
	"provider_asset_id" uuid,
	"timestamp" timestamp NOT NULL,
	"direction" "provider_transfer_direction" NOT NULL,
	"from_account_ref" text,
	"to_account_ref" text,
	"from_address" text,
	"to_address" text,
	"network_name" text,
	"network_hash" text,
	"amount" numeric(100,30) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "provider_transfers_identifier_present" CHECK ("external_id" is not null or "network_hash" is not null),
	CONSTRAINT "provider_transfers_from_party_present" CHECK ("from_address" is not null or "from_account_ref" is not null),
	CONSTRAINT "provider_transfers_to_party_present" CHECK ("to_address" is not null or "to_account_ref" is not null),
	CONSTRAINT "provider_transfers_amount_positive" CHECK ("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"user_id" uuid,
	"provider" "auth_provider_type" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_records_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"record_type" text NOT NULL,
	"external_account_id" text,
	"external_record_id" text NOT NULL,
	"external_parent_id" text,
	"occurred_at" timestamp NOT NULL,
	"payload" jsonb NOT NULL,
	"imported_at" timestamp DEFAULT now() NOT NULL,
	"normalized_at" timestamp,
	"normalization_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"provider_key" text,
	"provider_metadata" jsonb,
	"last_synced_at" timestamp,
	"address_id" uuid,
	"cex_account_id" uuid,
	"sourceable_type" "sourceable_type" NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sourceable_id_not_null" CHECK ("address_id" is not null or "cex_account_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "source_sync_state" (
	"source_id" uuid PRIMARY KEY,
	"cursor_payload" jsonb,
	"high_watermark" timestamp,
	"checkpoint_raw_record_id" uuid,
	"checkpoint_external_id" text,
	"last_synced_at" timestamp,
	"last_error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"processing_job_id" uuid,
	"status" "sync_run_item_status" DEFAULT 'queued'::"sync_run_item_status" NOT NULL,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"status" "sync_run_status" DEFAULT 'queued'::"sync_run_status" NOT NULL,
	"requested_source_count" integer DEFAULT 0 NOT NULL,
	"queued_source_count" integer DEFAULT 0 NOT NULL,
	"running_source_count" integer DEFAULT 0 NOT NULL,
	"completed_source_count" integer DEFAULT 0 NOT NULL,
	"failed_source_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_categories" (
	"category_key" text PRIMARY KEY,
	"name_en" text NOT NULL,
	"name_de" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid,
	"external_id" text,
	"tx_hash" text,
	"timestamp" timestamp NOT NULL,
	"user_id" uuid,
	"address_id" uuid,
	"asset_id" uuid NOT NULL,
	"amount" numeric(100,30) NOT NULL,
	"kind" "leg_kind" NOT NULL,
	"provenance" "leg_provenance" NOT NULL,
	"derivation_rule" text,
	"metadata" jsonb,
	"transaction_id" uuid,
	"source_transfer_id" uuid,
	"fiat_amount" numeric(36,8),
	"fiat_currency" text,
	"fee_for_transaction_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_legs_identifier_present" CHECK ("tx_hash" is not null or "external_id" is not null),
	CONSTRAINT "transaction_legs_tx_hash_requires_address" CHECK ("tx_hash" is null or "address_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "transaction_onchain_context" (
	"transaction_id" uuid PRIMARY KEY,
	"blockchain_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"block_number" numeric,
	"block_hash" text,
	"position_in_block" numeric,
	"from_address" text NOT NULL,
	"to_address" text,
	"gas_used" numeric(78,0),
	"gas_price" numeric(78,0),
	"gas_fee_in_native" numeric(78,0),
	"fee_asset_id" uuid,
	"gas_fee_cost_basis_amount" numeric(36,8),
	"gas_fee_cost_basis_currency" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"function_name" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"transaction_id" uuid NOT NULL UNIQUE,
	"user_id" uuid NOT NULL,
	"review_status" "review_status" DEFAULT 'needs_review'::"review_status" NOT NULL,
	"original_type_key" text,
	"original_confidence" numeric(3,2),
	"current_type_key" text,
	"legal_rule_set_version" text,
	"categorization_reason" text,
	"matched_layer" text,
	"needs_review" boolean DEFAULT true NOT NULL,
	"user_notes" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid,
	"external_id" text,
	"external_group_id" text,
	"timestamp" timestamp NOT NULL,
	"transaction_type" varchar,
	"provider_transaction_type" text,
	"provider_status" text,
	"provider_resource_path" text,
	"provider_description" text,
	"provider_created_at" timestamp,
	"provider_updated_at" timestamp,
	"metadata" jsonb,
	"user_id" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_identifier_present" CHECK ("external_id" is not null or "source_raw_record_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "transaction_subcategories" (
	"subcategory_key" text PRIMARY KEY,
	"name_en" text NOT NULL,
	"name_de" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_types" (
	"type_key" text PRIMARY KEY,
	"category_key" text,
	"subcategory_key" text,
	"label_en" text NOT NULL,
	"label_de" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_venue_context" (
	"transaction_id" uuid PRIMARY KEY,
	"venue_type" "transaction_venue_type" NOT NULL,
	"cex_account_id" uuid,
	"external_account_id" text,
	"external_order_id" text,
	"external_fill_id" text,
	"side" text,
	"instrument" text,
	"fill_price" numeric(100,30),
	"commission_amount" numeric(100,30),
	"commission_currency" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfer_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"provider_transfer_id" uuid NOT NULL,
	"canonical_transfer_id" uuid,
	"canonical_transaction_id" uuid,
	"status" "transfer_reconciliation_status" DEFAULT 'pending'::"transfer_reconciliation_status" NOT NULL,
	"match_reason" text NOT NULL,
	"confidence" numeric(5,4) DEFAULT '0' NOT NULL,
	"deterministic" boolean DEFAULT false NOT NULL,
	"review_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_reconciliations_confidence_range" CHECK ("confidence" >= 0 and "confidence" <= 1),
	CONSTRAINT "transfer_reconciliations_auto_applied_requires_match" CHECK ("status" != 'auto_applied' or ("canonical_transfer_id" is not null and "deterministic" = true)),
	CONSTRAINT "transfer_reconciliations_link_requires_target" CHECK ("canonical_transfer_id" is not null or "canonical_transaction_id" is not null or "status" in ('pending', 'needs_review', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_id" uuid NOT NULL,
	"source_raw_record_id" uuid,
	"external_id" text,
	"external_group_id" text,
	"address_id" uuid,
	"blockchain_id" uuid,
	"tx_hash" text,
	"timestamp" timestamp NOT NULL,
	"type" "transfer_type" NOT NULL,
	"from_address" text,
	"to_address" text,
	"from_account_ref" text,
	"to_account_ref" text,
	"from_party_type" text,
	"from_party_resource_path" text,
	"to_party_type" text,
	"to_party_resource_path" text,
	"asset_id" uuid NOT NULL,
	"amount" numeric(100,30) NOT NULL,
	"token_id" text,
	"notes" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_identifier_present" CHECK ("tx_hash" is not null or "external_id" is not null),
	CONSTRAINT "transfers_from_party_present" CHECK ("from_address" is not null or "from_account_ref" is not null),
	CONSTRAINT "transfers_to_party_present" CHECK ("to_address" is not null or "to_account_ref" is not null),
	CONSTRAINT "transfers_tx_hash_requires_onchain_context" CHECK ("tx_hash" is null or ("blockchain_id" is not null and "address_id" is not null and "from_address" is not null and "to_address" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'user'::"user_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "address_idx" ON "addresses" ("address");--> statement-breakpoint
CREATE INDEX "asset_price_asset_id_idx" ON "asset_prices" ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_price_timestamp_idx" ON "asset_prices" ("timestamp");--> statement-breakpoint
CREATE INDEX "asset_price_currency_idx" ON "asset_prices" ("currency");--> statement-breakpoint
CREATE INDEX "asset_symbol_idx" ON "assets" ("symbol");--> statement-breakpoint
CREATE INDEX "idx_cex_account_user_cex" ON "cex_account" ("user_id","cex_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cex_account_user_cex_provider_account_unique" ON "cex_account" ("user_id","cex_id","provider_account_id") WHERE "provider_account_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_disposal_matches_leg_unique" ON "disposal_matches" ("fifo_lot_id","disposal_leg_id");--> statement-breakpoint
CREATE INDEX "idx_disposal_matches_leg" ON "disposal_matches" ("disposal_leg_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_fifo_lots_source_leg" ON "fifo_lots" ("source_leg_id","source_leg_sequence");--> statement-breakpoint
CREATE INDEX "idx_fifo_lots_user_asset_remaining" ON "fifo_lots" ("user_id","asset_id","remaining_amount");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_provider_id_uidx" ON "auth_identities" ("provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_user_provider_uidx" ON "auth_identities" ("user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_jurisdiction_rule_set_rules_set" ON "jurisdiction_rule_set_rules" ("rule_set_id","priority");--> statement-breakpoint
CREATE INDEX "idx_jurisdiction_rule_set_rules_rule" ON "jurisdiction_rule_set_rules" ("rule_id");--> statement-breakpoint
CREATE INDEX "idx_jurisdiction_rule_sets_jurisdiction" ON "jurisdiction_rule_sets" ("jurisdiction_code");--> statement-breakpoint
CREATE INDEX "idx_jurisdiction_rule_sets_active" ON "jurisdiction_rule_sets" ("is_active");--> statement-breakpoint
CREATE INDEX "idx_legal_clauses_source" ON "legal_clauses" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_legal_clauses_randnummer" ON "legal_clauses" ("randnummer");--> statement-breakpoint
CREATE INDEX "idx_legal_rule_citations_rule_order" ON "legal_rule_citations" ("rule_id","citation_order");--> statement-breakpoint
CREATE INDEX "idx_legal_rule_citations_clause" ON "legal_rule_citations" ("clause_id");--> statement-breakpoint
CREATE INDEX "idx_legal_rules_jurisdiction" ON "legal_rules" ("jurisdiction_code");--> statement-breakpoint
CREATE INDEX "idx_legal_rules_active" ON "legal_rules" ("is_active");--> statement-breakpoint
CREATE INDEX "idx_legal_sources_jurisdiction" ON "legal_sources" ("jurisdiction_code");--> statement-breakpoint
CREATE INDEX "idx_legal_sources_effective_from" ON "legal_sources" ("effective_from");--> statement-breakpoint
CREATE INDEX "idx_transaction_type_legal_rules_type" ON "transaction_type_legal_rules" ("transaction_type_key");--> statement-breakpoint
CREATE INDEX "idx_transaction_type_legal_rules_rule" ON "transaction_type_legal_rules" ("rule_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_source_id" ON "processing_jobs" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_user_id" ON "processing_jobs" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_status" ON "processing_jobs" ("status");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_queue_job" ON "processing_jobs" ("queue_name","queue_job_id");--> statement-breakpoint
CREATE INDEX "idx_processing_jobs_heartbeat_at" ON "processing_jobs" ("heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_active_source_unique" ON "processing_jobs" ("source_id") WHERE "status" in ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_queue_job_unique" ON "processing_jobs" ("queue_name","queue_job_id") WHERE "queue_name" is not null and "queue_job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_asset_mappings_provider_asset_row_unique" ON "provider_asset_mappings" ("provider_asset_row_id");--> statement-breakpoint
CREATE INDEX "idx_provider_asset_mappings_status" ON "provider_asset_mappings" ("mapping_status");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_assets_provider_asset_id_unique" ON "provider_assets" ("provider","provider_asset_id") WHERE "provider_asset_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_assets_provider_natural_key_unique" ON "provider_assets" ("provider","natural_key") WHERE "natural_key" is not null;--> statement-breakpoint
CREATE INDEX "idx_provider_assets_provider" ON "provider_assets" ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transaction_type_catalog_provider_type_unique" ON "provider_transaction_type_catalog" ("provider","provider_transaction_type");--> statement-breakpoint
CREATE INDEX "idx_provider_transaction_type_catalog_provider" ON "provider_transaction_type_catalog" ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transaction_type_mappings_provider_type_unique" ON "provider_transaction_type_mappings" ("provider","provider_transaction_type");--> statement-breakpoint
CREATE INDEX "idx_provider_transaction_type_mappings_provider" ON "provider_transaction_type_mappings" ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_transfers_source_external_id_unique_idx" ON "provider_transfers" ("source_id","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_provider_transfers_source_timestamp" ON "provider_transfers" ("source_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_provider_transfers_transaction" ON "provider_transfers" ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_provider_transfers_external_group" ON "provider_transfers" ("source_id","external_group_id");--> statement-breakpoint
CREATE INDEX "idx_provider_transfers_network_hash" ON "provider_transfers" ("network_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "source_records_raw_source_external_unique" ON "source_records_raw" ("source_id","record_type","external_record_id");--> statement-breakpoint
CREATE INDEX "idx_source_records_raw_source_occurred" ON "source_records_raw" ("source_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_source_records_raw_source_normalized" ON "source_records_raw" ("source_id","normalized_at");--> statement-breakpoint
CREATE INDEX "idx_sources_provider_key" ON "sources" ("provider_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_user_address_unique" ON "sources" ("user_id","address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_user_cex_account_unique" ON "sources" ("user_id","cex_account_id");--> statement-breakpoint
CREATE INDEX "idx_source_sync_state_last_synced" ON "source_sync_state" ("last_synced_at");--> statement-breakpoint
CREATE INDEX "idx_sync_run_items_run_id" ON "sync_run_items" ("run_id");--> statement-breakpoint
CREATE INDEX "idx_sync_run_items_source_id" ON "sync_run_items" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_sync_run_items_processing_job_id" ON "sync_run_items" ("processing_job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_run_items_run_source_unique" ON "sync_run_items" ("run_id","source_id");--> statement-breakpoint
CREATE INDEX "idx_sync_runs_user_id" ON "sync_runs" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sync_runs_status" ON "sync_runs" ("status");--> statement-breakpoint
CREATE INDEX "idx_sync_runs_created_at" ON "sync_runs" ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transaction_legs_source_external_unique" ON "transaction_legs" ("source_id","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transaction_legs_unique" ON "transaction_legs" ("tx_hash","address_id","asset_id","kind","source_transfer_id") WHERE "tx_hash" is not null and "address_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transaction_legs_gas_fee_unique" ON "transaction_legs" ("tx_hash","address_id","asset_id") WHERE "tx_hash" is not null AND "address_id" is not null AND "kind" = 'fee' AND "derivation_rule" IN ('gas_fee', 'failed_tx_gas_fee');--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_source" ON "transaction_legs" ("source_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_transaction" ON "transaction_legs" ("transaction_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_address" ON "transaction_legs" ("address_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_user" ON "transaction_legs" ("user_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_asset" ON "transaction_legs" ("asset_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_kind" ON "transaction_legs" ("kind");--> statement-breakpoint
CREATE INDEX "idx_transaction_legs_timestamp" ON "transaction_legs" ("timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_onchain_context_chain_tx_hash_address_unique" ON "transaction_onchain_context" ("blockchain_id","tx_hash","address_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_onchain_context_tx_hash" ON "transaction_onchain_context" ("tx_hash");--> statement-breakpoint
CREATE INDEX "idx_transaction_onchain_context_blockchain_tx_hash" ON "transaction_onchain_context" ("blockchain_id","tx_hash");--> statement-breakpoint
CREATE INDEX "idx_transaction_onchain_context_address" ON "transaction_onchain_context" ("address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_source_external_id_unique_idx" ON "transactions" ("source_id","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_transactions_source_timestamp" ON "transactions" ("source_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_transactions_external_group" ON "transactions" ("source_id","external_group_id");--> statement-breakpoint
CREATE INDEX "idx_transactions_source_provider_type" ON "transactions" ("source_id","provider_transaction_type");--> statement-breakpoint
CREATE INDEX "idx_transactions_source_provider_status" ON "transactions" ("source_id","provider_status");--> statement-breakpoint
CREATE INDEX "idx_transaction_venue_context_cex_account" ON "transaction_venue_context" ("cex_account_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_venue_context_external_account" ON "transaction_venue_context" ("external_account_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_venue_context_order" ON "transaction_venue_context" ("external_order_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_venue_context_fill" ON "transaction_venue_context" ("external_fill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_reconciliations_provider_transfer_unique_idx" ON "transfer_reconciliations" ("provider_transfer_id");--> statement-breakpoint
CREATE INDEX "idx_transfer_reconciliations_user_status" ON "transfer_reconciliations" ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_transfer_reconciliations_canonical_transfer" ON "transfer_reconciliations" ("canonical_transfer_id");--> statement-breakpoint
CREATE INDEX "idx_transfer_reconciliations_canonical_transaction" ON "transfer_reconciliations" ("canonical_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transfers_source_external_unique" ON "transfers" ("source_id","external_id") WHERE "external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_transfers_unique" ON "transfers" ("tx_hash","address_id","type","from_address","to_address","asset_id") WHERE "tx_hash" is not null and "address_id" is not null and "from_address" is not null and "to_address" is not null;--> statement-breakpoint
CREATE INDEX "idx_transfers_source_timestamp" ON "transfers" ("source_id","timestamp");--> statement-breakpoint
CREATE INDEX "idx_transfers_external_group" ON "transfers" ("source_id","external_group_id");--> statement-breakpoint
CREATE INDEX "idx_transfers_source_type" ON "transfers" ("source_id","type");--> statement-breakpoint
CREATE INDEX "idx_transfers_blockchain_tx_hash" ON "transfers" ("blockchain_id","tx_hash");--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "asset_prices" ADD CONSTRAINT "asset_prices_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "cex_account" ADD CONSTRAINT "cex_account_cex_id_cex_id_fkey" FOREIGN KEY ("cex_id") REFERENCES "cex"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cex_account" ADD CONSTRAINT "cex_account_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "disposal_matches" ADD CONSTRAINT "disposal_matches_disposal_leg_id_transaction_legs_id_fkey" FOREIGN KEY ("disposal_leg_id") REFERENCES "transaction_legs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "disposal_matches" ADD CONSTRAINT "disposal_matches_fifo_lot_id_fifo_lots_id_fkey" FOREIGN KEY ("fifo_lot_id") REFERENCES "fifo_lots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "email_verification_requests" ADD CONSTRAINT "email_verification_requests_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id");--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "fifo_lots" ADD CONSTRAINT "fifo_lots_source_leg_id_transaction_legs_id_fkey" FOREIGN KEY ("source_leg_id") REFERENCES "transaction_legs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jurisdiction_rule_set_rules" ADD CONSTRAINT "jurisdiction_rule_set_rules_l8WA6MhMvBx4_fkey" FOREIGN KEY ("rule_set_id") REFERENCES "jurisdiction_rule_sets"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jurisdiction_rule_set_rules" ADD CONSTRAINT "jurisdiction_rule_set_rules_rule_id_legal_rules_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "legal_rules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_clauses" ADD CONSTRAINT "legal_clauses_source_id_legal_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "legal_sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_rule_citations" ADD CONSTRAINT "legal_rule_citations_rule_id_legal_rules_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "legal_rules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "legal_rule_citations" ADD CONSTRAINT "legal_rule_citations_clause_id_legal_clauses_id_fkey" FOREIGN KEY ("clause_id") REFERENCES "legal_clauses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_type_legal_rules" ADD CONSTRAINT "transaction_type_legal_rules_8XfTWuJYmG0D_fkey" FOREIGN KEY ("transaction_type_key") REFERENCES "transaction_types"("type_key") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_type_legal_rules" ADD CONSTRAINT "transaction_type_legal_rules_rule_id_legal_rules_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "legal_rules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_VWjtxlloj6Ae_fkey" FOREIGN KEY ("provider_asset_row_id") REFERENCES "provider_assets"("id");--> statement-breakpoint
ALTER TABLE "provider_asset_mappings" ADD CONSTRAINT "provider_asset_mappings_canonical_asset_id_assets_id_fkey" FOREIGN KEY ("canonical_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "provider_transaction_type_mappings" ADD CONSTRAINT "provider_transaction_type_mappings_shs1ErzDsl7H_fkey" FOREIGN KEY ("transaction_type_key") REFERENCES "transaction_types"("type_key");--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_XA1TFONMDvBX_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_transaction_id_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "provider_transfers" ADD CONSTRAINT "provider_transfers_provider_asset_id_provider_assets_id_fkey" FOREIGN KEY ("provider_asset_id") REFERENCES "provider_assets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_records_raw" ADD CONSTRAINT "source_records_raw_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_address_id_addresses_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_cex_account_id_cex_account_id_fkey" FOREIGN KEY ("cex_account_id") REFERENCES "cex_account"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD CONSTRAINT "source_sync_state_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "source_sync_state" ADD CONSTRAINT "source_sync_state_2VTS0oV0EXbd_fkey" FOREIGN KEY ("checkpoint_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_run_id_sync_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD CONSTRAINT "sync_run_items_processing_job_id_processing_jobs_id_fkey" FOREIGN KEY ("processing_job_id") REFERENCES "processing_jobs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_08IySLTIAriv_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_address_id_addresses_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_transaction_id_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_source_transfer_id_transfers_id_fkey" FOREIGN KEY ("source_transfer_id") REFERENCES "transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_legs" ADD CONSTRAINT "transaction_legs_fee_for_transaction_id_transactions_id_fkey" FOREIGN KEY ("fee_for_transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_onchain_context" ADD CONSTRAINT "transaction_onchain_context_transaction_id_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_onchain_context" ADD CONSTRAINT "transaction_onchain_context_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "transaction_onchain_context" ADD CONSTRAINT "transaction_onchain_context_address_id_addresses_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_onchain_context" ADD CONSTRAINT "transaction_onchain_context_fee_asset_id_assets_id_fkey" FOREIGN KEY ("fee_asset_id") REFERENCES "assets"("id");--> statement-breakpoint
ALTER TABLE "transaction_reviews" ADD CONSTRAINT "transaction_reviews_transaction_id_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_reviews" ADD CONSTRAINT "transaction_reviews_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_raw_record_id_source_records_raw_id_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transaction_type_fk" FOREIGN KEY ("transaction_type") REFERENCES "transaction_types"("type_key");--> statement-breakpoint
ALTER TABLE "transaction_types" ADD CONSTRAINT "transaction_types_category_key_fk" FOREIGN KEY ("category_key") REFERENCES "transaction_categories"("category_key");--> statement-breakpoint
ALTER TABLE "transaction_types" ADD CONSTRAINT "transaction_types_subcategory_key_fk" FOREIGN KEY ("subcategory_key") REFERENCES "transaction_subcategories"("subcategory_key");--> statement-breakpoint
ALTER TABLE "transaction_venue_context" ADD CONSTRAINT "transaction_venue_context_transaction_id_transactions_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transaction_venue_context" ADD CONSTRAINT "transaction_venue_context_cex_account_id_cex_account_id_fkey" FOREIGN KEY ("cex_account_id") REFERENCES "cex_account"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_0LTGRXfYOC6D_fkey" FOREIGN KEY ("provider_transfer_id") REFERENCES "provider_transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_aLMaGGKWBcB8_fkey" FOREIGN KEY ("canonical_transfer_id") REFERENCES "transfers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfer_reconciliations" ADD CONSTRAINT "transfer_reconciliations_np3pcnm4mPC4_fkey" FOREIGN KEY ("canonical_transaction_id") REFERENCES "transactions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_source_raw_record_id_source_records_raw_id_fkey" FOREIGN KEY ("source_raw_record_id") REFERENCES "source_records_raw"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_address_id_addresses_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_blockchain_id_blockchains_id_fkey" FOREIGN KEY ("blockchain_id") REFERENCES "blockchains"("id");--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_asset_id_assets_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id");
