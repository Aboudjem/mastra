# ClickHouse vNext Feedback Events Design

## Purpose

Define the logical shape, physical shape, and query contract for `feedback_events`.

## Logical Shape

Event metadata:

- `timestamp`

Correlation and feedback ids:

- `traceId`
- `spanId`
- `experimentId`
- `userId`
- `sourceId`

Entity and context:

- `entityType`
- `entityId`
- `entityName`
- `organizationId`
- `environment`
- `serviceName`

Feedback-specific scalars:

- `source`
- `feedbackType`
- `value`

Information-only payloads:

- `metadata`
- `comment`

Notes:

- `sourceId` is the identifier of the source record the feedback is linked to, not the feedback category itself
- the feedback category is stored separately in `source`

## Physical Shape

- `ENGINE = MergeTree`
- `PARTITION BY toDate(timestamp)`
- `ORDER BY (traceId, timestamp)`

Notes:

- `entityType`, `environment`, `serviceName`, `source`, and `feedbackType` are strong `LowCardinality` candidates
- `value` should not be treated as `LowCardinality`
- `ORDER BY (traceId, timestamp)` is intentional in v0 because feedback is expected to be consumed primarily in trace-scoped reads rather than global recency-first listing
- `PARTITION BY toDate(timestamp)` supports day-granularity feedback TTL management

## Query Contract

- `source` should be filterable in v0
- `feedbackType` should be filterable in v0
- `value` should be retained for display but stored as a JSON-encoded value so the storage layer preserves `string` vs `number`
- `value` should not participate in filtering, search, discovery, or grouping
- `comment` should not participate in filtering, search, discovery, or grouping
- `metadata` remains information-only in v0
- `feedback_events` must carry the context needed to satisfy the current public feedback filter schema
- the upstream feedback record-builder work needed to propagate that context should land separately from the ClickHouse `v-next` storage PR
- `feedback.value` should be JSON-encoded on write and JSON-decoded on read
- feedback `metadata` is present on the record but is not part of the current public feedback filter schema

## Intentional v0 Limitations

- no parent or root entity hierarchy on feedback in v0
- no metadata search on feedback in v0
- no searchable `value`
- no searchable `comment`
