# ClickHouse vNext Score Events Design

## Status

Working table design for `score_events`.

## Purpose

Define the logical shape, physical shape, and query contract for ClickHouse `v-next` score storage.

## Logical Shape

### Event metadata

- `timestamp`

### IDs

- `traceId`
- `spanId`
- `experimentId`
- `scoreTraceId`

### Entity

- `entityType`
- `entityId`
- `entityName`

### Context

- `userId`
- `organizationId`
- `environment`
- `serviceName`

### Score-specific scalars

- `scorerId`
- `scorerVersion`
- `source`
- `score`

### Information-only payloads

- `reason`
- `metadata`

## Physical Shape

Current v0 direction:

- `ENGINE = MergeTree`
- `PARTITION BY toDate(timestamp)`
- `ORDER BY (traceId, timestamp)`

Additional notes:

- `entityType`, `environment`, `serviceName`, `source`, `scorerId`, and `scorerVersion` are good `LowCardinality` candidates
- `PARTITION BY toDate(timestamp)` should support day-granularity score TTL management

## Query Contract

Current v0 direction:

- `listScores` should support the current public score filter surface directly from score rows
- `reason` should be retained for display but should not participate in filtering, search, discovery, or grouping
- `metadata` should remain information-only in v0

Current public score filter schema includes:

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
- `scorerId`

Important note:

- `score_events` should carry the context needed to satisfy the current public score filter schema
- the score write path will need to propagate these fields from emitted score context or enclosing trace/span context
- that upstream score record-builder work should land separately from the ClickHouse `v-next` storage PR
- score `metadata` is present on the record but is not part of the public score filter schema

## Intentional v0 Limitations

- no parent/root entity hierarchy on scores in v0
- no metadata search on scores in v0
- no queryable `reason` field in v0

Rationale:

- parent/root entity hierarchy is intentionally omitted from `score_events` in v0
- if that hierarchy is needed later, it can be reconstructed from traces by `traceId` rather than stored eagerly on every score row
