# Design Review: ClickHouse v-next Observability

**Reviewer**: Claude Opus 4.6
**Date**: 2026-03-26
**Scope**: Implementability review of clickhouse-design/ docs against Mastra codebase
**Verdict**: Solid design, ready for implementation with a handful of concrete issues to resolve first

---

## Findings

### P0 — Must resolve before implementation

#### 1. `trace_roots` partitioning vs. default query pattern mismatch

**Files**: trace-roots.md, span-events.md

`trace_roots` uses `PARTITION BY toDate(endedAt)` but `ORDER BY (startedAt, traceId, dedupeKey)`. The default `listTraces` query pattern is `ORDER BY startedAt DESC` with optional `startedAt` time-range filters.

Because partitioning is on `endedAt`, ClickHouse cannot use partition pruning for `startedAt`-based time-range filters. Every `listTraces` call with a startedAt range filter will scan all partitions.

For most short-lived spans this barely matters (startedAt and endedAt are the same day). But for long-running traces (hours/days), traces land in a "future" partition relative to their startedAt, and broad time-range queries degrade to full-table scans on `trace_roots`.

**Options to consider**:
- Accept this as a v0 tradeoff and document it (most traces are short-lived, so the practical impact is small)
- Partition trace_roots by `toDate(startedAt)` instead, and manage TTL on `startedAt + INTERVAL N DAY` (this breaks TTL alignment with span_events but optimizes the dominant query pattern)
- Keep current design but add a secondary index on startedAt for partition skipping

This should be a conscious decision, not a surprise during performance testing.

#### 2. Map type default-value trap for label filtering

**Files**: metric-events.md, shared.md, physical-types.md

`labels` is `Map(LowCardinality(String), String) DEFAULT {}`. When filtering labels with contains-all semantics, the implementation needs to be aware that ClickHouse Map access returns the type's default value (empty string for String) when a key doesn't exist, not NULL.

This means `labels['nonexistent_key'] = ''` evaluates to TRUE in ClickHouse, which would produce false-positive filter matches.

The correct contains-all filter pattern requires checking both key existence AND value match:
```sql
-- Wrong: labels['region'] = 'us-east-1'
-- Right: mapContains(labels, 'region') AND labels['region'] = 'us-east-1'
```

The design specifies the semantic contract (contains-all) but doesn't call out this ClickHouse-specific implementation trap. The DuckDB implementation uses `json_extract_string(labels, ?)` which returns NULL for missing keys and avoids this issue naturally.

Same concern applies to `metadataSearch` filtering on span_events and trace_roots.

#### 3. Score/feedback record-builder gap is a real sequencing risk

**Files**: shared.md (line 88-89), score-events.md (line 61-62), feedback-events.md (line 80-81), record-builders.ts

The design correctly identifies that `buildScoreRecord` and `buildFeedbackRecord` don't currently populate the entity/context columns (`entityType`, `entityId`, `entityName`, `userId`, `organizationId`, `environment`, `serviceName`) and says this should "land separately."

But the score and feedback table designs include these columns as filterable dimensions. If v-next ships before the record-builder enrichment:
- All entity/context columns on scores and feedback will be NULL
- Any filter on these dimensions returns zero rows
- The filter schema accepts these filters, so users get silent empty results rather than errors

**Recommendation**: Either (a) make the record-builder enrichment PR a hard prerequisite for v-next, or (b) explicitly document which score/feedback filters are non-functional until the enrichment lands, and consider having the adapter throw "not implemented" for those specific filter dimensions until the data exists.

---

### P1 — Should resolve before implementation, not blockers

#### 4. Discovery refreshable MV capability detection is underspecified

**Files**: discovery.md (line 24-26), shared.md (line 245-246)

The design says to "fail fast" if refreshable MVs aren't available, but doesn't specify how to detect this. In ClickHouse Cloud, refreshable MVs are available in recent versions. But:
- There's no `SELECT` query that cleanly checks "does this cluster support `REFRESH EVERY`"
- The typical detection pattern is to attempt creating a test refreshable MV and catch the error
- The `SYSTEM REFRESH VIEW` command for bootstrap also requires specific permissions

**Recommendation**: Add a concrete detection strategy. The simplest approach: attempt to create a small test refreshable MV during init, catch the error, and fail with a clear message. Clean up the test MV on success.

#### 5. `hasChildError` performance cliff is real and unquantified

**Files**: trace-roots.md, span-events.md

When `hasChildError` is used in `listTraces`, the query joins from `trace_roots` into `span_events` for every candidate trace. With the two-stage dedup query shape already in play, this becomes:

```
inner: trace_roots rows -> LIMIT 1 BY dedupeKey
outer: filtered/paginated results
+ per-trace EXISTS subquery into span_events
```

For a `listTraces` call returning 50 results from a million-trace dataset, the EXISTS subquery may touch a lot of data. The design says "may require checking child-span existence from trace_roots-driven trace listing queries" but doesn't estimate the cost or recommend mitigations.

**Recommendation**: Document the expected performance envelope. If `hasChildError` is expected to be used frequently in the UI, consider whether v0 should support it at all vs. deferring it to the refreshable helper structure mentioned as the future optimization path.

#### 6. Feedback `value` type detection needs explicit adapter-level specification

**Files**: feedback-events.md, physical-types.md, record-builders.ts

The design specifies `valueString` / `valueNumber` split but the current `buildFeedbackRecord` returns `value: fb.value` as a string. The v-next adapter must:
1. Receive a string `value` from the record builder
2. Detect whether it's numeric (parseable as a number)
3. Write to the appropriate column

The design doesn't specify:
- What constitutes "numeric" (is `"3.14"` numeric? `"NaN"`? `"Infinity"`? `""`)
- Whether the adapter or the record builder owns the type detection
- How the read path reconstructs: does `valueNumber` get `.toString()` or does it preserve numeric precision?

This is a small thing but will cause implementation churn if not decided upfront. My inference: the adapter should own the split since it's a ClickHouse-specific physical concern, and the record builder should remain backend-agnostic.

---

### P2 — Worth noting, unlikely to block

#### 7. `costUnit` LowCardinality inconsistency between docs

**Files**: shared.md (LowCardinality guidance section), physical-types.md

The LowCardinality guidance in shared.md lists strong v0 candidates but doesn't include `costUnit`. However, physical-types.md specifies `costUnit: LowCardinality(Nullable(String))`. This is a documentation inconsistency — the physical types are the authoritative source, but the guidance section should match.

#### 8. No explicit ClickHouse time-bucketing function specified for metrics

**Files**: metric-events.md

DuckDB uses `time_bucket(INTERVAL '...', timestamp)`. ClickHouse doesn't have `time_bucket` — the equivalent is `toStartOfInterval(timestamp, INTERVAL ...)`. The design doesn't mention this translation. Similarly, DuckDB's `percentile_cont(p) WITHIN GROUP (ORDER BY value)` maps to ClickHouse's `quantile(p)(value)` or `quantileExact(p)(value)`.

Not a design gap, but the implementer needs to know these aren't 1:1 translations. The quantile functions in particular have different interpolation behaviors — `quantileExact` is the closest to `percentile_cont` but can be memory-intensive.

#### 9. `log_events` message filtering not addressed

**Files**: log-events.md

The log design specifies `message: String` but doesn't discuss whether message supports any filtering (substring, LIKE, etc.). The current public log filter schema may support text-based message filtering. If it does, the design should explicitly state whether v0 supports it (and using what ClickHouse mechanism — LIKE, position(), hasToken(), full-text index).

If message filtering isn't part of the current filter schema, this is moot.

#### 10. Discovery refresh scanning cost at scale

**Files**: discovery.md (line 211)

The operational note acknowledges that refresh queries scan full source tables. For a deployment with, say, 100M span_events, 50M metric_events, and 20M log_events, the discovery_values refresh (every 1 minute) runs a large UNION ALL + DISTINCT across all three tables. This is a non-trivial ClickHouse query load.

The design accepts this as a v0 tradeoff, which is reasonable. But the implementer should consider adding time-range bounding (e.g., only refresh from the last 7 days) to the refresh queries even in v0 to prevent unbounded growth in refresh cost. The design's retention TTL partially mitigates this, but TTL expiry is asynchronous and the actual table size may exceed the nominal retention window.

#### 11. `span_events` ORDER BY has partial redundancy

**Files**: span-events.md, physical-types.md

`ORDER BY (traceId, endedAt, spanId, dedupeKey)` where `dedupeKey = traceId || ':' || spanId`. The dedupeKey is a concatenation of traceId and spanId, which are already in the sort key. The dedupeKey is there for ReplacingMergeTree replacement identity, which is correct. But it means the sort key stores `traceId` information twice and `spanId` information twice.

This is a conscious design choice (dedupeKey must be in ORDER BY for replacement) and the storage overhead is negligible. Not a problem, just calling it out since it looks odd at first glance.

---

## Implementation Traps (ClickHouse-specific)

These aren't design issues but things the implementer should be aware of:

1. **`LowCardinality(Nullable(String))` has quirks**: NULL handling in LowCardinality columns works but has subtle differences from regular Nullable in some aggregate functions. Test NULL filtering early.

2. **Refreshable MV DDL syntax**: `CREATE MATERIALIZED VIEW ... REFRESH EVERY INTERVAL 1 MINUTE TO target_table AS SELECT ...`. The `TO` clause is critical — without it, ClickHouse creates an internal storage table instead of writing to the explicit target. The design implies explicit target tables, so use `TO`.

3. **`SYSTEM REFRESH VIEW` permissions**: The bootstrap manual refresh requires the `SYSTEM RELOAD` privilege or similar. Cloud ClickHouse may have this by default, but verify.

4. **`TRUNCATE TABLE` doesn't propagate through MVs**: The design correctly handles this (explicit truncation of both span_events and trace_roots). But truncating the source of an incremental MV doesn't invalidate or truncate the MV target. Similarly, truncating trace_roots while the MV continues to run means new inserts into span_events will re-populate trace_roots. The `dangerouslyClearAll` implementation needs to truncate both in the right order (or it doesn't matter since both get truncated).

5. **`DELETE FROM` lightweight deletes**: These are eventually consistent in ClickHouse. The design acknowledges this. But in tests, you may need `OPTIMIZE TABLE ... FINAL` or `SELECT ... FINAL` to verify deletes happened. The design says "test eventual disappearance" which is the right approach, but be aware that test timing can be flaky.

6. **`Array(LowCardinality(String)) DEFAULT []`**: ClickHouse handles this correctly, but inserting NULL for the tags column will use the default `[]`. Make sure the adapter never sends `null` for tags — always send `[]`. Same for labels and metadataSearch maps.

---

## Document Quality Notes

### Redundancy

The design is repetitive by intent (each doc is self-contained for its table). The cost: the same decisions about "no scope filtering in v0" or "no stored status column" appear in shared.md, span-events.md, trace-roots.md, and physical-types.md. This makes it harder to spot contradictions and means a single decision change requires updating 3-4 files.

For implementation, this is fine — the implementer can work from one doc at a time. But if the design evolves during implementation, the update burden is real.

### What's good

- The separation between shared decisions and per-table contracts is clean
- The physical-types.md doc is exactly what an implementer needs — no ambiguity in column types
- The discovery design is thorough and the dimension semantics table is directly translatable to DDL
- The v0 limitations are explicit and don't pretend to be "just not implemented yet" — they're called out as intentional contracts
- The dedupeKey/LIMIT 1 BY strategy is well-reasoned for ClickHouse
- The metadataRaw/metadataSearch split is a pragmatic answer to the JSON-in-ClickHouse problem

### What could be trimmed

- The "important notes" sections in shared.md repeat what's already in the per-table docs. These could be reduced to forward references.
- The testing expectations section in shared.md overlaps heavily with the rollout order in README.md. Consider consolidating.

### What should be a separate doc

- The discovery design (discovery.md) is already separate, which is good — it's the most complex piece.
- The feedback value-split semantics could benefit from a small ADR-style note explaining why two columns instead of a single String, since this is a departure from the current model and will affect the adapter/record-builder interface.

---

## Summary Assessment

The design is thorough, internally consistent, and clearly implementable. The ClickHouse-specific decisions (ReplacingMergeTree for tracing only, LIMIT 1 BY for query-time dedup, refreshable MVs for discovery, metadataSearch as a flattened string-string map) are well-suited to the storage engine.

The main risks are:
1. The Map default-value trap (P0 — will cause incorrect filter results if not handled)
2. The record-builder sequencing gap for scores/feedback (P0 — will cause silent empty results)
3. The trace_roots partition vs. query pattern mismatch (P0 — conscious decision needed)
4. The hasChildError performance cliff (P1 — may force a fast-follow optimization)

None of these are design-breaking. Items 1 and 3 need a decision before DDL is written. Item 2 needs a sequencing decision. Item 4 can ship as-is with a known limitation.

The next steps in the rollout order (README.md) are realistic and complete for a v0 scope. The explicit exclusion of migration/cutover planning is the right call for keeping v0 focused.
