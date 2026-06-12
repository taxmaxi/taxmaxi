import { Console, Effect } from "effect"
import { createOnchainSource } from "../api/sources.ts"
import { CliCommandError } from "../errors.ts"
import { printJson } from "../io/json.ts"
import { readSession } from "../session.ts"
import { getNullableProviderKey, waitForSyncCompletion } from "./sourceSync.ts"

export const syncOnchainSourceProgram = ({
  walletAddress,
  json,
}: {
  readonly walletAddress: string
  readonly json: boolean
}) =>
  Effect.gen(function* () {
    const session = yield* readSession()
    const created = yield* createOnchainSource({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      walletAddress,
    })
    const syncJob = created.syncJob

    if (syncJob === null) {
      return yield* new CliCommandError({
        message: "Onchain source was created, but no sync job was returned.",
      })
    }

    const summary = yield* waitForSyncCompletion({
      apiUrl: session.apiUrl,
      sessionToken: session.sessionToken,
      sourceId: syncJob.sourceId,
      jobId: syncJob.jobId,
    })

    const providerKey = getNullableProviderKey(created.source)

    if (json) {
      yield* printJson({
        stage: "onchain_sync_completed",
        providerKey,
        created: created.created,
        ...summary,
      })
      return
    }

    yield* Console.log("Onchain source sync completed.")
    yield* Console.log(`Source: ${created.source.id}`)
    if (providerKey !== null) {
      yield* Console.log(`Provider: ${providerKey}`)
    }
    yield* Console.log(`Imported: ${summary.importedRecords}`)
    yield* Console.log(`Normalized: ${summary.normalizedRecords}`)
    yield* Console.log(`Failed: ${summary.failedRecords}`)
  })
