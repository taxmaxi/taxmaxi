# Results carry a factual core with jurisdiction treatment codes

## Status

Accepted

## Context

German tax vocabulary has leaked into shared contracts: `"tax_free"` appears in the REST API definition. "Tax-free after a one-year holding period" is a German §23 concept; the United States instead splits disposals into short-term and long-term rates. When jurisdiction vocabulary lives in a closed shared enum, adding a jurisdiction becomes a breaking API change.

## Decision

Engine results have two layers:

- A **factual core** that is the same for every jurisdiction. A disposal match carries acquisition date, disposal date, cost basis, proceeds, and gain or loss — which is simultaneously what §23 reporting and a US Form 8949 row need. Income results carry asset, quantity, value, and time.
- **Treatment codes** attached per jurisdiction: machine-readable strings such as `de.tax_free_holding_period` or, later, `us.short_term`. The set of codes a jurisdiction can emit is owned by that jurisdiction's engine module, not by a shared enum.

REST and SDK contracts expose treatment codes as codes. The frontend maps codes to localized copy, which the `apps/www` rules already require. No display text and no closed cross-jurisdiction enum in API responses.

## Consequences

- Adding a jurisdiction adds codes; it does not change existing response shapes or break existing clients.
- The existing `"tax_free"` value in the sources API is replaced during the engine migration, while contracts are already breaking.
- Report generators stay thin: they read the factual core and translate codes, rather than re-deriving rules (the holding-period rule currently duplicated between tax calculation and report generation collapses into the engine).
