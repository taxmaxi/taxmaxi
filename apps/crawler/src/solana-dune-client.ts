/**
 * Dune API client contract for executing saved Solana queries.
 *
 * @module
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type {
  SolanaDuneQueryConfig,
  SolanaDuneRecordedExecution,
} from "@my/sync-engine/providers/helius-solana"

export class SolanaDuneError extends Schema.TaggedError<SolanaDuneError>()("SolanaDuneError", {
  message: Schema.String,
  queryId: Schema.optional(Schema.Number),
}) {}

export interface ExecuteSolanaDuneQueryParams {
  readonly query: SolanaDuneQueryConfig
  readonly parameters: Readonly<Record<string, string>>
}

export interface SolanaDuneClientShape {
  readonly executeQuery: (
    params: ExecuteSolanaDuneQueryParams
  ) => Effect.Effect<unknown, SolanaDuneError>
}

export class SolanaDuneClient extends Context.Tag("SolanaDuneClient")<
  SolanaDuneClient,
  SolanaDuneClientShape
>() {}

/** Test layer for injecting deterministic Dune query responses. */
export const SolanaDuneClientTestLive = (
  client: SolanaDuneClientShape
): Layer.Layer<SolanaDuneClient> => Layer.succeed(SolanaDuneClient, client)

/** Stable lookup key for one recorded execution: query id plus sorted parameters. */
export const recordedExecutionKey = ({
  queryId,
  parameters,
}: {
  readonly queryId: number
  readonly parameters: Readonly<Record<string, string>>
}): string =>
  `${queryId}:${Object.entries(parameters)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")}`

/**
 * Client that serves recorded executions from a rankings file instead of
 * calling the Dune API. Timed-out recordings replay as timeout failures so the
 * window-halving decisions of the original crawl are reproduced exactly.
 */
export const solanaDuneClientFromRecordedExecutions = (
  executions: ReadonlyArray<SolanaDuneRecordedExecution>
): SolanaDuneClientShape => {
  const executionsByKey = new Map(
    executions.map((execution) => [recordedExecutionKey(execution), execution])
  )

  return {
    executeQuery: ({ query, parameters }) => {
      const recorded = executionsByKey.get(
        recordedExecutionKey({ queryId: query.queryId, parameters })
      )

      if (recorded === undefined) {
        return Effect.fail(
          new SolanaDuneError({
            queryId: query.queryId,
            message: `No recorded Dune execution for query ${query.queryId} with parameters ${JSON.stringify(
              parameters
            )}; a replay must use the file's original date range and window settings`,
          })
        )
      }

      if (recorded.status === "timed_out") {
        return Effect.fail(
          new SolanaDuneError({
            queryId: query.queryId,
            message:
              "Recorded Dune execution ended with QUERY_STATE_FAILED: FAILED_TYPE_EXECUTION_TIMEOUT",
          })
        )
      }

      return Effect.succeed(recorded.response)
    },
  }
}
