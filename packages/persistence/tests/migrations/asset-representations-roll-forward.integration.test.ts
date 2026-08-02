import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PgClient } from "@effect/sql-pg"
import * as Effect from "effect/Effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeIntegrationTestDatabaseContext } from "../support/integration-test-kit.ts"

const context = makeIntegrationTestDatabaseContext({
  databaseNamePrefix: "taxmaxi_asset_roll_forward",
})

const migrationFolder = fileURLToPath(new URL("../../drizzle", import.meta.url))
const rollForwardMigrationName = "20260802184334_petite_nova"
const oldMigrationsFolder = await mkdtemp(join(tmpdir(), "taxmaxi-old-migrations-"))

beforeAll(async () => {
  const migrationEntries = await readdir(migrationFolder, { withFileTypes: true })

  for (const entry of migrationEntries) {
    if (!entry.isDirectory() || entry.name === rollForwardMigrationName) {
      continue
    }

    await cp(join(migrationFolder, entry.name), join(oldMigrationsFolder, entry.name), {
      recursive: true,
    })
  }

  await Effect.runPromise(
    context.recreateTestDatabase({ migrationsFolder: oldMigrationsFolder })
  )
})

afterAll(async () => {
  await Effect.runPromise(context.destroyTestDatabase())
  await rm(oldMigrationsFolder, { recursive: true, force: true })
})

describe("asset representation roll-forward migration", () => {
  it("preserves existing asset data and rewrites chain-specific references", async () => {
    await context.runPg(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient

        yield* sql`
          insert into blockchains (
            id, name, chain_type, chain_id, native_asset_symbol, explorer_url,
            logo_url, coingecko_platform_id
          ) values
            ('00000000-0000-0000-0000-000000000101', 'solana', 'solana', null, 'SOL', null, null, 'solana'),
            ('00000000-0000-0000-0000-000000000102', 'ethereum', 'evm', 1, 'ETH', null, null, 'ethereum')
        `
        yield* sql`
          insert into assets (
            id, blockchain_id, contract_address, name, symbol, decimals,
            coingecko_coin_id, type, is_spam, created_at, updated_at
          ) values
            (
              '00000000-0000-0000-0000-000000000201',
              '00000000-0000-0000-0000-000000000101',
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              'USD Coin', 'USDC', 6, 'usd-coin', 'token', false,
              '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
            ),
            (
              '00000000-0000-0000-0000-000000000202',
              '00000000-0000-0000-0000-000000000102',
              '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
              'USD Coin', 'USDC', 6, 'usd-coin', 'token', false,
              '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
            )
        `
        yield* sql`
          insert into asset_prices (id, asset_id, timestamp, price, currency, updated_at) values
            (
              '00000000-0000-0000-0000-000000000301',
              '00000000-0000-0000-0000-000000000201',
              '2026-01-03T00:00:00Z', 1, 'EUR', '2026-01-03T00:00:00Z'
            ),
            (
              '00000000-0000-0000-0000-000000000302',
              '00000000-0000-0000-0000-000000000202',
              '2026-01-03T00:00:00Z', 1, 'EUR', '2026-01-02T00:00:00Z'
            )
        `
        yield* sql`
          insert into provider_assets (
            id, provider, natural_key, currency_code, retrieved_at
          ) values
            (
              '00000000-0000-0000-0000-000000000401',
              'coinbase', 'currency_code:USDC', 'USDC', now()
            ),
            (
              '00000000-0000-0000-0000-000000000402',
              'helius-solana',
              'solana:mint:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              'USDC', now()
            )
        `
        yield* sql`
          insert into provider_asset_mappings (
            provider_asset_row_id, mapping_kind, canonical_asset_id,
            canonical_fiat_currency, mapping_status
          ) values
            (
              '00000000-0000-0000-0000-000000000401',
              'asset', '00000000-0000-0000-0000-000000000202', null, 'approved'
            ),
            (
              '00000000-0000-0000-0000-000000000402',
              'asset', '00000000-0000-0000-0000-000000000201', null, 'approved'
            )
        `
      })
    )

    await Effect.runPromise(
      context.migrateTestDatabaseFromFolder({ migrationsFolder: migrationFolder })
    )

    const state = await context.runPg(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const assets = yield* sql<{
          readonly id: string
          readonly coingeckoCoinId: string | null
          readonly type: string
        }>`
          select id, coingecko_coin_id as "coingeckoCoinId", type
          from assets
          where coingecko_coin_id = 'usd-coin'
        `
        const representations = yield* sql<{
          readonly id: string
          readonly assetId: string
          readonly blockchainName: string
          readonly contractAddress: string | null
          readonly mintAddress: string | null
        }>`
          select
            representation.id,
            representation.asset_id as "assetId",
            blockchain.name as "blockchainName",
            representation.contract_address as "contractAddress",
            representation.mint_address as "mintAddress"
          from asset_representations as representation
          join blockchains as blockchain on blockchain.id = representation.blockchain_id
          order by blockchain.name
        `
        const prices = yield* sql<{ readonly assetId: string }>`
          select asset_id as "assetId" from asset_prices
        `
        const mappings = yield* sql<{
          readonly provider: string
          readonly canonicalAssetId: string | null
          readonly assetRepresentationId: string | null
        }>`
          select
            provider_asset.provider,
            provider_mapping.canonical_asset_id as "canonicalAssetId",
            provider_mapping.asset_representation_id as "assetRepresentationId"
          from provider_asset_mappings as provider_mapping
          join provider_assets as provider_asset
            on provider_asset.id = provider_mapping.provider_asset_row_id
          order by provider_asset.provider
        `

        return { assets, representations, prices, mappings }
      })
    )

    expect(state.assets).toEqual([
      {
        id: "00000000-0000-0000-0000-000000000201",
        coingeckoCoinId: "usd-coin",
        type: "fungible",
      },
    ])
    expect(state.representations).toEqual([
      expect.objectContaining({
        assetId: state.assets[0]?.id,
        blockchainName: "ethereum",
        contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        mintAddress: null,
      }),
      expect.objectContaining({
        assetId: state.assets[0]?.id,
        blockchainName: "solana",
        contractAddress: null,
        mintAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      }),
    ])
    expect(state.prices).toEqual([{ assetId: state.assets[0]?.id }])
    expect(state.mappings).toEqual([
      {
        provider: "coinbase",
        canonicalAssetId: state.assets[0]?.id,
        assetRepresentationId: null,
      },
      {
        provider: "helius-solana",
        canonicalAssetId: state.assets[0]?.id,
        assetRepresentationId: state.representations[1]?.id,
      },
    ])
  })
})
