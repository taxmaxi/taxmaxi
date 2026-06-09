import { Effect } from "effect"

export const nowIsoString = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => new Date(Number(currentTimeMillis)).toISOString()
)

export const nowMillis = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => Number(currentTimeMillis)
)
