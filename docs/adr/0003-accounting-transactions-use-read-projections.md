# Accounting transactions are served through read projections

TaxMaxi serves transaction activity through principal-owned read projections that assemble the accounting write model into transaction list and detail responses. This keeps accounting rules on the backend, gives API, CLI, and web clients one stable contract, and keeps the frequent transaction-browsing path bounded and measurable.

## Status

Accepted

## Context

Normalized accounting data is split across transactions, transaction legs, reviews, FIFO lots, disposal matches, inventory movements, canonical transfers, provider transfers, transfer reconciliations, venue context, onchain context, sources, and raw provider records. These tables are the durable write model and preserve the facts and decisions needed for replay, tax calculation, reconciliation, and audit.

The transaction UI needs a transaction-shaped view instead. A row combines classification, source, movements, review state, and aggregate tax results. Its inspector adds FIFO explanations, transfer reconciliation, provider evidence, and classification evidence.

The existing source transaction endpoint returns a thin transaction envelope with accounting legs. Separate tax-event, FIFO-lot, and disposal-explanation endpoints expose other parts of the model, but their rows and pagination do not align. Joining them in a client would duplicate accounting rules, make all-source pagination incorrect, and require several requests for one screen.

Transaction browsing is expected to be one of the most frequent authenticated operations. Users may move through many adjacent transactions during review, so list and detail reads must avoid unbounded joins, deep offsets, repeated counts, and one query per transaction.

## Constraints

- The accounting tables remain the source of truth. A read projection does not become a second write model.
- Ownership is checked by `principal_id` before accounting data is returned.
- The default view covers all sources owned by the principal and accepts an optional source filter.
- Accounting amounts remain decimal strings across persistence, REST, SDK, and UI boundaries.
- Missing valuation, incomplete FIFO matching, unknown tax treatment, and pending reconciliation remain explicit states. They are not converted to zero or guessed.
- Raw provider JSON and arbitrary metadata remain internal. Responses expose only selected evidence fields.
- Query count must stay bounded as page size grows. The implementation must not issue one query per transaction, movement, disposal, or FIFO lot.
- The read contract must allow the persistence implementation to change without changing API semantics.

## Decision

Introduce a first-class accounting transaction read projection with these authenticated REST resources:

- `GET /v1/transactions` lists transactions for the current principal. It accepts optional `sourceId`, cursor, limit, search, and filter parameters.
- `GET /v1/transactions/:transactionId` returns the inspector detail for one transaction owned by the current principal.

The SDK and CLI use the same resources. Source-specific transaction workflows pass `sourceId`; they do not use a separate transaction representation.

The list projection contains only data needed to render and navigate transaction rows:

- transaction identity and timestamp;
- canonical classification key, label, category, and review state;
- source identity, name, kind, provider, and safe display reference;
- accounting movements with asset, amount, fiat value, derivation, and available custody or reconciliation state;
- aggregate transaction value, fees, proceeds, cost basis, gain or loss, currency, tax treatment, and calculation status;
- stable external references needed for search and row identification.

The detail projection adds data that can grow independently of the list:

- disposal legs and matched FIFO lots;
- transfer and provider-transfer evidence;
- reconciliation status, reason, and confidence;
- venue or onchain context;
- selected provider evidence;
- the current classification and review explanation.

The list response does not include raw provider payloads, full metadata, or every FIFO match. The detail response also does not expose arbitrary raw JSON.

The backend owns accounting joins, tax aggregation, reconciliation semantics, and incomplete-data states. Clients own localized sentences, date and currency formatting, icons, badges, and shortened hashes or addresses. For example, the backend returns classification and movement data; the web app may render that data as “Swapped SOL for USDC.”

A real classification trail is returned only when durable classification events exist. The current transaction review snapshot must not be expanded into invented history. Exact valuation provenance is returned only when the valuation is durably linked to its source.

## Query strategy

The list implementation first selects one ordered page of transaction IDs. It then loads related rows for only those IDs through a fixed set of batch queries and assembles the projection in the persistence live layer. This avoids both row multiplication from one large join and N+1 queries.

Pagination uses a stable cursor over `(timestamp, transaction_id)`. The order is newest first, with the transaction ID as the tie-breaker. Deep offset pagination is not supported.

The normal list response does not run an exact `COUNT(*)` for every page. Unfiltered totals come from existing report or overview totals. A filtered search may omit an exact total or obtain it through a separate, independently cached query when the product requires one.

Search runs on selected, indexed fields such as canonical type, provider description, external reference, source name, and asset symbol. It does not search raw JSON or arbitrary metadata. Clients debounce search input and do not send a request for every keystroke.

The hot pagination paths require composite indexes equivalent to:

```text
transactions(principal_id, timestamp, id)
transactions(source_id, timestamp, id)
```

Related lookups require indexes by transaction or disposal origin, including transaction legs, inventory movements, provider transfers, transfer reconciliations, and disposal matches. Existing indexes are reused where they match the query. New indexes are added only after checking the query plan.

The default page size is 25 and the maximum page size is 100. List payloads should stay below 250 KB at the default page size under the benchmark dataset.

## Caching and navigation

Clients cache list pages by source filter, cursor, search, and other filters. Transaction details are cached by transaction ID. The web app may prefetch the previous and next transaction detail after a user selects a row.

Completed syncs, replay, classification changes, review changes, and reconciliation changes invalidate affected transaction pages and details. Shared caches must remain principal-scoped and must never serve one principal's accounting data to another.

HTTP validators or short-lived private caching may reduce repeated reads when they preserve these invalidation and ownership rules. Cache correctness takes priority over avoiding a database read.

## Performance validation

After the ADR is accepted and before the transaction read projection is considered production-ready, the implementation is tested with production-shaped data containing at least 100,000 transactions for one principal, multiple sources, several movements per transaction, and disposal legs matched across multiple FIFO lots.

The validation records:

- list and detail p50 and p95 server latency;
- database query count per request;
- query plans with `EXPLAIN ANALYZE` and buffer information;
- response size at the default and maximum page sizes;
- performance for all-source, source-filtered, searched, and review-filtered lists;
- repeated previous/next detail navigation with warm client caches.

The initial target is a server-side p95 below 300 ms for both the default list page and transaction detail on the benchmark environment. Query count must remain constant as the number of rows in a page increases. A missed target blocks production readiness or requires a recorded exception with the measured cause.

The first implementation reads from the normalized tables. If measured production-shaped queries cannot meet the latency target after bounded-query and index work, the persistence layer may introduce a denormalized transaction read table or another principal-scoped cache. That optimization must keep the REST and SDK contracts unchanged and define how sync, replay, review, and reconciliation updates refresh the projection.

## Considered Options

### Join existing accounting endpoints in each client

Rejected. Transaction, tax-event, FIFO-lot, and disposal rows have different identities and cursors. Clients would reproduce accounting aggregation, perform more requests, and disagree about incomplete or reconciled data.

### Return one eager transaction payload

Rejected. Loading every FIFO match, transfer, reconciliation, and evidence record in each list row makes the most frequent endpoint expensive and produces large repeated payloads.

### Use list and detail read projections over the normalized tables

Accepted. It gives clients a stable transaction contract, keeps common reads small, loads expensive evidence only on demand, and can be implemented with a bounded number of indexed queries.

### Create a denormalized transaction read table immediately

Deferred. It could make reads faster, but it introduces update, replay, repair, and consistency work before measurements show that indexed live projections are insufficient. The repository and API boundary preserve this option.

## Consequences

- Persistence gains an explicit accounting transaction read contract and live implementation.
- REST schemas and the SDK expose one principal-scoped transaction representation with an optional source filter.
- The CLI and web app stop joining accounting resources or defining their own tax aggregation rules.
- The web transaction table loads a small page first and inspector details on selection.
- The UI must display unknown, mixed, partial, and pending states instead of assuming every transaction has a complete EUR calculation.
- Transaction list and detail queries become named performance-sensitive paths with required benchmarks and query-plan review.
- Exact filtered counts are not guaranteed on every page.
- Classification history and valuation provenance require durable source data before the UI may present them as facts.
- A future denormalized read model can replace live joins without changing client contracts.
