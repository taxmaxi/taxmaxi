import {
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
  HttpServerRequest,
} from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import * as Cause from "effect/Cause"
import { createServer } from "node:http"
import {
  SourceSyncRunServiceLive,
  SourceSyncServiceLive,
  TransferReconciliationServiceLive,
} from "@my/sync-engine/layers"
import { AuthLive, PgClientLive, RepositoriesLive } from "@my/persistence/layers"
import {
  AnonSessionServiceLive,
  SessionTokenValidatorLive,
  SIWXProofVerifierLive,
  TaxMaxiApiLive,
  X402PaymentValidatorLive,
} from "@my/rest-api"
import { ApiBullMqSourceSyncQueueLive } from "./layers/ApiBullMqSourceSyncQueueLive.ts"

const port = 4000
const DEFAULT_FRONTEND_URL = "http://localhost:3000"

const SyncRuntimeLive = SourceSyncServiceLive.pipe(
  Layer.provide(ApiBullMqSourceSyncQueueLive),
  Layer.provide(RepositoriesLive)
)

const SyncRunRuntimeLive = SourceSyncRunServiceLive.pipe(
  Layer.provide(SyncRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const TransferReconciliationRuntimeLive = TransferReconciliationServiceLive.pipe(
  Layer.provide(RepositoriesLive)
)

const ApplicationLive = Layer.mergeAll(
  RepositoriesLive,
  SyncRuntimeLive,
  SyncRunRuntimeLive,
  TransferReconciliationRuntimeLive,
  AuthLive
)

const normalizeUrl = (url: string): string => (url.endsWith("/") ? url.slice(0, -1) : url)

const CorsLive = HttpApiBuilder.middleware(
  Effect.gen(function* () {
    const environment = yield* Config.string("ENVIRONMENT").pipe(Config.withDefault("development"))
    const frontendUrl = yield* Config.string("FRONTEND_URL").pipe(
      Config.withDefault(DEFAULT_FRONTEND_URL),
      Config.map(normalizeUrl)
    )

    return HttpMiddleware.cors({
      allowedOrigins: environment === "development" ? [DEFAULT_FRONTEND_URL] : [frontendUrl],
      credentials: true,
      exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    })
  })
)

const RequestFailureLoggingLive = HttpApiBuilder.middleware((httpApp) =>
  httpApp.pipe(
    Effect.tapErrorCause((cause) =>
      Effect.gen(function* () {
        const renderedCause = Cause.pretty(cause, { renderErrorCause: true })
        if (renderedCause.startsWith("SourcePaymentRequiredError:")) {
          return
        }

        const request = yield* HttpServerRequest.HttpServerRequest

        yield* Effect.logError(
          {
            method: request.method,
            url: request.originalUrl,
            cause: renderedCause,
          },
          "HTTP API request failed"
        )
      })
    )
  )
)

const ServerLive = HttpApiBuilder.serve().pipe(
  Layer.provide(CorsLive),
  Layer.provide(RequestFailureLoggingLive),
  Layer.provide(HttpApiSwagger.layer()),
  Layer.provide(HttpApiBuilder.middlewareOpenApi({ path: "/openapi.json" })),
  Layer.provide(TaxMaxiApiLive),
  Layer.provide(AnonSessionServiceLive),
  Layer.provide(SIWXProofVerifierLive),
  Layer.provide(X402PaymentValidatorLive),
  Layer.provide(SessionTokenValidatorLive),
  Layer.provide(ApplicationLive),
  Layer.provide(PgClientLive),
  HttpServer.withLogAddress,
  Layer.provide(NodeHttpServer.layer(createServer, { port }))
)

Layer.launch(ServerLive).pipe(NodeRuntime.runMain)
