# Asset identity separates economic assets from network representations

## Status

Accepted, amended by issue 95, amended by issue 143

## Context

Tax calculation needs one stable identity for the thing a person owns. A unit of USDC remains the same economic asset when it is held at Coinbase, represented by a Solana mint, or represented by a contract on Ethereum or Base. Network data is still needed to decode quantities and prove exactly what moved, but it must not split FIFO lots, valuation, or portfolio reporting into separate assets.

Provider metadata is evidence, not TaxMaxi identity. Symbols can collide, names can be false, token metadata can change, and a custody provider may report an asset without naming a blockchain.

This decision uses four explicit terms:

- **Economic asset**: the chain-independent asset used by transfers, transaction legs, FIFO lots, valuation, portfolios, and tax reports. Examples are BTC, ETH, SOL, and USDC. It has a TaxMaxi ID, name, symbol, asset type, and optional market-data identity.
- **Network representation**: one exact native asset, contract, or mint for an economic asset on one blockchain. It owns the blockchain, representation type, contract or mint address, decimals, and representation metadata.
- **Provider observation**: an asset description received from an external provider. It keeps the provider ID or natural key, reported symbol, decimals or exponent, type, raw payload, and discovery times. It is not trusted as canonical identity.
- **Custody source**: a wallet, exchange account, or other source that holds or reports a principal's assets. A custody source may be chainless, so it does not imply a network representation.

## Decision

`assets` stores economic assets. It does not store a blockchain, contract, mint, or decimals.

`asset_representations` stores concrete network identities. Every row points to an economic `asset_id` and a `blockchain_id`. Native representations have no contract or mint. Token and NFT representations have exactly one contract or mint. Uniqueness constraints prevent two native assets on one blockchain and prevent duplicate contract or mint identities on one blockchain.

`provider_assets` stores provider observations. `provider_asset_mappings` records review decisions:

- An approved crypto mapping must have `canonical_asset_id`.
- A chainless observation such as Coinbase USDC may map only to economic USDC.
- An on-chain observation such as a Helius Solana mint maps to economic USDC and its exact `asset_representation_id`.
- Pending and rejected observations may remain unresolved.
- Symbols are display data and never an authoritative mapping target.

Normalized accounting data always uses the economic `asset_id`. Rows that describe or derive from a concrete on-chain movement may also keep `asset_representation_id`. FIFO matching, prices, portfolio totals, and reports group by economic asset ID, so moving one economic asset between networks or custody sources does not create a new tax asset.

Known economic assets and network representations use stable TaxMaxi reference IDs and exact chain reference data. Seeds and provider defaults create or resolve them idempotently. Duplicate symbols are allowed because identity comes from IDs and reviewed mappings, not symbols.

Trusted identity facts live in the version-controlled [asset reference catalog](../asset-reference-catalog.md). Persistence seed rows and provider-local lookup projections are derived from that catalog so providers do not maintain separate identity assertions.

## Provider resolution lifecycle

1. Store the provider observation and raw payload.
2. Resolve known custody observations by exact TaxMaxi reference ID.
3. Resolve known on-chain observations by blockchain plus native identity, contract, or mint.
4. Create a pending mapping for unknown observations without inventing an economic asset, and schedule one durable resolution job keyed by the observation and its evidence revision. A provider observation never becomes the economic asset or representation itself; it only maps to a TaxMaxi-owned identity.
5. Let the resolution job decide automatically or wait for a human reviewer:
   - The automatic policy may accept the job with exact chain evidence and CoinGecko evidence: it attaches a new network representation to an already-existing economic asset and records the evidence, the policy revision, the actor, and the decision as immutable audit history.
   - The automatic policy may create a standalone economic asset for an exact, supported representation when no plausible existing candidate, ownership conflict, or authoritative spam evidence exists. Names and symbols can only pause this outcome as a possible duplicate; they never prove a merge or separation.
   - Otherwise the observation stays pending for manual review, approved the same way as before: with an economic asset ID and, when the observation identifies a network representation, that representation ID.
   - Stale evidence or a stale decision revision fails its compare-and-set check instead of silently overwriting a newer observation, and a duplicate job run is a no-op.
6. Replay from the stored observation and approved mapping. An accepted resolution job durably schedules a replay for every affected source before any replay work starts; workers own replay retries and report persistent replay failure separately from the accepted identity decision, so a replay problem never rolls back an already-accepted mapping.

## Consequences

- USDC has one economic identity across Coinbase, Solana, Ethereum, Base, and future networks.
- Network decimals and addresses remain available for decoding and provenance without affecting economic identity.
- Chainless custody data does not invent a blockchain.
- Duplicate symbols cannot silently merge assets.
- Review and replay remain deterministic because mappings target IDs, whether a human reviewer or the automatic policy decided the mapping.
- This is a pre-launch hard migration. The old chain-bound asset schema and symbol mapping bridge are removed rather than supported in parallel.
