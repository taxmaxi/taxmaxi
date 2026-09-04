# Solana historical pricing and Jupiter asset signals

**Research date:** 2026-08-24  
**Scope:** Historical EUR valuation of Solana and long-tail SPL assets, plus Jupiter signals that can reduce obvious spam before pricing.  
**Source standard:** First-party documentation, API references, terms, and public-chain specifications only.

## Answer in brief

CoinGecko Onchain is the API behind GeckoTerminal's on-chain data; it is a useful extension of CoinGecko, not an independent price source. For a Solana-focused product, Birdeye has the most convenient long-tail endpoint because it accepts a mint and an exact Unix timestamp. The most defensible source order for TaxMaxi is:

1. Use the actual consideration in the on-chain transaction for swaps.
2. Use Pyth for SOL and other assets for which Pyth has a feed.
3. Use Birdeye's point-in-time Solana endpoint for long-tail SPL tokens, subject to a commercial-data agreement.
4. Use a pinned CoinGecko Onchain/GeckoTerminal pool as secondary evidence.
5. Use Dune's DEX-derived prices or reconstruct a price from raw Solana DEX trades as the transparent fallback.

### Update 2026-08-24: TaxMaxi has a CoinGecko Analyst plan

The maintainer confirmed an active CoinGecko Analyst subscription, and the repo is already wired for it: `COINGECKO_PRO_API_KEY` is set and `packages/sync-engine/src/shared/CoinGeckoRequest.ts` switches every CoinGecko caller to `pro-api.coingecko.com` with the pro header when that key exists. This changes the source order above in two ways:

1. **CoinGecko Onchain moves ahead of Birdeye.** Analyst unlocks the full OHLCV depth (back to September 2021) on the token and pool endpoints, it rides the auth we already have, and it has no open licensing question — Birdeye's standard terms are still a blocker. Pin and store the pool ID per asset (pool endpoint, not the dynamic most-liquid-pool token endpoint) for repeatable evidence.
2. **EUR comes directly from CoinGecko for assets with a coin id.** Analyst also unlocks full history on the classic coins API (`/coins/{id}/history`, `/coins/{id}/market_chart`), which quotes EUR directly. Long-tail mints without a coin id still need a USD onchain price plus the ECB conversion below.

Revised order: executed swap value, then Pyth for SOL/majors, then CoinGecko classic (EUR, coin-id assets) and CoinGecko Onchain pinned pools (USD, mint-only assets), then Dune as backfill/second opinion, with Birdeye only if its licensing is resolved.

Jupiter does not provide historical prices. Beyond `banned`, its strongest useful signal is `audit.isSus`. Verification, Organic Score, mint/freeze authority, holder concentration, liquidity, trading activity, and pool age can support a **hide or quarantine** decision, but Jupiter's own documentation does not justify treating any one of them as proof that an asset does not exist. Keep suspicious assets in the ledger and tax calculation inputs even if the default portfolio UI hides them.

## What a German tax price must support

The German Federal Ministry of Finance says acquisition cost is the market price at the acquisition time and permits the price of an exchange or a web-based price list. A documented daily average, fixed-time daily price, or daily close may be accepted instead if it is applied consistently. The report must remain understandable from its records and settings; the ministry also lists the market price and its exchange/list source among the details that may be requested. See the official 6 March 2025 guidance, especially paragraphs 43, 90-91, and 102-104: [BMF guidance on crypto assets (PDF)](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte-bmf-schreiben.pdf?__blob=publicationFile&v=2).

This makes repeatability more important than finding the greatest number of nominal prices. A price from an unrecorded, changing "most liquid pool" is weaker evidence than a price tied to a pool/feed, timestamp, and documented rule. This note is a technical interpretation, not tax or legal advice.

Most Solana APIs return USD. TaxMaxi therefore needs one consistent USD-to-EUR policy and must save the applied rate. The ECB exposes historical reference-rate observations through its official data API; the USD/EUR series is `EXR/D.USD.EUR.SP00.A`: [ECB API guide](https://data.ecb.europa.eu/help/api/data) and [USD/EUR series endpoint](https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A). The policy must also define how weekends and days without a new ECB observation map to a rate.

## Historical price sources

| Source | Historical surface and coverage | Important limits | Fit for TaxMaxi |
| --- | --- | --- | --- |
| **Birdeye** | [`/defi/historical_price_unix`](https://docs.birdeye.so/reference/get-defi-historical_price_unix) returns a USD price for one Solana mint at a Unix timestamp. [`/defi/history_price`](https://docs.birdeye.so/reference/get-defi-history_price) returns a time range. [V3 OHLCV](https://docs.birdeye.so/reference/get-defi-v3-ohlcv) covers second through long candle intervals and up to 5,000 rows. | Exact-timestamp pricing is Solana-only. One-second history is retained for two weeks and 15/30-second history for three months. An API key and plan credits are required; the [package matrix](https://docs.birdeye.so/docs/data-accessibility-by-packages), [compute-unit table](https://docs.birdeye.so/docs/compute-unit-cost), and [pricing page](https://docs.birdeye.so/docs/pricing) define access. | Best ready-made address-based candidate for long-tail SPL assets. Save the timestamp returned and market-quality context because the public endpoint page does not fully specify how its point price is selected. **Licensing is a blocker:** Birdeye's standard [Data Services Terms](https://birdeye.so/data-api/terms-of-service) broadly restrict copying, downloading, storing, and distributing API data without permission. Obtain written product and tax-record retention rights before integrating it. |
| **CoinGecko Onchain / GeckoTerminal** | The [token OHLCV endpoint](https://docs.coingecko.com/reference/token-ohlcv-token-address) supports second, minute, hour, and day candles. Analyst plans and above can reach September 2021, limited by when GeckoTerminal began tracking the pool. The [pool OHLCV endpoint](https://docs.coingecko.com/reference/pool-ohlcv-contract-address) provides the same market data for a chosen pool. | Up to 1,000 rows per call and six months per request; fine-grained intervals have shorter useful windows. The token endpoint selects the token's **most liquid pool**, which can change. Empty intervals are skipped unless requested and are then filled from the prior close with zero volume. | Strong secondary source. Prefer the pool endpoint and save the pool ID; it is more repeatable than asking later which pool is most liquid. It is not independent of CoinGecko. The [API terms](https://www.coingecko.com/en/api_terms) allow paid-product integration under the applicable plan but restrict raw redistribution and place conditions on stored data, so confirm that long-lived tax evidence fits the contract. |
| **Pyth Core Benchmarks / Pyth Pro** | [Benchmarks historical data](https://docs.pyth.network/price-feeds/core/use-historical-price-data) returns a signed price update at or just after a requested time; the current [`/v2/updates/price/{publish_time}` reference](https://docs.pyth.network/api-reference/pyth-core/hermes/timestamp_price_updates) includes publish time, price, exponent, confidence, and slot-related data. [Pyth Pro History](https://docs.pyth.network/price-feeds/pro/api/history) adds exact timestamp, paged ranges, and OHLC resolutions from one minute through month. | Pyth is a curated feed catalogue, not an arbitrary-mint index. Its [Solana sponsored push-feed list](https://docs.pyth.network/price-feeds/core/push-feeds/solana) covers SOL and selected assets, not wallet spam and most meme tokens. Pro requires an API key. | Best evidence for SOL and supported majors: save feed ID, publish time, price, exponent, confidence, and signed update. Use it as the SOL/USD anchor when a long-tail swap is quoted in SOL. It cannot solve arbitrary SPL coverage. |
| **Dune** | [`prices_dex.minute/hour/day`](https://docs.dune.com/data-catalog/curated/prices/overview) exposes DEX-derived prices, while [`dex_solana.trades`](https://docs.dune.com/data-catalog/curated/dex-trades/solana/solana-dex-trades) exposes raw swap legs, mints, amounts, block time, slot, program, and transaction identifiers for independent reconstruction. | Dune documents a $10,000-volume inclusion threshold for DEX price coverage, best-effort methodology, and possible outliers. Queries use API keys and plan credits: [authentication](https://docs.dune.com/api-reference/overview/authentication), [billing](https://docs.dune.com/api-reference/overview/billing). Curated Solana data is not real-time. | Good batch/backfill and investigation source. Query `prices_dex.*`, not hybrid `prices.*`, when the goal is specifically DEX evidence rather than CoinPaprika-backed prices. For repeatability, store SQL, Dune execution ID/time, and result rows because maintained tables can be recomputed. Review the [Dune terms](https://dune.com/terms) and [SQL API addendum](https://dune.com/sql-api-terms) for product use. |
| **Direct Solana transaction / own DEX reconstruction** | [`getTransaction`](https://solana.com/docs/rpc/http/gettransaction) returns the slot, block time, instructions, inner instructions, native balances, and pre/post SPL balances described by Solana's [transaction JSON structures](https://solana.com/docs/rpc/json-structures). Helius [Enhanced Transactions](https://www.helius.dev/docs/api-reference/enhanced-transactions/gettransactions) adds parsed token/native transfers and timestamps. | The chain supplies asset amounts, not an intrinsic USD price. Multi-hop routes, fees, transfer taxes, shared accounts, and unsupported protocols must be decoded correctly. Transfers and airdrops without a market trade still need an external observation. | **First choice for an actual swap:** use its executed quote amount. A token/USDC execution is direct USD evidence; a token/SOL execution can use Pyth SOL/USD at the transaction time. For non-transaction valuation, build a documented median/VWAP window from trusted quote pools with minimum liquidity/trade rules and manipulation checks. Highest engineering cost, but clearest evidence. |
| **DefiLlama Coins** | The official [DefiLlama API SDK](https://github.com/DefiLlama/api-sdk) exposes exact historical, batch historical, and chart queries and accepts `solana:<mint>` keys. | Public documentation does not give a firm arbitrary-mint coverage, retention, or price-selection guarantee. Current [terms](https://defillama.com/terms) limit use to personal, non-commercial purposes unless DefiLlama gives written consent. | Convenient for prototypes or a second opinion, not a primary commercial tax source without a data agreement and methodology review. |

Other reasonable secondary candidates are pool-level [DexPaprika OHLCV](https://docs.dexpaprika.com/api-reference/pools/get-ohlcv-data-for-a-pool-pair), whose [API terms](https://dexpaprika.com/api/terms) require a paid plan for commercial use and attribution, and raw [Bitquery Solana DEX trade history](https://docs.bitquery.io/docs/blockchain/Solana/solana-dextrades/). Both add provider and venue diversity, but neither is as simple as Birdeye's mint-plus-timestamp endpoint.

### APIs that do not solve historical pricing

- Jupiter Price V3 returns a current USD price only, for up to 50 mints per request. Jupiter says tokens must have traded within the last seven days and pass its reliability heuristics, and explicitly tells consumers that need history to poll and store prices themselves: [Jupiter Price V3 guide](https://developers.jup.ag/docs/guides/how-to-get-token-price).
- Helius `getAsset` exposes only a current price, limited to the top 10,000 tokens by 24-hour volume and cached for up to 600 seconds; it is not a historical price endpoint: [Helius `getAsset`](https://www.helius.dev/docs/api-reference/das/getasset).

## Deprecation and change check as of 2026-08-24

- CoinGecko token and pool OHLCV, Birdeye V3 OHLCV, Jupiter Tokens V2/Price V3, Dune's query APIs, and DefiLlama's official SDK are current in their official documentation.
- Birdeye's old `/defi/ohlcv` endpoint is deprecated; use `/defi/v3/ohlcv`: [legacy endpoint notice](https://docs.birdeye.so/reference/get-defi-ohlcv).
- Jupiter Ultra Shield is deprecated because Ultra was superseded by Swap V2. Do not add a new Shield dependency: [Shield reference and deprecation banner](https://developers.jup.ag/docs/ultra/get-shield).
- Pyth's older Hermes `get_price_feed` and `get_vaa` methods are deprecated in favor of V2: [Hermes API reference](https://docs.pyth.network/api-reference/pyth-core/hermes). More importantly, Pyth's Core upgrade is scheduled for **2026-08-26 at 16:00 UTC**; the public endpoints will require an API key and new integrations should use the upgraded contracts: [Pyth Core upgrade preparation](https://docs.pyth.network/price-feeds/core/upgrade/preparing). This is two days after this research date and must be handled before adopting Pyth.
- Solana's `getConfirmedSignaturesForAddress2` is deprecated; transaction discovery should use [`getSignaturesForAddress`](https://solana.com/docs/rpc/http/getsignaturesforaddress).

## Jupiter signals beyond `banned`

Jupiter defines three verification levels: verified, unverified, and banned. It describes unverified tokens as possibly legitimate and banned tokens as malicious/scam/misleading. Jupiter also exposes Organic Score, audit information, market data, and trading statistics: [Tokens API overview](https://developers.jup.ag/docs/tokens) and [token-information guide](https://developers.jup.ag/docs/guides/how-to-get-token-information).

| Signal | What the official API says | TaxMaxi action |
| --- | --- | --- |
| `banned` verification level | Jupiter says not to display banned tokens or to show a clear warning. | **Hard UI exclusion** is reasonable. Preserve raw balances, transfers, and classification evidence in the ledger. |
| `audit.isSus` | Optional flag present when Jupiter's audit marks a token suspicious; absence is not a safety guarantee. | Strong **quarantine/hide-by-default** signal. Do not make it irreversible by itself. |
| `isVerified === false` | Unverified does not mean banned and may still be legitimate. | Warning or quarantine input only. Never hard-exclude alone. |
| `organicScore` and `organicScoreLabel` | Organic Score uses organic volume, holders, traders, and buyers. It is relative across the ecosystem; Jupiter recommends the raw score over broad labels, and warns that new-token scores can be volatile: [Organic Score explanation](https://developers.jup.ag/blog/what-is-organic-score). | Use the raw score as one ranking feature. Low score may hide dust in the portfolio UI, but it is not proof of spam. Save the observed score and time because it changes. |
| `audit.mintAuthorityDisabled`, `audit.freezeAuthorityDisabled` | Enabled mint/freeze authority is a documented risk signal. | Warning/quarantine input. Legitimate issued assets may retain authority, so never exclude alone. |
| `audit.topHoldersPercentage`, `audit.devBalancePercentage`, `audit.devMints` | These expose concentration and developer holdings/mints when available. | Stronger when combined with low organic activity and low liquidity. Custodians, pools, and treasuries can distort concentration, so do not use a single hard threshold without validation. |
| `liquidity`, `holderCount`, `stats5m/1h/6h/24h`, `firstPool.createdAt` | The search response exposes current liquidity, holders, buy/sell/trader/volume statistics, and first-pool metadata: [Tokens search schema](https://developers.jup.ag/docs/api-reference/tokens/search). | Use for a combined spam score and price-quality gate: tiny liquidity, almost no organic buyers, no credible trading, high concentration, and a new pool together are useful evidence. No liquidity/no price means **unpriceable**, not necessarily fake. |
| `tags` | Public schema defines free-form tags and Jupiter documents supported categorization tags such as verified/LST/stocks. | Useful metadata, but do not invent semantic meaning for undocumented tags. |

The old Shield endpoint exposed warnings including `NOT_VERIFIED`, `LOW_ORGANIC_ACTIVITY`, `NEW_LISTING`, `HAS_FREEZE_AUTHORITY`, and `HAS_MINT_AUTHORITY`, which confirms these are intended as warnings rather than all being bans. Because Shield is deprecated, derive equivalent warnings from current Tokens data instead of calling it: [deprecated Shield documentation](https://developers.jup.ag/docs/ultra/get-shield).

### Important contract gap around `banned`

The current public Tokens search schema exposes `isVerified`, `tags`, and `audit`, but does not expose a dedicated `banned: boolean` field, and its `tags` field is only documented as a free-form string array: [Tokens search schema](https://developers.jup.ag/docs/api-reference/tokens/search). Jupiter's overview documents the banned **verification level**, but the public schema does not promise that it arrives specifically as a `"banned"` tag.

Therefore, a TaxMaxi mapping of `tags.includes("banned")` should be treated as an observed upstream convention, not a fully documented contract. Before relying on it as the only hard exclusion, retain real response fixtures, monitor for schema drift, and fail toward quarantine if the signal disappears or changes shape.

### What the local wallet run shows

The test run supplied with this review is a useful example of why these states must stay separate:

- `PWEASE` received a usable market price, despite being a long-tail token.
- `MMELLOW` and `PPAIN` were reported as `low_activity`, and `MMLDAO` was not indexed by Jupiter; none had a usable displayed price.
- None of those outcomes was an explicit `banned` verdict.

The extra Jupiter fields would have helped rank or hide those assets before spending more pricing effort, but they would not justify deleting them from accounting. In particular, `low_activity`, not indexed, and no reliable current price should lead to **quarantined or visible-but-unpriced**, not **excluded**. The native SOL marker problem is separate from this spam/priceability policy.

## Recommended TaxMaxi policy

### Price selection

1. **Swap:** derive the event's value from the actual executed consideration. Use the stablecoin amount directly, or multiply a SOL quote by Pyth SOL/USD at the event time.
2. **Non-swap, supported major:** use the Pyth point update nearest the documented side of the event timestamp.
3. **Long-tail SPL:** query Birdeye at the event timestamp, after licensing is resolved.
4. **Cross-check/fallback:** use a pinned CoinGecko Onchain pool, with a declared candle rule and minimum market-quality rules.
5. **Last resort:** query Dune DEX prices or reconstruct a robust price from raw Solana trades around the event.
6. **Unsafe market:** return a typed `price_unavailable` reason. Do not manufacture a value merely to make a portfolio total complete.

For every accepted price, store:

- provider, endpoint/API version, chain, mint, and requested timestamp;
- returned timestamp or candle boundaries and timezone;
- price, quote currency, pool/feed ID, block/slot where available;
- liquidity, volume, trade count, confidence, or other acceptance evidence;
- raw response or a canonical response hash, plus retrieval time;
- USD/EUR source, rate, observation date, and weekend rule;
- pricing-policy version, fallback step, and any manual correction.

Historical reports should keep their saved evidence. A later provider history change should not silently reprice a filed report; it should require an explicit re-run under a new policy/version.

### Asset visibility

Use three states rather than `show`/`delete`:

- **Excluded from the normal asset list:** explicit Jupiter banned signal, while retaining records.
- **Quarantined/hidden by default:** `audit.isSus`, or a combination of unverified + very low raw organic activity + negligible liquidity/trading + high concentration/new pool.
- **Visible but unpriced:** credible or uncertain assets for which no reliable market observation exists.

Do not hard-code numeric Jupiter thresholds from this research. Jupiter provides no official universal cutoffs for "spam" beyond its explicit banned classification. Calibrate thresholds against a labelled set of real TaxMaxi wallets, record the evidence that led to each classification, and allow a user override. Most importantly, keep price availability separate from legitimacy: a manipulated scam can have a price, while a legitimate illiquid asset may not.
