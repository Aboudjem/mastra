# Codex Review 4

## Findings

1. High: the score/feedback design is not actually implementable against the current Mastra storage contracts, and the doc understates that gap.

   The design wants `score_events` to carry typed context like `entityType`, `entityId`, `entityName`, `userId`, `organizationId`, `environment`, and `serviceName` ([score-events.md:20-29](./score-events.md), [physical-types.md:183-202](./physical-types.md)). It wants the same kind of expansion for `feedback_events` plus `sourceId` ([feedback-events.md:21-29](./feedback-events.md), [physical-types.md:204-222](./physical-types.md)). But the current storage record schemas do not have those fields at all: `scoreRecordSchema` only has the score-specific fields plus `metadata` ([packages/_internal-core/src/storage/domains/observability/scores.ts:30-50](../../packages/_internal-core/src/storage/domains/observability/scores.ts)), and `feedbackRecordSchema` only has `traceId`, `spanId`, `source`, `feedbackType`, `value`, `comment`, `experimentId`, `userId`, `sourceId`, and `metadata` ([packages/_internal-core/src/storage/domains/observability/feedback.ts:32-57](../../packages/_internal-core/src/storage/domains/observability/feedback.ts)). The current builders match that smaller shape: `buildScoreRecord()` does not propagate any of the new context fields, and `buildFeedbackRecord()` does not even propagate `sourceId` ([packages/core/src/storage/domains/observability/record-builders.ts:287-320](../../packages/core/src/storage/domains/observability/record-builders.ts)).

   The shared doc says this is just "record-builder enrichment" that should land separately ([shared.md:87-88](./shared.md)), but that is not the full scope. This requires upstream schema/type changes in `_internal-core` and `core`, builder changes, tests, and probably API expectations. As written, the rollout order implies storage implementation can start after DDL ([README.md:50-66](./README.md)). It cannot. The upstream contract work is a prerequisite, not a follow-up.

2. High: the tracing filter/query contract is deliberately narrower than the current public Mastra contract, but the doc does not frame it as a contract change.

   The v-next tracing design says trace metadata is only searchable through a top-level string map (`metadataSearch`), non-string or nested metadata filters should just return no rows, and `scope` is inspection-only with no filtering support ([span-events.md:114-132](./span-events.md), [span-events.md:175-182](./span-events.md), [trace-roots.md:45-61](./trace-roots.md), [shared.md:186-191](./shared.md)). Current Mastra tracing types do not say that. `tracesFilterSchema` still exposes `metadata` and `scope` through `sharedFields` and `contextFields` ([packages/core/src/storage/domains/observability/tracing.ts:76-80](../../packages/core/src/storage/domains/observability/tracing.ts), [packages/core/src/storage/domains/observability/tracing.ts:291-306](../../packages/core/src/storage/domains/observability/tracing.ts), [packages/_internal-core/src/storage/domains/shared.ts:145-179](../../packages/_internal-core/src/storage/domains/shared.ts)). DuckDB also implements JSON filtering on both `metadata` and `scope` today ([stores/duckdb/src/storage/domains/observability/filters.ts:93-101](../../stores/duckdb/src/storage/domains/observability/filters.ts)).

   Backend-specific semantics are fine if they are intentional, but then they need to be made explicit at the repo contract level. Right now the design effectively says "same storage interface, different semantics, and some filters silently become no-op-or-empty." That is going to create churn in tests and caller expectations unless the public contract is updated before v-next lands.

3. High: the tracing dedupe story is not deterministic enough for ClickHouse as written.

   The design repeatedly says `dedupeKey` is the tracing row identity, that `ReplacingMergeTree` should be used with `dedupeKey` "participating" in the sorting key, and that query-time `LIMIT 1 BY dedupeKey` should hide duplicates before merges complete ([shared.md:111-119](./shared.md), [span-events.md:138-149](./span-events.md), [trace-roots.md:28-39](./trace-roots.md)). That is not a complete correctness rule. `ReplacingMergeTree` replacement is based on the full sorting key, not "dedupeKey exists somewhere in ORDER BY", and there is no version column here. In `span_events`, the key is `(traceId, endedAt, spanId, dedupeKey)` ([span-events.md:138-140](./span-events.md)); in `trace_roots`, it is `(startedAt, traceId, dedupeKey)` ([trace-roots.md:28-30](./trace-roots.md)).

   If the same `dedupeKey` is retried with a different `endedAt`, `startedAt`, or payload, merge-time replacement will not behave the way this doc implies, and query-time `LIMIT 1 BY dedupeKey` will pick an arbitrary survivor unless the preceding sort order is defined to pick a winner. If the real invariant is "exporter retries are byte-for-byte identical ended-span rows", say that explicitly and test it. If not, this needs a real winner rule, likely a version column or a strictly defined pre-`LIMIT 1 BY` ordering. As written, the storage is only idempotent for the happiest possible retry case.

4. Medium-high: the score/feedback physical ordering is optimized for a query pattern that the current Mastra API does not expose as the main read path.

   Both `score_events` and `feedback_events` choose `ORDER BY (traceId, timestamp)` because they are "expected to be consumed primarily in trace-scoped reads" ([score-events.md:44-52](./score-events.md), [feedback-events.md:48-57](./feedback-events.md)). That expectation is not reflected in the current storage interfaces. The actual list APIs are `listScores` and `listFeedback`, and both default to timestamp ordering ([packages/_internal-core/src/storage/domains/observability/scores.ts:151-171](../../packages/_internal-core/src/storage/domains/observability/scores.ts), [packages/_internal-core/src/storage/domains/observability/feedback.ts:161-179](../../packages/_internal-core/src/storage/domains/observability/feedback.ts)). There is no primary "get scores for a trace" or "get feedback for a trace" API driving this choice.

   This is an inference from the current Mastra API shape, but it is a strong one: the design is optimizing the physical layout for a workload the codebase does not currently present as primary. Unless you are also changing the read API surface, this makes the default recency-first list path the cold path for no documented reason.

5. Medium: the discovery plan is environment-conditional and still underspecified operationally.

   The design assumes Cloud ClickHouse and explicitly assumes refreshable materialized views exist; if they do not, the design "does not apply as written" ([README.md:41-48](./README.md), [discovery.md:20-24](./discovery.md)). That is not fatal, but it means this is not yet a general `stores/clickhouse` design. It is a Cloud ClickHouse design with no fallback. The doc also says init should trigger an immediate manual refresh after creating the helper tables/views ([discovery.md:211-223](./discovery.md)), but it does not say what `init()` should do when that refresh fails, whether startup should fail closed or serve stale/empty discovery, or how the adapter should feature-detect support cleanly.

   That needs to be resolved before implementation starts. Otherwise the first real question in `v-next/ddl.ts` and `v-next/discovery.ts` will be "what exactly is the supported runtime envelope?" and the answer is currently "it depends."

6. Medium: the rollout / next-steps section is not complete enough to guide implementation in this repo.

   The listed rollout is "finalize docs, implement DDL, implement writes/reads, add tests" ([README.md:50-66](./README.md)). That skips the repo-level prerequisites that this design itself depends on:

   Those prerequisites include core schema expansion for score/feedback records ([packages/_internal-core/src/storage/domains/observability/scores.ts:30-50](../../packages/_internal-core/src/storage/domains/observability/scores.ts), [packages/_internal-core/src/storage/domains/observability/feedback.ts:32-57](../../packages/_internal-core/src/storage/domains/observability/feedback.ts)), builder changes and probably event-shape propagation for those same fields ([packages/core/src/storage/domains/observability/record-builders.ts:287-320](../../packages/core/src/storage/domains/observability/record-builders.ts)), a shared normalization implementation for `tags`, `labels`, and `metadataSearch` that discovery can rely on ([shared.md:182-186](./shared.md), [discovery.md:151-156](./discovery.md)), concrete init/refresh orchestration for discovery helpers ([discovery.md:211-223](./discovery.md)), and a decision on how backend-specific trace-filter semantics are represented in tests and public docs ([span-events.md:122-132](./span-events.md), [packages/core/src/storage/domains/observability/tracing.ts:291-306](../../packages/core/src/storage/domains/observability/tracing.ts)).

   This should be reworked into a real implementation plan. Right now it reads like storage work can start immediately with only DDL/query effort, which is false.

## Secondary Notes

- The append-only + ended-span-only tracing model is the cleanest part of the design. It is a real simplification over DuckDB's event-sourced reconstruction and is a reasonable ClickHouse fit. The problem is not the direction; the problem is that the contract changes and dedupe guarantees are not nailed down tightly enough yet.

- The five-signal table family is mostly coherent for metrics/logs/traces. The asymmetry on scores/feedback is also defensible because the current public filters for those signals are much smaller. The issue there is not asymmetry by itself. The issue is that the docs currently describe a richer typed shape than the codebase can carry.

## Redundancy / Noise

- The doc set repeats the same invariants too many times. `dedupeKey`, `metadataSearch`, ended-span-only tracing, and `trace_roots` behavior are spread across [README.md](./README.md), [shared.md](./shared.md), [span-events.md](./span-events.md), [trace-roots.md](./trace-roots.md), and [physical-types.md](./physical-types.md). That is already enough duplication to cause drift.

- `physical-types.md` is useful because it is the closest thing to implementable DDL guidance. The repeated full field inventories in the per-table docs are much less useful. If I were implementing this, I would want one place for "logical contract" and one place for "physical columns/types", not three.

- The future-looking material around native JSON revisits, future `hasChildError` helpers, and hypothetical retention splits is not wrong, but it dilutes the v0 implementation signal. Those belong in a follow-up design/backlog note unless they change the first implementation.

## Things To Resolve Before Coding Starts

- Decide whether v-next is allowed to narrow trace filter semantics relative to the shared public API. If yes, update the contract/tests so that is explicit.

- Decide whether retry-idempotency only needs to handle byte-identical duplicate ended-span writes. If yes, say that directly. If no, add a deterministic winner rule.

- Expand the score/feedback storage schemas and builders before any ClickHouse storage work starts.

- Decide whether `stores/clickhouse` v-next is cloud-only. If yes, fail fast when refreshable MVs are unavailable. If no, add a fallback discovery design now, not later.

- Decide where normalization lives. If `tags`, `labels`, and `metadataSearch` normalization is storage-local, parity across adapters will drift. If it is shared, move it into shared helpers before writing adapter code.

## ClickHouse-Specific Implementation Traps

- `ReplacingMergeTree` without a version column plus `LIMIT 1 BY` can look correct in tests and still be semantically mushy under non-identical duplicate rows.

- The incremental MV into `trace_roots` will not save you from delete/truncate/TTL consistency issues. The design acknowledges that, but the tests need to assert eventual behavior across both tables, not just per-table disappearance.

- `Map` lookups and arbitrary label-key grouping are flexible, but they are not free. `getMetricBreakdown` / `getMetricTimeSeries` on ad hoc label keys will scan and compute. That is probably acceptable in v0, but it is a real cost, not an implementation detail.

- Discovery will look broken on day one if bootstrap refresh is forgotten or fails. The doc mentions manual refresh; the implementation needs to treat that as mandatory, not optional.
