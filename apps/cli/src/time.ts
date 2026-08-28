import { DateTime, Effect } from "effect"

export const nowIsoString = DateTime.now.pipe(Effect.map(DateTime.formatIso))

export const nowMillis = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (currentTimeMillis) => Number(currentTimeMillis)
)
