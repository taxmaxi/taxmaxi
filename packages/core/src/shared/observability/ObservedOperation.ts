/**
 * Shared helpers for consistent Effect-native spans and log annotations.
 *
 * @module shared/observability/ObservedOperation
 */

import * as Effect from "effect/Effect"
import type * as Tracer from "effect/Tracer"

/**
 * Options for wrapping an effect with a stable span name and log annotations.
 */
export interface ObservedOperationOptions {
  readonly name: string
  readonly attributes?: Record<string, unknown> | undefined
  readonly kind?: Tracer.SpanKind | undefined
}

/**
 * Apply the same structured context to logs and tracing for a meaningful
 * operation boundary.
 */
export const withObservedOperation =
  ({ name, attributes, kind }: ObservedOperationOptions) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>> => {
    const spanOptions = {
      ...(attributes === undefined ? {} : { attributes }),
      ...(kind === undefined ? {} : { kind }),
    } satisfies Tracer.SpanOptions

    const withLogs = attributes === undefined ? self : self.pipe(Effect.annotateLogs(attributes))
    return withLogs.pipe(Effect.withSpan(name, spanOptions))
  }
