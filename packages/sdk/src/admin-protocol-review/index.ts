import type {
  ProtocolCandidateReviewDetailResponse,
  ProtocolCandidateReviewListResponse,
  TaxMaxiTransactionTypeListResponse,
} from "@my/rest-api/contracts"
import * as Effect from "effect/Effect"
import type { TaxMaxiEffectClient } from "../client.ts"

export type ProtocolCandidateReview = ProtocolCandidateReviewListResponse["candidates"][number]
export type ProtocolCandidateReviewList = ProtocolCandidateReviewListResponse
export type ProtocolCandidateReviewDetail = ProtocolCandidateReviewDetailResponse
export type TaxMaxiTransactionTypeList = TaxMaxiTransactionTypeListResponse

export type ProtocolCandidateReviewListInput = {
  readonly limit?: number
}

export type ProtocolCandidateReviewDetailInput = {
  readonly candidateId: string
}

export type AdminProtocolReviewEffectResource = {
  readonly listProtocolCandidates: (
    input?: ProtocolCandidateReviewListInput
  ) => Effect.Effect<ProtocolCandidateReviewList, unknown, never>
  readonly getProtocolCandidate: (
    input: ProtocolCandidateReviewDetailInput
  ) => Effect.Effect<ProtocolCandidateReviewDetail, unknown, never>
  readonly listTaxMaxiTransactionTypes: () => Effect.Effect<
    TaxMaxiTransactionTypeList,
    unknown,
    never
  >
}

export type AdminProtocolReviewPromiseResource = {
  readonly listProtocolCandidates: (
    input?: ProtocolCandidateReviewListInput
  ) => Promise<ProtocolCandidateReviewList>
  readonly getProtocolCandidate: (
    input: ProtocolCandidateReviewDetailInput
  ) => Promise<ProtocolCandidateReviewDetail>
  readonly listTaxMaxiTransactionTypes: () => Promise<TaxMaxiTransactionTypeList>
}

export const makeAdminProtocolReviewEffectResource = (
  client: Effect.Effect<TaxMaxiEffectClient, never>
): AdminProtocolReviewEffectResource => ({
  listProtocolCandidates: (input) =>
    Effect.flatMap(client, (resolved) =>
      resolved.adminProtocolReview.listProtocolCandidates({
        urlParams: {
          limit: input?.limit,
        },
      })
    ),
  getProtocolCandidate: ({ candidateId }) =>
    Effect.flatMap(client, (resolved) =>
      resolved.adminProtocolReview.getProtocolCandidate({
        path: {
          candidateId,
        },
      })
    ),
  listTaxMaxiTransactionTypes: () =>
    Effect.flatMap(client, (resolved) =>
      resolved.adminProtocolReview.listTaxMaxiTransactionTypes(undefined)
    ),
})

export const makeAdminProtocolReviewPromiseResource = (
  effect: AdminProtocolReviewEffectResource,
  run: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
): AdminProtocolReviewPromiseResource => ({
  listProtocolCandidates: (input) => run(effect.listProtocolCandidates(input)),
  getProtocolCandidate: (input) => run(effect.getProtocolCandidate(input)),
  listTaxMaxiTransactionTypes: () => run(effect.listTaxMaxiTransactionTypes()),
})
