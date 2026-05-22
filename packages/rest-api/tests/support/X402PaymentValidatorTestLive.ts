import type { PaymentRequired, SettleResponse } from "@x402/core/types"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import {
  X402PaymentRequiredError,
  X402PaymentSettlementError,
  X402PaymentValidator,
  type X402PaymentValidatorService,
} from "../../src/services/X402PaymentValidator.ts"

const TEST_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
const TEST_RECEIVING_WALLET = "TaxMaxiTest111111111111111111111111111111111"
export const TEST_PAYER_WALLET = "Payer111111111111111111111111111111111111"

const paymentRequired = (message: string): PaymentRequired => ({
  x402Version: 2,
  error: message,
  resource: {
    url: "https://api.taxmaxi.test/v1/sources",
    description: "TaxMaxi test source creation",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: TEST_NETWORK,
      asset: "USDC",
      amount: "100000",
      payTo: TEST_RECEIVING_WALLET,
      maxTimeoutSeconds: 120,
      extra: {},
    },
  ],
})

export const makeX402PaymentValidatorTestLive = ({
  failSettlement = false,
  onSettle,
  validPaymentHeader,
}: {
  readonly failSettlement?: boolean | undefined
  readonly onSettle?: ((paymentHeader: string) => void) | undefined
  readonly validPaymentHeader: string
}) =>
  Layer.sync(X402PaymentValidator, () => {
    let settlementCount = 0

    return X402PaymentValidator.of({
      validateAnonymousSourceCreation: ({ paymentHeader }) =>
        Effect.gen(function* () {
          if (Option.isNone(paymentHeader) || paymentHeader.value !== validPaymentHeader) {
            return yield* Effect.fail(
              new X402PaymentRequiredError({
                message: "x402 payment required.",
                paymentRequired: paymentRequired("Payment required"),
                paymentRequiredHeader: "encoded-test-payment-requirements",
              })
            )
          }

          return {
            settle: () =>
              Effect.gen(function* () {
                yield* Effect.sync(() => {
                  onSettle?.(paymentHeader.value)
                })

                if (failSettlement) {
                  return yield* Effect.fail(
                    new X402PaymentSettlementError({
                      message: "x402 payment settlement failed.",
                      paymentRequired: paymentRequired("Settlement failed"),
                      paymentRequiredHeader: "encoded-test-settlement-failure",
                    })
                  )
                }

                settlementCount += 1
                const transaction = `test-settlement-${paymentHeader.value}-${settlementCount}`
                return {
                  receiptValue: `${TEST_NETWORK}:${transaction}`,
                  paymentResponseHeader: "encoded-test-payment-response",
                  response: {
                    success: true,
                    transaction,
                    network: TEST_NETWORK,
                    payer: TEST_PAYER_WALLET,
                    amount: "100000",
                  } satisfies SettleResponse,
                  payerChainType: "solana",
                  payerWalletAddress: TEST_PAYER_WALLET,
                }
              }),
          }
        }),
    } satisfies X402PaymentValidatorService)
  })
