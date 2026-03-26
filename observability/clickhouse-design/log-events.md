# ClickHouse vNext Log Events Design

## Status

Working table design for `log_events`.

## Purpose

Define the logical shape, physical shape, and query contract for ClickHouse `v-next` log storage.

## Logical Shape

### Event metadata

- `timestamp`
- `level`

### IDs

- `traceId`
- `spanId`
- `experimentId`

### Entity hierarchy

- `entityType`
- `entityId`
- `entityName`
- `parentEntityType`
- `parentEntityId`
- `parentEntityName`
- `rootEntityType`
- `rootEntityId`
- `rootEntityName`

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

### Log-specific scalars

- `message`

### Information-only payloads

- `data`
- `metadata`
- `scope`

### Query-relevant flexible fields

- `tags`

## Physical Shape

Current v0 direction:

- `ENGINE = MergeTree`
- `PARTITION BY toDate(timestamp)`
- `ORDER BY (timestamp, traceId)`

Additional notes:

- `level`, `entityType`, `parentEntityType`, `rootEntityType`, `environment`, `source`, and `serviceName` are good `LowCardinality` candidates
- `tags` should use `Array(LowCardinality(String))`
- `PARTITION BY toDate(timestamp)` should support day-granularity log TTL management

## Query Contract

Current v0 direction:

- `listLogs` should support the current public log filter surface
- `tags` remain filterable
- `data`, `metadata`, and `scope` should not participate in discovery or grouping in v0

Current public log filter schema includes:

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
- `parentEntityType`
- `parentEntityName`
- `rootEntityType`
- `rootEntityName`
- `resourceId`
- `runId`
- `sessionId`
- `threadId`
- `requestId`
- `source`
- `tags`
- `level`

Important note:

- log `metadata` is present on the record but is not part of the public log filter schema

## Intentional v0 Limitations

- no searchable metadata map for logs in v0
- no filtering/grouping on `data`
- no filtering/grouping on `scope`
