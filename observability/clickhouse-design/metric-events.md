# ClickHouse vNext Metric Events Design

## Status

Working table design for `metric_events`.

## Purpose

Define the logical shape, physical shape, and query contract for ClickHouse `v-next` metrics storage and OLAP queries.

## Logical Shape

### Event metadata

- `timestamp`
- `name`

### Correlation and experiment ids

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
- `provider`
- `model`

### Metric-specific scalars

- `value`
- `estimatedCost`
- `costUnit`

### Semi-structured fields

- `tags`
- `labels`
- `costMetadata`
- `metadata`
- `scope`

Important note:

- `metric_events` should not store a `status` column in v0
- metric emission does not know the final terminal status of the enclosing trace/span at write time

## Physical Shape

Current v0 direction:

- `ENGINE = MergeTree`
- `PARTITION BY toDate(timestamp)`
- `ORDER BY (name, timestamp)`

Additional notes:

- `name`, entity type fields, `environment`, `source`, `serviceName`, and `provider` are strong `LowCardinality` candidates
- `labels` should use `Map(LowCardinality(String), String)`
- `tags` should use `Array(LowCardinality(String))`
- `PARTITION BY toDate(timestamp)` should support day-granularity metric TTL management

## Semi-Structured Policy

Current v0 direction:

- `labels` and `tags` remain query-relevant
- `costMetadata`, `metadata`, and `scope` remain information-only JSON payloads

## Query Contract

The ClickHouse `v-next` metrics implementation should support:

- `batchCreateMetrics`
- `listMetrics`
- `getMetricAggregate`
- `getMetricBreakdown`
- `getMetricTimeSeries`
- `getMetricPercentiles`
- metric discovery for names, label keys, and label values

For OLAP responses in v0:

- aggregate, breakdown, and time series return `value` plus optional `estimatedCost` and `costUnit`
- percentiles remain value-only

### Filter surface

Current public metrics filter schema includes:

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
- `name`
- `provider`
- `model`
- `costUnit`
- `labels`

Current v0 direction:

- the ClickHouse metrics implementation should support that filter surface directly from typed columns plus `labels`/`tags`
- `metadata`, `costMetadata`, and `scope` are stored on the record but are not part of the current metrics filter schema
- metric `labels` filters should use contains-all semantics over exact key/value pairs after shared normalization
- metric `labels` filters should not imply wildcard, regex, prefix, substring, or fuzzy-match semantics in v0

### `groupBy` semantics

Current v0 direction:

- if a `groupBy` key matches a typed metric column, group by that typed column
- otherwise, treat the key as a metric-label key and group by the value stored under `labels`
- `metadata`, `costMetadata`, and `scope` should not participate in `groupBy`
- typed metric columns should win when a `groupBy` key collides with both a typed column name and a label key
- rows that do not contain the requested label key should be excluded from that label-based grouped result in v0

## Discovery Direction

Current v0 direction:

- metric discovery should read from the shared discovery helper tables rather than directly from `metric_events`
- `getMetricNames` should read from `discovery_values`
- `getMetricLabelKeys` should read from `discovery_values`
- `getMetricLabelValues` should read from `discovery_pairs`

## Intentional v0 Limitations

- no stored `status`
- no grouping by `metadata`, `costMetadata`, or `scope`
- no query dependence on JSON extraction for label-aware grouping if it can be avoided
