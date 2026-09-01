/**
 * ProcessingJobConflict - Helpers for classifying processing job insert races.
 *
 * @module ProcessingJobConflict
 */

import { databaseErrorMetadata } from "./DatabaseErrorMetadata.ts"

const ACTIVE_PROCESSING_JOB_CONSTRAINT = "processing_jobs_active_source_unique"

/**
 * Detect the uniqueness violation raised when another active processing job
 * was inserted concurrently.
 */
export const isActiveProcessingJobConflict = (error: unknown): boolean =>
  databaseErrorMetadata(error)?.code === "23505" &&
  databaseErrorMetadata(error)?.constraint === ACTIVE_PROCESSING_JOB_CONSTRAINT
