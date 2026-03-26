# ClickHouse v-next Observability Review Synthesis

This combines the substantive findings from:

- [codex-review-4.md](./codex-review-4.md)
- [claude-review-4.md](./claude-review-4.md)

It is intentionally deduplicated. Repeated findings are merged into one issue. Where one review was making an inference rather than citing an explicit contract, that is called out.

## Current Status

The synthesis below reflects the merged review backlog at the time it was written. Several issues in that backlog have since been resolved directly in the design docs:

- discovery helper sort-key nullability was removed by making discovery key slots non-null with `''` sentinels
- discovery helper `scope` was removed
- tracing retry-idempotency now explicitly assumes byte-identical duplicate ended-span rows
- tracing multi-row queries now explicitly use a two-stage dedupe/query pattern
- trace metadata filtering is now explicitly narrowed to top-level string equality over `metadataSearch`
- trace `scope` filtering is now explicitly unsupported in v0
- `observabilityStrategy` is now the only supported strategy property for `v-next`
- trace status is now explicitly derived from `error` presence rather than stored as a physical column
- feedback value storage now uses split typed columns (`valueString` / `valueNumber`) rather than JSON-encoding mixed scalars into one string column

The main intentionally deferred issue is still the score/feedback upstream contract gap relative to current builders and schemas.

## Working Queue

### 1. P0: discovery table DDL is not safe as written because `Nullable` columns are used in MergeTree sort keys

`discovery_values` uses `ORDER BY (kind, key1, value)` while `key1` is `Nullable(String)`, and `discovery_pairs` uses `ORDER BY (kind, key1, key2, value)` while `key2` is `Nullable(String)`. That is not a safe default ClickHouse assumption. Some versions/settings allow nullable keys, but the design does not explicitly require `allow_nullable_key = 1`, and even where it works it is a tradeoff rather than a neutral choice.

This is the clearest design-level DDL blocker in the set. If the design wants broad implementability, it should stop using nullable sort-key columns here and switch to a non-nullable sentinel representation such as empty string for "no secondary key". If the design instead wants to require nullable keys, it needs to say so explicitly and justify the operational cost.

Affected docs:

- [physical-types.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/physical-types.md)
- [discovery.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/discovery.md)

### 2. P1: the tracing dedupe/query model is still underspecified for real ClickHouse queries

Both reviews converged on the same core problem from different angles:

- the design leans on `ReplacingMergeTree` plus `LIMIT 1 BY dedupeKey`
- the docs imply this is enough to make retry duplicates harmless
- the actual winner rule is not fully specified
- the actual query shape is more constrained than the docs admit

Concretely:

- `ReplacingMergeTree` without a version column is only safe if duplicate tracing rows are semantically identical
- if the same `dedupeKey` can be retried with different timestamps or payload, merge-time replacement is not deterministic enough
- `LIMIT 1 BY dedupeKey` does not magically preserve a second presentation order; in practice the design will need a wrapping subquery/CTE for `listTraces` and likely for some `span_events` reads too
- pagination and counts also need to deduplicate in the same query shape, not as a postscript

The design should pick one of these positions explicitly:

1. Strong invariant: tracing retries are byte-identical ended-span rows, so any survivor is equivalent.
2. Stronger storage rule: duplicate tracing rows may differ, so add a deterministic winner rule and encode it in schema/query design.

Without that decision, the current dedupe story is too hand-wavy to implement confidently.

Affected docs:

- [shared.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/shared.md)
- [span-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/span-events.md)
- [trace-roots.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/trace-roots.md)
- [physical-types.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/physical-types.md)

### 3. P1: score/feedback design is ahead of the actual Mastra storage contracts, so the current rollout is not implementable as written

Both reviews flagged this, and the problem is straightforward:

- the design gives `score_events` and `feedback_events` richer typed context columns
- the current record schemas and record builders do not actually carry enough data to populate that shape
- the docs describe this as enrichment that can land separately, but in practice it is a prerequisite if those filters are meant to work

That means the design currently mixes two different states:

1. a desired ClickHouse table shape
2. a repo contract that does not yet supply the required fields

Those cannot be treated as loosely coupled. The design needs to decide whether:

- score/feedback v-next are blocked on upstream schema/builder changes, or
- the initial ClickHouse design intentionally ships those columns mostly null and narrows the supported filter surface for v0

Right now it claims the richer shape without really pricing in the dependency.

Affected docs:

- [shared.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/shared.md)
- [score-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/score-events.md)
- [feedback-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/feedback-events.md)
- [README.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/README.md)

### 4. P1: the tracing filter/discovery contract narrows current Mastra semantics, but the design does not fully own that as a contract change

This is primarily from the Codex review, but it is a significant design issue.

The docs narrow tracing search/filter behavior in at least these ways:

- metadata search is limited to a top-level string-only `metadataSearch` map
- nested or non-string metadata filtering becomes unsupported
- `scope` becomes effectively inspection-only rather than a first-class filter surface

That may be a reasonable ClickHouse tradeoff. The problem is that the design mostly presents it as an implementation detail rather than a contract change relative to the current shared tracing filters and DuckDB behavior.

If this narrowing is intentional, the design should say so directly and include the compatibility consequence. If it is not intentional, then the current docs are too optimistic about what the new tables can support.

Affected docs:

- [shared.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/shared.md)
- [span-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/span-events.md)
- [trace-roots.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/trace-roots.md)

### 5. P1: discovery is conceptually strong, but operationally underspecified

The discovery design is one of the better-thought-out parts of the doc set, but there are still operational gaps:

- the design depends on a Cloud ClickHouse feature envelope, especially refreshable materialized views
- there is no fallback plan if that feature set is unavailable
- bootstrap refresh behavior is not tight enough
- refresh failure semantics are not nailed down
- large refresh-query complexity is acknowledged only indirectly

This matters because discovery is not just "some helper tables". It is part of the user-facing filter/discovery story. If the runtime support envelope is not decided now, implementers will end up making product decisions in adapter code.

Affected docs:

- [README.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/README.md)
- [discovery.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/discovery.md)

### 6. P1/P2: some physical layout choices do not clearly match the current Mastra read surface

This is partly explicit and partly inference from current interfaces:

- `score_events` and `feedback_events` are ordered around trace-scoped reads, but current public APIs are still timestamp-oriented list APIs
- `log_events` ordering is chosen for recency-first access, but the docs do not state whether trace-scoped log reads are expected to be secondary
- `getSpan` should prefer `(traceId, spanId)` lookups rather than presenting `dedupeKey` as an equivalent point-lookup path

None of these are fatal, but they are exactly the sort of "small" decisions that create later churn once real query behavior shows up in benchmarks and tests. The design should tie each physical key choice to a stated dominant access pattern, not leave that implicit.

Affected docs:

- [score-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/score-events.md)
- [feedback-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/feedback-events.md)
- [log-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/log-events.md)
- [span-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/span-events.md)

### 7. P2: several implementation-critical details are still loose enough to cause avoidable churn

These are smaller than the issues above, but they are real implementation traps:

- `hasChildError` query shape and whether it needs deduplication or can rely on duplicate-equivalent rows
- `feedback.value` storage direction: JSON-encoded string vs plain string, and whether that reflects current API reality or a future-proofing idea
- `metadataSearch` promoted-key exclusion list needs one canonical definition
- `status` string casing needs to be spelled out
- discovery refresh SQL should state whether deduplication of tracing sources is unnecessary because `DISTINCT`/replacement semantics make duplicates harmless for discovery
- missing explicit defaults on non-nullable columns increase the chance of silent bad MV projections
- `observabilityStrategy` vs `tracingStrategy` compatibility should be called out directly if the design depends on it

Affected docs:

- [shared.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/shared.md)
- [span-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/span-events.md)
- [trace-roots.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/trace-roots.md)
- [feedback-events.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/feedback-events.md)
- [discovery.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/discovery.md)
- [physical-types.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/physical-types.md)

### 8. P2: the rollout section is too optimistic for the amount of unresolved contract work

The current rollout still reads too much like:

1. finalize docs
2. implement DDL
3. implement writes/reads
4. add tests

That is not enough. Based on the combined reviews, the real prerequisites include:

- settling discovery DDL/runtime assumptions
- settling tracing duplicate invariants and query patterns
- deciding whether trace-filter narrowing is a real contract change
- deciding whether score/feedback contract expansion is a prerequisite or deferred scope
- specifying normalization ownership for `tags`, `labels`, and `metadataSearch`

The docs need a more honest implementation order, otherwise the design will look more ready than it is.

Affected docs:

- [README.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/README.md)
- [shared.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/shared.md)

## Overlap Summary

Issues independently flagged by both reviews:

- tracing dedupe story is too loose
- score/feedback upstream contract gap is a real blocker
- rollout/prerequisites are understated

Issues primarily surfaced by Claude:

- nullable discovery sort keys are a concrete DDL blocker
- `LIMIT 1 BY` requires more explicit subquery/query-shape guidance
- discovery refresh/query operational details need more precision

Issues primarily surfaced by Codex:

- trace filter semantics are being narrowed relative to current Mastra contract
- score/feedback ordering choices may not match actual read APIs
- doc-set redundancy is high enough to become an implementation liability

## Recommended Order To Fix The Design

1. Fix discovery sort-key nullability and lock the supported ClickHouse feature envelope.
2. Tighten tracing duplicate invariants and prescribe the real query shape for dedupe, ordering, counts, and pagination.
3. Decide whether tracing filter semantics are intentionally narrower than current shared Mastra behavior.
4. Decide whether score/feedback contract expansion is a blocker for v-next or whether those signals need a smaller honest v0.
5. Reconcile physical key choices with stated dominant read paths.
6. Collapse repeated cross-cutting rules so there is one authoritative home for each major invariant.

## Doc Hygiene

The design docs are doing too much repeated teaching. The worst repetition is around:

- ended-span-only tracing
- `dedupeKey`
- `metadataSearch`
- `trace_roots` purpose
- divergence from DuckDB

That repetition is already making the design harder to audit because the same rule shows up in multiple places with slightly different wording. The practical fix is:

- keep cross-cutting rules in [shared.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/shared.md)
- keep concrete physical schema in [physical-types.md](/Users/epinzur/src/github.com/mastra-ai/mastra/observability/clickhouse-design/physical-types.md)
- keep per-signal docs focused on signal-specific write/read behavior and omit repeated field inventories where possible

Discovery is also a reasonable split candidate if the main doc set keeps growing. It is already substantial enough to stand alone as its own implementation design.
