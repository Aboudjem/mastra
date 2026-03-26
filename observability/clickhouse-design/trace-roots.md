# ClickHouse vNext Trace Roots Design

## Purpose

Define the logical shape, physical shape, and query contract for `trace_roots`, the root-span helper table used by ClickHouse `v-next` trace-listing queries.

## Role In v0

- `trace_roots` is a normal ClickHouse table
- it is populated incrementally from `span_events` by a materialized view
- only completed root spans should be inserted into `trace_roots`
- it stays close to the root-row shape rather than collapsing into a minimal summary row
- application writes continue targeting `span_events`; `trace_roots` is a helper table, not a replacement
- delete, truncate, and TTL behavior must be managed explicitly on `trace_roots`; they do not propagate from `span_events`

## Logical Shape

- keep essentially the same logical shape as a root row in `span_events`
- include `dedupeKey`, matching the root row's `span_events.dedupeKey`
- include the same root-facing typed columns used by the public trace filter surface
- include the same root payload fields needed for trace-list UI display so `listTraces` does not need a second hydration read in v0
- `parentSpanId` remains present and is always `null`
- use the same `metadataRaw` / `metadataSearch` split as `span_events`
- do not store a dedicated `hasChildError` column in v0

## Physical Shape

- `ENGINE = ReplacingMergeTree`
- `PARTITION BY toDate(endedAt)`
- `ORDER BY (startedAt, traceId, dedupeKey)`

Notes:

- optimize `trace_roots` for the default `listTraces` read pattern, which orders by `startedAt`
- keep partitioning aligned with `span_events` on `endedAt` so tracing TTL can be managed consistently across both tables
- the incremental materialized view should project only `parentSpanId IS NULL` rows from `span_events`
- the incremental materialized view should carry through the root row's `dedupeKey`
- `ORDER BY (startedAt, traceId, dedupeKey)` keeps the list-oriented sort while making `dedupeKey` part of the replacement identity
- retry-idempotency in v0 assumes duplicate root rows for the same `dedupeKey` are byte-identical
- because this is an incremental materialized-view target, deletes and truncation must be issued directly against `trace_roots`

## Query Contract

- `listTraces` reads from `trace_roots`
- `getRootSpan` reads from `trace_roots`
- all root-span-oriented trace filters other than `hasChildError` are evaluated against `trace_roots`
- trace status filtering is derived from the root row rather than a stored `status` column:
  - `status = error` means `error IS NOT NULL`
  - `status = success` means `error IS NULL`
  - `status = running` returns no rows in v0 because only completed rows are stored
- trace `metadata` filters target `metadataSearch`
- trace metadata filtering is intentionally limited to top-level string equality in v0
- trace `scope` filtering is intentionally unsupported in v0
- when `hasChildError` is present, the query should use `span_events` for the child-span existence check while still using `trace_roots` as the main listing source
- `hasChildError` means that some non-root span in the same trace has `error IS NOT NULL`
- `getRootSpan` should filter by root tracing identity and use ordinary `LIMIT 1`
- `listTraces` should use a two-stage query shape:
  - inner query: narrow the candidate root row set first, apply a deterministic pre-dedupe `ORDER BY`, then use `LIMIT 1 BY dedupeKey`
  - outer query: apply final presentation ordering and pagination over the deduplicated root row set
- `listTraces` count queries should count from the same filtered-and-deduplicated inner query shape rather than counting raw `trace_roots` rows
- because duplicate tracing rows are required to be byte-identical in v0, the pre-dedupe ordering only needs to be deterministic; it is not selecting between semantically different row versions
- the `hasChildError` existence check does not need `FINAL` or separate deduplication in v0, because duplicate child-span rows do not change the boolean result
- `batchDeleteTraces` should issue a matching lightweight delete against `trace_roots`
- `dangerouslyClearAll` should explicitly truncate `trace_roots`

If `hasChildError` later needs optimization, prefer a refreshable trace-level helper structure rather than storing it directly on `trace_roots`.

## Intentional v0 Limitations

- no live or running trace visibility
- no stored `hasChildError`
- no scope filtering
- no dedicated summary-only schema for `trace_roots`; v0 favors direct root-row usability over maximal storage minimization
