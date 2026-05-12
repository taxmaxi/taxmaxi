import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { principals } from "./PrincipalsTable.ts"

export const addressTypeEnum = pgEnum("address_type", ["evm", "solana", "bitcoin"])

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull(),
    type: addressTypeEnum("type").notNull(),
    name: text("name").notNull(),
    ensName: text("ens_name"),
    principalId: uuid("principal_id")
      .references(() => principals.id, { onDelete: "cascade" })
      .notNull(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("addresses_principal_address_unique").on(table.address, table.principalId),
    index("address_idx").on(table.address),
  ]
)

export type Address = typeof addresses.$inferSelect
