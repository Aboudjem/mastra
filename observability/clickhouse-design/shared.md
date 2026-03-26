# ClickHouse vNext Observability Shared Design

## Purpose

Capture the cross-cutting decisions for ClickHouse `v-next` so the per-table docs can stay focused on table-specific behavior.

## Scope

- support all five observability signals in the first `v-next` pass:
  - tracing via `span_events` plus `trace_roots`
  - `metric_events`
  - `log_events`
  - `score_events`
  - `feedback_events`
- keep the `v-next` code path isolated from the current ClickHouse observability implementation
- preserve the standard Mastra `ObservabilityStorage` integration surface with `DefaultExporter`

## Non-Goals

- reusing the current ClickHouse observability schema as the design driver
- finalizing every long-term optimization before the base tables exist
- forcing ClickHouse semantics to mirror DuckDB internals when ClickHouse-specific behavior is a better fit

## Core v0 Model

- use append-only `MergeTree` tables for all five signals
- use `insert-only` tracing routing in ClickHouse `v-next`
- persist only create records for completed spans
- normalize event spans so `endedAt = startedAt` when `isEvent = true` and `endedAt` is null before persistence
- use `span_events` as the tracing write target and full-trace read table
- use `trace_roots` as the root-span helper table for `listTraces` and `getRootSpan`
- populate `trace_roots` from `span_events` with an incremental materialized view
- use `discovery_values` and `discovery_pairs` as refreshable helper tables for discovery
- do not add physical `createdAt` or `updatedAt` columns to the `v-next` tables
- use raw ClickHouse DDL for the `v-next` schema

Expected `observabilityStrategy` direction:

- preferred: `insert-only`
- supported: `insert-only`

## Domain Layout

```text
stores/clickhouse/src/storage/domains/observability/v-next/
  index.ts
  ddl.ts
  metrics.ts
  tracing.ts
  trace-roots.ts
  logs.ts
  scores.ts
  feedback.ts
  discovery.ts
  filters.ts
  helpers.ts
```

## Write Path

The intended write path does not change:

1. observability signals are emitted from the runtime
2. `DefaultExporter` batches the events
3. the exporter calls the relevant `batchCreate*` method on the observability storage domain
4. ClickHouse `v-next` persists and queries those records through the standard storage interface

Important notes:

- in the current exporter implementation, `observabilityStrategy` affects tracing-event routing only
- metrics, logs, scores, and feedback still flow as create-only batched writes
- `insert-only` should keep started-span records out of the `batchCreateSpans` path in normal operation
- the current shared record builders do not yet populate every typed field required by the `score_events` and `feedback_events` designs
- that upstream score/feedback record-builder enrichment should land separately from the ClickHouse `v-next` storage PR

## Backend-Specific Trace Contract

ClickHouse `v-next` intentionally diverges from the broader tracing contract in these ways:

- it stores and returns only completed spans and traces
- `status = running` may still exist in the shared public API, but ClickHouse `v-next` v0 should return no rows for that filter
- trace filters are evaluated against the root span in this backend
- because trace filters are root-span-based here, `parentEntityType`, `parentEntityId`, `parentEntityName`, `rootEntityType`, `rootEntityId`, and `rootEntityName` behave as aliases of the root span's `entityType`, `entityId`, and `entityName`

Implementation tests should lock in this behavior explicitly rather than assuming cross-backend parity with live-running trace visibility.

## Shared Field Rules

### Column naming

- prefer public field names directly as ClickHouse column names when there is no real ambiguity inside the table
- do not introduce rename layers such as `spanName`, `metricName`, `feedbackSource`, or `scoreSource` in v0
- if a storage-specific rename ever becomes necessary later, keep it explicit and centralized

### Typed query-hot columns

- keep query-hot dimensions in typed columns
- do not hide stable product dimensions inside JSON if they need filtering, grouping, or discovery support

### Information-only JSON payloads

These fields stay off the hot query path in v0:

- `metadata`
- `scope`
- `costMetadata`
- log `data`
- span `attributes`
- span `links`
- span `input`
- span `output`
- span `error`
- span `requestContext`

Rules:

- store them as JSON-encoded strings
- preserve any JSON-serializable value shape, including scalars and `null`
- JSON-encode on writes and JSON-decode on reads
- do not use them for discovery or grouping
- `requestContext` is retained for inspection only and does not participate in filtering or search

Tracing is the exception for metadata:

- `span_events.metadataRaw` keeps the full logical metadata payload for fidelity and response reconstruction
- `span_events.metadataSearch` is a narrowed string-string search surface for trace metadata filters
- `trace_roots` uses the same `metadataRaw` / `metadataSearch` split as the root-row projection of `span_events`

### Query-relevant flexible fields

These flexible fields remain query-relevant in v0:

- `tags`
- `labels`
- `span_events.metadataSearch`
- `trace_roots.metadataSearch`

Current physical direction:

- `tags`: `Array(LowCardinality(String))`
- `labels`: `Map(LowCardinality(String), String)`
- `metadataSearch`: `Map(LowCardinality(String), String)`

Not every table needs `tags` or `labels`; this applies only where those fields exist.

## Shared Filter And Normalization Rules

Filter semantics:

- `tags` filters use contains-all semantics
- `labels` filters use contains-all semantics over exact key/value pairs
- unless a specific endpoint says otherwise, v0 does not imply wildcard, regex, prefix, substring, or fuzzy-match semantics for `tags` or `labels`

Normalization rules:

- `labels`: trim string values; drop `null`, non-string, and empty values
- `tags`: trim string values; drop `null`, non-string, and empty values; de-duplicate repeated tags within a row
- `metadataSearch`: flatten nested metadata objects into stable dot-path keys; keep only non-empty string leaf values; drop `null`, non-string values, arrays, and objects; remove keys already promoted into typed columns

Important note:

- `span_events.metadataSearch` and `trace_roots.metadataSearch` are intentionally narrower than arbitrary JSON-path filtering
- they are not meant to preserve every metadata-query behavior from backends that directly inspect arbitrary JSON values

## LowCardinality Guidance

Strong v0 candidates:

- `entityType`
- `parentEntityType`
- `rootEntityType`
- `environment`
- `source`
- `serviceName`
- metric `name`
- `provider`
- span `status`

Intentional v0 decisions:

- do not treat `entityId` or `entityName` fields as `LowCardinality`
- do not treat `model` as `LowCardinality`
- do not treat `feedback_events.value` as `LowCardinality`

## Discovery

- discovery queries should read from dedicated helper tables rather than scanning the signal tables directly
- maintain `discovery_values` and `discovery_pairs` with refreshable materialized views in v0
- discovery is intentionally eventually consistent in v0
- scores and feedback should not be forced into cross-signal entity discovery just for symmetry

## Deletes And Retention

Delete behavior:

- `batchDeleteTraces` and similar delete-style operations should use ClickHouse lightweight deletes
- assume eventual consistency for deletes
- `dangerouslyClearAll` should use `TRUNCATE TABLE`
- delete-style trace operations must apply to both `span_events` and `trace_roots`
- the incremental materialized view feeding `trace_roots` does not make deletes or truncation propagate automatically
- read-after-delete is not a strict correctness guarantee in ClickHouse `v-next` v0
- delete-path tests should verify successful execution and eventual disappearance semantics rather than immediate absence

Retention behavior:

- TTL should be configurable per signal in day increments
- tracing retention should apply consistently to both `span_events` and `trace_roots`
- day-based partitioning is the default physical strategy because it keeps day-granularity expiry and partition management straightforward
- v0 is optimized for signal-level retention, not for retaining selected trace subsets longer than their source signal tables

Future requirements such as "keep traces with scores for 30 days but drop ordinary traces after 10 days" are explicitly out of scope for v0. If that retention split becomes necessary later, it will likely require adjacent trace/span retention tables or another explicit archival/export path before source partitions are dropped.

## DDL And Helper Structures

- use raw ClickHouse DDL in `v-next/ddl.ts`
- do not try to force `Map(...)`, `Array(...)`, or `LowCardinality(...)` through the current generic storage-schema abstraction
- use one tracing helper structure in v0:
  - `trace_roots`
  - one incremental materialized view from `span_events` into `trace_roots`
- use two discovery helper structures in v0:
  - `discovery_values`
  - `discovery_pairs`
- keep `hasChildError` query-derived in v0
- if `hasChildError` later becomes a concrete performance problem, prefer a refreshable trace-level helper structure over row-local denormalization on `span_events` or `trace_roots`

## Testing Expectations

At minimum, `v-next` tests should cover:

- per-table write/read happy paths
- tracing insert-only routing with ended-span-only persistence
- `trace_roots` materialized-view population
- discovery helper refresh behavior
- per-table `ORDER BY` expectations where testable
- span `status`
- trace `hasChildError`
- `metadataRaw` vs `metadataSearch`
- exact filter-surface behavior per signal
- shared normalization rules
- mixed `costUnit` behavior in metrics responses
- delete eventual-consistency expectations

## Reference Behavior

- ClickHouse semantics are the primary reference for `v-next`
- DuckDB is a parity reference, not the source of ClickHouse query semantics
