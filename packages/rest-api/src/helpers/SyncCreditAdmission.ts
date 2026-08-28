/**
 * SyncCreditAdmission - Shared credit-required gate for billable source sync starts.
 *
 * @module SyncCreditAdmission
 */

import type { AuthUserId } from "@my/core/authentication"
import { SyncCreditReasonCode } from "@my/core/billing"
import type { PersistenceError } from "@my/persistence/errors"
import type {
  BillingRepositoryService,
  PrincipalClaimRepositoryService,
} from "@my/persistence/services"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * NoUsableCreditsError - Registered caller has no usable credits for a billable sync.
 */
export class NoUsableCreditsError extends Schema.TaggedError<NoUsableCreditsError>()(
  "NoUsableCreditsError",
  {
    reasonCode: SyncCreditReasonCode,
    availableCredits: Schema.Finite,
  }
) {}

/** Public refusal message shared by every credit-required sync gate. */
export const SYNC_CREDIT_REQUIRED_MESSAGE = "No usable credits available to start a sync."

/**
 * Fail with NoUsableCreditsError unless the caller has usable credits, or the source's
 * records were already paid for anonymously through a consumed x402 receipt claim.
 */
export const assertHasSyncCredits = ({
  billingRepository,
  principalClaimRepository,
  userId,
  sourceId,
}: {
  readonly billingRepository: BillingRepositoryService
  readonly principalClaimRepository: PrincipalClaimRepositoryService
  readonly userId: AuthUserId
  readonly sourceId: string
}): Effect.Effect<void, NoUsableCreditsError | PersistenceError> =>
  Effect.gen(function* () {
    const exemptFromX402Claim =
      yield* principalClaimRepository.hasConsumedX402ReceiptForSource(sourceId)

    if (exemptFromX402Claim) {
      return
    }

    const availableCredits = yield* billingRepository.availableCredits(userId)

    if (availableCredits > 0) {
      return
    }

    return yield* new NoUsableCreditsError({ reasonCode: "no_usable_credits", availableCredits })
  })
