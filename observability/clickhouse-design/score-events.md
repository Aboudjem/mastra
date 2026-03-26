# ClickHouse vNext Score Events Design

## Purpose

Define the logical shape, physical shape, and query contract for `score_events`.

## Logical Shape

Event metadata:

- `timestamp`

Correlation and experiment ids:

- `traceId`
- `spanId`
- `experimentId`
- `scoreTraceId`

Entity and context:

- `entityType`
- `entityId`
- `entityName`
- `userId`
- `organizationId`
- `environment`
- `serviceName`

Score-specific scalars:

- `scorerId`
- `scorerVersion`
- `source`
- `score`

Information-only payloads:

- `reason`
- `metadata`

## Physical Shape

- `ENGINE = MergeTree`
- `PARTITION BY toDate(timestamp)`
- `ORDER BY (traceId, timestamp)`

Notes:

- `entityType`, `environment`, `serviceName`, `source`, `scorerId`, and `scorerVersion` are strong `LowCardinality` candidates
- `PARTITION BY toDate(timestamp)` supports day-granularity score TTL management

## Query Contract

- `listScores` should support the current public score filter surface directly from score rows
- `reason` is retained for display but does not participate in filtering, search, discovery, or grouping
- `metadata` remains information-only in v0
- `score_events` must carry the context needed to satisfy the current public score filter schema
- the upstream score record-builder work needed to propagate that context should land separately from the ClickHouse `v-next` storage PR
- score `metadata` is present on the record but is not part of the current public score filter schema

## Intentional v0 Limitations

- no parent or root entity hierarchy on scores in v0
- no metadata search on scores in v0
- no queryable `reason` field in v0
