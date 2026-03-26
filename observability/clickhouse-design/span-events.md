# ClickHouse vNext Span Events Design

## Status

Working table design for `span_events`.

## Purpose

Define the logical shape, physical shape, and query contract for ClickHouse `v-next` tracing storage.

## v0 Model

Current v0 direction:

- persist only completed spans
- use `insert-only` tracing routing so the normal `batchCreateSpans` path receives only create records corresponding to `SPAN_ENDED`
- event spans should first be normalized so `endedAt = startedAt` when `isEvent = true` and `endedAt` is null
- after that normalization, persist the resulting row directly
- each stored row represents the final ended span state
- do not store `eventType`

This intentionally diverges from DuckDB's start/end event model.

## Trace Model

Current v0 direction:

- a trace is the set of spans sharing the same `traceId`
- the root span is the span whose `parentSpanId` is `null`
- `trace_roots` should own the root-span listing/filtering path
- `span_events` should own full-trace reads and point lookups within a trace
- trace-level filters should be evaluated against `trace_roots` unless the filter is explicitly trace-aggregate behavior such as `hasChildError`
- because trace listing operates on root spans, `entity*`, `parentEntity*`, and `rootEntity*` trace filters collapse to the same root-span entity values
- no separate physical parent/root entity columns are required on `span_events` in v0
- span tags should be treated as a root-span feature in v0
- non-root span tags should not be relied on for query behavior in v0

## Logical Shape

### IDs

- `traceId`
- `spanId`
- `parentSpanId`
- `experimentId`

### Entity

- `entityType`
- `entityId`
- `entityName`

### Context

- `userId`
- `organizationId`
- `resourceId`
- `runId`
- `sessionId`
- `threadId`
- `requestId`
- `environment`
- `source`
- `serviceName`
- `requestContext`

Important note:

- `requestContext` should be stored as a serialized JSON blob
- `requestContext` is retained for inspection only in v0
- `requestContext` should not participate in filtering, search, discovery, or grouping in v0

### Span-specific scalars

- `name`
- `spanType`
- `isEvent`
- `status`
- `startedAt`
- `endedAt`

### Searchable metadata

- `metadataSearch`

### Information-only payloads

- `attributes`
- `scope`
- `links`
- `input`
- `output`
- `error`
- `metadataRaw`

Important note:

- `input`, `output`, `scope`, `links`, `error`, `requestContext`, `attributes`, and `metadataRaw` should all be stored as JSON-encoded strings in ClickHouse
- the write path should preserve any JSON-serializable value shape for these fields, including scalar values
- the read path should JSON-decode them back into their original logical shapes

### Query-relevant flexible fields

- `tags`

## Span Status

Current v0 direction:

- store a typed `status` column
- allowed values:
  - `success`
  - `error`
- determine write-time `status` from the presence of span error information
- do not determine `status` by inspecting `output`

Important note:

- stored span `status` is not the same thing as the public trace `status` filter surface
- `span_events.status` only stores `success` or `error`
- `running` remains part of the public trace API, but ClickHouse `v-next` v0 intentionally returns no rows for it

## Event Span Normalization

Current v0 direction:

- event spans should be stored in ClickHouse as zero-duration spans
- when `isEvent = true` and `endedAt` is null on ingest, set `endedAt = startedAt` before persistence
- this normalization is ClickHouse-internal and exists to make ended-span-only storage workable for event spans

Important note:

- this means event spans should still be persisted from `SPAN_ENDED` tracing events even though the exported span shape does not carry a real end time
- if preserving the current public contract matters on reads, ClickHouse can normalize `endedAt` back to `null` for event spans when returning API records

## Metadata Model

Current v0 direction:

- keep the original metadata payload in `metadataRaw`
- return span `metadata` by reconstructing from `metadataRaw`
- flatten searchable metadata into dot-path string keys in `metadataSearch`
- keep only searchable string-string pairs in `metadataSearch`
- filter/search only against `metadataSearch`
- do not support searching non-string metadata values in v0
- `scope` remains a serialized JSON blob and should only be filtered through JSON extraction because the current trace filter schema exposes it

Important note:

- `metadataRaw` should be JSON-encoded at write time even when the original metadata contains scalar leaf values or mixed nested shapes
- `metadataRaw` exists for fidelity and response reconstruction, not as a fallback scan target for trace metadata filters

Important note:

- nested metadata objects should be flattened into dot-path keys before storage in `metadataSearch`
- example: metadata `{ user: { id: "u_123" } }` becomes `metadataSearch["user.id"] = "u_123"`
- only string leaf values should be indexed into `metadataSearch`
- `null`, empty strings, non-string scalar values, arrays, and objects should not be indexed into `metadataSearch`
- metadata keys that cannot be represented as a stable flattened path should be omitted from `metadataSearch` and remain available only in `metadataRaw`

Important note:

- this intentionally makes ClickHouse trace metadata filtering narrower than arbitrary JSON-path filtering
- if future ClickHouse version support allows native JSON columns with acceptable query behavior, revisit this contract rather than expanding `metadataSearch` indefinitely

Before writing `metadataSearch`, remove keys already promoted into typed columns, including:

- `userId`
- `organizationId`
- `resourceId`
- `runId`
- `sessionId`
- `threadId`
- `requestId`
- `environment`
- `source`
- `serviceName`

## Physical Shape

Current v0 direction:

- `ENGINE = MergeTree`
- `PARTITION BY toDate(endedAt)`
- `ORDER BY (traceId, endedAt, spanId)`

Additional notes:

- `startedAt` must be stored directly because there are no started-span rows to reconstruct it from
- `status`, `spanType`, `entityType`, `environment`, `source`, and `serviceName` are good `LowCardinality` candidates
- `PARTITION BY toDate(endedAt)` keeps the physical layout aligned with the stored ended-span model
- `PARTITION BY toDate(endedAt)` also keeps day-granularity TTL and partition expiry practical for tracing retention
- `ORDER BY (traceId, endedAt, spanId)` prioritizes full-trace reads and point lookups within a trace in v0
- event spans should have `startedAt = endedAt` after ClickHouse ingest normalization

## Query Contract

Current v0 direction:

- `getSpan`, `getRootSpan`, `getTrace`, and `listTraces` should operate only on completed spans/traces
- ClickHouse `v-next` v0 does not support live/running trace visibility
- `getSpan` and `getTrace` should read from `span_events`
- `getRootSpan` should read from `trace_roots`
- `listTraces` should read from `trace_roots`
- `span_events` should not be the main scan source for `listTraces`
- `hasChildError` should be computed at query time as "any span in the same trace has `status = error`"
- `hasChildError` should not require a stored helper column on `span_events` in v0
- if `hasChildError` later needs optimization, the preferred follow-up is a refreshable trace-level helper structure rather than a row-local column on `span_events`
- metadata filtering should target `metadataSearch`, not `metadataRaw`
- scope filtering should target the serialized `scope` payload via JSON extraction
- returned span records should reconstruct `metadata` from `metadataRaw`
- returned span records should populate `createdAt = startedAt` and `updatedAt = null` in v0

Metadata filter semantics in v0:

- trace metadata filters should support equality-only matching against flattened `metadataSearch` keys
- metadata filter values must be strings in v0
- metadata filters targeting non-string values should fail explicitly rather than silently return no rows
- metadata filters targeting keys that are not indexed into `metadataSearch` should fail explicitly rather than silently fall back to scanning `metadataRaw`
- metadata filters should not imply nested-object matching, array membership, wildcard, regex, or partial-match semantics in v0

Scope filter semantics in v0:

- trace `scope` filters should support nested-path equality via JSON extraction from the serialized `scope` payload
- `scope` filter behavior should be limited to exact equality on scalar JSON values in v0
- `scope` filter values may be strings, numbers, or booleans, but not arrays or objects
- `scope` filters should not imply wildcard, regex, or partial-match semantics in v0

Current public trace filter schema includes:

- `startedAt`
- `endedAt`
- `spanType`
- `entityType`
- `entityId`
- `entityName`
- `parentEntityType`
- `parentEntityId`
- `parentEntityName`
- `rootEntityType`
- `rootEntityId`
- `rootEntityName`
- `userId`
- `organizationId`
- `resourceId`
- `runId`
- `sessionId`
- `threadId`
- `requestId`
- `environment`
- `source`
- `serviceName`
- `scope`
- `experimentId`
- `metadata`
- `tags`
- `status`
- `hasChildError`

Important note:

- all trace filters other than `hasChildError` should be evaluated against the root span
- because trace filters are evaluated on the root span, `parentEntityType`, `parentEntityId`, `parentEntityName`, `rootEntityType`, `rootEntityId`, and `rootEntityName` should be treated as aliases of the root span's `entityType`, `entityId`, and `entityName`
- trace `metadata` filters should target `metadataSearch`
- trace `scope` filters should target the serialized `scope` payload
- ClickHouse should map normalized zero-duration event spans back to `endedAt = null` on reads to preserve the current public event-span shape

## Intentional v0 Limitations

- no live/running trace visibility
- no reconstruction from start/end span events
- `insert-only` routing intentionally keeps started-span writes out of the storage create path in v0
- no searching non-string metadata values
- no metadata grouping/discovery from `metadataRaw`
- no dedicated optimization for `hasChildError` beyond trace-local query structure in v0
