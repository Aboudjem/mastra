# ClickHouse vNext Observability Shared Design

## Status

Working shared design for the ClickHouse `v-next` observability domain.

## Purpose

Capture the decisions that apply across the ClickHouse `v-next` observability domain so the per-table docs can stay focused on table-specific behavior.

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

## Write Path Assumptions

The intended write path does not change:

1. observability signals are emitted from the runtime
2. `DefaultExporter` batches the events
3. the exporter calls the relevant `batchCreate*` method on the observability storage domain
4. ClickHouse `v-next` persists and queries those records through the standard storage interface

Important note:

- in the current exporter implementation, `observabilityStrategy` affects tracing-event routing only
- metrics, logs, scores, and feedback still flow as create-only batched writes
- this means ClickHouse can use `insert-only` exporter routing for tracing while leaving the other four signals on their existing create-only batched write path
- tracing event type is still visible inside `DefaultExporter` before `buildCreateSpanRecord` runs, but `insert-only` should keep started-span records out of the `batchCreateSpans` path in normal operation
- the current shared record-builders do not yet populate every field required by the `v-next` score/feedback designs
- the required score/feedback record-builder enrichment should be delivered in separate upstream work rather than inside the ClickHouse `v-next` implementation PR
- the `v-next` implementation should update the write path and record-builder layer as needed to populate the agreed typed columns

## Storage Strategy

Current v0 direction:

- use append-only tables for all five signals
- use `insert-only` exporter routing for tracing in ClickHouse `v-next`
- treat ended-span persistence as the actual tracing storage model in v0
- persist only tracing create events corresponding to completed spans
- first normalize event spans so `endedAt = startedAt` when `isEvent = true` and `endedAt` is null
- after that normalization, persist the resulting create records directly; storage should not need to discard started-span rows in v0
- use `span_events` as the tracing write target and full-trace read table
- use `trace_roots` as a helper table for root-span listing/filtering
- do not add physical `createdAt` or `updatedAt` columns to the append-only `v-next` tables
- do not use a mutation-oriented span table design as the primary model
- use `MergeTree` base tables in v0

Expected `observabilityStrategy` direction:

- preferred: `insert-only`
- supported: `insert-only`

## Backend-Specific Trace Contract

Current v0 direction:

- ClickHouse `v-next` intentionally stores and returns only completed spans and traces
- the shared public trace API may still expose `status = running`, but ClickHouse `v-next` v0 should return no rows for that filter
- trace filters should be evaluated against the root span in ClickHouse `v-next`
- because trace filters are root-span-based in this backend, `parentEntityType`, `parentEntityId`, `parentEntityName`, `rootEntityType`, `rootEntityId`, and `rootEntityName` should behave as aliases of the root span's `entityType`, `entityId`, and `entityName`

Important note:

- these are intentional ClickHouse `v-next` v0 tradeoffs, not accidental omissions
- implementation tests should lock in this backend-specific behavior explicitly rather than assuming cross-backend parity with live-running trace visibility

## Domain Layout

Planned layout:

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

## API To Storage Mapping

Current v0 direction:

- prefer using the public field names directly as ClickHouse physical column names when there is no meaningful ambiguity inside the table
- do not introduce rename layers such as `spanName`, `metricName`, `feedbackSource`, or `scoreSource` in v0
- if a field ever does require a storage-specific rename later, keep that mapping explicit and centralized rather than scattering it across query code

## Shared Field Policy

### Typed query-hot columns

Current v0 direction:

- keep query-hot dimensions in typed columns
- do not hide stable product dimensions inside JSON if we already know they need filtering, grouping, or discovery support

### Information-only semi-structured payloads

These fields should remain off the hot query path in v0:

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

Current v0 direction:

- store them as JSON-encoded strings
- keep them available for retention and inspection
- do not use them for discovery
- do not use them for grouping

Important note:

- JSON encoding here means the storage layer should preserve any JSON-serializable value shape, not just objects
- this includes strings, numbers, booleans, arrays, objects, and `null`
- the storage write path should JSON-encode these values before insert and JSON-decode them on reads
- `requestContext` is explicitly an information-only JSON payload in v0
- `requestContext` should not participate in filtering or search

Important note:

- this default `metadata` rule applies to metrics, logs, scores, and feedback
- tracing is the exception:
  - `span_events.metadataRaw` is information-only and stays off the hot path
  - `span_events.metadataSearch` is query-relevant and exists specifically for trace metadata filtering
  - `trace_roots` should follow the same tracing metadata split as the root-row projection of `span_events`

### Query-relevant flexible fields

These fields remain query-relevant in v0:

- `labels`
- `tags`
- `span_events.metadataSearch`
- `trace_roots.metadataSearch`

Current v0 direction:

- `tags` should use `Array(LowCardinality(String))`
- `labels` should use `Map(LowCardinality(String), String)`
- `span_events.metadataSearch` should use `Map(LowCardinality(String), String)`
- `trace_roots.metadataSearch` should use `Map(LowCardinality(String), String)`

Important note:

- the shared direction applies only where those fields actually exist on a table
- not every signal needs `labels`
- not every signal needs `tags`

## Shared Filter Semantics

Current v0 direction:

- `tags` filters should use contains-all semantics
- a row matches a `tags` filter only if it contains every requested tag value
- `labels` filters should use contains-all semantics over exact key/value pairs
- a row matches a `labels` filter only if every requested label key is present with the exact requested string value
- v0 should not imply wildcard, regex, prefix, substring, or fuzzy-match semantics for `tags` or `labels` unless a specific endpoint explicitly defines them

## Shared Normalization Rules

Normalization should live in shared code rather than being reimplemented separately per backend.

For `labels`:

- trim string values before storage
- drop entries whose value is `null`
- drop entries whose value is not a string
- drop entries whose trimmed value is empty

For `tags`:

- trim string values before storage
- drop `null` values
- drop non-string values
- drop entries whose trimmed value is empty
- de-duplicate repeated tags within the same row before insert

For `span_events.metadataSearch`:

- flatten nested metadata objects into stable dot-path keys before storage
- trim string values before storage
- drop entries whose value is `null`
- drop entries whose value is not a string
- drop entries whose trimmed value is empty
- remove keys already promoted into typed columns before storage

Important note:

- `span_events.metadataSearch` and `trace_roots.metadataSearch` are intentionally a narrowed string-string search surface in v0
- they are not intended to preserve all metadata query behaviors from backends that can directly inspect arbitrary JSON values

## Shared LowCardinality Guidance

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

## Discovery Policy

Current v0 direction:

- discovery queries should read from dedicated helper tables rather than scanning the signal tables directly
- use refreshable materialized views for discovery helper maintenance in v0

Cross-signal discovery should operate over the tables that actually carry those fields in the intended query path for v0:

- `discovery_values`
- `discovery_pairs`

Scores and feedback should not be forced into cross-signal entity discovery just for symmetry.

## Deletes And Clearing

Current v0 direction:

- `batchDeleteTraces` and similar delete-style operations should use ClickHouse lightweight deletes
- the design should assume eventual consistency for deletes
- `dangerouslyClearAll` should use `TRUNCATE TABLE`

Important note:

- delete-style trace operations should apply to both `span_events` and `trace_roots`
- the incremental materialized view feeding `trace_roots` does not make deletes or truncation propagate automatically
- refreshable discovery helpers should be rebuilt from current source data so discovery stays correct as source rows age out via deletes or TTL
- read-after-delete should not be treated as a strict correctness guarantee in ClickHouse `v-next` v0
- delete-path tests should verify successful execution and eventual disappearance semantics rather than assuming immediate absence after a lightweight delete

## Retention And TTL

Current v0 direction:

- TTL should be configurable per signal in day increments
- tracing retention should apply consistently to both `span_events` and `trace_roots`
- day-based partitioning should remain the baseline physical strategy because it keeps day-granularity expiry and partition management straightforward

Important note:

- v0 should optimize for signal-level retention, not for retaining selected trace subsets longer than their source signal tables
- future requirements such as "keep traces with scores for 30 days but drop ordinary traces after 10 days" are intentionally out of scope for v0
- if that retention split becomes necessary later, it will likely require dedicated adjacent trace/span retention tables or another explicit archival/export path before source partitions are dropped

## DDL Strategy

Current v0 direction:

- use raw ClickHouse DDL in `v-next/ddl.ts` for the observability base tables
- do not try to force `Map(...)`, `Array(...)`, or `LowCardinality(...)` through the current generic storage-schema abstraction

## Additional ClickHouse Structures

Current v0 direction:

- use one targeted helper structure for tracing in v0:
  - a normal `trace_roots` table
  - an incremental materialized view that projects root rows from `span_events` into `trace_roots`
- use two targeted helper structures for discovery in v0:
  - `discovery_values`, maintained by a refreshable materialized view
  - `discovery_pairs`, maintained by a refreshable materialized view
- keep `hasChildError` query-derived in v0
- if `hasChildError` later becomes a concrete performance problem, prefer a refreshable trace-level helper structure over row-local denormalization on `span_events` or `trace_roots`
- if a specific query becomes a concrete implementation problem, add a targeted optimization only with a measured reason

## Testing Requirements

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

## Implementation Notes

- ClickHouse semantics should be the primary reference for `v-next`
- DuckDB should be treated as a parity reference, not as the source of ClickHouse query semantics
- implementation should include explicit read/write adapters for the storage-column renames introduced by `v-next`
