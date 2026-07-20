# Principal inventory replay

`POST /v1/sync-runs/replay` starts one replay for the authenticated principal. The run reserves a
source job for every current source, then rebuilds all cached raw rows in ascending occurrence time.
Source id, provider external id, and raw row id provide deterministic tie-breaking.

The replay always rebuilds the full principal. This keeps FIFO correct when source dependencies form
chains or cycles. Source-only replay remains available at `POST /v1/sources/:sourceId/replay` when the
source has no cross-source FIFO dependency.

Before reset, the run snapshots transaction reviews with status `approved` or `changed`, reviews
containing user notes, and transfer reconciliations with status `approved` or `rejected`. After
normalization, it restores those decisions when the rebuilt records have the same source and provider
identity. If a reviewed record is no longer produced, the run fails instead of silently discarding
the decision.

Every retry starts by reclaiming the whole plan, resetting the full principal again, and reusing the
original decision snapshot. A failed attempt therefore cannot be resumed from a mixture of old and
new inventory state.
