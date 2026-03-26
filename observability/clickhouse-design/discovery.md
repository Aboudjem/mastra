# ClickHouse vNext Observability Discovery Design

## Purpose

Define the helper-table shape, refresh behavior, and endpoint mapping for ClickHouse `v-next` discovery.

## v0 Model

- discovery reads from two dedicated helper tables:
  - `discovery_values`
  - `discovery_pairs`
- both helper tables are normal ClickHouse tables maintained by refreshable materialized views
- do not feed them incrementally from insert-time materialized views in v0
- discovery is intentionally eventually consistent
- do not add discovery over JSON payloads in v0
- do not force scores or feedback into cross-signal discovery just for symmetry

Refreshable helper tables are preferred here because they recompute the current set after deletes and TTL expiry.

## Helper Tables

`discovery_values` stores de-duplicated unique values for:

- `entityType`
- `serviceName`
- `environment`
- `tag`
- `metricName`
- metric `labelKey`

`discovery_pairs` stores de-duplicated key-value style lookups for:

- `entityType -> entityName`
- `metricName + labelKey -> labelValue`

## Refresh Cadence

Starting defaults:

- refresh `discovery_values` every 1 minute
- refresh `discovery_pairs` every 5 minutes

Rationale:

- `discovery_values` backs the most common lightweight UI pickers, so it should refresh more frequently
- `discovery_pairs` is expected to be larger and less latency-sensitive
- treat these as product defaults, not hard architectural requirements

## Endpoint Mapping

Current discovery endpoints:

- `getEntityTypes`
- `getEntityNames`
- `getServiceNames`
- `getEnvironments`
- `getTags`
- `getMetricNames`
- `getMetricLabelKeys`
- `getMetricLabelValues`

Entity and service discovery:

- `getEntityTypes` reads from `discovery_values` where `kind = entityType`
- `getEntityNames` reads from `discovery_pairs` where `kind = entityTypeName`
- when `entityType` is provided to `getEntityNames`, filter by the stored entity-type key before ordering and limit
- `getServiceNames` reads from `discovery_values` where `kind = serviceName`
- `getEnvironments` reads from `discovery_values` where `kind = environment`

Tag discovery:

- `getTags` reads from `discovery_values` where `kind = tag`
- when `entityType` is provided to `getTags`, filter on the stored entity-type dimension before ordering and limit

Metric discovery:

- `getMetricNames` reads from `discovery_values` where `kind = metricName`
- apply `prefix` before ordering and `limit` after ordering
- `getMetricLabelKeys` reads from `discovery_values` where `kind = metricLabelKey` and metric name matches
- `getMetricLabelValues` reads from `discovery_pairs` where `kind = metricLabelValue`, metric name matches, and label key matches
- apply `prefix` to metric label values before ordering and `limit` after ordering

## Non-Goals

- no discovery over `metadata`
- no discovery over `scope`
- no discovery over `costMetadata`
- no discovery over log `data`
- no discovery over span `metadataRaw`
- no discovery over scores or feedback

## Operational Note

The current discovery API does not expose time-range filters. Refresh queries may still scan broad source ranges, but query-time endpoint cost should no longer depend on scanning the observability base tables directly. That is the intended v0 tradeoff.
