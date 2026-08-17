/**
 * Shared runtime observability layers for TaxMaxi Node apps.
 *
 * @module
 */

import { NodeFileSystem } from "@effect/platform-node"
import {
  Cause,
  Config,
  Effect,
  Array as EffectArray,
  FileSystem,
  Formatter,
  Layer,
  Logger,
  Option,
  References,
  Tracer,
} from "effect"

const LOG_DIR = ".logs"
const LOG_FILE = `${LOG_DIR}/app.log`
const MAX_FILE_SIZE = FileSystem.MiB(10)

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
const toDatadogSpanIds = (
  span: Tracer.AnySpan
): { readonly spanId: string; readonly traceId: string } => {
  const { spanId, traceId } = span
  const traceIdEnd = traceId.slice(traceId.length / 2)
  return {
    traceId: BigInt(`0x${traceIdEnd}`).toString(),
    spanId: BigInt(`0x${spanId}`).toString(),
  }
}

/**
 * Skip anonymous virtual spans added by Effect.fn.
 */
const filterSpan = (span: Tracer.AnySpan | undefined): Tracer.AnySpan | undefined => {
  if (span?._tag === "Span" && span.name === "<anonymous>") {
    return filterSpan(Option.getOrUndefined(span.parent))
  }

  return span
}

/**
 * Read Datadog trace/span identifiers from the current Effect span.
 */
const getDatadogSpanAnnotations = (
  span: Tracer.AnySpan | undefined
): Readonly<Record<string, string>> => {
  const currentSpan = filterSpan(span)
  if (currentSpan === undefined) {
    return {}
  }

  const { spanId, traceId } = toDatadogSpanIds(currentSpan)
  return {
    "dd.trace_id": traceId,
    "dd.span_id": spanId,
  }
}

/**
 * Create a one-line JSON log entry compatible with Datadog ingestion.
 */
const formatJsonLogEntry = ({
  logLevel,
  cause,
  message,
  date,
  fiber,
}: Logger.Options<unknown>): string => {
  const messages: Array<string> = []
  const attributes: Array<object> = []

  for (const entry of EffectArray.ensure(message)) {
    if (EffectArray.isArray(entry)) {
      messages.push(entry.join(" "))
      continue
    }

    if (entry instanceof Error) {
      messages.push(entry.message)
      continue
    }

    if (typeof entry === "object" && entry !== null) {
      attributes.push(entry)
      continue
    }

    messages.push(String(entry))
  }

  const annotationObject = fiber.getRef(References.CurrentLogAnnotations)
  const spanAnnotations = getDatadogSpanAnnotations(fiber.currentSpan)
  const attributeObject = Object.assign({}, ...attributes)

  const logObject = {
    level: logLevel.toUpperCase(),
    timestamp: date.toISOString(),
    message: messages.join(" ").trim(),
    cause: cause.reasons.length === 0 ? undefined : Cause.pretty(cause),
    ...annotationObject,
    ...spanAnnotations,
    ...attributeObject,
  }

  return Formatter.formatJson(convertBigIntToString(logObject))
}

const DatadogJsonLogger = Logger.make(formatJsonLogEntry).pipe(Logger.withConsoleLog)

const FileJsonLogger = Logger.make(formatJsonLogEntry)

const PrettyDevLogger = Logger.consolePretty({
  colors: "auto",
  mode: "auto",
})

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

  return yield* Logger.batched(FileJsonLogger, {
    window: "500 millis",
    flush: (messages) =>
      fs.writeFileString(LOG_FILE, `${messages.join("\n")}\n`, { flag: "a" }).pipe(Effect.orDie),
  })
})

const combineLoggers = (
  first: Logger.Logger<unknown, void>,
  second: Logger.Logger<unknown, void>
): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    first.log(options)
    second.log(options)
  })

/**
 * LoggerLive installs pretty console plus file JSON logging in development, and
 * Datadog-compatible one-line JSON logging in non-development environments.
 */
export const LoggerLive = Logger.layer([
  Effect.gen(function* () {
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const consoleLogger = yield* makeConsoleLogger
    if (environment !== "development") {
      return consoleLogger
    }

    return combineLoggers(consoleLogger, yield* makeFileLogger)
  }),
]).pipe(Layer.provide(NodeFileSystem.layer))
