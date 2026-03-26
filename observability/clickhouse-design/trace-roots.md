# ClickHouse vNext Trace Roots Design

## Status

Working table design for `trace_roots`.

## Purpose

Define the logical shape, physical shape, and query contract for the root-span helper table used by ClickHouse `v-next` trace listing queries.

## v0 Model

Current v0 direction:

- `trace_roots` should be a normal ClickHouse table
- `trace_roots` should be populated incrementally from `span_events` by a materialized view
- only completed root spans should be inserted into `trace_roots`
- `trace_roots` should stay close to the root-span shape rather than collapsing into a minimal summary row
- `trace_roots` exists to optimize `listTraces` and other root-span-oriented trace queries

Important note:

- application writes should continue targeting `span_events`; the materialized view should project root-span rows into `trace_roots`
- `trace_roots` is not a replacement for `span_events`

## Logical Shape

Current v0 direction:

- `trace_roots` should keep essentially the same logical shape as a root row in `span_events`
- this includes the same root-facing typed columns used by the public trace filter surface
- this also includes the same root payload fields needed for trace-list UI display so `listTraces` does not need a second hydration read in v0

Important note:

- `parentSpanId` should remain present and should always be `null` in `trace_roots`
- `trace_roots` should use the same root-row `metadataRaw` / `metadataSearch` split as `span_events`
- `trace_roots` should not store a dedicated `hasChildError` column in v0

## Physical Shape

Current v0 direction:

- `ENGINE = MergeTree`
- `PARTITION BY toDate(endedAt)`
- `ORDER BY (endedAt, traceId)`

Additional notes:

- `trace_roots` should be optimized for recent time-range filtering and ordering
- `trace_roots` should be materially smaller than scanning all spans because it contains only one row per trace
- the incremental materialized view should filter `parentSpanId IS NULL` from `span_events` inserts
- `PARTITION BY toDate(endedAt)` should stay aligned with `span_events` so tracing TTL can be managed consistently across both tables

## Query Contract

Current v0 direction:

- `listTraces` should read from `trace_roots`
- `getRootSpan` should read from `trace_roots`
- all root-span-oriented trace filters other than `hasChildError` should be evaluated against `trace_roots`
- filters asking for `status = running` should return no rows
- `hasChildError` should remain query-derived in v0
- when `hasChildError` is present, the query may use `span_events` for the child-span existence check while still using `trace_roots` as the main listing source
- if `hasChildError` later needs optimization, the preferred follow-up is a refreshable trace-level helper structure rather than a stored `trace_roots` column

Important note:

- trace `metadata` filters should target `metadataSearch`
- trace `scope` filters should target the serialized `scope` payload
- ClickHouse should map normalized zero-duration event spans back to `endedAt = null` on reads to preserve the current public event-span shape

## Intentional v0 Limitations

- no live/running trace visibility
- no stored `hasChildError`
- no dedicated summary-only schema for `trace_roots`; v0 should favor direct root-row usability over maximal storage minimization
