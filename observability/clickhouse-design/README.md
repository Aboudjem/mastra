# ClickHouse vNext Observability Design

## Purpose

Use this file as the entry point for the ClickHouse `v-next` observability design. Cross-cutting decisions live in the shared doc; table-specific behavior lives in the per-table docs.

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

- use append-only storage for all five signals
- prefer ClickHouse-native design choices over inheriting constraints from DuckDB or other backends
- use `insert-only` exporter routing for tracing
- store and return only completed spans and traces in v0
- tracing should use two physical tables in v0:
  - `span_events` for full-trace reads
  - `trace_roots` for root-span listing/filtering
- populate `trace_roots` from `span_events` with an incremental materialized view
- discovery should use two refreshable helper tables in v0:
  - `discovery_values` for unique-value lookups
  - `discovery_pairs` for key-value lookups
- configure TTL/retention per signal in day increments
- keep per-table physical design decisions per table rather than forcing one shared `ORDER BY`
- use raw ClickHouse DDL for the `v-next` tables
- treat ClickHouse semantics as the primary design reference; DuckDB is a parity reference, not the source of truth

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
2. Implement raw ClickHouse DDL for the five signal tables, `trace_roots`, `discovery_values`, `discovery_pairs`, and their materialized views.
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
