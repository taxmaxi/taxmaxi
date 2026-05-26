/**
 * HeliusSolanaAssetResolutionServiceLive - Helius DAS-backed Solana asset resolution.
 *
 * @module HeliusSolanaAssetResolutionServiceLive
 */

import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { AssetRepository } from "../../../services/AssetRepository.ts"
import {
  ProviderAssetRepository,
  type ProviderAssetCatalogEntry,
  type ProviderAssetMappingDraft,
  type ProviderAssetRecord,
  type ResolvedProviderAssetMapping,
} from "../../../services/ProviderAssetRepository.ts"
import { SyncEngineStorageError } from "../../../services/SyncEngineStorageError.ts"
import {
  HELIUS_SOLANA_PROVIDER_KEY,
  type HeliusSolanaReferenceDataRefreshResult,
} from "../services/HeliusSolanaSourceSyncProvider.ts"
import { HeliusSolanaSyncClient } from "../services/HeliusSolanaSyncClient.ts"
import {
  HeliusSolanaAssetMetadataDecodeError,
  HeliusSolanaBrokenApprovedProviderAssetMappingError,
  type HeliusSolanaAssetResolutionError,
  HeliusSolanaAssetResolutionService,
  type HeliusSolanaAssetResolutionServiceShape,
  SOLANA_BLOCKCHAIN_NAME,
  SOLANA_NATIVE_SYMBOL,
  SOLANA_USDC_MINT,
  SOLANA_USDT_MINT,
  SOLANA_WRAPPED_NATIVE_MINT,
  type HeliusSolanaAssetReference,
  type HeliusSolanaAssetReferenceDataRefreshResult,
  type HeliusSolanaResolvedAsset,
} from "../services/HeliusSolanaAssetResolutionService.ts"

interface DefaultAssetMapping {
  readonly mintAddress: string | null
  readonly naturalKey: string
  readonly currencyCode: string
  readonly name: string
  readonly decimals: number
  readonly providerType: "native" | "spl-token"
  readonly canonicalAssetSymbol: string
  readonly sourceNotes: string
}

interface NormalizedAssetReference {
  readonly kind: "native" | "spl"
  readonly mintAddress: string | null
  readonly rawProviderPayload: unknown | undefined
}

interface DecodedDasAsset {
  readonly mintAddress: string
  readonly currencyCode: string
  readonly name: string | null
  readonly decimals: number | null
  readonly tokenProgram: string | null
  readonly providerType: "spl-token" | "spl-token-2022" | "nft"
  readonly nftHint: boolean
  readonly payload: unknown
}

const NATIVE_SOL_NATURAL_KEY = "solana:native:SOL"

const nativeDefaultAssetMapping = {
  mintAddress: SOLANA_WRAPPED_NATIVE_MINT,
  naturalKey: NATIVE_SOL_NATURAL_KEY,
  currencyCode: SOLANA_NATIVE_SYMBOL,
  name: "Solana",
  decimals: 9,
  providerType: "native",
  canonicalAssetSymbol: SOLANA_NATIVE_SYMBOL,
  sourceNotes: "TaxMaxi built-in Solana native SOL mapping.",
} as const satisfies DefaultAssetMapping

const defaultAssetMappings = [
  nativeDefaultAssetMapping,
  {
    mintAddress: SOLANA_USDC_MINT,
    naturalKey: `solana:mint:${SOLANA_USDC_MINT}`,
    currencyCode: "USDC",
    name: "USD Coin",
    decimals: 6,
    providerType: "spl-token",
    canonicalAssetSymbol: "USDC",
    sourceNotes: "TaxMaxi built-in Solana USDC mint mapping.",
  },
  {
    mintAddress: SOLANA_USDT_MINT,
    naturalKey: `solana:mint:${SOLANA_USDT_MINT}`,
    currencyCode: "USDT",
    name: "Tether USD",
    decimals: 6,
    providerType: "spl-token",
    canonicalAssetSymbol: "USDT",
    sourceNotes: "TaxMaxi built-in Solana USDT mint mapping.",
  },
] as const satisfies ReadonlyArray<DefaultAssetMapping>

const DasMetadataSchema = Schema.Struct({
  name: Schema.optional(Schema.String),
  symbol: Schema.optional(Schema.String),
  token_standard: Schema.optional(Schema.String),
})

const DasAssetSchema = Schema.Struct({
  id: Schema.String,
  interface: Schema.optional(Schema.String),
  content: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        metadata: Schema.optional(Schema.NullOr(DasMetadataSchema)),
      })
    )
  ),
  compression: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        compressed: Schema.Boolean,
      })
    )
  ),
  token_info: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        symbol: Schema.optional(Schema.String),
        decimals: Schema.optional(Schema.Number),
        token_program: Schema.optional(Schema.String),
      })
    )
  ),
  mint_extensions: Schema.optional(Schema.Unknown),
  burnt: Schema.optional(Schema.Boolean),
})

const DasAssetBatchSchema = Schema.Array(DasAssetSchema)
const decodeUnknownDasAssetBatch = Schema.decodeUnknown(DasAssetBatchSchema)
const decodeStoredProviderPayload = Schema.decodeUnknownEither(
  Schema.Struct({
    source: Schema.optional(Schema.String),
    tokenProgram: Schema.optional(Schema.NullOr(Schema.String)),
    nftHint: Schema.optional(Schema.Boolean),
  })
)

type DasAsset = Schema.Schema.Type<typeof DasAssetSchema>

const toStorageError = ({
  operation,
  cause,
}: {
  readonly operation: string
  readonly cause: unknown
}) =>
  new SyncEngineStorageError({
    operation,
    cause,
  })

const normalizeText = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null
  }

  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const normalizeMintAddress = (mintAddress: string | null): string | null => {
  if (mintAddress === null) {
    return null
  }

  const trimmed = mintAddress.trim()
  return trimmed === "" ? null : trimmed
}

const isNativeSolReference = (reference: HeliusSolanaAssetReference): boolean =>
  reference.kind === "native" ||
  normalizeMintAddress(reference.mintAddress) === SOLANA_WRAPPED_NATIVE_MINT

const mintNaturalKey = (mintAddress: string): string => `solana:mint:${mintAddress}`

const defaultMappingForReference = (
  reference: NormalizedAssetReference
): DefaultAssetMapping | null => {
  if (reference.kind === "native") {
    return nativeDefaultAssetMapping
  }

  const match = defaultAssetMappings.find(
    (mapping) => mapping.mintAddress === reference.mintAddress
  )
  return match ?? null
}

const providerAssetCatalogEntryForDefault = (
  mapping: DefaultAssetMapping
): ProviderAssetCatalogEntry => ({
  providerAssetId: mapping.mintAddress,
  naturalKey: mapping.naturalKey,
  currencyCode: mapping.currencyCode,
  name: mapping.name,
  exponent: mapping.decimals,
  providerType: mapping.providerType,
  payload: {
    source: "taxmaxi_builtin_solana_asset_mapping",
    provider: HELIUS_SOLANA_PROVIDER_KEY,
    mintAddress: mapping.mintAddress,
    naturalKey: mapping.naturalKey,
    currencyCode: mapping.currencyCode,
    decimals: mapping.decimals,
    providerType: mapping.providerType,
    sourceNotes: mapping.sourceNotes,
  },
})

const tokenStandardFromDasAsset = (asset: DasAsset): string | null =>
  asset.content?.metadata?.token_standard ?? null

const dasAssetName = (asset: DasAsset): string | null =>
  normalizeText(asset.content?.metadata?.name)

const dasAssetSymbol = (asset: DasAsset): string | null =>
  normalizeText(asset.token_info?.symbol) ?? normalizeText(asset.content?.metadata?.symbol)

const fallbackCurrencyCode = (mintAddress: string): string =>
  `SOLANA_MINT_${mintAddress.slice(0, 8).toUpperCase()}`

const isNftDasAsset = (asset: DasAsset): boolean => {
  const interfaceName = asset.interface?.toLowerCase() ?? ""
  const tokenStandard = tokenStandardFromDasAsset(asset)?.toLowerCase() ?? ""

  return (
    interfaceName.includes("nft") ||
    tokenStandard.includes("nft") ||
    asset.compression?.compressed === true
  )
}

const providerTypeFromDasAsset = (asset: DasAsset): DecodedDasAsset["providerType"] => {
  if (isNftDasAsset(asset)) {
    return "nft"
  }

  const tokenProgram = normalizeText(asset.token_info?.token_program)
  return tokenProgram?.toLowerCase().startsWith("tokenz") === true ? "spl-token-2022" : "spl-token"
}

const decodeDasAsset = (
  asset: DasAsset
): Effect.Effect<DecodedDasAsset, HeliusSolanaAssetMetadataDecodeError> =>
  Effect.gen(function* () {
    const decimals = asset.token_info?.decimals

    if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
      return yield* Effect.fail(
        new HeliusSolanaAssetMetadataDecodeError({
          message: `Invalid Helius DAS decimals for Solana mint ${asset.id}`,
          cause: { mintAddress: asset.id, decimals },
        })
      )
    }

    const tokenProgram = normalizeText(asset.token_info?.token_program)
    const nftHint = isNftDasAsset(asset)
    const providerType = providerTypeFromDasAsset(asset)

    return {
      mintAddress: asset.id,
      currencyCode: dasAssetSymbol(asset) ?? fallbackCurrencyCode(asset.id),
      name: dasAssetName(asset),
      decimals: decimals ?? null,
      tokenProgram,
      providerType,
      nftHint,
      payload: {
        source: "helius_das_get_asset_batch",
        provider: HELIUS_SOLANA_PROVIDER_KEY,
        mintAddress: asset.id,
        tokenProgram,
        nftHint,
        asset,
      },
    } satisfies DecodedDasAsset
  })

const decodeDasAssetBatch = (
  payload: unknown
): Effect.Effect<ReadonlyMap<string, DecodedDasAsset>, HeliusSolanaAssetMetadataDecodeError> =>
  Effect.gen(function* () {
    const decodedAssets = yield* decodeUnknownDasAssetBatch(payload).pipe(
      Effect.mapError(
        (cause) =>
          new HeliusSolanaAssetMetadataDecodeError({
            message: `Invalid Helius DAS asset batch payload: ${cause.message}`,
            cause,
          })
      )
    )
    const assets = yield* Effect.forEach(decodedAssets, decodeDasAsset)
    const byMintAddress = new Map<string, DecodedDasAsset>()

    for (const asset of assets) {
      byMintAddress.set(asset.mintAddress, asset)
    }

    return byMintAddress
  })

const normalizeReference = (
  reference: HeliusSolanaAssetReference
): Effect.Effect<NormalizedAssetReference, HeliusSolanaAssetMetadataDecodeError> => {
  if (isNativeSolReference(reference)) {
    return Effect.succeed({
      kind: "native",
      mintAddress: null,
      rawProviderPayload: reference.rawProviderPayload,
    })
  }

  const mintAddress = normalizeMintAddress(reference.mintAddress)

  if (mintAddress === null) {
    return Effect.fail(
      new HeliusSolanaAssetMetadataDecodeError({
        message: "SPL asset references require a mint address.",
        cause: reference,
      })
    )
  }

  return Effect.succeed({
    kind: "spl",
    mintAddress,
    rawProviderPayload: reference.rawProviderPayload,
  })
}

const storedTokenProgram = (providerAsset: ProviderAssetRecord): string | null => {
  const decoded = decodeStoredProviderPayload(providerAsset.rawProviderPayload)

  if (Either.isLeft(decoded)) {
    return null
  }

  return decoded.right.tokenProgram ?? null
}

const storedNftHint = (providerAsset: ProviderAssetRecord): boolean => {
  const decoded = decodeStoredProviderPayload(providerAsset.rawProviderPayload)

  if (Either.isLeft(decoded)) {
    return providerAsset.providerType === "nft"
  }

  return decoded.right.nftHint ?? providerAsset.providerType === "nft"
}

const hasHeliusDasPayload = (providerAsset: ProviderAssetRecord): boolean => {
  const decoded = decodeStoredProviderPayload(providerAsset.rawProviderPayload)

  if (Either.isLeft(decoded)) {
    return false
  }

  return decoded.right.source === "helius_das_get_asset_batch"
}

const assetKindFromProviderAsset = (
  providerAsset: ProviderAssetRecord
): HeliusSolanaResolvedAsset["assetKind"] => {
  if (providerAsset.providerType === "native") {
    return "native"
  }

  return storedNftHint(providerAsset) ? "nft" : "token"
}

const resolvedKindFromMapping = (
  mapping: ResolvedProviderAssetMapping
): HeliusSolanaResolvedAsset["kind"] =>
  mapping.mappingStatus === "approved" ? "canonical" : "review_required"

const makeMissingProviderAssetAfterUpsertError = ({
  providerAssetId,
  naturalKey,
}: {
  readonly providerAssetId: string | null
  readonly naturalKey: string | null
}) =>
  new SyncEngineStorageError({
    operation: "heliusSolanaAssetResolutionService.ensureProviderAssetRecord",
    cause: {
      providerAssetId,
      naturalKey,
      message: "Helius Solana provider asset row could not be persisted.",
    },
  })

const make = Effect.gen(function* () {
  const assetRepository = yield* AssetRepository
  const providerAssetRepository = yield* ProviderAssetRepository
  const heliusSyncClient = yield* HeliusSolanaSyncClient

  const loadProviderAssetRecord = ({
    providerAssetId,
    naturalKey,
  }: {
    readonly providerAssetId: string | null
    readonly naturalKey: string | null
  }) =>
    providerAssetId !== null
      ? providerAssetRepository
          .findProviderAssetByProviderAssetId({
            providerKey: HELIUS_SOLANA_PROVIDER_KEY,
            providerAssetId,
          })
          .pipe(Effect.map(Option.getOrNull))
      : naturalKey === null
        ? Effect.succeed(null)
        : providerAssetRepository
            .findProviderAssetByNaturalKey({
              providerKey: HELIUS_SOLANA_PROVIDER_KEY,
              naturalKey,
            })
            .pipe(Effect.map(Option.getOrNull))

  const upsertAndReloadProviderAssetRecord = (
    entry: ProviderAssetCatalogEntry
  ): Effect.Effect<ProviderAssetRecord, SyncEngineStorageError> =>
    Effect.gen(function* () {
      yield* providerAssetRepository.upsertProviderAssets({
        providerKey: HELIUS_SOLANA_PROVIDER_KEY,
        entries: [entry],
      })

      const reloaded = yield* loadProviderAssetRecord({
        providerAssetId: entry.providerAssetId,
        naturalKey: entry.naturalKey,
      })

      if (reloaded !== null) {
        return reloaded
      }

      return yield* Effect.fail(
        makeMissingProviderAssetAfterUpsertError({
          providerAssetId: entry.providerAssetId,
          naturalKey: entry.naturalKey,
        })
      )
    })

  const ensureProviderAssetRecord = (
    entry: ProviderAssetCatalogEntry
  ): Effect.Effect<ProviderAssetRecord, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const existing = yield* loadProviderAssetRecord({
        providerAssetId: entry.providerAssetId,
        naturalKey: entry.naturalKey,
      })

      if (existing !== null) {
        return existing
      }

      return yield* upsertAndReloadProviderAssetRecord(entry)
    })

  const canonicalAssetForDefault = (mapping: DefaultAssetMapping) =>
    mapping.providerType === "native"
      ? assetRepository.findNativeAssetForBlockchain({
          blockchainName: SOLANA_BLOCKCHAIN_NAME,
          symbol: mapping.canonicalAssetSymbol,
        })
      : mapping.mintAddress === null
        ? Effect.succeed(Option.none())
        : assetRepository.findAssetByBlockchainAndContractAddress({
            blockchainName: SOLANA_BLOCKCHAIN_NAME,
            contractAddress: mapping.mintAddress,
          })

  const defaultProviderAssetMappingDraft = ({
    mapping,
    providerAssetRowId,
  }: {
    readonly mapping: DefaultAssetMapping
    readonly providerAssetRowId: string
  }): Effect.Effect<ProviderAssetMappingDraft, SyncEngineStorageError> =>
    Effect.gen(function* () {
      const canonicalAsset = yield* canonicalAssetForDefault(mapping)

      if (Option.isSome(canonicalAsset)) {
        return {
          providerAssetRowId,
          mappingKind: "asset",
          canonicalAssetId: canonicalAsset.value.id,
          canonicalAssetSymbol: canonicalAsset.value.symbol,
          canonicalFiatCurrency: null,
          mappingStatus: "approved",
          reviewerNotes: null,
          sourceNotes: mapping.sourceNotes,
        } satisfies ProviderAssetMappingDraft
      }

      return {
        providerAssetRowId,
        mappingKind: "asset",
        canonicalAssetId: null,
        canonicalAssetSymbol: mapping.canonicalAssetSymbol,
        canonicalFiatCurrency: null,
        mappingStatus: "pending_review",
        reviewerNotes: null,
        sourceNotes: `${mapping.sourceNotes} Canonical Solana asset row is missing; review required after reference data repair.`,
      } satisfies ProviderAssetMappingDraft
    })

  const ensureDefaultMappingForProviderAsset = ({
    mapping,
    providerAsset,
  }: {
    readonly mapping: DefaultAssetMapping
    readonly providerAsset: ProviderAssetRecord
  }) =>
    Effect.gen(function* () {
      const draft = yield* defaultProviderAssetMappingDraft({
        mapping,
        providerAssetRowId: providerAsset.id,
      })

      yield* providerAssetRepository.seedProviderAssetMappingsIfMissing({
        mappings: [draft],
      })

      if (
        draft.mappingKind === "asset" &&
        draft.mappingStatus === "approved" &&
        draft.canonicalAssetId !== null &&
        draft.canonicalAssetSymbol !== null
      ) {
        yield* providerAssetRepository.backfillApprovedSymbolMappingsCanonicalAssetIds({
          mappings: [
            {
              providerAssetRowId: providerAsset.id,
              canonicalAssetId: draft.canonicalAssetId,
              canonicalAssetSymbol: draft.canonicalAssetSymbol,
            },
          ],
        })
      }
    })

  const ensureDefaultMappings = (): Effect.Effect<
    HeliusSolanaAssetReferenceDataRefreshResult,
    SyncEngineStorageError
  > =>
    Effect.gen(function* () {
      const providerAssets = yield* Effect.forEach(defaultAssetMappings, (mapping) =>
        ensureProviderAssetRecord(providerAssetCatalogEntryForDefault(mapping))
      )

      const mappingDrafts = yield* Effect.forEach(providerAssets, (providerAsset) => {
        const mapping = defaultAssetMappings.find(
          (candidate) =>
            candidate.mintAddress === providerAsset.providerAssetId ||
            candidate.naturalKey === providerAsset.naturalKey
        )

        return mapping === undefined
          ? Effect.fail(
              toStorageError({
                operation: "heliusSolanaAssetResolutionService.ensureDefaultMappings",
                cause: {
                  providerAssetId: providerAsset.providerAssetId,
                  naturalKey: providerAsset.naturalKey,
                  message: "Default Helius Solana provider asset was not recognized.",
                },
              })
            )
          : defaultProviderAssetMappingDraft({
              mapping,
              providerAssetRowId: providerAsset.id,
            })
      })

      yield* providerAssetRepository.seedProviderAssetMappingsIfMissing({
        mappings: mappingDrafts,
      })
      yield* providerAssetRepository.backfillApprovedSymbolMappingsCanonicalAssetIds({
        mappings: mappingDrafts.flatMap((mapping) =>
          mapping.mappingKind === "asset" &&
          mapping.mappingStatus === "approved" &&
          mapping.canonicalAssetId !== null &&
          mapping.canonicalAssetSymbol !== null
            ? [
                {
                  providerAssetRowId: mapping.providerAssetRowId,
                  canonicalAssetId: mapping.canonicalAssetId,
                  canonicalAssetSymbol: mapping.canonicalAssetSymbol,
                },
              ]
            : []
        ),
      })

      return {
        providerAssetCatalogCount: defaultAssetMappings.length,
        defaultProviderAssetMappingCount: defaultAssetMappings.length,
      } satisfies HeliusSolanaAssetReferenceDataRefreshResult
    })

  const providerAssetEntryFromDasAsset = (asset: DecodedDasAsset): ProviderAssetCatalogEntry => ({
    providerAssetId: asset.mintAddress,
    naturalKey: mintNaturalKey(asset.mintAddress),
    currencyCode: asset.currencyCode,
    name: asset.name,
    exponent: asset.decimals,
    providerType: asset.providerType,
    payload: asset.payload,
  })

  const fallbackProviderAssetEntry = ({
    mintAddress,
    rawProviderPayload,
  }: {
    readonly mintAddress: string
    readonly rawProviderPayload: unknown | undefined
  }): ProviderAssetCatalogEntry => ({
    providerAssetId: mintAddress,
    naturalKey: mintNaturalKey(mintAddress),
    currencyCode: fallbackCurrencyCode(mintAddress),
    name: null,
    exponent: null,
    providerType: "spl-token",
    payload: {
      source: "helius_das_get_asset_batch_missing",
      provider: HELIUS_SOLANA_PROVIDER_KEY,
      mintAddress,
      rawProviderPayload: rawProviderPayload ?? null,
    },
  })

  const ensurePendingProviderAssetMapping = (providerAsset: ProviderAssetRecord) =>
    providerAssetRepository.seedProviderAssetMappingsIfMissing({
      mappings: [
        {
          providerAssetRowId: providerAsset.id,
          mappingKind: providerAsset.providerType === "fiat" ? "fiat" : "asset",
          canonicalAssetId: null,
          canonicalAssetSymbol: null,
          canonicalFiatCurrency: null,
          mappingStatus: "pending_review",
          reviewerNotes: null,
          sourceNotes:
            "Observed Helius Solana mint without an approved TaxMaxi canonical asset mapping. Review required.",
        },
      ],
    })

  const loadProviderAssetMapping = ({
    providerAssetRowId,
  }: {
    readonly providerAssetRowId: string
  }) =>
    providerAssetRepository
      .findProviderAssetMapping({ providerAssetRowId })
      .pipe(Effect.map(Option.getOrNull))

  const ensureMappingForProviderAsset = ({
    reference,
    providerAsset,
  }: {
    readonly reference: NormalizedAssetReference
    readonly providerAsset: ProviderAssetRecord
  }) =>
    Effect.gen(function* () {
      const defaultMapping = defaultMappingForReference(reference)

      if (defaultMapping !== null) {
        yield* ensureDefaultMappingForProviderAsset({
          mapping: defaultMapping,
          providerAsset,
        })
      } else {
        yield* ensurePendingProviderAssetMapping(providerAsset)
      }

      const mapping = yield* loadProviderAssetMapping({
        providerAssetRowId: providerAsset.id,
      })

      if (mapping !== null) {
        return mapping
      }

      return yield* Effect.fail(
        toStorageError({
          operation: "heliusSolanaAssetResolutionService.ensureMappingForProviderAsset",
          cause: {
            providerAssetRowId: providerAsset.id,
            message: "Helius Solana provider asset mapping could not be persisted.",
          },
        })
      )
    })

  const validateApprovedMapping = ({
    reference,
    providerAsset,
    mapping,
  }: {
    readonly reference: NormalizedAssetReference
    readonly providerAsset: ProviderAssetRecord
    readonly mapping: ResolvedProviderAssetMapping
  }) =>
    Effect.gen(function* () {
      if (mapping.mappingStatus !== "approved") {
        return
      }

      if (mapping.mappingKind === "fiat" && mapping.canonicalFiatCurrency !== null) {
        return
      }

      if (mapping.canonicalAssetId === null) {
        return yield* Effect.fail(
          new HeliusSolanaBrokenApprovedProviderAssetMappingError({
            mintAddress: reference.mintAddress,
            providerAssetRowId: providerAsset.id,
            message: `Helius Solana provider asset mapping for ${providerAsset.currencyCode} is approved but has no canonical asset target.`,
          })
        )
      }

      const canonicalAsset = yield* assetRepository.findAssetById({
        assetId: mapping.canonicalAssetId,
      })

      if (Option.isNone(canonicalAsset)) {
        return yield* Effect.fail(
          new HeliusSolanaBrokenApprovedProviderAssetMappingError({
            mintAddress: reference.mintAddress,
            providerAssetRowId: providerAsset.id,
            message: `Helius Solana provider asset mapping for ${providerAsset.currencyCode} points at missing canonical asset ${mapping.canonicalAssetId}.`,
          })
        )
      }
    })

  const toResolvedAsset = ({
    reference,
    providerAsset,
    mapping,
  }: {
    readonly reference: NormalizedAssetReference
    readonly providerAsset: ProviderAssetRecord
    readonly mapping: ResolvedProviderAssetMapping
  }) =>
    Effect.gen(function* () {
      yield* validateApprovedMapping({
        reference,
        providerAsset,
        mapping,
      })

      return {
        kind: resolvedKindFromMapping(mapping),
        assetKind: assetKindFromProviderAsset(providerAsset),
        mintAddress: reference.mintAddress,
        providerAssetRowId: providerAsset.id,
        providerAssetId: providerAsset.providerAssetId,
        naturalKey: providerAsset.naturalKey,
        currencyCode: providerAsset.currencyCode,
        name: providerAsset.name,
        decimals: providerAsset.exponent,
        tokenProgram: storedTokenProgram(providerAsset),
        nftHint: storedNftHint(providerAsset),
        mappingStatus: mapping.mappingStatus,
        mappingKind: mapping.mappingKind,
        canonicalAssetId: mapping.canonicalAssetId,
        canonicalAssetSymbol: mapping.canonicalAssetSymbol,
        canonicalFiatCurrency: mapping.canonicalFiatCurrency,
      } satisfies HeliusSolanaResolvedAsset
    })

  const loadProviderAssetForReference = (reference: NormalizedAssetReference) =>
    reference.kind === "native"
      ? loadProviderAssetRecord({
          providerAssetId: null,
          naturalKey: NATIVE_SOL_NATURAL_KEY,
        })
      : reference.mintAddress === null
        ? Effect.succeed(null)
        : loadProviderAssetRecord({
            providerAssetId: reference.mintAddress,
            naturalKey: mintNaturalKey(reference.mintAddress),
          })

  const fetchDasAssetsForMissingMints = (mintAddresses: ReadonlyArray<string>) =>
    mintAddresses.length === 0
      ? Effect.succeed(new Map<string, DecodedDasAsset>())
      : heliusSyncClient
          .fetchAssetBatch({ mintAddresses })
          .pipe(Effect.flatMap(decodeDasAssetBatch))

  const ensureProviderAssetForReference = ({
    reference,
    dasAssets,
  }: {
    readonly reference: NormalizedAssetReference
    readonly dasAssets: ReadonlyMap<string, DecodedDasAsset>
  }) =>
    Effect.gen(function* () {
      const existing = yield* loadProviderAssetForReference(reference)

      if (reference.kind === "native") {
        if (existing !== null) {
          return existing
        }

        const defaultMapping = defaultMappingForReference(reference)
        if (defaultMapping !== null) {
          return yield* ensureProviderAssetRecord(
            providerAssetCatalogEntryForDefault(defaultMapping)
          )
        }
      }

      if (reference.mintAddress === null) {
        return yield* Effect.fail(
          toStorageError({
            operation: "heliusSolanaAssetResolutionService.ensureProviderAssetForReference",
            cause: "SPL asset reference unexpectedly had no mint address.",
          })
        )
      }

      const dasAsset = dasAssets.get(reference.mintAddress)
      if (dasAsset !== undefined) {
        return yield* upsertAndReloadProviderAssetRecord(providerAssetEntryFromDasAsset(dasAsset))
      }

      if (existing !== null) {
        return existing
      }

      return yield* ensureProviderAssetRecord(
        fallbackProviderAssetEntry({
          mintAddress: reference.mintAddress,
          rawProviderPayload: reference.rawProviderPayload,
        })
      )
    })

  const resolveNormalizedAssets = (
    references: ReadonlyArray<NormalizedAssetReference>
  ): Effect.Effect<ReadonlyArray<HeliusSolanaResolvedAsset>, HeliusSolanaAssetResolutionError> =>
    Effect.gen(function* () {
      const missingMintAddresses = yield* Effect.forEach(references, (reference) =>
        Effect.gen(function* () {
          if (reference.kind === "native" || reference.mintAddress === null) {
            return null
          }

          const existing = yield* loadProviderAssetForReference(reference)
          return existing === null || !hasHeliusDasPayload(existing) ? reference.mintAddress : null
        })
      )
      const distinctMissingMintAddresses = Array.from(
        new Set(
          missingMintAddresses.flatMap((mintAddress) => (mintAddress === null ? [] : [mintAddress]))
        )
      )
      const dasAssets = yield* fetchDasAssetsForMissingMints(distinctMissingMintAddresses)

      return yield* Effect.forEach(references, (reference) =>
        Effect.gen(function* () {
          const providerAsset = yield* ensureProviderAssetForReference({
            reference,
            dasAssets,
          })
          const mapping = yield* ensureMappingForProviderAsset({
            reference,
            providerAsset,
          })

          return yield* toResolvedAsset({
            reference,
            providerAsset,
            mapping,
          })
        })
      )
    })

  const resolveAssets: HeliusSolanaAssetResolutionServiceShape["resolveAssets"] = ({ assets }) =>
    Effect.gen(function* () {
      const normalizedReferences = yield* Effect.forEach(assets, normalizeReference)
      return yield* resolveNormalizedAssets(normalizedReferences)
    })

  const resolveAsset: HeliusSolanaAssetResolutionServiceShape["resolveAsset"] = (params) =>
    resolveAssets({ assets: [params] }).pipe(
      Effect.flatMap((resolvedAssets) => {
        const resolvedAsset = resolvedAssets[0]

        return resolvedAsset === undefined
          ? Effect.fail(
              toStorageError({
                operation: "heliusSolanaAssetResolutionService.resolveAsset",
                cause: "Expected one resolved Solana asset.",
              })
            )
          : Effect.succeed(resolvedAsset)
      })
    )

  return HeliusSolanaAssetResolutionService.of({
    ensureDefaultMappings,
    resolveAsset,
    resolveAssets,
  })
})

/**
 * HeliusSolanaAssetResolutionServiceLive - Live DAS-backed Solana asset resolver.
 */
export const HeliusSolanaAssetResolutionServiceLive = Layer.effect(
  HeliusSolanaAssetResolutionService,
  make
)

/**
 * Converts asset-reference counts into the provider refresh summary shape.
 */
export const toHeliusSolanaReferenceDataRefreshResult = ({
  providerAssetCatalogCount,
  defaultProviderAssetMappingCount,
}: HeliusSolanaAssetReferenceDataRefreshResult): HeliusSolanaReferenceDataRefreshResult => ({
  transactionTypeCatalogCount: 0,
  providerAssetCatalogCount,
  defaultTransactionMappingCount: 0,
  defaultProviderAssetMappingCount,
})
