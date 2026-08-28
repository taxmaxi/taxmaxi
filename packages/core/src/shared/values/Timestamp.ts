/**
 * Timestamp - UTC timestamp value object
 *
 * A Schema wrapper around Effect's DateTime.Utc for representing UTC timestamps.
 * Encodes to/from ISO 8601 datetime strings.
 *
 * @module shared/values/Timestamp
 */

import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import { LocalDate } from "./LocalDate.ts"

/**
 * Timestamp - A Schema.Class wrapping DateTime.Utc for UTC timestamps
 *
 * Stores the epoch milliseconds internally.
 * Encoded as ISO 8601 datetime string.
 */
export class Timestamp extends Schema.Class<Timestamp>("Timestamp")({
  epochMillis: Schema.Finite.pipe(Schema.check(Schema.isInt())),
}) {
  /**
   * Get the underlying DateTime.Utc instance
   */
  toDateTime(): DateTime.Utc {
    return DateTime.makeUnsafe(this.epochMillis)
  }

  /**
   * Convert to JavaScript Date
   */
  toDate(): Date {
    return DateTime.toDateUtc(this.toDateTime())
  }

  /**
   * Convert to ISO 8601 string
   */
  toISOString(): string {
    return DateTime.formatIso(this.toDateTime())
  }

  /**
   * Convert to string representation
   */
  override toString(): string {
    return this.toISOString()
  }

  /**
   * Extract the LocalDate portion (UTC date)
   */
  toLocalDate(): LocalDate {
    const parts = DateTime.toPartsUtc(this.toDateTime())
    return LocalDate.make({
      year: parts.year,
      month: parts.month,
      day: parts.day,
    })
  }
}

/**
 * Type guard for Timestamp using Schema.is
 */
export const isTimestamp = Schema.is(Timestamp)

/**
 * Create a Timestamp from a DateTime.Utc
 */
export const fromDateTime = (dateTime: DateTime.Utc): Timestamp => {
  return Timestamp.make({ epochMillis: dateTime.epochMilliseconds })
}

/**
 * Create a Timestamp from a JavaScript Date
 */
export const fromDate = (date: Date): Timestamp => {
  return Timestamp.make({ epochMillis: date.getTime() })
}

/**
 * Create a Timestamp from an ISO 8601 string
 * Returns an Effect that may fail with SchemaError
 */
export const fromString = (dateString: string): Effect.Effect<Timestamp, Schema.SchemaError> => {
  return Option.match(DateTime.make(dateString), {
    onNone: () =>
      Effect.fail(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue(
            { message: `Invalid ISO 8601 datetime: "${dateString}"` },
            dateString,
            { reportInput: true }
          )
        )
      ),
    onSome: (dateTime) => Effect.succeed(fromDateTime(dateTime)),
  })
}

/**
 * Get the current timestamp (now)
 */
export const now = (): Timestamp => {
  return fromDateTime(DateTime.nowUnsafe())
}

/**
 * Get the current timestamp as an Effect using the Clock service
 */
export const nowEffect: Effect.Effect<Timestamp> = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (millis) => Timestamp.make({ epochMillis: Number(millis) })
)

/**
 * Order for Timestamp - compares chronologically
 */
export const OrderTimestamp: Order.Order<Timestamp> = Order.make((a, b) => {
  if (a.epochMillis < b.epochMillis) return -1
  if (a.epochMillis > b.epochMillis) return 1
  return 0
})

/**
 * Check if first timestamp is before second
 */
export const isBefore = (a: Timestamp, b: Timestamp): boolean => {
  return a.epochMillis < b.epochMillis
}

/**
 * Check if first timestamp is after second
 */
export const isAfter = (a: Timestamp, b: Timestamp): boolean => {
  return a.epochMillis > b.epochMillis
}

/**
 * Check if two timestamps are equal
 */
export const equals = (a: Timestamp, b: Timestamp): boolean => {
  return a.epochMillis === b.epochMillis
}

/**
 * Add milliseconds to a timestamp
 */
export const addMillis = (timestamp: Timestamp, millis: number): Timestamp => {
  return Timestamp.make({ epochMillis: timestamp.epochMillis + millis })
}

/**
 * Add seconds to a timestamp
 */
export const addSeconds = (timestamp: Timestamp, seconds: number): Timestamp => {
  return addMillis(timestamp, seconds * 1000)
}

/**
 * Add minutes to a timestamp
 */
export const addMinutes = (timestamp: Timestamp, minutes: number): Timestamp => {
  return addMillis(timestamp, minutes * 60 * 1000)
}

/**
 * Add hours to a timestamp
 */
export const addHours = (timestamp: Timestamp, hours: number): Timestamp => {
  return addMillis(timestamp, hours * 60 * 60 * 1000)
}

/**
 * Add days to a timestamp
 */
export const addDays = (timestamp: Timestamp, days: number): Timestamp => {
  return addMillis(timestamp, days * 24 * 60 * 60 * 1000)
}

/**
 * Get the difference in milliseconds between two timestamps
 */
export const diffInMillis = (a: Timestamp, b: Timestamp): number => {
  return a.epochMillis - b.epochMillis
}

/**
 * Get the difference in seconds between two timestamps
 */
export const diffInSeconds = (a: Timestamp, b: Timestamp): number => {
  return Math.floor(diffInMillis(a, b) / 1000)
}

/**
 * Get the minimum of two timestamps
 */
export const min = (a: Timestamp, b: Timestamp): Timestamp => {
  return a.epochMillis <= b.epochMillis ? a : b
}

/**
 * Get the maximum of two timestamps
 */
export const max = (a: Timestamp, b: Timestamp): Timestamp => {
  return a.epochMillis >= b.epochMillis ? a : b
}

/**
 * Return the later of two nullable Dates, or null when both are null.
 *
 * Useful for advancing high-watermark cursors in sync pipelines where
 * database timestamps are represented as `Date | null`.
 */
export const maxNullableDate = (left: Date | null, right: Date | null): Date | null => {
  if (left === null) return right
  if (right === null) return left
  return max(fromDate(left), fromDate(right)).toDate()
}

/**
 * Unix epoch timestamp (1970-01-01T00:00:00.000Z)
 */
export const EPOCH: Timestamp = Timestamp.make({ epochMillis: 0 })
