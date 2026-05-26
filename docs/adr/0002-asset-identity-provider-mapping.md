# Asset identity uses canonical assets and provider mappings

TaxMaxi separates canonical assets from provider-reported assets so sync can ingest unknown crypto assets without guessing their tax identity.

## Status

Accepted

## Context

TaxMaxi calculates taxes from normalized transactions. Normalization needs stable asset identity: the system must know whether a raw provider reference is canonical `SOL`, canonical `USDC`, an NFT, a spam token, an unsupported token, or an asset that still needs review.

Crypto providers and chains expose assets through provider-native identifiers such as Solana mint addresses, token programs, symbols, names, decimals, and metadata payloads. That metadata is useful evidence, but it is not authoritative TaxMaxi identity. Symbols can collide, names can lie, token metadata can change, and unknown assets are common.

That is especially important for crypto taxes because asset identity mistakes can poison cost basis and valuation.

## Constraints

- Canonical tax calculations must use TaxMaxi-owned asset identity, not raw provider metadata.
- Provider metadata must be preserved for provenance and later review.
- Unknown assets must not fail sync merely because TaxMaxi has not approved them yet.
- Unknown assets must not be silently treated as canonical assets.
- Native assets such as Solana `SOL` may use built-in reference data instead of external metadata calls.
- Provider-specific asset resolution belongs in the sync provider layer, not in core tax calculation logic.
- Replay after approval must resolve the same provider asset deterministically.

## Decision

Use two separate concepts:

- `assets` are canonical TaxMaxi assets used by normalized transactions, valuation, and tax calculation.
- `provider_assets` are assets as observed from an external provider, including provider identifiers and raw metadata.

Connect them through `provider_asset_mappings`.

An approved mapping means TaxMaxi has decided that a provider asset is safe to resolve to a canonical TaxMaxi asset or supported fiat/stablecoin convention. A pending mapping means the provider asset is known to TaxMaxi but not yet approved for canonical tax treatment.

For Solana, Helius asset resolution follows this lifecycle:

1. Native `SOL` resolves from built-in Solana reference data without a Helius DAS metadata call.
2. Known mints such as Solana USDC and USDT seed provider assets and approved mappings to canonical TaxMaxi assets.
3. Unknown SPL, Token-2022, and NFT-like mints are fetched through Helius DAS batch metadata where possible.
4. The resolver stores the provider asset with mint, symbol/name, decimals, token program, NFT hints, and raw provider payload.
5. The resolver creates a `pending_review` provider asset mapping instead of failing sync or fabricating a canonical asset.
6. A human or later review workflow approves the mapping after deciding whether to map to an existing canonical asset, create a new canonical asset, map to another supported convention, or leave it unresolved.
7. Replay after approval uses the approved mapping and does not need to rediscover the asset through provider metadata.

## Considered Options

1. Trust provider symbols and automatically map by symbol.
2. Automatically create canonical TaxMaxi assets for every unknown mint.
3. Fail sync whenever a provider reports an unknown asset.
4. Store provider assets separately and require explicit mappings to canonical assets.

## Consequences

- Sync can continue when new or obscure assets appear.
- Tax calculation remains protected from unreviewed provider metadata.
- Review workflows have the raw provider payload and provenance needed to make asset decisions.
- Most legitimate unknown tokens will become new TaxMaxi `assets` rows during review, then receive approved mappings.
- Duplicate symbols, spam tokens, bad metadata, and NFT-like assets can be handled explicitly instead of being normalized incorrectly.
- Replay can convert previously review-required records into canonical records once mappings are approved.
- The system needs product and operational surfaces for reviewing pending provider asset mappings before full production use.
