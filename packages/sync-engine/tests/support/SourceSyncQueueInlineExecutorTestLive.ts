/**
 * SourceSyncQueueInlineExecutorTestLive - Test queue layer for integration suites.
 *
 * @module SourceSyncQueueInlineExecutorTestLive
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  SourceSyncJobExecutor,
  SourceSyncQueue,
  SourceSyncQueueError,
} from "../../src/services/index.ts"

/**
 * SourceSyncQueueInlineExecutorTestLive - Test queue that executes jobs immediately.
 *
 * Executor failures stay in the persisted job summary in normal sync failure
 * paths; this layer maps only the executor error channel into queue errors.
 */
export const SourceSyncQueueInlineExecutorTestLive = Layer.effect(
  SourceSyncQueue,
  Effect.gen(function* () {
    const sourceSyncJobExecutor = yield* SourceSyncJobExecutor

    return SourceSyncQueue.of({
      enqueueSourceSyncJob: (payload) =>
        // Fire-and-forget enqueue succeeds when execution records its own failed summary.
        sourceSyncJobExecutor.execute({ jobId: payload.jobId }).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new SourceSyncQueueError({
                operation: "test.enqueueSourceSyncJob",
                cause,
              })
          )
        ),
    })
  })
)
