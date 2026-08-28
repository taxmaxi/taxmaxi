import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { LoggerLive } from "@my/observability"
import { PgClientLive, RepositoriesLive } from "@my/persistence/layers"
import {
  AssetResolutionCoinGeckoClientLive,
  AssetResolutionJobExecutorLive,
  SourceSyncJobExecutorLive,
  SourceProviderRegistryLive,
  TransferReconciliationServiceLive,
} from "@my/sync-engine/layers"
import { AssetResolutionJupiterClientLive } from "@my/sync-engine/providers/jupiter/layers"
import {
  CoinbaseLegDerivationServiceLive,
  CoinbaseRecordNormalizerLive,
  CoinbaseReferenceDataServiceLive,
  CoinbaseReferenceMappingServiceLive,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClientLive,
} from "@my/sync-engine/providers/coinbase/layers"
import { HeliusSolanaSourceSyncProviderLive } from "@my/sync-engine/providers/helius-solana/layers"
import { WorkerAssetResolutionPollerLive } from "./layers/WorkerAssetResolutionPollerLive.ts"
import { WorkerHealthServerLive } from "./layers/WorkerHealthServerLive.ts"
import { WorkerSourceSyncPollerLive } from "./layers/WorkerSourceSyncPollerLive.ts"
import { TracingLive } from "./layers/TracingLive.ts"

const CoinbaseReferenceMappingRuntimeLive = CoinbaseReferenceMappingServiceLive.pipe(
  Layer.provide(RepositoriesLive)
)

const CoinbaseReferenceDataRuntimeLive = CoinbaseReferenceDataServiceLive.pipe(
  Layer.provide(CoinbaseSyncClientLive),
  Layer.provide(CoinbaseReferenceMappingRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const CoinbaseSourceSyncProviderRuntimeLive = CoinbaseSourceSyncProviderLive.pipe(
  Layer.provide(CoinbaseRecordNormalizerLive),
  Layer.provide(CoinbaseLegDerivationServiceLive),
  Layer.provide(CoinbaseReferenceDataRuntimeLive),
  Layer.provide(CoinbaseReferenceMappingRuntimeLive),
  Layer.provide(CoinbaseSyncClientLive),
  Layer.provide(RepositoriesLive)
)

const SourceProviderRegistryRuntimeLive = SourceProviderRegistryLive.pipe(
  Layer.provide(CoinbaseSourceSyncProviderRuntimeLive),
  Layer.provide(HeliusSolanaSourceSyncProviderLive)
)

const TransferReconciliationRuntimeLive = TransferReconciliationServiceLive.pipe(
  Layer.provide(RepositoriesLive)
)

const SourceSyncJobExecutorRuntimeLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationRuntimeLive),
  Layer.provide(SourceProviderRegistryRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const SourceSyncWorkerRuntimeLive = WorkerSourceSyncPollerLive.pipe(
  Layer.provide(SourceSyncJobExecutorRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const AssetResolutionJobExecutorRuntimeLive = AssetResolutionJobExecutorLive.pipe(
  Layer.provide(AssetResolutionCoinGeckoClientLive),
  Layer.provide(AssetResolutionJupiterClientLive),
  Layer.provide(RepositoriesLive)
)

const AssetResolutionWorkerRuntimeLive = WorkerAssetResolutionPollerLive.pipe(
  Layer.provide(AssetResolutionJobExecutorRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const AppLive: Layer.Layer<never, unknown, never> = Layer.mergeAll(
  WorkerHealthServerLive,
  SourceSyncWorkerRuntimeLive,
  AssetResolutionWorkerRuntimeLive
).pipe(Layer.provide(PgClientLive))

Layer.launch(AppLive).pipe(
  Effect.provide(Layer.mergeAll(LoggerLive, TracingLive)),
  NodeRuntime.runMain
)
