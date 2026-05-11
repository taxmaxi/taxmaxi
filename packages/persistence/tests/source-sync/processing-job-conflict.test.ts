import { describe, expect, it } from "vitest"
import { isActiveProcessingJobConflict } from "../../src/errors/ProcessingJobConflict.ts"
import { PersistenceError } from "../../src/errors/RepositoryError.ts"
import { SyncEngineStorageError } from "@my/sync-engine/services"

describe("processing job conflict detection", () => {
  it("detects active-job uniqueness conflicts through wrapped persistence errors", () => {
    expect(
      isActiveProcessingJobConflict(
        new PersistenceError({
          operation: "sourceSyncService.createProcessingJob",
          cause: {
            code: "23505",
            constraint: "processing_jobs_active_source_unique",
          },
        })
      )
    ).toBe(true)

    expect(
      isActiveProcessingJobConflict(
        new PersistenceError({
          operation: "sourceSyncService.createProcessingJob",
          cause: { code: "22001", message: "value too long" },
        })
      )
    ).toBe(false)
  })

  it("detects the active-job constraint through additional error wrappers", () => {
    expect(
      isActiveProcessingJobConflict(
        new SyncEngineStorageError({
          operation: "sourceSyncJobRepository.createOrReuseJob",
          cause: new PersistenceError({
            operation: "sourceSyncJobRepository.createProcessingJob.insert",
            cause: {
              code: "23505",
              constraint: "processing_jobs_active_source_unique",
            },
          }),
        })
      )
    ).toBe(true)

    expect(
      isActiveProcessingJobConflict(
        new PersistenceError({
          operation: "sourceSyncJobRepository.createProcessingJob.insert",
          cause: {
            code: "23505",
            constraint: "processing_jobs_queue_job_unique",
          },
        })
      )
    ).toBe(false)
  })
})
