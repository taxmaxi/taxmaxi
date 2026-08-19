import { Duration, Effect } from "effect"
import { getSyncJob } from "../api/sources.ts"
import { CliCommandError, mapUnknownToCliCommandError } from "../errors.ts"
import { nowMillis } from "../time.ts"

const JOB_TIMEOUT = Duration.minutes(10)
const JOB_POLL_INTERVAL = Duration.seconds(2)

export type SyncSummary = {
  readonly sourceId: string
  readonly jobId: string
  readonly fetchedRecords: number
  readonly normalizedRecords: number
  readonly failedRecords: number
}

export const getNullableProviderKey = (source: { readonly providerKey: string | null }) =>
  source.providerKey

export const waitForSyncCompletion = ({
  apiUrl,
  sessionToken,
  sourceId,
  jobId,
}: {
  readonly apiUrl: string
  readonly sessionToken: string
  readonly sourceId: string
  readonly jobId: string
}) =>
  Effect.gen(function* () {
    const startedAt = yield* nowMillis

    const poll = (): Effect.Effect<SyncSummary, CliCommandError> =>
      Effect.gen(function* () {
        const job = yield* getSyncJob({ apiUrl, sessionToken, sourceId, jobId }).pipe(
          Effect.mapError(mapUnknownToCliCommandError("Failed to poll sync job."))
        )

        if (job.status === "completed") {
          return {
            sourceId: job.sourceId,
            jobId: job.jobId,
            fetchedRecords: job.fetchedRecords ?? 0,
            normalizedRecords: job.normalizedRecords ?? 0,
            failedRecords: job.failedRecords ?? 0,
          } satisfies SyncSummary
        }

        if (job.status === "failed") {
          return yield* new CliCommandError({ message: job.message ?? "Source sync failed." })
        }

        if (job.status === "credit_required") {
          // The server sends no message for this outcome; the CLI builds its
          // own copy from the structured credit fields.
          const shortfall = job.creditOutcome?.additionalCreditsRequired
          return yield* new CliCommandError({
            message:
              shortfall === null || shortfall === undefined
                ? "Sync paused: add credits, then run sync again to continue."
                : `Sync paused: ${shortfall} more credit${shortfall === 1 ? "" : "s"} needed. Add credits, then run sync again to continue.`,
          })
        }

        const currentTime = yield* nowMillis
        if (currentTime - startedAt > Duration.toMillis(JOB_TIMEOUT)) {
          return yield* new CliCommandError({
            message: "Timed out waiting for source sync job to finish.",
          })
        }

        yield* Effect.sleep(JOB_POLL_INTERVAL)
        return yield* poll()
      })

    return yield* poll()
  })
