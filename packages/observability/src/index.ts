/**
 * Shared runtime observability layers for TaxMaxi Node apps.
 *
 * @module
 */

import { FileSystem } from "@effect/platform"
import { NodeFileSystem } from "@effect/platform-node"
import {
  Cause,
  Config,
  Context,
  Effect,
  Array as EffectArray,
  Either,
  FiberRef,
  FiberRefs,
  flow,
  HashMap,
  HashSet,
  Inspectable,
  Layer,
  Logger,
  Option,
  Struct,
  Tracer,
} from "effect"

const LOG_DIR = ".logs"
const LOG_FILE = `${LOG_DIR}/app.log`
const MAX_FILE_SIZE = 10 * 1024 * 1024

/**
 * Recursively convert BigInt values to strings so JSON log serialization is safe.
 */
const convertBigIntToString = (value: unknown, seen?: WeakSet<object>): unknown => {
  if (typeof value === "bigint") {
    return value.toString()
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === "object") {
    const objectValue = value
    const localSeen = seen ?? new WeakSet<object>()
    if (localSeen.has(objectValue)) {
      return "[Circular]"
    }
    localSeen.add(objectValue)

    if (Array.isArray(value)) {
      return value.map((item) => convertBigIntToString(item, localSeen))
    }

    if (value instanceof Error) {
      return value.message
    }

    if (value instanceof Date || value instanceof RegExp) {
      return value
    }

    const output: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[key] = convertBigIntToString(entryValue, localSeen)
    }
    return output
  }

  return value
}

/**
 * Convert OpenTelemetry trace/span ids into Datadog decimal ids.
 */
const withDatadogFormat = (span: Tracer.AnySpan): Tracer.AnySpan => {
  const { spanId, traceId } = span
  const traceIdEnd = traceId.slice(traceId.length / 2)
  return Struct.evolve(span, {
    traceId: () => BigInt(`0x${traceIdEnd}`).toString(),
    spanId: () => BigInt(`0x${spanId}`).toString(),
  })
}

/**
 * Skip anonymous virtual spans added by Effect.fn.
 */
const filterSpan = (span: Option.Option<Tracer.AnySpan>): Option.Option<Tracer.AnySpan> => {
  if (span._tag === "Some") {
    if (span.value._tag === "Span" && span.value.name === "<anonymous>") {
      return filterSpan(span.value.parent)
    }

    return span
  }

  return Option.none()
}

/**
 * Add Datadog trace/span identifiers from the current Effect span to log annotations.
 */
const withDatadogSpanAnnotations = <Message, Output>(
  self: Logger.Logger<Message, Output>
): Logger.Logger<Message, Output> =>
  Logger.mapInputOptions(self, (options: Logger.Logger.Options<Message>) => {
    const span = filterSpan(
      Context.getOption(
        FiberRefs.getOrDefault(options.context, FiberRef.currentContext),
        Tracer.ParentSpan
      )
    )

    if (span._tag === "None") {
      return options
    }

    const { spanId, traceId } = withDatadogFormat(span.value)

    return Struct.evolve(options, {
      annotations: flow(
        HashMap.set("dd.trace_id", traceId as unknown),
        HashMap.set("dd.span_id", spanId as unknown)
      ),
    })
  })

/**
 * Create a one-line JSON log entry compatible with Datadog ingestion.
 */
const formatJsonLogEntry = ({
  logLevel,
  annotations,
  cause,
  message,
  date,
}: Logger.Logger.Options<unknown>): string => {
  const [messages, attributes] = EffectArray.partitionMap(EffectArray.ensure(message), (entry) => {
    if (EffectArray.isArray(entry)) {
      return Either.left(entry.join(" "))
    }

    if (entry instanceof Error) {
      return Either.left(entry.message)
    }

    if (typeof entry === "object" && entry !== null) {
      return Either.right(entry)
    }

    return Either.left(`${entry}`)
  })

  const annotationObject = Object.fromEntries(HashMap.entries(annotations))
  const attributeObject = Object.assign({}, ...attributes)

  const logObject = {
    level: logLevel.label,
    timestamp: date.toISOString(),
    message: messages.join(" ").trim(),
    cause: Cause.isEmpty(cause) ? undefined : Cause.pretty(cause, { renderErrorCause: true }),
    ...annotationObject,
    ...attributeObject,
  }

  return Inspectable.stringifyCircular(convertBigIntToString(logObject))
}

const DatadogJsonLogger = Logger.make(formatJsonLogEntry).pipe(
  withDatadogSpanAnnotations,
  Logger.withConsoleLog
)

const FileJsonLogger = Logger.make(formatJsonLogEntry).pipe(withDatadogSpanAnnotations)

const PrettyDevLogger = Logger.prettyLogger({
  colors: "auto",
  mode: "auto",
}).pipe(withDatadogSpanAnnotations)

const makeConsoleLogger = Effect.gen(function* () {
  const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
  return environment === "development" ? PrettyDevLogger : DatadogJsonLogger
})

const makeFileLogger = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const dirExists = yield* fs.exists(LOG_DIR)
  if (!dirExists) {
    yield* fs.makeDirectory(LOG_DIR, { recursive: true })
  }

  const fileExists = yield* fs.exists(LOG_FILE)
  if (fileExists) {
    const stat = yield* fs.stat(LOG_FILE)
    if (stat.size > MAX_FILE_SIZE) {
      yield* fs.remove(`${LOG_FILE}.old`).pipe(Effect.ignore)
      yield* fs.rename(LOG_FILE, `${LOG_FILE}.old`)
    }
  }

  return yield* Logger.batched(FileJsonLogger, "500 millis", (messages) =>
    fs.writeFileString(LOG_FILE, `${messages.join("\n")}\n`, { flag: "a" }).pipe(Effect.orDie)
  )
})

/**
 * LoggerLive installs pretty console plus file JSON logging in development, and
 * Datadog-compatible one-line JSON logging in non-development environments.
 */
export const LoggerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const consoleLogger = yield* makeConsoleLogger
    const combinedLogger =
      environment === "development"
        ? Logger.zip(consoleLogger, yield* makeFileLogger)
        : consoleLogger

    yield* Effect.locallyScoped(FiberRef.currentLoggers, HashSet.make(combinedLogger))
  })
).pipe(Layer.provide(NodeFileSystem.layer))
