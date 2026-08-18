# Asset reference catalog

TaxMaxi keeps trusted asset identity facts in
`packages/core/src/assets/AssetReferenceCatalog.ts`. Persistence seeds, Coinbase aliases, and
Helius Solana defaults are projections of this catalog. Provider sync reads those projections
locally and does not need an external request for a known alias.

## Format

The catalog has one `revision` and three ordered lists:

- `assets` defines chain-independent economic assets. `key` is the stable TaxMaxi key. Names,
  symbols, logos, and CoinGecko IDs are metadata and must not be used in place of `key`.
- `representations` defines one exact native asset, contract, or mint on one network. Each row
  points to one economic `assetKey` and records its decimals.
- `providerAliases` maps one exact provider-local identity to an economic asset and, when the
  provider identifies a network representation, to its `representationKey`.

Every row has a `source` with an authority and a reference. The current entries are TaxMaxi-
curated assertions reviewed in this repository. `sourceNotes` explains provider-specific aliases.

### Economic assets

The initial economic assets preserve the former persistence seed set. Their stable TaxMaxi keys
are independent of provider symbols and CoinGecko IDs.

### Network representations

The initial exact native, contract, and mint identities preserve the former persistence seed set.
Changing ownership of an existing exact representation is an identity correction, not a metadata
update, and needs explicit review.

### Coinbase aliases

Coinbase currency codes are chainless custody aliases. They point only to an economic asset. Fiat
currency handling remains outside this asset catalog.

### Helius Solana aliases

Helius Solana aliases identify native SOL or an exact mint and therefore point to both an economic
asset and a network representation.

## Contribution rules

1. Change the catalog instead of adding trusted identity constants to persistence or a provider.
2. Reuse an existing economic asset key only when authoritative evidence proves the same
   chain-independent asset. A shared symbol or name is not enough.
3. Use an exact network and contract or mint address for token representations. Native
   representations use the network plus `native` identity.
4. Keep asset keys, representation keys, and provider aliases unique. One exact representation
   cannot belong to two economic assets.
5. Add the referenced economic asset before adding its representation or provider alias. A
   network-specific provider alias must reference an existing representation owned by that asset.
6. Add a clear source reference and provider note. Do not treat unreviewed provider metadata as a
   trusted identity assertion.
7. Bump `revision` for every catalog change. Use `YYYY-MM-DD.N`, increasing `N` for another change
   on the same day.
8. Update catalog unit tests and the affected persistence or provider integration test. Run the
   focused package tests, type checks, and lint.

Catalog validation rejects duplicate stable keys, duplicate exact representations, conflicting
representation ownership, duplicate provider aliases, and references to missing assets or
representations. Projections preserve catalog order so generated seed and lookup data is stable.
