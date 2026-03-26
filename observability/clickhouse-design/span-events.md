# ClickHouse vNext Span Events Design

## Purpose

Define the logical shape, physical shape, and query contract for `span_events`, the full-trace table in ClickHouse `v-next`.

## Stored Model

- persist only completed spans
- use `insert-only` tracing routing so `batchCreateSpans` receives create records derived from `SPAN_ENDED`
- normalize event spans so `endedAt = startedAt` when `isEvent = true` and `endedAt` is null before persistence
- persist the resulting row directly; do not store `eventType`
- each stored row represents the final ended span state

This intentionally diverges from DuckDB's start/end event model.

## Trace Role

- a trace is the set of spans sharing the same `traceId`
- the root span is the span whose `parentSpanId` is `null`
- `span_events` owns `getTrace` and `getSpan`
- `trace_roots` owns `listTraces`, `getRootSpan`, and the root-span listing/filtering path
- trace-level filters should be evaluated against `trace_roots` unless the filter is explicitly aggregate behavior such as `hasChildError`
- in v0, trace tag behavior should be treated as root-span behavior; non-root span tags are not part of the trace-listing contract

## Logical Shape

IDs:

- `traceId`
- `spanId`
- `parentSpanId`
- `experimentId`

Entity and context:

- `entityType`
- `entityId`
- `entityName`
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

Span-specific scalars:

- `name`
- `spanType`
- `isEvent`
- `status`
- `startedAt`
- `endedAt`

Query-relevant flexible fields:

- `tags`
- `metadataSearch`

Information-only JSON payloads:

- `attributes`
- `scope`
- `links`
- `input`
- `output`
- `error`
- `metadataRaw`

Important notes:

- `requestContext`, `attributes`, `scope`, `links`, `input`, `output`, `error`, and `metadataRaw` are stored as JSON-encoded strings
- the write path should preserve any JSON-serializable value shape for those fields, including scalar values
- `requestContext` is retained for inspection only and does not participate in filtering, search, discovery, or grouping

## Stored Semantics

Status:

- store a typed `status` column with allowed values `success` and `error`
- determine write-time `status` from the presence of span error information
- do not infer `status` from `output`
- `span_events.status` is not the same thing as the broader public trace `status` surface

Event spans:

- event spans are stored as zero-duration spans in ClickHouse
- they should still be written from `SPAN_ENDED` tracing events even if the exported span shape does not carry a real end time
- if preserving the current public contract matters on reads, ClickHouse can map normalized event spans back to `endedAt = null`

Read-path shaping:

- `startedAt` must be stored directly because there are no started-span rows to reconstruct it from
- returned span records should reconstruct `metadata` from `metadataRaw`
- returned span records should populate `createdAt = startedAt` and `updatedAt = null` in v0

## Metadata And Scope Contract

`metadataRaw`:

- stores the original metadata payload for fidelity and response reconstruction
- is JSON-encoded on write even when the logical metadata contains scalar values or mixed nested shapes
- is not a fallback scan target for trace metadata filters

`metadataSearch`:

- stores a top-level string-string index of trace metadata
- only top-level metadata entries whose values are non-empty strings are indexed
- `null`, empty strings, non-string scalar values, arrays, and objects are not indexed
- nested objects and arrays remain available only in `metadataRaw`
- before writing `metadataSearch`, remove keys already promoted into typed columns such as `userId`, `organizationId`, `resourceId`, `runId`, `sessionId`, `threadId`, `requestId`, `environment`, `source`, and `serviceName`

Metadata filter semantics:

- trace metadata filters support equality-only matching against top-level `metadataSearch` keys
- only top-level string metadata values are searchable in v0
- metadata filters that target non-string values, nested values, or non-indexed keys should simply return no rows rather than throw
- v0 does not imply nested-object matching, array membership, wildcard, regex, or partial-match semantics for trace metadata

`scope`:

- stays as a serialized JSON blob for inspection only
- `scope` does not participate in filtering, search, discovery, or grouping in v0

If future ClickHouse version support makes native JSON columns practical, revisit this contract instead of expanding `metadataSearch` indefinitely.

## Physical Shape

- `ENGINE = MergeTree`
- `PARTITION BY toDate(endedAt)`
- `ORDER BY (traceId, endedAt, spanId)`

Notes:

- `PARTITION BY toDate(endedAt)` keeps the physical layout aligned with the ended-span storage model
- it also keeps day-granularity TTL and partition expiry practical for tracing retention
- `ORDER BY (traceId, endedAt, spanId)` prioritizes full-trace reads and point lookups within a trace
- `status`, `spanType`, `entityType`, `environment`, `source`, and `serviceName` are strong `LowCardinality` candidates

## Query Contract

Routing:

- `getSpan` reads from `span_events`
- `getTrace` reads from `span_events`
- `getRootSpan` reads from `trace_roots`
- `listTraces` reads from `trace_roots`

Trace filter behavior:

- all trace filters other than `hasChildError` are evaluated against the root span
- trace `metadata` filters target `metadataSearch`

`hasChildError`:

- compute it at query time as "any span in the same trace has `status = error`"
- do not store a dedicated helper column on `span_events` in v0
- if it later needs optimization, prefer a refreshable trace-level helper structure rather than row-local denormalization

## Intentional v0 Limitations

- no live or running trace visibility
- no reconstruction from start/end span events
- no search over non-string metadata values
- no nested metadata filtering
- no scope filtering
- no metadata grouping or discovery from `metadataRaw`
