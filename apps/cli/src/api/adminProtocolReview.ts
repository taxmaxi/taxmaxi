import { Effect } from "effect"
import type {
  ProtocolCandidateReviewDetail,
  ProtocolCandidateReviewList,
  TaxMaxiTransactionTypeList,
} from "taxmaxi"
import { CliCommandError } from "../errors.ts"
import { toCliApiError } from "./errors.ts"
import { makeCliTaxMaxiClient } from "./taxmaxi.ts"

type AdminSessionParams = {
  readonly apiUrl: string
  readonly sessionToken: string
}

export const listProtocolCandidates = ({
  apiUrl,
  sessionToken,
}: AdminSessionParams): Effect.Effect<ProtocolCandidateReviewList, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.adminProtocolReview.listProtocolCandidates({
        urlParams: {
          cursor: undefined,
          limit: undefined,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to list protocol candidates."))
  )

export const getProtocolCandidate = ({
  apiUrl,
  candidateId,
  sessionToken,
}: AdminSessionParams & {
  readonly candidateId: string
}): Effect.Effect<ProtocolCandidateReviewDetail, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.adminProtocolReview.getProtocolCandidate({
        path: {
          candidateId,
        },
        urlParams: {
          observationCursor: undefined,
          observationLimit: undefined,
        },
      })
    ),
    Effect.mapError(toCliApiError("Failed to load protocol candidate."))
  )

export const listTaxMaxiTransactionTypes = ({
  apiUrl,
  sessionToken,
}: AdminSessionParams): Effect.Effect<TaxMaxiTransactionTypeList, CliCommandError> =>
  makeCliTaxMaxiClient({ apiUrl, sessionToken }).pipe(
    Effect.flatMap((resolved) =>
      resolved.adminProtocolReview.listTaxMaxiTransactionTypes(undefined)
    ),
    Effect.mapError(toCliApiError("Failed to list TaxMaxi transaction types."))
  )
