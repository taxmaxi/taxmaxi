/**
 * Source - Container entity for transactions
 *
 * The source represents an onchain wallet or an account on a CEX or DEX.
 *
 * @module source/Source
 */

import * as Schema from "effect/Schema"
import { Timestamp } from "../shared/values/Timestamp.ts"

/**
 * SourceId - Branded UUID string for Source identification
 *
 * Uses Effect's built-in UUID schema with additional branding for type safety.
 */
export const SourceId = Schema.UUID.pipe(
  Schema.brand("SourceId"),
  Schema.annotations({
    identifier: "SourceId",
    title: "Source ID",
    description: "A unique identifier for a workspace (UUID format)",
  })
)

/**
 * The branded SourceId type
 */
export type SourceId = typeof SourceId.Type

/**
 * Type guard for SourceId using Schema.is
 */
export const isSourceId = Schema.is(SourceId)

/**
 * SourceableType - Family of source data we ingest from.
 */
export const SourceableType = Schema.Literal("onchain", "cex", "dex").annotations({
  identifier: "SourceableType",
  title: "Sourceable Type",
  description: "Source family routing for ingestion and normalization",
})

/**
 * The SourceableType type.
 */
export type SourceableType = typeof SourceableType.Type

/**
 * Type guard for SourceableType using Schema.is.
 */
export const isSourceableType = Schema.is(SourceableType)

/**
 * SourceRef - Onchain source linkage.
 */
export class OnchainSourceRef extends Schema.TaggedClass<OnchainSourceRef>()("onchain", {
  addressId: Schema.UUID,
}) {}

/**
 * SourceRef - Centralized exchange source linkage.
 */
export class CexSourceRef extends Schema.TaggedClass<CexSourceRef>()("cex", {
  cexAccountId: Schema.UUID,
}) {}

/**
 * SourceRef - Decentralized exchange source linkage.
 */
export class DexSourceRef extends Schema.TaggedClass<DexSourceRef>()("dex", {
  addressId: Schema.UUID,
}) {}

/**
 * SourceRef - Discriminated linkage to the underlying source owner.
 */
export type SourceRef = OnchainSourceRef | CexSourceRef | DexSourceRef

/**
 * Schema for SourceRef discriminated union.
 */
export const SourceRefSchema = Schema.Union(OnchainSourceRef, CexSourceRef, DexSourceRef)

/**
 * Type guard for SourceRef using Schema.is.
 */
export const isSourceRef = Schema.is(SourceRefSchema)

/**
 * Source - The top-level container entity
 *
 * Represents a source that can belong to a workspace.
 * Contains the transactions used for tax reports
 */
export class Source extends Schema.Class<Source>("Source")({
  /**
   * Unique identifier for the source
   */
  id: SourceId,

  /**
   * User owner identifier for this source
   */
  userId: Schema.UUID,

  /**
   * Display name of the source
   */
  name: Schema.NonEmptyTrimmedString.annotations({
    title: "Source Name",
    description: "The display name of the source",
  }),

  /**
   * Concrete provider key (for example: etherscan, coinbase, bitcoin-rpc)
   */
  providerKey: Schema.NullOr(Schema.NonEmptyTrimmedString).annotations({
    title: "Provider Key",
    description: "Concrete key of the provider",
  }),

  /**
   * Linkage to the source owner model (address or CEX account)
   */
  sourceRef: SourceRefSchema,

  /**
   * When the source was created
   */
  createdAt: Timestamp,
}) {}

/**
 * Type guard for source using Schema.is
 */
export const isSource = Schema.is(Source)
