import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { PgClientLive, RepositoriesLive } from "@my/persistence/layers"
import {
  SourceSyncJobExecutorLive,
  SourceSyncProviderLive,
  TransferReconciliationServiceLive,
} from "@my/sync-engine/layers"
import {
  CoinbaseLegDerivationServiceLive,
  CoinbaseRecordNormalizerLive,
  CoinbaseReferenceDataServiceLive,
  CoinbaseReferenceMappingServiceLive,
  CoinbaseSourceSyncProviderLive,
  CoinbaseSyncClientLive,
} from "@my/sync-engine/providers/coinbase/layers"
import { WorkerBullMqSourceSyncConsumerLive } from "./layers/WorkerBullMqSourceSyncConsumerLive.ts"
import { WorkerHealthServerLive } from "./layers/WorkerHealthServerLive.ts"
import { WorkerSourceSyncStartupRepairLive } from "./layers/WorkerSourceSyncStartupRepairLive.ts"

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

const SourceSyncProviderRuntimeLive = SourceSyncProviderLive.pipe(
  Layer.provide(CoinbaseSourceSyncProviderRuntimeLive)
)

const TransferReconciliationRuntimeLive = TransferReconciliationServiceLive.pipe(
  Layer.provide(RepositoriesLive)
)

const SourceSyncJobExecutorRuntimeLive = SourceSyncJobExecutorLive.pipe(
  Layer.provide(TransferReconciliationRuntimeLive),
  Layer.provide(SourceSyncProviderRuntimeLive),
  Layer.provide(CoinbaseSourceSyncProviderRuntimeLive),
  Layer.provide(RepositoriesLive)
)

const WorkerRuntimeLive = WorkerBullMqSourceSyncConsumerLive.pipe(
  Layer.provide(SourceSyncJobExecutorRuntimeLive),
  // Startup repair is a dependency of the consumer so reconciliation finishes before BullMQ claims work.
  Layer.provide(WorkerSourceSyncStartupRepairLive.pipe(Layer.provide(RepositoriesLive)))
)

const AppLive: Layer.Layer<never, unknown, never> = Layer.mergeAll(
  WorkerHealthServerLive,
  WorkerRuntimeLive
).pipe(Layer.provide(PgClientLive))

Layer.launch(AppLive).pipe(NodeRuntime.runMain)
