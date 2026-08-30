import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"

export const calculationRunStatusEnum = pgEnum("calculation_run_status", [
  "pending",
  "running",
  "complete",
  "partial",
  "failed",
])

export const calculationRunInventoryScopeEnum = pgEnum("calculation_run_inventory_scope", [
  "per_custody_unit",
  "whole_taxpayer",
])

/** One reproducible invocation of the stateless accounting engine. */
export const calculationRuns = pgTable(
  "calculation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    engineVersion: text("engine_version").notNull(),
    ruleSetVersion: text("rule_set_version").notNull(),
    inputLedgerRevision: text("input_ledger_revision").notNull(),
    valuationRevision: text("valuation_revision").notNull(),
    status: calculationRunStatusEnum("status").notNull().default("pending"),
    accountingMethod: text("accounting_method"),
    inventoryScope: calculationRunInventoryScopeEnum("inventory_scope"),
    appliedChoiceIds: jsonb("applied_choice_ids").$type<ReadonlyArray<string>>().notNull(),
    appliedRules: jsonb("applied_rules").$type<ReadonlyArray<string>>().notNull(),
    processedEventIds: jsonb("processed_event_ids").$type<ReadonlyArray<string>>().notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("calculation_runs_id_principal_unique").on(table.id, table.principalId),
    unique("calculation_runs_id_scope_unique").on(
      table.id,
      table.principalId,
      table.jurisdiction,
      table.taxYear,
      table.reportingCurrency
    ),
    index("idx_calculation_runs_principal_scope_created").on(
      table.principalId,
      table.jurisdiction,
      table.taxYear,
      table.reportingCurrency,
      table.createdAt
    ),
    index("idx_calculation_runs_status").on(table.status),
    check("calculation_runs_tax_year_positive", sql`${table.taxYear} > 0`),
    check(
      "calculation_runs_result_policy_present",
      sql`(${table.status} in ('complete', 'partial') and ${table.accountingMethod} is not null and ${table.inventoryScope} is not null) or (${table.status} not in ('complete', 'partial'))`
    ),
    check(
      "calculation_runs_completion_time_consistent",
      sql`(${table.status} in ('complete', 'partial', 'failed')) = (${table.completedAt} is not null)`
    ),
    check(
      "calculation_runs_failure_consistent",
      sql`(${table.status} = 'failed' and ${table.failureCode} is not null) or (${table.status} <> 'failed' and ${table.failureCode} is null and ${table.failureMessage} is null)`
    ),
  ]
)

/** Active completed result for one principal and calculation scope. */
export const activeCalculationRuns = pgTable(
  "active_calculation_runs",
  {
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    jurisdiction: text("jurisdiction").notNull(),
    taxYear: integer("tax_year").notNull(),
    reportingCurrency: text("reporting_currency").notNull(),
    runId: uuid("run_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.principalId, table.jurisdiction, table.taxYear, table.reportingCurrency],
    }),
    foreignKey({
      columns: [
        table.runId,
        table.principalId,
        table.jurisdiction,
        table.taxYear,
        table.reportingCurrency,
      ],
      foreignColumns: [
        calculationRuns.id,
        calculationRuns.principalId,
        calculationRuns.jurisdiction,
        calculationRuns.taxYear,
        calculationRuns.reportingCurrency,
      ],
      name: "active_calculation_runs_matching_scope_fk",
    }).onDelete("cascade"),
    unique("active_calculation_runs_run_unique").on(table.runId),
  ]
)

export type CalculationRun = typeof calculationRuns.$inferSelect
export type CalculationRunInsert = typeof calculationRuns.$inferInsert
export type ActiveCalculationRun = typeof activeCalculationRuns.$inferSelect
export type ActiveCalculationRunInsert = typeof activeCalculationRuns.$inferInsert
