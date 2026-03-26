# ClickHouse vNext Feedback Events Design

## Status

Working table design for `feedback_events`.

## Purpose

Define the logical shape, physical shape, and query contract for ClickHouse `v-next` feedback storage.

## Logical Shape

### Event metadata

- `timestamp`

### IDs

- `traceId`
- `spanId`
- `experimentId`
- `userId`
- `sourceId`

### Entity

- `entityType`
- `entityId`
- `entityName`

### Context

- `organizationId`
- `environment`
- `serviceName`

### Feedback-specific scalars

- `source`
- `feedbackType`
- `value`

### Information-only payloads

- `metadata`
- `comment`

## Physical Shape

Current v0 direction:

- `ENGINE = MergeTree`
- `PARTITION BY toDate(timestamp)`
- `ORDER BY (traceId, timestamp)`

Additional notes:

- `entityType`, `environment`, `serviceName`, `source`, and `feedbackType` are good `LowCardinality` candidates
- `value` should not be treated as `LowCardinality`
- `PARTITION BY toDate(timestamp)` should support day-granularity feedback TTL management

## Query Contract

Current v0 direction:

- `source` should be searchable/filterable in v0
- `feedbackType` should be searchable/filterable in v0
- `value` should be retained for display but stored as a JSON-encoded value to preserve `string` vs `number`
- `value` should not participate in filtering, search, discovery, or grouping in v0
- `comment` should not participate in filtering, search, discovery, or grouping in v0
- `metadata` should remain information-only in v0

Current public feedback filter schema includes:

- `timestamp`
- `traceId`
- `spanId`
- `entityType`
- `entityName`
- `userId`
- `organizationId`
- `experimentId`
- `serviceName`
- `environment`
- `feedbackType`
- `source`

Important note:

- `feedback_events` should carry the context needed to satisfy the current public feedback filter schema
- the feedback write path will need to propagate these fields from emitted feedback context or enclosing trace/span context
- that upstream feedback record-builder work should land separately from the ClickHouse `v-next` storage PR
- `feedback.value` should be JSON-encoded on write and JSON-decoded on read so the storage layer preserves the public `string | number` contract cleanly
- feedback `metadata` is present on the record but is not part of the public feedback filter schema

## Notes

- `sourceId` is part of the logical shape, but it may be sparse on the default exporter path
- `sourceId` means the identifier of the source record the feedback is linked to, not the feedback source/category itself
- the feedback source/category is stored separately in `source`

## Intentional v0 Limitations

- no parent/root entity hierarchy on feedback in v0
- no metadata search on feedback in v0
- no searchable `value`
- no searchable `comment`

Rationale:

- parent/root entity hierarchy is intentionally omitted from `feedback_events` in v0
- if that hierarchy is needed later, it can be reconstructed from traces by `traceId` rather than stored eagerly on every feedback row
