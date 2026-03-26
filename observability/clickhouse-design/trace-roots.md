# ClickHouse vNext Trace Roots Design

## Purpose

Define the logical shape, physical shape, and query contract for `trace_roots`, the root-span helper table used by ClickHouse `v-next` trace-listing queries.

## Role In v0

- `trace_roots` is a normal ClickHouse table
- it is populated incrementally from `span_events` by a materialized view
- only completed root spans should be inserted into `trace_roots`
- it stays close to the root-row shape rather than collapsing into a minimal summary row
- application writes continue targeting `span_events`; `trace_roots` is a helper table, not a replacement

## Logical Shape

- keep essentially the same logical shape as a root row in `span_events`
- include the same root-facing typed columns used by the public trace filter surface
- include the same root payload fields needed for trace-list UI display so `listTraces` does not need a second hydration read in v0
- `parentSpanId` remains present and is always `null`
- use the same `metadataRaw` / `metadataSearch` split as `span_events`
- do not store a dedicated `hasChildError` column in v0

## Physical Shape

- `ENGINE = MergeTree`
- `PARTITION BY toDate(endedAt)`
- `ORDER BY (endedAt, traceId)`

Notes:

- optimize `trace_roots` for recent time-range filtering and ordering
- keep partitioning aligned with `span_events` so tracing TTL can be managed consistently across both tables
- the incremental materialized view should project only `parentSpanId IS NULL` rows from `span_events`

## Query Contract

- `listTraces` reads from `trace_roots`
- `getRootSpan` reads from `trace_roots`
- all root-span-oriented trace filters other than `hasChildError` are evaluated against `trace_roots`
- `status = running` returns no rows
- trace `metadata` filters target `metadataSearch`
- trace `scope` filters target the serialized `scope` payload
- when `hasChildError` is present, the query may use `span_events` for the child-span existence check while still using `trace_roots` as the main listing source

If `hasChildError` later needs optimization, prefer a refreshable trace-level helper structure rather than storing it directly on `trace_roots`.

## Intentional v0 Limitations

- no live or running trace visibility
- no stored `hasChildError`
- no dedicated summary-only schema for `trace_roots`; v0 favors direct root-row usability over maximal storage minimization
