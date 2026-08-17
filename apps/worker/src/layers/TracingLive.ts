/**
 * OpenTelemetry tracing for the worker process.
 *
 * @module TracingLive
 */

import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, Effect, Layer, Schema } from "effect"

const DEFAULT_SERVICE_NAME = "taxmaxi-worker"
const DEFAULT_SERVICE_VERSION = "0.0.0"
const DEFAULT_ENVIRONMENT = "development"

class TracingConfigError extends Schema.TaggedError<TracingConfigError>()("TracingConfigError", {
  field: Schema.String,
  value: Schema.String,
  cause: Schema.Unknown,
}) {}

const trimmedStringConfig = (name: string) =>
  Config.string(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim())
  )

const firstNonEmpty = (...values: ReadonlyArray<string>): string | undefined =>
  values.find((value) => value !== "")

const parseEndpoint = (value: string): Effect.Effect<URL | null, TracingConfigError> => {
  if (value === "") {
    return Effect.succeed(null)
  }

  return Effect.try({
    try: () => new URL(value),
    catch: (cause) =>
      new TracingConfigError({
        field: "OTEL_EXPORTER_OTLP_ENDPOINT",
        value,
        cause,
      }),
  })
}

const tracingConfig = Effect.gen(function* () {
  const endpoint = yield* trimmedStringConfig("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(
    Effect.flatMap(parseEndpoint)
  )
  const configuredServiceName = yield* trimmedStringConfig("OTEL_SERVICE_NAME")
  const configuredServiceVersion = yield* trimmedStringConfig("OTEL_SERVICE_VERSION")
  const appVersion = yield* trimmedStringConfig("APP_VERSION")
  const configuredEnvironment = yield* trimmedStringConfig("ENVIRONMENT")

  return {
    endpoint,
    serviceName: firstNonEmpty(configuredServiceName) ?? DEFAULT_SERVICE_NAME,
    serviceVersion: firstNonEmpty(configuredServiceVersion, appVersion) ?? DEFAULT_SERVICE_VERSION,
    environment: firstNonEmpty(configuredEnvironment) ?? DEFAULT_ENVIRONMENT,
  }
})

/**
 * TracingLive installs Effect's OpenTelemetry tracer when an OTLP traces
 * endpoint is configured. Without an endpoint, tracing stays disabled so local
 * development does not try to export spans.
 */
export const TracingLive = Layer.unwrap(
  Effect.map(tracingConfig, ({ endpoint, serviceName, serviceVersion, environment }) => {
    if (endpoint === null) {
      return Layer.empty
    }

    return NodeSdk.layer(() => ({
      resource: {
        serviceName,
        serviceVersion,
        attributes: {
          "deployment.environment": environment,
        },
      },
      spanProcessor: new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: endpoint.toString(),
        })
      ),
      shutdownTimeout: "5 seconds",
    }))
  })
)
