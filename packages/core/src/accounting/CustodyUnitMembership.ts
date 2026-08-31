/**
 * Factual source membership in an accounting custody unit.
 *
 * @module accounting/CustodyUnitMembership
 */

import * as Schema from "effect/Schema"
import { SourceId } from "../source/Source.ts"
import { CustodyUnitId } from "./AccountingChoice.ts"

/** One recorded source-to-custody-unit assignment consumed by the accounting engine. */
export const CustodyUnitMembership = Schema.Struct({
  sourceId: SourceId,
  custodyUnitId: CustodyUnitId,
}).annotate({
  identifier: "CustodyUnitMembership",
  title: "Custody Unit Membership",
  description: "Recorded source membership used to resolve derived accounting inventory",
})

/** The CustodyUnitMembership type. */
export type CustodyUnitMembership = typeof CustodyUnitMembership.Type
