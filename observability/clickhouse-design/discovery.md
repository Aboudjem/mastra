# ClickHouse vNext Observability Discovery Design

## Status

Working discovery design for the ClickHouse `v-next` observability domain.

## Purpose

Define the discovery endpoints, table coverage, and query behavior for ClickHouse `v-next`.

## v0 Direction

- discovery should read from two dedicated helper tables:
  - `discovery_values`
  - `discovery_pairs`
- both discovery helper tables should be maintained by refreshable materialized views
- do not add discovery over JSON payloads in v0
- do not force scores or feedback into cross-signal discovery just for symmetry

## Helper Tables

Current v0 direction:

- `discovery_values` should store de-duplicated unique values for:
  - `entityType`
  - `serviceName`
  - `environment`
  - `tag`
  - `metricName`
  - metric `labelKey`
- `discovery_pairs` should store de-duplicated key-value style lookups for:
  - `entityType -> entityName`
  - `metricName + labelKey -> labelValue`

Important note:

- `discovery_values` and `discovery_pairs` should be normal tables refreshed from source queries
- they should not be fed incrementally from insert-time materialized views in v0
- refreshable materialized views are the preferred v0 mechanism because they recompute the current set after deletes and TTL expiry

## Refresh Cadence

Current v0 direction:

- start with `discovery_values` refreshed every 1 minute
- start with `discovery_pairs` refreshed every 5 minutes
- treat those intervals as product defaults, not hard architectural requirements

Important note:

- `discovery_values` is expected to back the most common lightweight UI pickers, so it should refresh more frequently
- `discovery_pairs` is expected to be larger and less latency-sensitive, so it can refresh less often in v0
- discovery should be explicitly eventually consistent in v0

## Public Discovery API

Current storage API discovery endpoints are:

- `getEntityTypes`
- `getEntityNames`
- `getServiceNames`
- `getEnvironments`
- `getTags`
- `getMetricNames`
- `getMetricLabelKeys`
- `getMetricLabelValues`

Current API argument surface:

- `getEntityTypes()`
- `getEntityNames({ entityType? })`
- `getServiceNames()`
- `getEnvironments()`
- `getTags({ entityType? })`
- `getMetricNames({ prefix?, limit? })`
- `getMetricLabelKeys({ metricName })`
- `getMetricLabelValues({ metricName, labelKey, prefix?, limit? })`

## Cross-Signal Discovery

Cross-signal discovery should operate over the discovery helper tables in v0:

- `discovery_values`
- `discovery_pairs`

### Entity discovery

Current v0 direction:

- `getEntityTypes` should read from `discovery_values` rows where kind = `entityType`
- `getEntityNames` should read from `discovery_pairs` rows where kind = `entityTypeName`
- when `entityType` is provided to `getEntityNames`, it should filter `discovery_pairs` by the stored entity type key before ordering/limit

### Service/environment discovery

Current v0 direction:

- `getServiceNames` should read from `discovery_values` rows where kind = `serviceName`
- `getEnvironments` should read from `discovery_values` rows where kind = `environment`

### Tag discovery

Current v0 direction:

- `getTags` should read from `discovery_values` rows where kind = `tag`
- when `entityType` is provided to `getTags`, it should filter on the stored entity type dimension before ordering/limit

## Metric Discovery

Metric-specific discovery should operate on the discovery helper tables rather than directly on `metric_events`.

Current v0 direction:

- `getMetricNames` should read from `discovery_values` rows where kind = `metricName`
- `prefix` should apply as a value prefix filter before ordering
- `limit` should apply after ordering
- `getMetricLabelKeys` should read from `discovery_values` rows where kind = `metricLabelKey` and metric name matches
- `getMetricLabelValues` should read from `discovery_pairs` rows where kind = `metricLabelValue`, metric name matches, and label key matches
- `prefix` on `getMetricLabelValues` should apply before ordering
- `limit` on `getMetricLabelValues` should apply after ordering

## Explicit Non-Goals

Current v0 direction:

- no discovery over `metadata`
- no discovery over `scope`
- no discovery over `costMetadata`
- no discovery over log `data`
- no discovery over span `metadataRaw`
- no discovery over scores or feedback

## Operational Note

The current discovery API does not expose time-range filters for these endpoints. Inference: discovery helper refresh queries may still scan broad source ranges, but query-time endpoint cost should no longer depend on scanning the observability base tables directly. That is the intended v0 tradeoff.
