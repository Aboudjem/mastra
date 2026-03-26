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

- stores a flattened dot-path string-string index of trace metadata
- example: metadata `{ user: { id: "u_123" } }` becomes `metadataSearch["user.id"] = "u_123"`
- only non-empty string leaf values are indexed
- `null`, empty strings, non-string scalar values, arrays, and objects are not indexed
- keys that cannot be represented as stable flattened paths are omitted from `metadataSearch` and remain available only in `metadataRaw`
- before writing `metadataSearch`, remove keys already promoted into typed columns such as `userId`, `organizationId`, `resourceId`, `runId`, `sessionId`, `threadId`, `requestId`, `environment`, `source`, and `serviceName`

Metadata filter semantics:

- trace metadata filters support equality-only matching against flattened `metadataSearch` keys
- metadata filter values must be strings in v0
- metadata filters targeting non-string values should fail explicitly rather than silently return no rows
- metadata filters targeting keys that are not indexed into `metadataSearch` should fail explicitly rather than silently fall back to scanning `metadataRaw`
- v0 does not imply nested-object matching, array membership, wildcard, regex, or partial-match semantics for trace metadata

`scope`:

- stays as a serialized JSON blob because the current trace filter schema exposes it
- filters should use nested-path equality via JSON extraction from the serialized payload
- filter values may be strings, numbers, or booleans, but not arrays or objects
- v0 does not imply wildcard, regex, or partial-match semantics for `scope`

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
- because trace filters are root-span-based, `parentEntityType`, `parentEntityId`, `parentEntityName`, `rootEntityType`, `rootEntityId`, and `rootEntityName` behave as aliases of the root span's `entityType`, `entityId`, and `entityName`
- trace `metadata` filters target `metadataSearch`
- trace `scope` filters target the serialized `scope` payload

`hasChildError`:

- compute it at query time as "any span in the same trace has `status = error`"
- do not store a dedicated helper column on `span_events` in v0
- if it later needs optimization, prefer a refreshable trace-level helper structure rather than row-local denormalization

## Intentional v0 Limitations

- no live or running trace visibility
- no reconstruction from start/end span events
- no search over non-string metadata values
- no metadata grouping or discovery from `metadataRaw`
