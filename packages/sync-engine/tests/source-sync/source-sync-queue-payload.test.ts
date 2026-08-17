import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { SourceSyncQueuePayload } from "@my/sync-engine/services"

describe("SourceSyncQueuePayload", () => {
  it("decodes valid payloads and rejects missing or invalid mode", () => {
    const decodePayload = Schema.decodeUnknownExit(SourceSyncQueuePayload)

    expect(
      Exit.isSuccess(
        decodePayload({
          jobId: "job-1",
          sourceId: "source-1",
          principalId: "principal-1",
          mode: "sync",
        })
      )
    ).toBe(true)
    expect(
      Exit.isSuccess(
        decodePayload({
          jobId: "job-1",
          sourceId: "source-1",
          principalId: "principal-1",
        })
      )
    ).toBe(false)
    expect(
      Exit.isSuccess(
        decodePayload({
          jobId: "job-1",
          sourceId: "source-1",
          principalId: "principal-1",
          mode: "full",
        })
      )
    ).toBe(false)
  })
})
