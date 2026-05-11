/**
 * Shared telemetry helpers for source sync API and executor layers.
 *
 * These helpers keep metric names, span naming, and timestamp conversion aligned
 * while source job creation still runs inline before PR-04 moves execution to the worker.
 *
 * @module SourceSyncTelemetry
 */

import { withObservedOperation } from "@my/core/shared/observability/ObservedOperation"
import * as Timestamp from "@my/core/shared/values/Timestamp"
import * as Metric from "effect/Metric"
import type { SourceSyncJobMode } from "../../services/index.ts"

const sourceSyncJobOutcomeMetric = Metric.frequency("taxmaxi_source_sync_job_outcomes", {
  description: "Outcome frequencies for source sync and replay jobs.",
})

const sourceSyncJobDurationMetric = Metric.timer(
  "taxmaxi_source_sync_job_duration",
  "Duration of successful source sync and replay jobs."
)

/**
 * Create a source-sync timestamp using the shared TaxMaxi clock wrapper.
 */
export const nowDate = (): Date => Timestamp.now().toDate()

/**
 * Serialize nullable high-watermark timestamps for logs and progress metadata.
 */
export const highWatermarkToIso = (highWatermark: Date | null): string | null =>
  highWatermark === null ? null : Timestamp.fromDate(highWatermark).toISOString()

/**
 * Wrap one source-sync operation in the shared observed-operation span naming scheme.
 */
export const sourceSyncSpan = ({
  name,
  attributes,
  kind,
}: {
  readonly name: string
  readonly attributes?: Record<string, unknown>
  readonly kind?: "internal" | "server" | "client" | "producer" | "consumer"
}) =>
  withObservedOperation({
    name: `sync-engine.${name}`,
    attributes,
    kind,
  })

/**
 * Record a source-sync job outcome with consistent provider and mode tags.
 */
export const recordSourceSyncJobOutcome = ({
  provider,
  mode,
  outcome,
}: {
  readonly provider: string
  readonly mode: SourceSyncJobMode
  readonly outcome: string
}) =>
  Metric.update(
    sourceSyncJobOutcomeMetric.pipe(
      Metric.tagged("provider", provider),
      Metric.tagged("mode", mode)
    ),
    outcome
  )

/**
 * Track source-sync job duration with consistent provider and mode tags.
 */
export const trackSourceSyncJobDuration = ({
  provider,
  mode,
}: {
  readonly provider: string
  readonly mode: SourceSyncJobMode
}) =>
  Metric.trackDuration(
    sourceSyncJobDurationMetric.pipe(
      Metric.tagged("provider", provider),
      Metric.tagged("mode", mode)
    )
  )
