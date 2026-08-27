/**
 * CoinbaseReferenceMappingServiceLive - Live Coinbase mapping persistence and resolution.
 *
 * @module CoinbaseReferenceMappingServiceLive
 */

import { coinbaseCurrencyNaturalKey, type ProviderNaturalKey } from "@my/core/assets"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { AssetRepository } from "../../../services/AssetRepository.ts"
import { AssetResolutionJobRepository } from "../../../services/AssetResolutionJobRepository.ts"
import {
  ProviderAssetRepository,
  type ProviderAssetMappingDraft,
  type ProviderAssetMappingState,
  type ProviderAssetRecord,
} from "../../../services/ProviderAssetRepository.ts"
import { ProviderReferenceRepository } from "../../../services/ProviderReferenceRepository.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import {
  coinbaseDefaultCurrencyMappings,
  coinbaseDefaultTransactionTypeMappings,
} from "../reference-data/CoinbaseDefaultReferenceMappings.ts"
import {
  CoinbaseBrokenApprovedProviderAssetMappingError,
  CoinbasePendingProviderAssetMappingError,
  CoinbasePendingTransactionTypeMappingError,
  CoinbaseProviderAssetMappingNotFoundError,
  CoinbaseReferenceMappingService,
  type CoinbaseReferenceMappingServiceShape,
  type CoinbaseResolvedCurrencyMapping,
  type CoinbaseResolvedTransactionTypeMapping,
} from "../services/CoinbaseReferenceMappingService.ts"

const COINBASE_PROVIDER = "coinbase"

const toProviderAssetMappingKind = ({
  providerType,
}: {
  readonly providerType: string | null
}): "asset" | "fiat" => (providerType?.trim().toLowerCase() === "fiat" ? "fiat" : "asset")

const normalizeSide = (side: string | null): string | null =>
  side === null ? null : side.trim().toLowerCase()

const deriveTransactionType = ({
  providerTransactionType,
  defaultTransactionType,
  venueSide,
  nativeCurrency,
}: {
  readonly providerTransactionType: string
  readonly defaultTransactionType: string | null
  readonly venueSide: string | null
  readonly nativeCurrency: string | null
}): string | null => {
  if (providerTransactionType === "advanced_trade_fill") {
    const side = normalizeSide(venueSide)
    if (side === "buy" && nativeCurrency !== null) {
      return "buy_fiat"
    }
    if (side === "sell" && nativeCurrency !== null) {
      return "sell_fiat"
    }
  }

  return defaultTransactionType
}

const make = Effect.gen(function* () {
  const providerReferenceRepository = yield* ProviderReferenceRepository
  const providerAssetRepository = yield* ProviderAssetRepository
  const assetResolutionJobRepository = yield* AssetResolutionJobRepository
  const assetRepository = yield* AssetRepository

  const loadTransactionTypeMapping = ({
    providerTransactionType,
  }: {
    readonly providerTransactionType: string
  }) =>
    providerReferenceRepository
      .findTransactionTypeMapping({
        providerKey: COINBASE_PROVIDER,
        providerTransactionType,
      })
      .pipe(Effect.map(Option.getOrNull))

  const loadProviderAssetMapping = ({
    providerAssetRowId,
  }: {
    readonly providerAssetRowId: string
  }) =>
    providerAssetRepository
      .findProviderAssetMapping({
        providerAssetRowId,
      })
      .pipe(Effect.map(Option.getOrNull))

  const loadProviderAssetRecord = ({ currencyCode }: { readonly currencyCode: string }) =>
    providerAssetRepository
      .findProviderAssetByCurrencyCode({
        providerKey: COINBASE_PROVIDER,
        currencyCode,
      })
      .pipe(Effect.map(Option.getOrNull))

  const ensurePendingTransactionType = ({
    providerTransactionType,
    rawSourcePayload,
  }: {
    readonly providerTransactionType: string
    readonly rawSourcePayload: unknown
  }) =>
    providerReferenceRepository
      .recordPendingTransactionTypeMapping({
        providerKey: COINBASE_PROVIDER,
        providerTransactionType,
        transactionType: null,
        inventoryEffect: "unknown",
        taxTreatment: "requires_additional_rule_logic",
        resolutionStrategy: "no_leg",
        pairedRecordRequired: false,
        mappingStatus: "pending_review",
        reviewerNotes: null,
        sourceNotes:
          "Observed Coinbase transaction type without an approved TaxMaxi mapping. Review required.",
      })
      .pipe(
        Effect.andThen(
          providerReferenceRepository
            .upsertTransactionTypeCatalog({
              providerKey: COINBASE_PROVIDER,
              entries: [
                {
                  providerKey: COINBASE_PROVIDER,
                  providerTransactionType,
                  displayName: null,
                  payload: rawSourcePayload,
                },
              ],
            })
            .pipe(Effect.asVoid)
        )
      )

  const ensureProviderAssetRecord = ({
    currencyCode,
    naturalKey,
    rawSourcePayload,
  }: {
    readonly currencyCode: string
    readonly naturalKey?: ProviderNaturalKey
    readonly rawSourcePayload: unknown
  }) =>
    Effect.gen(function* () {
      const upperCurrencyCode = currencyCode.toUpperCase()
      const persistedProviderAsset = yield* loadProviderAssetRecord({
        currencyCode: upperCurrencyCode,
      })

      if (persistedProviderAsset !== null) {
        return persistedProviderAsset
      }

      yield* providerAssetRepository.upsertProviderAssets({
        providerKey: COINBASE_PROVIDER,
        entries: [
          {
            providerAssetId: null,
            naturalKey:
              naturalKey ?? coinbaseCurrencyNaturalKey({ currencyCode: upperCurrencyCode }),
            currencyCode: upperCurrencyCode,
            name: null,
            exponent: null,
            providerType: null,
            payload: rawSourcePayload,
          },
        ],
      })

      const reloadedProviderAsset = yield* loadProviderAssetRecord({
        currencyCode: upperCurrencyCode,
      })

      if (reloadedProviderAsset !== null) {
        return reloadedProviderAsset
      }

      return yield* new SyncEngineStorageError({
        operation: "coinbaseReferenceMappingService.ensureProviderAssetRecord",
        cause: {
          currencyCode: upperCurrencyCode,
          message: "Coinbase provider asset row could not be persisted.",
        },
      })
    })

  const ensurePendingProviderAssetMapping = ({
    providerAssetRowId,
    providerType,
    sourceNotes = "Observed Coinbase provider asset without an approved TaxMaxi mapping. Review required.",
  }: {
    readonly providerAssetRowId: string
    readonly providerType: string | null
    readonly sourceNotes?: string
  }) => {
    const mappingKind = toProviderAssetMappingKind({ providerType })

    return Effect.gen(function* () {
      yield* providerAssetRepository.upsertProviderAssetMappings({
        mappings: [
          {
            providerAssetRowId,
            mappingKind,
            canonicalAssetId: null,
            assetRepresentationId: null,
            canonicalFiatCurrency: null,
            mappingStatus: "pending_review",
            reviewerNotes: null,
            sourceNotes,
          },
        ],
      })
      yield* assetResolutionJobRepository.scheduleUnresolvedResolutionJob({
        providerAssetRowId,
      })
    })
  }

  const failMissingTransactionTypeMapping = ({
    providerTransactionType,
    rawSourcePayload,
  }: {
    readonly providerTransactionType: string
    readonly rawSourcePayload: unknown
  }) =>
    Effect.gen(function* () {
      yield* ensurePendingTransactionType({
        providerTransactionType,
        rawSourcePayload,
      })

      return yield* new CoinbasePendingTransactionTypeMappingError({
        providerTransactionType,
        message: `Coinbase transaction type ${providerTransactionType} is missing an approved mapping. A pending_review mapping row was created.`,
      })
    })

  const failPendingTransactionTypeMapping = ({
    providerTransactionType,
  }: {
    readonly providerTransactionType: string
  }) =>
    Effect.fail(
      new CoinbasePendingTransactionTypeMappingError({
        providerTransactionType,
        message: `Coinbase transaction type ${providerTransactionType} is pending review. Approve the mapping row before replaying normalization.`,
      })
    )

  const failMissingProviderAssetMapping = ({
    currencyCode,
    providerAssetRowId,
    providerType,
  }: {
    readonly currencyCode: string
    readonly providerAssetRowId: string
    readonly providerType: string | null
  }) =>
    Effect.gen(function* () {
      yield* ensurePendingProviderAssetMapping({
        providerAssetRowId,
        providerType,
      })

      return yield* new CoinbaseProviderAssetMappingNotFoundError({
        currencyCode,
        providerAssetRowId,
        message: `Coinbase provider asset for ${currencyCode} is missing an approved mapping. A pending_review mapping row was created.`,
      })
    })

  const failPendingProviderAssetMapping = ({
    currencyCode,
    providerAssetRowId,
  }: {
    readonly currencyCode: string
    readonly providerAssetRowId: string
  }) =>
    Effect.gen(function* () {
      yield* assetResolutionJobRepository.scheduleUnresolvedResolutionJob({ providerAssetRowId })

      return yield* new CoinbasePendingProviderAssetMappingError({
        currencyCode,
        providerAssetRowId,
        message: `Coinbase provider asset mapping for ${currencyCode} is pending review. Approve the mapping row before replaying normalization.`,
      })
    })

  const failReclassifiedProviderAssetMapping = ({
    currencyCode,
    providerAssetRowId,
    providerType,
  }: {
    readonly currencyCode: string
    readonly providerAssetRowId: string
    readonly providerType: string | null
  }) =>
    Effect.gen(function* () {
      yield* ensurePendingProviderAssetMapping({
        providerAssetRowId,
        providerType,
        sourceNotes:
          "Coinbase reclassified this currency between crypto and fiat after the mapping was approved. Review required.",
      })

      return yield* new CoinbasePendingProviderAssetMappingError({
        currencyCode,
        providerAssetRowId,
        message: `Coinbase provider asset ${currencyCode} changed type since its mapping was approved. The mapping was reopened for review.`,
      })
    })

  const resolveCanonicalAssetId = ({
    persistedMapping,
    currencyCode,
  }: {
    readonly persistedMapping: CoinbaseResolvedCurrencyMapping
    readonly currencyCode: string
  }) =>
    Effect.gen(function* () {
      if (persistedMapping.canonicalAssetId !== null) {
        const canonicalAsset = yield* assetRepository.findAssetById({
          assetId: persistedMapping.canonicalAssetId,
        })

        if (Option.isNone(canonicalAsset)) {
          return yield* new CoinbaseBrokenApprovedProviderAssetMappingError({
            currencyCode,
            providerAssetRowId: persistedMapping.providerAssetRowId,
            message: `Coinbase provider asset mapping for ${currencyCode} is approved but points at a missing canonical asset ${persistedMapping.canonicalAssetId}.`,
          })
        }

        return persistedMapping.canonicalAssetId
      }

      if (
        persistedMapping.mappingKind === "fiat" &&
        persistedMapping.canonicalFiatCurrency !== null
      ) {
        return null
      }

      return yield* new CoinbaseBrokenApprovedProviderAssetMappingError({
        currencyCode,
        providerAssetRowId: persistedMapping.providerAssetRowId,
        message: `Coinbase provider asset mapping for ${currencyCode} is approved but has no canonical target configured.`,
      })
    })

  const resolveDefaultCurrencyMapping = ({
    mapping,
    providerAssetRowId,
  }: {
    readonly mapping: (typeof coinbaseDefaultCurrencyMappings)[number]
    readonly providerAssetRowId: string
  }): Effect.Effect<ProviderAssetMappingDraft, SyncEngineStorageError> =>
    Effect.gen(function* () {
      if (mapping.mappingKind === "fiat") {
        return {
          providerAssetRowId,
          mappingKind: mapping.mappingKind,
          canonicalAssetId: null,
          assetRepresentationId: null,
          canonicalFiatCurrency: mapping.canonicalFiatCurrency,
          mappingStatus: mapping.mappingStatus,
          reviewerNotes: null,
          sourceNotes: mapping.sourceNotes,
        } satisfies ProviderAssetMappingDraft
      }

      if (mapping.canonicalAssetCoinGeckoId === null) {
        return {
          providerAssetRowId,
          mappingKind: mapping.mappingKind,
          canonicalAssetId: null,
          assetRepresentationId: null,
          canonicalFiatCurrency: null,
          mappingStatus: "pending_review",
          reviewerNotes: null,
          sourceNotes:
            "Coinbase default asset mapping has no canonical economic asset id configured. Review required.",
        } satisfies ProviderAssetMappingDraft
      }

      const canonicalAsset = yield* assetRepository.findAssetByCoinGeckoId({
        coingeckoCoinId: mapping.canonicalAssetCoinGeckoId,
      })

      if (Option.isSome(canonicalAsset)) {
        return {
          providerAssetRowId,
          mappingKind: mapping.mappingKind,
          canonicalAssetId: canonicalAsset.value.id,
          assetRepresentationId: null,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: null,
          sourceNotes: mapping.sourceNotes,
        } satisfies ProviderAssetMappingDraft
      }

      return {
        providerAssetRowId,
        mappingKind: mapping.mappingKind,
        canonicalAssetId: null,
        assetRepresentationId: null,
        canonicalFiatCurrency: null,
        mappingStatus: "pending_review",
        reviewerNotes: null,
        sourceNotes: `Coinbase default mapping targets CoinGecko asset ${mapping.canonicalAssetCoinGeckoId}, but no assets row exists. Review required after adding or selecting an economic asset.`,
      } satisfies ProviderAssetMappingDraft
    })

  const ensureDefaultMappings: CoinbaseReferenceMappingServiceShape["ensureDefaultMappings"] = () =>
    Effect.gen(function* () {
      yield* providerReferenceRepository.ensureTransactionTypeMappings({
        providerKey: COINBASE_PROVIDER,
        mappings: coinbaseDefaultTransactionTypeMappings.map((mapping) => ({
          providerKey: COINBASE_PROVIDER,
          providerTransactionType: mapping.providerTransactionType,
          transactionType: mapping.transactionTypeKey,
          inventoryEffect: mapping.inventoryEffect,
          taxTreatment: mapping.taxTreatment,
          resolutionStrategy: mapping.resolutionStrategy,
          pairedRecordRequired: mapping.pairedRecordRequired,
          mappingStatus: mapping.mappingStatus,
          reviewerNotes: null,
          sourceNotes: mapping.sourceNotes,
        })),
      })

      const resolvedDefaultMappings = yield* Effect.forEach(
        coinbaseDefaultCurrencyMappings,
        (mapping) =>
          Effect.gen(function* () {
            const providerAssetRecord = yield* ensureProviderAssetRecord({
              currencyCode: mapping.currencyCode,
              naturalKey: mapping.naturalKey,
              rawSourcePayload: {
                source: "coinbase_default_currency_mapping",
                currencyCode: mapping.currencyCode,
              },
            })

            const providerAssetMapping = yield* resolveDefaultCurrencyMapping({
              mapping,
              providerAssetRowId: providerAssetRecord.id,
            })

            return {
              currencyCode: mapping.currencyCode,
              providerAssetMapping,
            } as const
          })
      )

      yield* providerAssetRepository.seedProviderAssetMappingsIfMissing({
        mappings: resolvedDefaultMappings.map(({ providerAssetMapping }) => providerAssetMapping),
      })

      return {
        transactionTypeMappingCount: coinbaseDefaultTransactionTypeMappings.length,
        providerAssetMappingCount: coinbaseDefaultCurrencyMappings.length,
      } as const
    })

  const resolveTransactionType: CoinbaseReferenceMappingServiceShape["resolveTransactionType"] = ({
    providerTransactionType,
    venueSide,
    nativeCurrency,
    rawSourcePayload,
  }) =>
    Effect.gen(function* () {
      const persistedMapping = yield* loadTransactionTypeMapping({ providerTransactionType })

      if (persistedMapping === null) {
        return yield* failMissingTransactionTypeMapping({
          providerTransactionType,
          rawSourcePayload,
        })
      }

      if (persistedMapping.mappingStatus !== "approved") {
        return yield* failPendingTransactionTypeMapping({ providerTransactionType })
      }

      return {
        providerTransactionType,
        transactionType: deriveTransactionType({
          providerTransactionType,
          defaultTransactionType: persistedMapping.transactionType,
          venueSide,
          nativeCurrency,
        }),
        inventoryEffect: persistedMapping.inventoryEffect,
        taxTreatment: persistedMapping.taxTreatment,
        resolutionStrategy: persistedMapping.resolutionStrategy,
        pairedRecordRequired: persistedMapping.pairedRecordRequired,
        mappingStatus: persistedMapping.mappingStatus,
      } satisfies CoinbaseResolvedTransactionTypeMapping
    })

  const resolvePersistedCurrency = ({
    currencyCode,
    persistedMapping,
    providerAssetRecord,
  }: {
    readonly currencyCode: string
    readonly persistedMapping: ProviderAssetMappingState | null
    readonly providerAssetRecord: ProviderAssetRecord
  }) =>
    Effect.gen(function* () {
      const upperCurrencyCode = currencyCode.toUpperCase()
      if (persistedMapping === null) {
        return yield* failMissingProviderAssetMapping({
          currencyCode: upperCurrencyCode,
          providerAssetRowId: providerAssetRecord.id,
          providerType: providerAssetRecord.providerType,
        })
      }

      if (
        persistedMapping.mappingStatus !== "approved" &&
        persistedMapping.mappingStatus !== "excluded"
      ) {
        return yield* failPendingProviderAssetMapping({
          currencyCode: upperCurrencyCode,
          providerAssetRowId: providerAssetRecord.id,
        })
      }

      // An approval is tied to the provider type it was reviewed under. When
      // a catalog refresh reclassifies the currency between crypto and fiat,
      // the old mapping must not decide accounting; reopen it for review. A
      // null provider type is no report at all (default mappings are seeded
      // without one), and an exclusion stays settled: it keeps the
      // observation out of accounting under either type.
      if (
        persistedMapping.mappingStatus === "approved" &&
        providerAssetRecord.providerType !== null &&
        persistedMapping.mappingKind !==
          toProviderAssetMappingKind({ providerType: providerAssetRecord.providerType })
      ) {
        return yield* failReclassifiedProviderAssetMapping({
          currencyCode: upperCurrencyCode,
          providerAssetRowId: providerAssetRecord.id,
          providerType: providerAssetRecord.providerType,
        })
      }

      const canonicalAssetId =
        persistedMapping.mappingStatus === "excluded"
          ? null
          : yield* resolveCanonicalAssetId({
              persistedMapping: {
                kind: "canonical",
                providerAssetRowId: providerAssetRecord.id,
                currencyCode: upperCurrencyCode,
                mappingStatus: persistedMapping.mappingStatus,
                mappingKind: persistedMapping.mappingKind,
                canonicalAssetId: persistedMapping.canonicalAssetId,
                assetRepresentationId: persistedMapping.assetRepresentationId,
                canonicalFiatCurrency: persistedMapping.canonicalFiatCurrency,
              },
              currencyCode: upperCurrencyCode,
            })

      return {
        kind: persistedMapping.mappingStatus === "excluded" ? "excluded" : "canonical",
        providerAssetRowId: providerAssetRecord.id,
        currencyCode: upperCurrencyCode,
        mappingStatus: persistedMapping.mappingStatus,
        mappingKind: persistedMapping.mappingKind,
        canonicalAssetId,
        assetRepresentationId: persistedMapping.assetRepresentationId,
        canonicalFiatCurrency: persistedMapping.canonicalFiatCurrency,
      } satisfies CoinbaseResolvedCurrencyMapping
    })

  const resolveCurrency: CoinbaseReferenceMappingServiceShape["resolveCurrency"] = ({
    currencyCode,
    rawSourcePayload,
  }) =>
    Effect.gen(function* () {
      const upperCurrencyCode = currencyCode.toUpperCase()
      const providerAssetRecord = yield* ensureProviderAssetRecord({
        currencyCode: upperCurrencyCode,
        rawSourcePayload: rawSourcePayload ?? { currencyCode: upperCurrencyCode },
      })
      const persistedMapping = yield* loadProviderAssetMapping({
        providerAssetRowId: providerAssetRecord.id,
      })
      return yield* resolvePersistedCurrency({
        currencyCode: upperCurrencyCode,
        persistedMapping,
        providerAssetRecord,
      })
    })

  const resolveProviderAsset: CoinbaseReferenceMappingServiceShape["resolveProviderAsset"] = ({
    currencyCode,
    providerAssetRowId,
  }) =>
    Effect.gen(function* () {
      const review = yield* providerAssetRepository.findProviderAssetReviewById({
        providerAssetRowId,
      })
      if (Option.isNone(review)) {
        return yield* new CoinbaseProviderAssetMappingNotFoundError({
          currencyCode: currencyCode.toUpperCase(),
          providerAssetRowId,
          message: `Coinbase provider asset row ${providerAssetRowId} does not exist.`,
        })
      }
      if (
        review.value.providerAsset.provider !== COINBASE_PROVIDER ||
        review.value.providerAsset.currencyCode !== currencyCode.toUpperCase()
      ) {
        return yield* new CoinbaseProviderAssetMappingNotFoundError({
          currencyCode: currencyCode.toUpperCase(),
          providerAssetRowId,
          message: `Coinbase provider asset row ${providerAssetRowId} does not match ${currencyCode.toUpperCase()}.`,
        })
      }
      return yield* resolvePersistedCurrency({
        currencyCode,
        persistedMapping: review.value.mapping,
        providerAssetRecord: review.value.providerAsset,
      })
    })

  const resolveAssetId: CoinbaseReferenceMappingServiceShape["resolveAssetId"] = (params) =>
    resolveCurrency(params).pipe(
      Effect.flatMap((mapping) => {
        if (mapping.canonicalAssetId !== null) {
          return Effect.succeed(mapping.canonicalAssetId)
        }

        return Effect.fail(
          new CoinbaseBrokenApprovedProviderAssetMappingError({
            currencyCode: mapping.currencyCode,
            providerAssetRowId: mapping.providerAssetRowId,
            message: `Coinbase provider asset mapping for ${mapping.currencyCode} is approved but has no canonical asset binding for transfer/leg normalization.`,
          })
        )
      })
    )

  return CoinbaseReferenceMappingService.of({
    ensureDefaultMappings,
    resolveTransactionType,
    resolveCurrency,
    resolveProviderAsset,
    resolveAssetId,
  } satisfies CoinbaseReferenceMappingServiceShape)
})

/**
 * CoinbaseReferenceMappingServiceLive - Live layer for Coinbase mapping resolution.
 */
export const CoinbaseReferenceMappingServiceLive = Layer.effect(
  CoinbaseReferenceMappingService,
  make
)
