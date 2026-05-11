import { index, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core"
import { users } from "./UsersTable.ts"

export const addressTypeEnum = pgEnum("address_type", ["evm", "solana", "bitcoin"])

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull(),
    type: addressTypeEnum("type").notNull(),
    name: text("name").notNull(),
    ensName: text("ens_name"),
    userId: uuid("user_id").references(() => users.id),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [unique().on(table.address, table.userId), index("address_idx").on(table.address)]
)

export type Address = typeof addresses.$inferSelect
