<img width="2652" height="672" alt="GitHub README banner" src="https://github.com/user-attachments/assets/1faac63e-3afe-482a-b495-9fdcd2a64f97" />

# TaxMaxi

**The open source crypto tax API.**

TaxMaxi is crypto tax infrastructure for products that need tax logic built in from day one: wallets, exchanges, portfolio trackers, trading bots, accounting tools, fintech apps, and AI agents.

Crypto tax today is still too manual, too opaque, and too locked inside end-user dashboards. Every product that touches crypto eventually needs the same primitives: import activity, normalize it, classify it, apply jurisdiction-specific rules, and return a result that users and systems can trust. TaxMaxi makes those primitives available through a modular, transparent API.

Think Stripe or Slack, but for programmatic crypto taxation: RESTful endpoints, predictable data contracts, machine-readable responses, and a CLI that lets developers run the same workflows from a terminal.

## Why TaxMaxi exists

Crypto taxation needs open infrastructure.

The current market is full of closed tools that hide their assumptions, struggle with complex transaction histories, and leave developers with no clean way to embed tax-aware behavior into their own products. That does not work for a world of wallets, bots, exchanges, agents, and onchain finance.

TaxMaxi is built to establish open standards for crypto taxation:

- **API-first**: integrate tax workflows directly into your own product instead of sending users to a separate tax app.
- **Modular**: providers, chains, exchanges, classification logic, and jurisdictions are separate pieces that can evolve independently.
- **Transparent**: tax calculations should be explainable, inspectable, and reproducible.
- **Developer-friendly**: RESTful principles, simple primitives, and a CLI that can be installed as `tax` from npm.
- **Open source**: crypto tax logic is too important to live only in black boxes.

## What you can build with it

- Add tax previews to a wallet before a user swaps, sells, bridges, or transfers.
- Give a trading bot tax-aware PnL and disposal reporting.
- Let an exchange or broker expose jurisdiction-specific tax summaries.
- Build accounting, reporting, or compliance workflows on normalized crypto activity.
- Give AI agents deterministic tax primitives instead of letting them guess from CSV files.

## API

TaxMaxi exposes a RESTful crypto tax API at:

```text
https://api.taxmaxi.com
```

The OpenAPI specification is available at:

```text
https://api.taxmaxi.com/openapi.json
```

The goal is simple: tax infrastructure should feel like using a modern developer API. You should be able to create sources, sync activity, classify events, calculate tax results, and consume structured responses without reverse-engineering a tax product.

## CLI

TaxMaxi also ships as an npm CLI package named `tax`.

```bash
npm install -g tax
```

Calculate taxes for a wallet address:

```bash
`tax <your wallet address>`
```

Calculate taxes for your Coinbase account:

```bash
tax coinbase
```

Or run the steps separately:

```bash
tax coinbase connect
tax coinbase sync
tax coinbase calculate --year 2025
```

The CLI is not a separate product surface. It is the fastest way to try the same API primitives from your terminal.

## Support Matrix

TaxMaxi is pre-launch and in beta. The first supported jurisdiction is Germany, and the initial provider surface focuses on Coinbase and Solana activity.

### Chains and Exchanges

| Type | Provider | Status | Notes |
| --- | --- | --- | --- |
| Exchange | Coinbase | Supported | OAuth sync and German tax calculation workflow |
| Chain | Solana | In progress | Helius-backed activity sync and classification |
| Exchange | Binance | Planned | Planned exchange connector |
| Exchange | Kraken | Planned | Planned exchange connector |
| Chain | Ethereum | Planned | Planned EVM chain support |
| Chain | Base | Planned | Planned EVM chain support |
| Chain | Bitcoin | Planned | Planned UTXO chain support |

### Jurisdictions

| Jurisdiction | Status | Notes |
| --- | --- | --- |
| Germany | Supported | First tax ruleset and calculation target |
| Austria | Planned | Planned DACH expansion |
| Switzerland | Planned | Planned DACH expansion |
| United States | Planned | Planned future jurisdiction |
| United Kingdom | Planned | Planned future jurisdiction |

## Repository

This repository contains the public TaxMaxi platform:

- `apps/cli` - the installable `tax` CLI
- `apps/server` - the hosted REST API server
- `apps/worker` - background sync and classification worker
- `packages/core` - domain contracts and shared types
- `packages/persistence` - database schema and durable repositories
- `packages/rest-api` - API definitions and handlers
- `packages/sync-engine` - provider sync, normalization, replay, and classification
- `packages/sdk` - JavaScript SDK client

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run type-check
```

Run the API server locally:

```bash
pnpm run server:dev
```

Run the worker locally:

```bash
pnpm run worker:dev
```

## License

TaxMaxi is open source under the Apache-2.0 license.
