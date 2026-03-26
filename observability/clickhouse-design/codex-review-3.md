# Codex Review 3

Reviewed:

- `observability/clickhouse-design/README.md`
- `observability/clickhouse-design/shared.md`
- `observability/clickhouse-design/trace-roots.md`
- `observability/clickhouse-design/span-events.md`
- `observability/clickhouse-design/metric-events.md`
- `observability/clickhouse-design/log-events.md`
- `observability/clickhouse-design/score-events.md`
- `observability/clickhouse-design/feedback-events.md`
- `observability/clickhouse-design/discovery.md`
- `observability/clickhouse-design/physical-types.md`
- `stores/duckdb/src/storage/domains/observability/{ddl.ts,index.ts,metrics.ts,tracing.ts,logs.ts,scores.ts,feedback.ts,filters.ts}`
- `packages/core/src/storage/domains/observability/record-builders.ts`
- `packages/_internal-core/src/storage/domains/observability/{metrics.ts,logs.ts,scores.ts,feedback.ts,discovery.ts}`
- `packages/core/src/storage/domains/observability/{base.ts,tracing.ts}`
- `observability/mastra/src/exporters/{default.ts,event-buffer.ts}`
- `stores/clickhouse/src/storage/domains/observability/index.ts`

I did not review examples, and I did not read `observability/clickhouse-design/claude-review-3.md`.

## Findings

### 1. Blocking: score/feedback v-next is not implementable through the current Mastra storage contract as written

The design understates the gap as "record-builder enrichment", but the problem is bigger than that.

- The design wants `score_events` to store typed context fields like `entityType`, `entityId`, `entityName`, `userId`, `organizationId`, `environment`, and `serviceName` (`observability/clickhouse-design/score-events.md:20-28`, `observability/clickhouse-design/score-events.md:56-60`).
- It wants the same kind of expansion for `feedback_events` (`observability/clickhouse-design/feedback-events.md:21-29`, `observability/clickhouse-design/feedback-events.md:67-70`).
- But the current public/core score and feedback record schemas do not have those fields at all. `ScoreRecord` only has timestamp, trace/span ids, scorer info, score, reason, experimentId, scoreTraceId, and metadata (`packages/_internal-core/src/storage/domains/observability/scores.ts:30-50`). `FeedbackRecord` only has timestamp, trace/span ids, source, feedbackType, value, comment, experimentId, userId, sourceId, and metadata (`packages/_internal-core/src/storage/domains/observability/feedback.ts:32-57`).
- The current record builders match those narrower schemas. `buildScoreRecord()` does not emit any of the proposed typed context columns (`packages/core/src/storage/domains/observability/record-builders.ts:287-303`). `buildFeedbackRecord()` does not emit them either, and it currently does not even emit `sourceId` despite the existing schema supporting it (`packages/core/src/storage/domains/observability/record-builders.ts:306-320`).

This means the design is not just waiting on a helper PR. It requires upstream schema/type changes in `@internal/core` and `@mastra/core`, plus builder/exporter work, before ClickHouse `v-next` can honestly implement the proposed score/feedback tables. That should be called out as a prerequisite, not a side note.

### 2. Blocking: append-only `MergeTree` plus exporter retries gives you duplicate rows by design, and the doc has no idempotency story

This is the biggest practical risk in the whole design.

- The design explicitly chooses append-only `MergeTree` tables for all five signals (`observability/clickhouse-design/shared.md:26-35`, `observability/clickhouse-design/README.md:27-33`).
- `trace_roots` is then populated incrementally from `span_events` by materialized view (`observability/clickhouse-design/shared.md:30-33`, `observability/clickhouse-design/trace-roots.md:9-13`).
- The exporter retries failed create batches by re-adding them to the buffer on any non-"not implemented" error (`observability/mastra/src/exporters/default.ts:219-238`), and the buffer will retry create events multiple times (`observability/mastra/src/exporters/event-buffer.ts:124-137`).
- Under `insert-only`, ended spans are routed through the create path, and all non-tracing signals are always create-only (`observability/mastra/src/exporters/event-buffer.ts:79-120`).

Inference: if a ClickHouse insert partially succeeds and the client times out, or if the insert succeeds but the client sees an ambiguous failure, the exporter will replay the same logical records. With plain append-only `MergeTree`, that means duplicate span rows, duplicate root rows, duplicate metrics/logs/scores/feedback rows, and duplicate discovery source data.

The current ClickHouse observability adapter already carries scars from this exact class of problem. It uses a mutable/deduplicating model and even has explicit migration logic around deduplication and sort keys (`stores/clickhouse/src/storage/domains/observability/index.ts:44-100`, `stores/clickhouse/src/storage/domains/observability/index.ts:107-153`, `stores/clickhouse/src/storage/domains/observability/index.ts:392-408`).

If v-next wants pure append-only, it needs a real idempotency plan before implementation starts. Options could include insert dedupe tokens, deterministic event ids, or an explicit deduping engine/table design. Right now this is missing.

### 3. High: `hasChildError` is defined inconsistently, and the proposed definition is probably wrong

- The design says `hasChildError` should be computed as "any span in the same trace has `status = error`" (`observability/clickhouse-design/span-events.md:160-164`).
- That definition includes the root span.
- The current DuckDB implementation explicitly excludes the root span with `c.spanId != root_spans.spanId` (`stores/duckdb/src/storage/domains/observability/tracing.ts:143-146`).

The name is `hasChildError`, not `traceHasAnyError`. Counting root-span failure as a child error would silently change semantics from the current implementation and from what the field name implies. This needs to be resolved before code is written.

### 4. High: score/feedback table ordering is optimized for a workload the current API does not expose

- `score_events` uses `ORDER BY (traceId, timestamp)` and the doc says this is intentional because scores are expected to be consumed primarily in trace-scoped reads (`observability/clickhouse-design/score-events.md:44-52`).
- `feedback_events` makes the same choice for the same reason (`observability/clickhouse-design/feedback-events.md:48-57`).
- But the current public API surface is `listScores` and `listFeedback`, both paginated list endpoints. `listScores` defaults to `timestamp DESC` and also allows `orderBy.field = score` (`packages/_internal-core/src/storage/domains/observability/scores.ts:151-176`). `listFeedback` defaults to `timestamp DESC` (`packages/_internal-core/src/storage/domains/observability/feedback.ts:161-184`).

There is no trace-scoped score/feedback read method in the storage interface that would justify making trace locality the primary physical sort key. This feels like designing for a hypothetical future access pattern while degrading the only access pattern that actually exists today.

### 5. High: trace status is overloaded and likely to create implementation bugs

- The design wants a stored span `status` column with values `success` and `error` (`observability/clickhouse-design/span-events.md:84-90`).
- It also says that this stored span status is not the same as the public trace status surface (`observability/clickhouse-design/span-events.md:89-90`).
- Meanwhile the public trace/listing API computes `status` from `error` and `endedAt`, and includes `running` (`packages/core/src/storage/domains/observability/tracing.ts:148-172`, `packages/core/src/storage/domains/observability/tracing.ts:291-307`).
- `trace_roots` is supposed to stay close enough to root span rows that `listTraces` can return them directly in v0 (`observability/clickhouse-design/trace-roots.md:17-22`, `observability/clickhouse-design/physical-types.md:105-109`).

This is a bad naming collision. You will have one `status` column in storage with one meaning, and one `status` field in list-trace responses with another meaning. Since v-next only stores completed spans, the public trace status will never be `running` anyway, so the stored column is mostly redundant. I would either:

- rename the internal column to something like `spanTerminalStatus`, or
- drop it entirely and derive error/success from `error` on the query path where needed.

As written, this invites subtle bugs and confusing tests.

### 6. High: key ClickHouse query semantics for metrics are still not designed, only implied

The metrics doc is not concrete enough for implementation.

- It promises `getMetricAggregate`, `getMetricBreakdown`, `getMetricTimeSeries`, and `getMetricPercentiles` (`observability/clickhouse-design/metric-events.md:80-88`).
- It defines broad `groupBy` behavior for typed columns vs label lookups (`observability/clickhouse-design/metric-events.md:102-108`).
- But it never chooses the ClickHouse-specific functions that actually determine semantics: percentile function (`quantileExact`, `quantileTDigest`, etc.), time bucketing function, or the exact `Map` lookup/filter pattern for arbitrary label keys.

DuckDB is concrete here. It already commits to `percentile_cont`, explicit time bucketing, and explicit label fallback logic (`stores/duckdb/src/storage/domains/observability/metrics.ts:172-199`, `stores/duckdb/src/storage/domains/observability/metrics.ts:578-617`).

For ClickHouse, these are not implementation details to defer. They materially affect correctness, cost, and cross-backend drift. Percentiles especially need a design decision before implementation begins.

### 7. Medium-High: the discovery design is still too assumption-heavy to be a repo implementation plan

- The discovery design assumes Cloud ClickHouse supports refreshable materialized views, and says the design "does not apply as written" if that is not true (`observability/clickhouse-design/discovery.md:20-25`).
- The main README also scopes Cloud ClickHouse as the target (`observability/clickhouse-design/README.md:39-46`).
- But the code is going into the general `stores/clickhouse` adapter, and the repo will still need deterministic init/test behavior locally.

What is missing:

- the exact DDL shape for refreshable MVs
- the init/bootstrap sequence for helper tables, views, and initial refresh
- failure behavior when refresh fails
- version/feature gating
- the test environment assumption

`discovery.md` is good at describing the logical helper-table model, but it is not yet concrete enough to hand to an implementer and expect low-churn ClickHouse code.

### 8. Medium: event-span read semantics are not actually decided

- The design normalizes event spans to `endedAt = startedAt` on write (`observability/clickhouse-design/shared.md:28-29`, `observability/clickhouse-design/span-events.md:9-13`, `observability/clickhouse-design/span-events.md:91-96`).
- Then it says ClickHouse "can" map them back to `endedAt = null` on reads if preserving the public contract matters (`observability/clickhouse-design/span-events.md:95-96`).

That is too soft. The adapter needs a single committed read contract. "Can" means the implementer is being asked to pick semantics ad hoc. Resolve this before implementation:

- either event spans always read back as zero-duration spans, or
- they always read back with `endedAt = null`.

### 9. Medium: the rollout plan is not realistic because it omits prerequisite work

The stated rollout is:

1. finalize docs
2. implement DDL/helpers
3. implement writes/reads
4. add tests

That ignores several prerequisites that are already obvious from the design and the current code:

- upstream score/feedback schema changes in core
- record-builder/exporter changes for score/feedback context propagation
- an idempotency/deduplication strategy for append-only writes
- a concrete discovery bootstrap/test plan
- concrete ClickHouse query choices for percentiles, bucketing, and dynamic label access

See `observability/clickhouse-design/README.md:48-68`, `observability/clickhouse-design/shared.md:74-75`, `observability/clickhouse-design/score-events.md:59-60`, and `observability/clickhouse-design/feedback-events.md:67-69`.

As written, the next steps are too optimistic and will cause churn.

## Open Questions That Should Be Resolved Before Implementation

1. What is the idempotency model for create-only writes under exporter retries and ambiguous insert failures?
2. Does `hasChildError` exclude the root span or not?
3. Are score/feedback context fields part of the core storage contract now, or is this design blocked on a separate upstream contract expansion?
4. What exact ClickHouse functions will define metric percentiles and time bucketing?
5. What is the minimum ClickHouse feature/version target for refreshable materialized views and `Map`-heavy queries?
6. What is the committed read contract for event spans: `endedAt = null` or `endedAt = startedAt`?
7. Should `score_events` and `feedback_events` optimize for the current list APIs instead of hypothetical future trace-scoped reads?

## Redundancy And Noise

The doc set is trying too hard to explain everything in three places.

- `shared.md` repeats some per-table facts.
- `physical-types.md` repeats nearly every column from the per-table docs.
- the per-table docs then restate the same logical and physical information yet again.

That creates a drift trap before any DDL exists. It is also internally awkward that the shared doc says raw DDL should become the schema source (`observability/clickhouse-design/shared.md:213-216`) while `physical-types.md` is itself a second schema spec (`observability/clickhouse-design/physical-types.md:1-25` and below).

I would cut this down to:

- one shared doc for cross-cutting decisions only
- one table doc per signal/helper where the table-specific contract lives
- DDL as the authoritative source once implementation lands

## What Should Probably Be Split Into A Follow-Up Doc

The discovery operational plan should probably be its own short implementation ADR instead of living inline with the core schema design.

Reasons:

- it depends on ClickHouse feature availability more than on signal schema shape
- it has its own operational lifecycle: refresh cadence, bootstrap, failure behavior, staleness, and testability
- it is the part most likely to change independently of the base tables

`discovery.md` is useful, but it is operationally dense enough that it will probably churn separately from the core five-signal schema.

## ClickHouse-Specific Implementation Traps

- Retry-driven duplicate inserts are the big one. Pure append-only `MergeTree` does not make that problem disappear.
- Lightweight deletes are asynchronous. Tests and API expectations must avoid strict read-after-delete assumptions.
- Dynamic `Map` key access for labels/metadata/groupBy needs careful sanitization. Do not interpolate arbitrary keys into SQL.
- Refreshable materialized views are a feature dependency, not just a convenience. If they are unavailable or awkward in the target environment, discovery falls apart.
- Duplicating large JSON payloads into `trace_roots` will materially increase write amplification and storage. That may still be acceptable, but the cost is real.

## Bottom Line

The tracing core is directionally sensible, but the design is not yet implementation-ready.

The two biggest problems are:

- it has no idempotency/deduplication plan for append-only writes, and
- it pretends score/feedback only need record-builder enrichment when they actually need upstream contract changes.

If those are not resolved first, the implementation under `stores/clickhouse/src/storage/domains/observability/v-next/` will either drift from the design immediately or ship with correctness problems.
