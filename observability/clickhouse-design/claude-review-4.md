# Claude Code Design Review 4 — ClickHouse v-next Observability

Reviewer: Claude Opus 4.6 (1M context)
Date: 2026-03-26
Scope: Full design doc set + reference code (DuckDB impl, record builders, DefaultExporter, current ClickHouse adapter)

---

## Findings (ordered by severity)

### P0 — DDL blockers

#### 1. `Nullable` columns in discovery table ORDER BY keys

`discovery_values` specifies `ORDER BY (kind, key1, value)` but `key1` is `Nullable(String)`.
`discovery_pairs` specifies `ORDER BY (kind, key1, key2, value)` but `key2` is `Nullable(String)`.

ClickHouse historically forbids `Nullable` in MergeTree ORDER BY / primary key columns. Newer Cloud ClickHouse versions (23.3+) may allow it with the `allow_nullable_key` setting, but it carries a performance cost (extra null-bitmap file per part) and is not the default. The design does not acknowledge this or declare that `allow_nullable_key = 1` is required.

**Fix options:**

- Change `key1` and `key2` to non-nullable `String` with empty-string sentinel for "no key," and adjust queries to filter `key1 != ''` where needed. This is the idiomatic ClickHouse approach.
- Or explicitly require `allow_nullable_key = 1` in the DDL and document the tradeoff.

**Files:** `physical-types.md` (lines for discovery_values/discovery_pairs), `discovery.md`

---

### P1 — Will cause implementation churn or subtle bugs

#### 2. `LIMIT 1 BY dedupeKey` + "final presentation ordering" is not expressible in a single query

The design repeatedly says: "narrow the row set first, then use `LIMIT 1 BY dedupeKey`, then apply final presentation ordering." (span-events.md, trace-roots.md, shared.md)

In ClickHouse's query execution pipeline, the order is: `WHERE` -> `ORDER BY` -> `LIMIT BY` -> `LIMIT`. There is no way to apply a *second* ORDER BY after `LIMIT BY` in a single query. The presentation ordering must either:

- Be applied via a wrapping subquery/CTE:
  ```sql
  SELECT * FROM (
    SELECT * FROM span_events
    WHERE traceId = {traceId:String}
    ORDER BY endedAt  -- arbitrary; just needs to be deterministic for LIMIT BY
    LIMIT 1 BY dedupeKey
  )
  ORDER BY startedAt ASC  -- actual presentation ordering
  ```
- Or rely on the fact that for `getTrace` (which returns all spans in a trace), the initial ORDER BY can serve both purposes if chosen carefully.

This is a real ClickHouse implementation trap. The design should either show the subquery pattern or at minimum acknowledge that "apply final ordering" requires a wrapping query. An implementer reading the current text will write a single-level query and get the wrong row order or realize mid-implementation that the described pattern doesn't work.

**Files:** `span-events.md` ("Query Contract" section), `trace-roots.md` ("Query Contract"), `shared.md` ("Tracing retry idempotency")

#### 3. `hasChildError` cross-table query shape is underspecified

The design says `hasChildError` is computed at query time as "any non-root span in the same trace has `status = error`," using `span_events` for the child-span existence check while listing from `trace_roots`.

This is architecturally sound but the actual query composition is going to be tricky:

- `listTraces` reads from `trace_roots` with `LIMIT 1 BY dedupeKey` (which already requires a subquery per finding #2).
- The `hasChildError` correlated subquery goes into `span_events`, which also has duplicates that need `LIMIT 1 BY dedupeKey` or `FINAL` to be correct.
- ClickHouse correlated subqueries with `EXISTS` into `ReplacingMergeTree` tables that haven't been merged can return false positives (a deleted/replaced row still matches `EXISTS`).

The design should specify whether the `hasChildError` subquery should use `FINAL` on `span_events` (simple but slow), or whether pre-merge duplicates in `span_events` are acceptable for the existence check (they are — if any copy of the span has `status = error`, all copies do, since the span payload is the same across retries). This inference should be made explicit.

**Files:** `span-events.md` ("hasChildError" section), `trace-roots.md`

#### 4. Score/feedback record-builder enrichment is a hard prerequisite, not a soft one

The design says score and feedback record-builder enrichment "should land separately from the ClickHouse v-next storage PR." (score-events.md, feedback-events.md, shared.md)

Looking at the current code:

- `buildScoreRecord` (record-builders.ts:288-303) does not produce `entityType`, `entityId`, `entityName`, `userId`, `organizationId`, `environment`, or `serviceName`
- `buildFeedbackRecord` (record-builders.ts:306-321) does not produce `entityType`, `entityId`, `entityName`, `organizationId`, `environment`, or `serviceName`

Without these fields populated, the score and feedback filter surface described in the design cannot work. Rows will have all those columns null, rendering entity/context filters useless.

This should be tracked as a **blocking prerequisite** rather than a "should land separately" suggestion. If the record-builder work slips, the v-next score/feedback tables will be writable but effectively unfilterable on most of their designed filter surface.

**Files:** `score-events.md`, `feedback-events.md`, `shared.md`, `packages/core/src/storage/domains/observability/record-builders.ts`

#### 5. `observabilityStrategy` vs `tracingStrategy` naming mismatch

The current ClickHouse adapter (`stores/clickhouse/src/storage/domains/observability/index.ts:188-199`) exposes `tracingStrategy`. The DuckDB adapter exposes `observabilityStrategy`. The `DefaultExporter` (`observability/mastra/src/exporters/default.ts:47`) reads `observabilityStorage.observabilityStrategy`.

The design correctly notes that v-next should expose `observabilityStrategy`, but this means:

- The current ClickHouse adapter's `tracingStrategy` may not be read by the current `DefaultExporter` at all (inference: this is likely a pre-existing bug or the base class has a compatibility layer).
- The v-next adapter needs to expose `observabilityStrategy` as the primary property.

The design should be explicit about whether `tracingStrategy` on the base class still works (via a getter or compatibility shim) or whether it's silently broken in the current ClickHouse adapter.

**Files:** `shared.md` ("Adapter note"), `stores/clickhouse/src/storage/domains/observability/index.ts:188-199`, `observability/mastra/src/exporters/default.ts:47`

#### 6. `ReplacingMergeTree` without a version column

Both `span_events` and `trace_roots` use `ReplacingMergeTree` without specifying a version column. Without a version:

- During merges, ClickHouse keeps the *last inserted* row among duplicates sharing the same ORDER BY key.
- "Last inserted" is determined by insertion order within a part, which is non-deterministic under concurrent inserts or retries that land in different parts.

For the v0 use case (retries produce identical rows), this is acceptable — any copy is equivalent. But the design should explicitly state that **retry idempotency requires the retried row to be byte-identical to the original**. If a retry could produce a row with a different `endedAt` timestamp (e.g., due to clock skew or re-processing delay), the version-less `ReplacingMergeTree` could silently keep either version.

**Files:** `shared.md`, `span-events.md`, `trace-roots.md`, `physical-types.md`

---

### P2 — Design gaps that will cause questions during implementation

#### 7. `listTraces` pagination with `LIMIT 1 BY dedupeKey`

`listTraces` needs pagination (page + perPage) and a total count. With `LIMIT 1 BY dedupeKey` in play:

- The count query must also deduplicate. You can't `SELECT COUNT(*)` from `trace_roots` directly — you need `SELECT COUNT(*) FROM (SELECT ... LIMIT 1 BY dedupeKey)`.
- The OFFSET/LIMIT for pagination must be applied *after* the `LIMIT 1 BY` deduplication, requiring a wrapping query.

This is the same subquery issue as finding #2 but specifically impacts pagination correctness. The DuckDB implementation doesn't have this problem because it uses `arg_max` reconstruction which naturally deduplicates. The design should specify the pagination query shape.

**Files:** `trace-roots.md` ("Query Contract"), `span-events.md`

#### 8. `feedback.value` JSON encoding direction is unclear relative to current types

The design says `feedback.value` should be JSON-encoded on write and JSON-decoded on read to preserve `number` vs `string` distinction (feedback-events.md, physical-types.md). But:

- The current `CreateFeedbackRecord` type (from the zod schema) types `value` as `string`.
- The current `buildFeedbackRecord` passes `fb.value` through directly.
- The DuckDB DDL has `value VARCHAR NOT NULL`.

If the public API `value` is always a string, JSON encoding adds unnecessary overhead and complexity (a string `"hello"` becomes `"\"hello\""` in storage). If the API truly allows `number | string`, the TypeScript types need updating first.

The design should clarify: is this JSON-encoding direction a *current requirement* or a *forward-looking design* for a future API change? If the latter, consider just using `String` with direct storage in v0 and deferring JSON encoding until the API actually changes.

**Files:** `feedback-events.md`, `physical-types.md`

#### 9. `metadataSearch` key exclusion list is not enumerated in one place

The design says: "before writing `metadataSearch`, remove keys already promoted into typed columns such as `userId`, `organizationId`, `resourceId`, `runId`, `sessionId`, `threadId`, `requestId`, `environment`, `source`, and `serviceName`" (span-events.md).

This exclusion list needs to be maintained as code. It should either:

- Be defined as a constant in the v-next implementation
- Or be derived from the span_events column list programmatically

The design doesn't specify the approach. Given that the DuckDB implementation has no `metadataSearch` concept (it stores metadata as a single JSON blob), there's no reference implementation to follow. The implementer will need to decide how to maintain this list, and getting it wrong means metadata keys silently disappearing from search or appearing in both typed columns and metadataSearch.

**Files:** `span-events.md` ("Metadata And Scope Contract")

#### 10. Discovery refresh SQL complexity

The discovery refresh queries need to `UNION ALL` across 3 source tables (`span_events`, `metric_events`, `log_events`), each with different column shapes, and apply `ARRAY JOIN` for tags and `ARRAY JOIN mapKeys(labels)` for metric labels.

For `discovery_values`, the refresh query has ~8 subqueries unioned together. For `discovery_pairs`, ~2-3. These will be large, complex SQL strings.

The design describes the shape well but doesn't discuss:

- Error handling if one source table is empty or doesn't exist yet during bootstrap
- Whether the refresh query should use `SETTINGS max_execution_time = X` to prevent runaway refreshes on large datasets
- Whether `span_events` needs `FINAL` or `LIMIT 1 BY dedupeKey` in the discovery source queries (inference: no, because discovery is approximate/eventually consistent and duplicate span rows just produce duplicate values that get `DISTINCT`-ed away — but this should be stated)

**Files:** `discovery.md`

#### 11. No explicit `DEFAULT` values for non-nullable columns

The physical types doc specifies `DEFAULT` values for `tags`, `labels`, and `metadataSearch` (arrays/maps with empty defaults). But other non-nullable columns like `name`, `traceId`, `spanId`, `dedupeKey`, `status`, `spanType`, `level`, `message`, `scorerId`, `source`, `feedbackType`, `value` have no `DEFAULT` specified.

In ClickHouse, if a non-nullable column has no `DEFAULT` and a row is inserted without that column, the zero value is used (empty string for `String`, 0 for numbers). This is fine for normal application inserts, but the materialized view from `span_events` to `trace_roots` needs to explicitly project all columns. If a column is missed in the MV projection, it silently gets the zero value rather than erroring.

**Files:** `physical-types.md`

---

### P3 — Minor inconsistencies and suggestions

#### 12. `costUnit` LowCardinality inconsistency between docs

`physical-types.md` specifies `costUnit: LowCardinality(Nullable(String))` for `metric_events`, but `shared.md`'s LowCardinality guidance section doesn't list `costUnit` as a candidate. Minor doc inconsistency — the physical-types doc is authoritative, but the shared guidance should be updated for completeness.

#### 13. Span `status` values and the public `TraceStatus` enum

The design says `span_events.status` has values `success` and `error`. The existing code uses `TraceStatus.ERROR`, `TraceStatus.RUNNING`, `TraceStatus.SUCCESS`. The design correctly notes that `running` returns no rows, but doesn't specify the exact string values stored. Should it be `'success'`/`'error'`, or `'SUCCESS'`/`'ERROR'`? The DuckDB implementation derives status at query time rather than storing it. The v-next implementer needs to know the exact casing.

#### 14. `getSpan` can use `(traceId, spanId)` directly — `dedupeKey` adds no value for point lookups

The design says `getSpan` should "filter by tracing identity (`dedupeKey` or `(traceId, spanId)`)." Since `dedupeKey = traceId || ':' || spanId`, filtering by `(traceId, spanId)` is strictly better for point lookups because it matches the ORDER BY prefix `(traceId, endedAt, spanId, ...)` and allows index range narrowing. Filtering by `dedupeKey` alone would require scanning the entire `dedupeKey` column. The design should drop the `dedupeKey` option for point lookups and recommend `(traceId, spanId)` only.

#### 15. Log events ORDER BY choice

`log_events` uses `ORDER BY (timestamp, traceId)`. This optimizes for recency-first listing. But the DuckDB implementation's `listLogs` also supports filtering by `traceId`. If trace-scoped log reads are common, `ORDER BY (traceId, timestamp)` would be better (matching the pattern used by `score_events` and `feedback_events`). The design should state which access pattern is expected to dominate.

#### 16. No `batchDeleteLogs`, `batchDeleteMetrics`, etc.

The design mentions `batchDeleteTraces` but doesn't discuss delete operations for the other four signals. The `ObservabilityStorage` interface may not require them, but if they're expected later, the design should note that lightweight deletes are the mechanism and that discovery staleness bounds apply.

---

## Document Quality

### What works well

- The separation of shared decisions from per-table docs is effective. Cross-cutting rules are stated once and per-table docs stay focused.
- The explicit "Intentional v0 Limitations" sections in each doc prevent scope creep during implementation.
- The physical-types doc is valuable — having concrete column types in one place eliminates ambiguity.
- The discovery design is thorough and the dimension-semantics tables are clear enough to implement from.
- The dedupe strategy (dedupeKey + LIMIT 1 BY + ReplacingMergeTree) is well-reasoned for the append-only constraint.

### Redundancy and noise

- The README, shared.md, and several per-table docs repeat the same "this diverges from DuckDB" and "only completed spans" statements. Once in shared.md is enough.
- The "Important note: this is design documentation..." disclaimer appears in both README.md and the rollout section. Once is sufficient.
- The discovery.md "Assumed ClickHouse Feature Set" section lists standard MergeTree features (`ARRAY JOIN`, `mapKeys()`) that don't need to be called out. Only the refreshable materialized view assumption is non-obvious.
- The LowCardinality guidance in shared.md partially duplicates what's already fully specified in physical-types.md.

### Split candidates

- **Discovery design** could be its own standalone doc referenced from the main set. It's largely independent of the signal-table designs and has its own DDL, refresh logic, and endpoint mapping. Keeping it separate would make the per-signal docs easier to navigate.
- **Migration/cutover planning** is explicitly out of scope but will need its own design before v-next can replace the current implementation. Consider creating a placeholder doc now.

---

## ClickHouse Implementation Traps

1. **`Nullable` + `LowCardinality` interaction**: `LowCardinality(Nullable(String))` is valid but the null handling in comparisons differs from `Nullable(String)`. Equality checks against `NULL` require `IS NULL`, not `= NULL`. The filter builder must handle this consistently.

2. **`Map` column filtering**: ClickHouse `Map(K, V)` supports `map[key]` syntax for value lookup, but the return type for a missing key is the zero value (empty string for `String`), not `NULL`. Contains-all label filtering must use `mapContains(labels, key) AND labels[key] = value`, not just `labels[key] = value` (which would false-positive on missing keys with empty-string values).

3. **`FINAL` performance**: The design avoids `FINAL` in favor of `LIMIT 1 BY dedupeKey`, which is correct. But be aware that `FINAL` can be surprisingly fast on small result sets in recent ClickHouse versions (the "lazy FINAL" optimization). During development/testing, the temptation to use `FINAL` for simplicity will be strong — resist it for production queries but it may be acceptable for `getSpan` point lookups.

4. **`DateTime64(3, 'UTC')` timezone handling**: ClickHouse stores DateTime64 internally as UTC epoch ticks regardless of the timezone parameter. The timezone parameter only affects display/parsing. Ensure the ClickHouse client's `use_client_time_zone` setting is consistent between reads and writes. The current ClickHouse adapter uses `use_client_time_zone: 1` — the v-next adapter should document its timezone handling decision.

5. **Lightweight delete eventual consistency**: ClickHouse lightweight deletes (`DELETE FROM ... WHERE ...`) are eventually consistent — deleted rows may still appear in reads until the next merge. The design acknowledges this for `batchDeleteTraces`. But combined with `LIMIT 1 BY dedupeKey`, a deleted row that hasn't been merged yet will still count as a valid row and consume the `LIMIT 1` slot, potentially hiding the replacement row. For tracing, this shouldn't matter (deletes remove all copies), but it's worth noting.

6. **Refreshable materialized view atomicity**: Refreshable MVs in ClickHouse do an atomic table swap on each refresh. But if the refresh query fails (timeout, OOM, source table doesn't exist), the old data persists. The discovery tables will never go empty due to a failed refresh — they'll just go stale. This is the right behavior but should be verified in testing.

---

## Unresolved Questions That Should Be Resolved Before Implementation

1. **Nullable in ORDER BY for discovery tables**: Is `allow_nullable_key` acceptable, or should key1/key2 use empty-string sentinels? (P0 — DDL blocker)

2. **Score/feedback record-builder timeline**: When will the upstream enrichment land? Is there a tracking issue? Can v-next scores/feedback be implemented with null columns initially and filled in later, or should those two tables be deferred?

3. **`feedback.value` storage format**: JSON-encode or store directly? Depends on whether the public API actually allows non-string values today. (Verify against current types)

4. **`LIMIT 1 BY` subquery pattern**: Should the design prescribe the exact CTE/subquery shape for `getTrace` and `listTraces`, or leave it to the implementer?

5. **`status` string casing**: `'success'`/`'error'` or `'SUCCESS'`/`'ERROR'`? Needs to match whatever the trace filter schema expects.

6. **`hasChildError` subquery correctness under unmerged duplicates**: Explicitly state whether the `EXISTS` subquery into `span_events` needs deduplication or not.

---

## Summary

The design is solid in its overall architecture — the append-only model, insert-only tracing routing, dedupe strategy, metadata split, and discovery helper tables are all well-reasoned for ClickHouse. The signal table shapes are coherent and the column typing is thorough.

The main risks are:

- **P0**: Discovery table DDL will fail or require non-default settings due to Nullable ORDER BY keys
- **P1**: The `LIMIT 1 BY` + pagination + ordering query pattern is more complex than the design suggests, and will cause churn if not specified more concretely
- **P1**: Score/feedback tables are unimplementable (in terms of their filter surface) until the upstream record-builder enrichment lands — this needs to be a tracked hard dependency, not a soft note

The design is implementable as written for the core tracing and metrics paths. Logs, scores, and feedback are simpler tables with fewer ClickHouse-specific concerns. The discovery system is well-designed but needs the Nullable ORDER BY issue fixed before DDL can be written.

Overall: **ready to implement with the P0 fix and P1 clarifications above**. The P2/P3 items can be resolved during implementation without requiring design changes.
