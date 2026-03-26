# ClickHouse v-next Observability Design Review

## Findings

### 1. Score/feedback v0 is not implementable as described without upstream type and schema work. Calling it "separate record-builder enrichment" is misleading.

- The design requires typed context columns on `score_events` and `feedback_events`, and says those rows must satisfy the current public filter surface, while deferring the upstream work as a separate concern ([observability/clickhouse-design/score-events.md](./score-events.md#L55), [observability/clickhouse-design/feedback-events.md](./feedback-events.md#L65), [observability/clickhouse-design/shared.md](./shared.md#L79), [observability/clickhouse-design/physical-types.md](./physical-types.md#L181)).
- Current builders do not emit the required typed context for either signal. `buildScoreRecord()` emits only score-local fields. `buildFeedbackRecord()` extracts only `userId` from metadata and nothing else ([packages/core/src/storage/domains/observability/record-builders.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/core/src/storage/domains/observability/record-builders.ts#L287), [packages/core/src/storage/domains/observability/record-builders.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/core/src/storage/domains/observability/record-builders.ts#L305)).
- Current storage record schemas for scores/feedback do not even contain those typed columns, while their list filters already expose `entityType`, `entityName`, `userId`, `organizationId`, `serviceName`, and `environment` via `commonFilterFields` ([packages/_internal-core/src/storage/domains/observability/scores.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/observability/scores.ts#L30), [packages/_internal-core/src/storage/domains/observability/scores.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/observability/scores.ts#L132), [packages/_internal-core/src/storage/domains/observability/feedback.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/observability/feedback.ts#L32), [packages/_internal-core/src/storage/domains/observability/feedback.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/observability/feedback.ts#L141), [packages/_internal-core/src/storage/domains/shared.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/shared.ts#L186)).
- Worse, the exported score/feedback event types currently say inherited context lives inside `metadata`, not in a typed `correlationContext`, so the adapter still needs explicit extraction rules or upstream event-shape changes before this becomes clean ([packages/core/src/observability/types/scores.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/core/src/observability/types/scores.ts#L41), [packages/core/src/observability/types/feedback.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/core/src/observability/types/feedback.ts#L38)).
- This is not optional follow-up work. It is a prerequisite. If you start implementing ClickHouse `v-next` before resolving this, you will either ship an adapter that lies about its filter support or you will churn the storage interfaces mid-flight.

### 2. Accepting duplicate non-tracing writes under retries is not a harmless v0 limitation. It is data corruption under normal exporter behavior.

- The design explicitly accepts retry duplicates for metrics, logs, scores, and feedback ([observability/clickhouse-design/README.md](./README.md#L25), [observability/clickhouse-design/shared.md](./shared.md#L24), [observability/clickhouse-design/shared.md](./shared.md#L114), [observability/clickhouse-design/span-events.md](./span-events.md#L191)).
- The exporter already retries failed create batches by putting the same events back into the buffer, with no event ID or dedupe surface for non-tracing signals ([observability/mastra/src/exporters/default.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/mastra/src/exporters/default.ts#L214), [observability/mastra/src/exporters/default.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/mastra/src/exporters/default.ts#L365), [observability/mastra/src/exporters/event-buffer.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/mastra/src/exporters/event-buffer.ts#L124)).
- For metrics this is especially bad. Duplicates directly poison sums, counts, time series, percentiles, estimated cost, and any downstream analytics built on those rows ([observability/clickhouse-design/metric-events.md](./metric-events.md#L78)).
- The design treats this like a tolerable asymmetry. It is not. If exporter retries are expected in production, metrics at minimum need an idempotency story before this is safe enough to roll out.

### 3. The trace filter contract silently weakens the public API in a way the current storage surface cannot express safely.

- The design says `status=running` should return no rows, trace `scope` filters are unsupported, and metadata filters on non-string or nested values should also return no rows rather than error ([observability/clickhouse-design/shared.md](./shared.md#L91), [observability/clickhouse-design/span-events.md](./span-events.md#L124), [observability/clickhouse-design/trace-roots.md](./trace-roots.md#L42)).
- The public trace filter schema still exposes `status`, arbitrary `metadata`, and `scope` as normal filter inputs ([packages/core/src/storage/domains/observability/tracing.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/core/src/storage/domains/observability/tracing.ts#L265), [packages/core/src/storage/domains/observability/tracing.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/core/src/storage/domains/observability/tracing.ts#L331)).
- Returning empty results instead of an explicit unsupported-capability signal means callers cannot distinguish "no matching traces" from "filter silently not implemented". That is a bad contract.
- If this narrowing is intentional, the design needs a real answer for how adapter-specific capability gaps are surfaced. Right now it is just redefining the meaning of empty results.

### 4. Discovery is over-coupled to base observability and operationally optimistic.

- The design makes refreshable materialized views a required capability and says adapter init should fail closed if discovery bootstrap fails or the feature is unavailable ([observability/clickhouse-design/shared.md](./shared.md#L240), [observability/clickhouse-design/discovery.md](./discovery.md#L20), [observability/clickhouse-design/discovery.md](./discovery.md#L213)).
- That means an auxiliary discovery feature can block the whole observability adapter, including writes and reads for the five core signal tables. That coupling is hard to justify.
- The same design refreshes discovery by full recomputation with `UNION ALL` plus outer `DISTINCT` over `span_events`, `metric_events`, and `log_events`, on 1-minute and 5-minute cadences, with no time scoping and an explicit acknowledgment that refreshes may scan broad source ranges ([observability/clickhouse-design/discovery.md](./discovery.md#L115), [observability/clickhouse-design/discovery.md](./discovery.md#L128), [observability/clickhouse-design/discovery.md](./discovery.md#L209)).
- That might be acceptable at small scale. It is not a believable default at unknown scale. The design needs real scale assumptions, a fallback mode, or both.

### 5. Score/feedback physical ordering is optimized for a read pattern that the current Mastra API does not actually make primary.

- The design chooses `ORDER BY (traceId, timestamp)` for both `score_events` and `feedback_events` because those signals are "expected to be consumed primarily in trace-scoped reads" ([observability/clickhouse-design/score-events.md](./score-events.md#L42), [observability/clickhouse-design/feedback-events.md](./feedback-events.md#L47)).
- The current public APIs are `listScores` and `listFeedback`, both defaulting to timestamp-first ordering. There is no dedicated trace-scoped read endpoint that would justify making `traceId` the leading sort key a priori ([packages/_internal-core/src/storage/domains/observability/scores.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/observability/scores.ts#L151), [packages/_internal-core/src/storage/domains/observability/feedback.ts](/Users/epinzur/src/github.com/mastra-ai/mastra/packages/_internal-core/src/storage/domains/observability/feedback.ts#L161)).
- This is a design assumption, not a codebase reality. Unless the read API is changing soon, the chosen sort keys are likely to penalize the default path while optimizing a path that barely exists.

### 6. The Map-based label and metadataSearch behavior is underspecified for ClickHouse and likely to drift in implementation.

- The design relies on `labels` and `metadataSearch` as `Map(...)` columns with exact contains-all semantics, and it says label-based groupings must exclude rows missing the requested key ([observability/clickhouse-design/shared.md](./shared.md#L169), [observability/clickhouse-design/shared.md](./shared.md#L186), [observability/clickhouse-design/metric-events.md](./metric-events.md#L95)).
- Inference: in ClickHouse, naive `map[key]` usage is a trap because missing-key handling can collapse into the value type's default unless the query also checks key existence explicitly.
- The docs never pin down the required query form for:
  - label equality filters
  - label-key grouping with missing-key exclusion
  - `metadataSearch` equality filters
- That is too vague. For this design to be implementable without behavior drift, it should specify exact query patterns, not just logical intent.

### 7. `trace_roots` is heavier than a helper table should be, and the storage/write amplification is not justified.

- The design intentionally keeps `trace_roots` close to the full root-span shape and duplicates large serialized payload columns from `span_events` ([observability/clickhouse-design/trace-roots.md](./trace-roots.md#L16), [observability/clickhouse-design/physical-types.md](./physical-types.md#L70)).
- That means every root-span insert pays for the base row, the materialized-view insert, and duplicated payload storage, even though the main value of `trace_roots` is root-level filtering and list performance.
- If you want that tradeoff for API compatibility, say so explicitly. Right now the doc reads like convenience won by default.

### 8. The rollout plan is incomplete relative to the real prerequisites.

- The rollout order is "finalize docs, implement DDL, implement reads/writes, add tests" ([observability/clickhouse-design/README.md](./README.md#L51)).
- It omits:
  - upstream score/feedback schema and builder changes
  - explicit capability detection and bootstrap behavior for discovery
  - exact query-builder semantics for narrowed trace filters
  - write/read normalization helpers shared across all five tables
- That does not make the design impossible to execute, but it does make the "next steps" look cleaner than they are.

## Open Questions That Should Be Resolved Before Implementation

- Do you actually want observability adapter initialization to fail if discovery is unsupported, or should discovery be the only failing surface?
- Are score/feedback events staying metadata-based for context propagation, or are you introducing explicit typed correlation context for them?
- Are duplicate non-tracing writes really acceptable for metrics, given the exporter's built-in retry behavior?
- Is the primary score/feedback read path supposed to be trace-scoped or global recency-first? The current API says global list, not trace detail.
- What exact ClickHouse expressions are required for `labels` and `metadataSearch` so missing-key behavior does not silently violate the logical contract?

## Doc Quality Problems

- The document set is noisier than it needs to be. `README.md`, `shared.md`, the per-table docs, and `physical-types.md` repeatedly restate the same constraints. That increases drift risk and made this harder to review than it should be.
- `physical-types.md` should stay about physical types. Read-path behaviors like reconstructing `metadata`, `createdAt`, and `updatedAt` do not belong there.
- Discovery is operational design, not just schema design. If you keep the refreshable-MV/bootstrap policy, it probably deserves a follow-up implementation note or ADR instead of being mixed into the same set as table shapes.

## Bottom Line

- Spans, metrics, and logs are mostly heading in a coherent direction.
- Scores and feedback are not ready for implementation in this codebase without upstream contract work.
- The biggest design mistakes are accepting duplicate non-tracing writes, silently weakening trace filter semantics, and making discovery failure a blocker for the whole adapter.
