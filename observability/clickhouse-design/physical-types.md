# ClickHouse vNext Observability Physical Types

## Purpose

Define the concrete ClickHouse column types and nullability direction for the `v-next` observability tables so DDL work is mechanical rather than inferred during implementation.

## Shared Conventions

- event and span timestamps should use `DateTime64(3, 'UTC')`
- required textual identifiers should use `String`
- nullable textual identifiers should use `Nullable(String)` unless they are explicitly marked as `LowCardinality` candidates
- nullable low-cardinality textual dimensions should use `LowCardinality(Nullable(String))`
- required low-cardinality textual dimensions should use `LowCardinality(String)`
- boolean fields should use `Bool`
- numeric measurements should use `Float64`
- serialized JSON payloads should use `Nullable(String)`
- do not add physical `createdAt` or `updatedAt` columns to `v-next` append-only tables
- `tags` should use `Array(LowCardinality(String)) DEFAULT []`
- `labels` should use `Map(LowCardinality(String), String) DEFAULT {}`
- `metadataSearch` should use `Map(LowCardinality(String), String) DEFAULT {}`

Important note:

- any column described as a serialized JSON payload should store the JSON-encoded representation of the logical value
- this rule applies even when the logical value is a scalar such as a string, number, boolean, or `null`

## `span_events`

- `dedupeKey`: `String`
- `traceId`: `String`
- `spanId`: `String`
- `parentSpanId`: `Nullable(String)`
- `experimentId`: `Nullable(String)`
- `entityType`: `LowCardinality(Nullable(String))`
- `entityId`: `Nullable(String)`
- `entityName`: `Nullable(String)`
- `userId`: `Nullable(String)`
- `organizationId`: `Nullable(String)`
- `resourceId`: `Nullable(String)`
- `runId`: `Nullable(String)`
- `sessionId`: `Nullable(String)`
- `threadId`: `Nullable(String)`
- `requestId`: `Nullable(String)`
- `environment`: `LowCardinality(Nullable(String))`
- `source`: `LowCardinality(Nullable(String))`
- `serviceName`: `LowCardinality(Nullable(String))`
- `requestContext`: `Nullable(String)`
- `name`: `String`
- `spanType`: `LowCardinality(String)`
- `isEvent`: `Bool`
- `status`: `LowCardinality(String)`
- `startedAt`: `DateTime64(3, 'UTC')`
- `endedAt`: `DateTime64(3, 'UTC')`
- `metadataSearch`: `Map(LowCardinality(String), String) DEFAULT {}`
- `tags`: `Array(LowCardinality(String)) DEFAULT []`
- `attributes`: `Nullable(String)`
- `scope`: `Nullable(String)`
- `links`: `Nullable(String)`
- `input`: `Nullable(String)`
- `output`: `Nullable(String)`
- `error`: `Nullable(String)`
- `metadataRaw`: `Nullable(String)`

Read-path notes:

- returned span `metadata` should be reconstructed from `metadataRaw`
- returned span `createdAt` should be populated as `startedAt`
- returned span `updatedAt` should be `null` in v0
- `dedupeKey` should use the natural tracing identity string `traceId || ':' || spanId`

## `trace_roots`

- `dedupeKey`: `String`
- `traceId`: `String`
- `spanId`: `String`
- `parentSpanId`: `Nullable(String)`
- `experimentId`: `Nullable(String)`
- `entityType`: `LowCardinality(Nullable(String))`
- `entityId`: `Nullable(String)`
- `entityName`: `Nullable(String)`
- `userId`: `Nullable(String)`
- `organizationId`: `Nullable(String)`
- `resourceId`: `Nullable(String)`
- `runId`: `Nullable(String)`
- `sessionId`: `Nullable(String)`
- `threadId`: `Nullable(String)`
- `requestId`: `Nullable(String)`
- `environment`: `LowCardinality(Nullable(String))`
- `source`: `LowCardinality(Nullable(String))`
- `serviceName`: `LowCardinality(Nullable(String))`
- `requestContext`: `Nullable(String)`
- `name`: `String`
- `spanType`: `LowCardinality(String)`
- `isEvent`: `Bool`
- `status`: `LowCardinality(String)`
- `startedAt`: `DateTime64(3, 'UTC')`
- `endedAt`: `DateTime64(3, 'UTC')`
- `metadataSearch`: `Map(LowCardinality(String), String) DEFAULT {}`
- `tags`: `Array(LowCardinality(String)) DEFAULT []`
- `attributes`: `Nullable(String)`
- `scope`: `Nullable(String)`
- `links`: `Nullable(String)`
- `input`: `Nullable(String)`
- `output`: `Nullable(String)`
- `error`: `Nullable(String)`
- `metadataRaw`: `Nullable(String)`

Read-path notes:

- `trace_roots` should remain close enough to the root-span shape that `listTraces` can return root records directly in v0
- returned trace-root `metadata` should be reconstructed from `metadataRaw`
- `trace_roots.dedupeKey` should match the root row's `span_events.dedupeKey`

## `metric_events`

- `timestamp`: `DateTime64(3, 'UTC')`
- `name`: `LowCardinality(String)`
- `traceId`: `Nullable(String)`
- `spanId`: `Nullable(String)`
- `experimentId`: `Nullable(String)`
- `entityType`: `LowCardinality(Nullable(String))`
- `entityId`: `Nullable(String)`
- `entityName`: `Nullable(String)`
- `parentEntityType`: `LowCardinality(Nullable(String))`
- `parentEntityId`: `Nullable(String)`
- `parentEntityName`: `Nullable(String)`
- `rootEntityType`: `LowCardinality(Nullable(String))`
- `rootEntityId`: `Nullable(String)`
- `rootEntityName`: `Nullable(String)`
- `userId`: `Nullable(String)`
- `organizationId`: `Nullable(String)`
- `resourceId`: `Nullable(String)`
- `runId`: `Nullable(String)`
- `sessionId`: `Nullable(String)`
- `threadId`: `Nullable(String)`
- `requestId`: `Nullable(String)`
- `environment`: `LowCardinality(Nullable(String))`
- `source`: `LowCardinality(Nullable(String))`
- `serviceName`: `LowCardinality(Nullable(String))`
- `provider`: `LowCardinality(Nullable(String))`
- `model`: `Nullable(String)`
- `value`: `Float64`
- `estimatedCost`: `Nullable(Float64)`
- `costUnit`: `LowCardinality(Nullable(String))`
- `tags`: `Array(LowCardinality(String)) DEFAULT []`
- `labels`: `Map(LowCardinality(String), String) DEFAULT {}`
- `costMetadata`: `Nullable(String)`
- `metadata`: `Nullable(String)`
- `scope`: `Nullable(String)`

## `log_events`

- `timestamp`: `DateTime64(3, 'UTC')`
- `level`: `LowCardinality(String)`
- `message`: `String`
- `data`: `Nullable(String)`
- `traceId`: `Nullable(String)`
- `spanId`: `Nullable(String)`
- `experimentId`: `Nullable(String)`
- `entityType`: `LowCardinality(Nullable(String))`
- `entityId`: `Nullable(String)`
- `entityName`: `Nullable(String)`
- `parentEntityType`: `LowCardinality(Nullable(String))`
- `parentEntityId`: `Nullable(String)`
- `parentEntityName`: `Nullable(String)`
- `rootEntityType`: `LowCardinality(Nullable(String))`
- `rootEntityId`: `Nullable(String)`
- `rootEntityName`: `Nullable(String)`
- `userId`: `Nullable(String)`
- `organizationId`: `Nullable(String)`
- `resourceId`: `Nullable(String)`
- `runId`: `Nullable(String)`
- `sessionId`: `Nullable(String)`
- `threadId`: `Nullable(String)`
- `requestId`: `Nullable(String)`
- `environment`: `LowCardinality(Nullable(String))`
- `source`: `LowCardinality(Nullable(String))`
- `serviceName`: `LowCardinality(Nullable(String))`
- `tags`: `Array(LowCardinality(String)) DEFAULT []`
- `metadata`: `Nullable(String)`
- `scope`: `Nullable(String)`

## `score_events`

- `timestamp`: `DateTime64(3, 'UTC')`
- `traceId`: `String`
- `spanId`: `Nullable(String)`
- `experimentId`: `Nullable(String)`
- `scoreTraceId`: `Nullable(String)`
- `entityType`: `LowCardinality(Nullable(String))`
- `entityId`: `Nullable(String)`
- `entityName`: `Nullable(String)`
- `userId`: `Nullable(String)`
- `organizationId`: `Nullable(String)`
- `environment`: `LowCardinality(Nullable(String))`
- `serviceName`: `LowCardinality(Nullable(String))`
- `scorerId`: `LowCardinality(String)`
- `scorerVersion`: `LowCardinality(Nullable(String))`
- `source`: `LowCardinality(Nullable(String))`
- `score`: `Float64`
- `reason`: `Nullable(String)`
- `metadata`: `Nullable(String)`

## `feedback_events`

- `timestamp`: `DateTime64(3, 'UTC')`
- `traceId`: `String`
- `spanId`: `Nullable(String)`
- `experimentId`: `Nullable(String)`
- `userId`: `Nullable(String)`
- `sourceId`: `Nullable(String)`
- `entityType`: `LowCardinality(Nullable(String))`
- `entityId`: `Nullable(String)`
- `entityName`: `Nullable(String)`
- `organizationId`: `Nullable(String)`
- `environment`: `LowCardinality(Nullable(String))`
- `serviceName`: `LowCardinality(Nullable(String))`
- `source`: `LowCardinality(String)`
- `feedbackType`: `LowCardinality(String)`
- `value`: `String`
- `comment`: `Nullable(String)`
- `metadata`: `Nullable(String)`

Important note:

- `feedback.value` is `number | string` in the public API but should not be queryable in v0
- current v0 direction is to store the JSON-encoded representation in `String` so read-time decoding preserves `number` vs `string`
- if stronger type fidelity becomes important later, `feedback.value` should be redesigned explicitly rather than inferred during implementation

## `discovery_values`

- `kind`: `LowCardinality(String)`
- `scope`: `LowCardinality(String)`
- `key1`: `Nullable(String)`
- `value`: `String`

Important note:

- `kind` identifies the logical lookup family such as `entityType`, `serviceName`, `environment`, `tag`, `metricName`, or `metricLabelKey`
- `scope` identifies the source family such as `cross-signal` or `metric`
- `key1` should be used only when the value depends on one parent key in v0, such as metric name for metric label keys
- physical v0 direction: `ENGINE = MergeTree`, no partitioning, `ORDER BY (kind, key1, value)`

## `discovery_pairs`

- `kind`: `LowCardinality(String)`
- `scope`: `LowCardinality(String)`
- `key1`: `String`
- `key2`: `Nullable(String)`
- `value`: `String`

Important note:

- `kind` identifies the logical pair family such as `entityTypeName` or `metricLabelValue`
- `key1` should store the primary lookup key such as entity type or metric name
- `key2` should store the secondary lookup key when needed, such as metric label key
- physical v0 direction: `ENGINE = MergeTree`, no partitioning, `ORDER BY (kind, key1, key2, value)`
