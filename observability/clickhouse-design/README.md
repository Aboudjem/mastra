# ClickHouse vNext Observability Design

## Status

Working design index for the new ClickHouse observability domain under `stores/clickhouse/src/storage/domains/observability/v-next/`.

## Purpose

This file is now the overview and entry point for the ClickHouse `v-next` observability design. The detailed design has been split into one shared document plus one document per table so implementation decisions are easier to find and maintain.

Important note:

- this document set is design documentation for the initial `v-next` implementation
- it is intended to guide implementation, not to remain a permanent second source of truth after the implementation and DDL/query code exist
- once `v-next` is implemented, the code and tests should become the authoritative source for ongoing behavior

## Design Set

- [Shared Design](./shared.md)
- [Trace Roots](./trace-roots.md)
- [Span Events](./span-events.md)
- [Metric Events](./metric-events.md)
- [Log Events](./log-events.md)
- [Score Events](./score-events.md)
- [Feedback Events](./feedback-events.md)
- [Discovery Design](./discovery.md)
- [Physical Types](./physical-types.md)

## Core v0 Decisions

- ClickHouse `v-next` should use append-only storage for all five signals.
- ClickHouse `v-next` v0 should follow ClickHouse best practices wherever practical instead of inheriting design constraints from DuckDB or other storage backends.
- ClickHouse `v-next` should use `insert-only` exporter routing semantics for tracing.
- ClickHouse `v-next` v0 should store only completed spans.
- ClickHouse `v-next` v0 should persist only tracing create events corresponding to completed spans.
- ClickHouse `v-next` v0 should not support live/running trace visibility.
- tracing should use two physical tables in v0:
  - `span_events` for full-trace reads
  - `trace_roots` for root-span listing/filtering
- `trace_roots` should be a normal table populated from `span_events` by an incremental materialized view.
- discovery should use two refreshable helper tables in v0:
  - `discovery_values` for unique-value lookups
  - `discovery_pairs` for key-value lookups
- TTL/retention should be configurable per signal in day increments.
- `span_events` should store `startedAt`, `endedAt`, and a typed `status`.
- `span_events` should keep original metadata in `metadataRaw` and a separate searchable string-string map in `metadataSearch`.
- `metric_events` should not store a `status` column in v0.
- Per-table physical design should be defined per table, not through one shared `ORDER BY`.
- Raw ClickHouse DDL should be used for `v-next` base tables.
- ClickHouse semantics should be the primary reference for `v-next`; DuckDB is a parity reference, not the source of truth.

## Scope

- Cloud ClickHouse physical design is the target for this work.
- Mastra runtime should continue writing through the standard storage interface via `DefaultExporter`.
- ClickHouse `v-next` should be designed around the batched create path used by `DefaultExporter`.
- Legacy observability methods outside that path are expected to be deprecated and should not drive `v-next` design decisions.
- Previous DuckDB or other storage implementations may be used as parity references, but they should not be treated as the design source of truth for ClickHouse `v-next`.
- New code should live under `stores/clickhouse/src/storage/domains/observability/v-next/`.
- Transition, migration, and cutover planning are intentionally out of scope for this design.
- The existing ClickHouse observability domain can remain separate while `v-next` is implemented.

## Rollout Order

1. Finalize the shared and per-table docs.
2. Implement raw ClickHouse DDL for the five signal tables plus tracing/discovery helper tables and their materialized views.
3. Implement writes and reads for the five signals.
4. Add targeted tests around the risky contract points:
   - tracing insert-only routing with ended-span-only persistence
   - `trace_roots` population from root-span inserts
   - discovery helper refresh behavior and staleness expectations
   - per-table ordering
   - span status
   - trace `hasChildError`
   - `metadataRaw` vs `metadataSearch`
   - exact filter-surface behavior per signal
   - label/tag normalization
   - delete eventual consistency

Important note:

- this document set is intentionally about steady-state `v-next` design, not transition mechanics
- migration, cutover, and coexistence planning should not block v0 implementation work

## AI Agent Reviews

- [Claude Code Review](./claude-review.md)
- [Codex Review](./codex-review.md)
