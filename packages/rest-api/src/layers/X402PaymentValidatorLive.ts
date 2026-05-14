/**
 * X402PaymentValidatorLive - Configured x402 payment validator.
 *
 * @module X402PaymentValidatorLive
 */

import {
  decodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentRequiredHeader,
  HTTPFacilitatorClient,
  type HTTPAdapter,
  type HTTPProcessResult,
  x402HTTPResourceServer,
} from "@x402/core/http"
import { x402ResourceServer } from "@x402/core/server"
import type { Network, PaymentRequired, SettleResponse } from "@x402/core/types"
import { registerExactEvmScheme } from "@x402/evm/exact/server"
import { registerExactSvmScheme } from "@x402/svm/exact/server"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  X402PaymentRequiredError,
  X402PaymentSettlementError,
  X402PaymentValidator,
  type BuildX402PaymentRequiredErrorParams,
  type X402PaymentSettlement,
  type X402PaymentValidatorService,
} from "../services/X402PaymentValidator.ts"

const DEFAULT_SOURCE_CREATION_DESCRIPTION = "TaxMaxi anonymous wallet source creation"
const DEFAULT_SOURCE_CREATION_MIME_TYPE = "application/json"
const DEFAULT_SOURCE_CREATION_PATH = "/v1/sources"
const DEFAULT_SOURCE_CREATION_RESOURCE = "https://api.taxmaxi.com/v1/sources"
const DEFAULT_X402_MAX_TIMEOUT_SECONDS = 120
const X402Network = Schema.TemplateLiteral(Schema.String, ":", Schema.String).pipe(
  Schema.pattern(/^[^:\s]+:[^,\s=]+$/)
)

const requiredTrimmedConfig = (key: string) =>
  Config.string(key).pipe(Config.map((value) => value.trim()))

const x402Config = {
  facilitatorUrl: requiredTrimmedConfig("X402_FACILITATOR_URL"),
  acceptedNetworks: requiredTrimmedConfig("X402_ACCEPTED_NETWORKS"),
  receivingWalletAddress: Config.string("X402_RECEIVING_WALLET_ADDRESS").pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim())
  ),
  receivingWalletAddresses: Config.string("X402_RECEIVING_WALLET_ADDRESSES").pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim())
  ),
  price: requiredTrimmedConfig("X402_SOURCE_CREATION_PRICE"),
  description: Config.string("X402_SOURCE_CREATION_DESCRIPTION").pipe(
    Config.withDefault(DEFAULT_SOURCE_CREATION_DESCRIPTION),
    Config.map((value) => value.trim())
  ),
  resource: Config.string("X402_SOURCE_CREATION_RESOURCE").pipe(
    Config.withDefault(DEFAULT_SOURCE_CREATION_RESOURCE),
    Config.map((value) => value.trim())
  ),
  maxTimeoutSeconds: Config.integer("X402_MAX_TIMEOUT_SECONDS").pipe(
    Config.withDefault(DEFAULT_X402_MAX_TIMEOUT_SECONDS)
  ),
}

const splitNetworks = (
  value: string
): Effect.Effect<ReadonlyArray<Network>, X402PaymentRequiredError> =>
  Effect.forEach(
    value
      .split(",")
      .map((network) => network.trim())
      .filter((network) => network.length > 0),
    (network) =>
      Schema.decodeUnknown(X402Network)(network).pipe(
        Effect.mapError(() =>
          buildPaymentRequiredError({
            message: `Invalid x402 network configuration: ${network}`,
          })
        )
      )
  )

const parseReceivingWalletAddresses = (
  value: string
): Effect.Effect<ReadonlyMap<Network, string>, X402PaymentRequiredError> =>
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const separatorIndex = entry.indexOf("=")
          if (separatorIndex < 1) {
            return Option.none<{ readonly network: string; readonly walletAddress: string }>()
          }

          const network = entry.slice(0, separatorIndex).trim()
          const walletAddress = entry.slice(separatorIndex + 1).trim()
          return network.length === 0 || walletAddress.length === 0
            ? Option.none<{ readonly network: string; readonly walletAddress: string }>()
            : Option.some({ network, walletAddress })
        }),
      (entry) =>
        Option.match(entry, {
          onNone: () =>
            Effect.succeed(
              Option.none<{ readonly network: Network; readonly walletAddress: string }>()
            ),
          onSome: ({ network, walletAddress }) =>
            Schema.decodeUnknown(X402Network)(network).pipe(
              Effect.map((decodedNetwork) =>
                Option.some({ network: decodedNetwork, walletAddress })
              ),
              Effect.mapError(() =>
                buildPaymentRequiredError({
                  message: `Invalid x402 receiving wallet network configuration: ${network}`,
                })
              )
            ),
        })
    )

    return new Map(
      entries
        .flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
        .map((entry): readonly [Network, string] => [entry.network, entry.walletAddress])
    )
  })

const firstHeaderValue = (
  headers: Readonly<Record<string, string>>,
  name: string
): string | undefined => {
  const target = name.toLowerCase()
  return Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1]
}

const makeAdapter = (paymentHeader: string): HTTPAdapter => {
  const headers = {
    "payment-signature": paymentHeader,
    "x-payment": paymentHeader,
    accept: "application/json",
  }

  return {
    getHeader: (name) => firstHeaderValue(headers, name),
    getMethod: () => "POST",
    getPath: () => DEFAULT_SOURCE_CREATION_PATH,
    getUrl: () => DEFAULT_SOURCE_CREATION_RESOURCE,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "taxmaxi-cli",
  }
}

const decodePaymentRequiredFromHeaders = (
  headers: Readonly<Record<string, string>>
): Effect.Effect<PaymentRequired | undefined> => {
  const encoded = firstHeaderValue(headers, "PAYMENT-REQUIRED")
  if (encoded === undefined) {
    return Effect.succeed(undefined)
  }

  return Effect.try({
    try: () => decodePaymentRequiredHeader(encoded),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
}

const decodePaymentRequired = (
  response: Extract<HTTPProcessResult, { readonly type: "payment-error" }>["response"]
): Effect.Effect<PaymentRequired | undefined> => decodePaymentRequiredFromHeaders(response.headers)

const buildPaymentRequiredError = ({
  message,
  paymentRequired,
  paymentRequiredHeader,
}: BuildX402PaymentRequiredErrorParams): X402PaymentRequiredError =>
  new X402PaymentRequiredError({
    message,
    paymentRequired,
    paymentRequiredHeader,
  })

const buildSettlementError = ({
  message,
  paymentRequired,
  paymentRequiredHeader,
}: BuildX402PaymentRequiredErrorParams): X402PaymentSettlementError =>
  new X402PaymentSettlementError({
    message,
    paymentRequired,
    paymentRequiredHeader,
  })

const toPaymentError = (
  response: Extract<HTTPProcessResult, { readonly type: "payment-error" }>["response"]
): Effect.Effect<X402PaymentRequiredError> =>
  Effect.gen(function* () {
    const paymentRequired = yield* decodePaymentRequired(response)
    return buildPaymentRequiredError({
      message: paymentRequired?.error ?? "x402 payment required.",
      paymentRequired,
      paymentRequiredHeader: firstHeaderValue(response.headers, "PAYMENT-REQUIRED"),
    })
  })

const toSettlementError = (result: {
  readonly errorReason: string
  readonly errorMessage?: string | undefined
  readonly response: { readonly headers: Readonly<Record<string, string>> }
}): Effect.Effect<X402PaymentSettlementError> =>
  Effect.gen(function* () {
    const paymentRequiredHeader = firstHeaderValue(result.response.headers, "PAYMENT-REQUIRED")
    const paymentRequired =
      paymentRequiredHeader === undefined
        ? undefined
        : yield* decodePaymentRequiredFromHeaders(result.response.headers)
    return buildSettlementError({
      message: result.errorMessage ?? result.errorReason,
      paymentRequired,
      paymentRequiredHeader,
    })
  })

const receiptValueFromSettlement = (settlement: SettleResponse): string =>
  `${settlement.network}:${settlement.transaction}`

const make = Effect.gen(function* () {
  const facilitatorUrl = yield* x402Config.facilitatorUrl
  const acceptedNetworks = yield* splitNetworks(yield* x402Config.acceptedNetworks)
  const receivingWalletAddress = yield* x402Config.receivingWalletAddress
  const receivingWalletAddresses = yield* parseReceivingWalletAddresses(
    yield* x402Config.receivingWalletAddresses
  )
  const price = yield* x402Config.price
  const description = yield* x402Config.description
  const resource = yield* x402Config.resource
  const maxTimeoutSeconds = yield* x402Config.maxTimeoutSeconds

  if (acceptedNetworks.length === 0) {
    return yield* Effect.dieMessage("X402_ACCEPTED_NETWORKS must contain at least one network.")
  }

  const resolveReceivingWalletAddress = (network: Network) =>
    receivingWalletAddresses.get(network) ?? receivingWalletAddress

  if (acceptedNetworks.some((network) => resolveReceivingWalletAddress(network) === "")) {
    return yield* Effect.dieMessage(
      "Configure X402_RECEIVING_WALLET_ADDRESS or X402_RECEIVING_WALLET_ADDRESSES."
    )
  }

  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  const evmNetworks = acceptedNetworks.filter((network) => network.startsWith("eip155:"))
  const svmNetworks = acceptedNetworks.filter((network) => network.startsWith("solana:"))

  yield* Effect.when(
    Effect.sync(() => {
      registerExactEvmScheme(resourceServer, { networks: [...evmNetworks] })
    }),
    () => evmNetworks.length > 0
  )
  yield* Effect.when(
    Effect.sync(() => {
      registerExactSvmScheme(resourceServer, { networks: [...svmNetworks] })
    }),
    () => svmNetworks.length > 0
  )

  const httpResourceServer = new x402HTTPResourceServer(resourceServer, {
    [`POST ${DEFAULT_SOURCE_CREATION_PATH}`]: {
      accepts: acceptedNetworks.map((network) => ({
        scheme: "exact",
        network,
        payTo: resolveReceivingWalletAddress(network),
        price,
        maxTimeoutSeconds,
      })),
      resource,
      description,
      mimeType: DEFAULT_SOURCE_CREATION_MIME_TYPE,
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: { message: "x402 payment required." },
      }),
    },
  })

  yield* Effect.tryPromise({
    try: () => httpResourceServer.initialize(),
    catch: (cause) => cause,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new X402PaymentRequiredError({
          message:
            cause instanceof Error ? cause.message : "x402 payment validation is not configured.",
        })
    )
  )

  const validateAnonymousSourceCreation: X402PaymentValidatorService["validateAnonymousSourceCreation"] =
    ({ paymentHeader }) =>
      Effect.gen(function* () {
        if (Option.isNone(paymentHeader) || paymentHeader.value.trim() === "") {
          const requirements = yield* Effect.tryPromise({
            try: () =>
              resourceServer
                .buildPaymentRequirementsFromOptions(
                  acceptedNetworks.map((network) => ({
                    scheme: "exact",
                    network,
                    payTo: resolveReceivingWalletAddress(network),
                    price,
                    maxTimeoutSeconds,
                  })),
                  {}
                )
                .then((accepts) =>
                  resourceServer.createPaymentRequiredResponse(
                    accepts,
                    {
                      url: resource,
                      description,
                      mimeType: DEFAULT_SOURCE_CREATION_MIME_TYPE,
                    },
                    "Payment required"
                  )
                ),
            catch: (cause) => cause,
          }).pipe(
            Effect.mapError((cause) =>
              buildPaymentRequiredError({
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Failed to build x402 payment requirements.",
              })
            )
          )
          return yield* Effect.fail(
            buildPaymentRequiredError({
              message: "x402 payment required.",
              paymentRequired: requirements,
              paymentRequiredHeader: encodePaymentRequiredHeader(requirements),
            })
          )
        }

        const processResult = yield* Effect.tryPromise({
          try: () =>
            httpResourceServer.processHTTPRequest({
              adapter: makeAdapter(paymentHeader.value),
              method: "POST",
              path: DEFAULT_SOURCE_CREATION_PATH,
              paymentHeader: paymentHeader.value,
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.mapError((cause) =>
            buildPaymentRequiredError({
              message: cause instanceof Error ? cause.message : "x402 payment verification failed.",
            })
          )
        )

        switch (processResult.type) {
          case "no-payment-required":
            return yield* Effect.fail(
              buildPaymentRequiredError({ message: "x402 payment validation is not configured." })
            )
          case "payment-error":
            return yield* Effect.fail(yield* toPaymentError(processResult.response))
          case "payment-verified":
            return {
              settle: () =>
                Effect.gen(function* () {
                  const settlement = yield* Effect.tryPromise({
                    try: () =>
                      httpResourceServer.processSettlement(
                        processResult.paymentPayload,
                        processResult.paymentRequirements,
                        processResult.declaredExtensions ?? {},
                        {
                          request: {
                            adapter: makeAdapter(paymentHeader.value),
                            method: "POST",
                            path: DEFAULT_SOURCE_CREATION_PATH,
                            paymentHeader: paymentHeader.value,
                          },
                        }
                      ),
                    catch: (cause) => cause,
                  }).pipe(
                    Effect.mapError((cause) =>
                      buildSettlementError({
                        message:
                          cause instanceof Error
                            ? cause.message
                            : "x402 payment settlement failed.",
                      })
                    )
                  )

                  if (!settlement.success) {
                    return yield* Effect.fail(yield* toSettlementError(settlement))
                  }

                  return {
                    receiptValue: receiptValueFromSettlement(settlement),
                    paymentResponseHeader: encodePaymentResponseHeader(settlement),
                    response: settlement,
                  } satisfies X402PaymentSettlement
                }),
            }
        }
      })

  return X402PaymentValidator.of({
    validateAnonymousSourceCreation,
  } satisfies X402PaymentValidatorService)
})

/**
 * X402PaymentValidatorLive - Live x402 validator layer.
 */
export const X402PaymentValidatorLive = Layer.effect(X402PaymentValidator, make)
