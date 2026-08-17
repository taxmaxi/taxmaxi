# Core

Core defines the shared tax and monetary concepts used throughout TaxMaxi.

## Language

**Supported fiat currency**:
A fiat monetary denomination that TaxMaxi recognizes by its canonical ISO currency code. It is not an economic asset and has no network representation.
_Avoid_: Fiat asset, canonical asset

**Fiat observation**:
A fiat currency description received from a provider's dedicated fiat catalog. An exact supported currency code resolves without provider asset review; unknown or conflicting evidence fails closed.
_Avoid_: Provider asset
