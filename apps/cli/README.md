<p align="center">
  <img src="https://www.taxmaxi.com/logo-wordmark.svg" alt="TaxMaxi logo" width="300" />
</p>

<p align="center"><strong>Official CLI for TaxMaxi</strong></p>

<p align="center" style="font-size:18px"><strong>Crypto tax infrastructure for fintechs, degens, and AI agents.</strong></p>

<p align="center"><em>Your "tax tool" labels half your transactions "Unknown". You spend a weekend fixing it. Every year.<br />Time to put an end to this.</em></p>

## What is TaxMaxi?

TaxMaxi is API-first crypto tax infrastructure.

Instead of a UI-only tax tool, TaxMaxi turns raw exchange and onchain activity into machine-readable, tax-ready events that can be consumed by:

- tax firms
- wallets and exchanges
- neobanks
- AI agents that need deterministic tax logic

Today, this CLI focuses on a Coinbase integration for German tax law. Under the hood, it uses the same TaxMaxi API primitives that product teams can integrate directly.

## Why this matters

- Crypto tax data is fragmented across exchanges and blockchains
- Existing tools often fail to categorize complex transactions automatically
- New regulation (for example DAC8 + MiCA in the EU) increases compliance pressure
- Agentic finance needs structured tax infrastructure, not manual spreadsheets

## Install

```bash
npm install -g tax
```

## Quick start

```bash
# run the full Coinbase workflow
tax coinbase
```

## Coinbase workflow

`tax coinbase` runs three steps in sequence:

1. `connect` - OAuth connect and local session caching
2. `sync` - sync Coinbase records into TaxMaxi
3. `calculate` - compute German tax summary for the selected year

You can also run each subcommand independently:

```bash
tax coinbase connect
tax coinbase sync
tax coinbase replay
tax coinbase calculate --year 2025
```

Use `tax coinbase replay` when you want to rebuild a source from cached raw Coinbase records after mapping or normalization logic changes, without refetching data from Coinbase.

## Useful flags

- `--json`: machine-readable output
- `--no-browser`: do not auto-open OAuth URL
- `--force`: force re-authentication
- `--year <YYYY>`: tax year for `calculate`

Internal note: TaxMaxi team can override the API endpoint with `TAXMAXI_API_URL`.

## Links

- Website: https://www.taxmaxi.com
- API: https://api.taxmaxi.com
