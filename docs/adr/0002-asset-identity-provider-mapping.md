# Asset identity separates economic assets from network representations

TaxMaxi separates economic identity, network representation, provider observation, and custody source. This decision supersedes the original form of ADR 0002.

## Status

Accepted

## Context

One economic asset can exist in several places. USDC held at Coinbase has no required blockchain. USDC on Solana has a mint, while USDC on Ethereum and Base has a different contract on each chain. Treating each contract as a separate canonical asset splits valuation, inventory, FIFO, and portfolio reporting. Treating a symbol as identity can merge unrelated assets that share a symbol.

Provider metadata is evidence, not canonical identity. Providers can report aliases, duplicate symbols, incomplete decimals, or unknown assets. A custody source such as a Coinbase account or wallet describes where activity was observed; it is not an asset identity.

## Decision

TaxMaxi uses four explicit concepts:

- **Economic asset**: the fungible or non-fungible thing used by valuation, inventory, FIFO, portfolio, and tax reporting. `assets.id` is its authoritative identity. An economic asset has a display name, symbol, and optional external market-data identity, but no blockchain, contract, mint, decimals, or native/token kind.
- **Network representation**: one concrete form of an economic asset on a blockchain. `asset_representations` records `assetId`, `blockchainId`, native/token/NFT kind, contract address or mint, decimals, and representation metadata.
- **Provider observation**: the asset facts reported by an external provider. `provider_assets` preserves provider IDs, natural keys, symbols, exponents, types, and raw payloads without making them canonical.
- **Custody source**: the account, wallet, or address from which TaxMaxi imports activity. Sources preserve custody and ingestion lineage separately from asset identity.

An approved crypto provider mapping must target `canonicalAssetId`. It may also target `canonicalAssetRepresentationId` when the observation identifies a concrete network representation. It never targets a symbol.

A chainless observation such as Coinbase USDC maps only to economic USDC. An on-chain observation such as the Solana USDC mint maps to economic USDC and the exact Solana representation.

Normalized transfers and transaction legs use economic `assetId` for accounting and carry nullable representation provenance. FIFO lots, prices, valuation, and portfolio aggregation remain keyed by economic `assetId`; their source transfer or leg retains representation provenance when it exists.

## Constraints

- Symbols are display and search data. They are not unique and are never foreign keys or approved mapping targets.
- A contract address or mint is unique within one blockchain.
- A blockchain has at most one native representation.
- Native representations have no contract address or mint. Token and NFT representations require one.
- Representation decimals are non-negative.
- Known reference assets and representations are resolved by exact external IDs, blockchain IDs, and contract or mint values.
- Unknown or rejected provider observations remain provider observations and do not create canonical assets automatically.

## Consequences

- One USDC economic asset can aggregate Coinbase custody and several chain representations.
- Duplicate symbols do not force two economic assets to merge.
- Cross-chain transfers can preserve origin and destination representations while sharing one accounting asset.
- Provider review must choose an economic asset ID and, for on-chain observations, the exact representation ID.
- The pre-launch database uses a hard migration with a clean baseline rather than a symbol compatibility bridge.
