# Claude Design Review 3 -- ClickHouse vNext Observability

Reviewer: Claude Opus 4.6
Date: 2026-03-26
Scope: Full design doc set, cross-referenced against DuckDB implementation, core record builders, DefaultExporter, and current ClickHouse observability domain.

---

## Severity Scale

- **P0 -- Blocking**: Will cause implementation failure, data loss, or require rework.
- **P1 -- High**: Will cause significant implementation churn or runtime bugs if not resolved before coding starts.
- **P2 -- Medium**: Design gap that will need a decision during implementation; better to decide now.
- **P3 -- Low**: Nit, clarification, or minor inconsistency.

---

## P0 -- Blocking

### 1. `trace_roots` incremental MV vs refreshable MV -- contradictory design

`shared.md` line 32-33 says:

> populate `trace_roots` from `span_events` with an incremental materialized view

`trace-roots.md` line 12:

> it is populated incrementally from `span_events` by a materialized view

But `discovery.md` line 16-17 explicitly says:

> do not feed them incrementally from insert-time materialized views in v0

And the discovery tables use *refreshable* MVs. The design never explains why `trace_roots` uses an incremental MV while discovery uses refreshable MVs. This matters because:

- An incremental MV on `trace_roots` means deletes from `span_events` do **not** propagate to `trace_roots`. The design acknowledges this (`shared.md` line 200) but this creates a real consistency problem: after `batchDeleteTraces`, `trace_roots` will continue to return deleted traces until... when? There is no refresh mechanism specified for `trace_roots`. The discovery tables get refreshed periodically, but `trace_roots` just accumulates forever.
- `dangerouslyClearAll` must truncate `trace_roots` separately (`shared.md` line 199), but `batchDeleteTraces` needs a matching lightweight delete on `trace_roots` too. This is stated but the design never specifies whether deletes on `trace_roots` and `span_events` should be in the same operation or separate.

**Recommendation**: Either (a) make `trace_roots` also refreshable (simplifies delete/TTL consistency but adds refresh lag to trace listing), or (b) explicitly document that `batchDeleteTraces` must issue parallel lightweight deletes to both `span_events` and `trace_roots`, and that TTL must be configured identically on both tables. Option (b) is probably fine but it needs to be stated concretely, not left as an inference.

### 2. `span_events.endedAt` is NOT nullable but event spans set `endedAt = startedAt`

`physical-types.md` specifies `endedAt: DateTime64(3, 'UTC')` for `span_events` -- not nullable. The design says to normalize event spans so `endedAt = startedAt` when `isEvent = true`. This is internally consistent so far.

But then `span-events.md` line 95 says:

> if preserving the current public contract matters on reads, ClickHouse can map normalized event spans back to `endedAt = null`

This is a conditional statement with no resolution. The DuckDB implementation returns `endedAt: null` for event spans (`tracing.ts:114` uses `toDateOrNull`). The core `SpanRecord` type has `endedAt` as nullable. If the v-next read path returns `endedAt = startedAt` for event spans instead of `null`, it will break any consumer that checks `endedAt === null` to identify event spans.

**Recommendation**: Resolve this now. Either (a) store `endedAt = startedAt` and map back to `null` on read when `isEvent = true`, or (b) store `endedAt = startedAt` and accept that the public contract changes. This will affect every read-path function and the `trace_roots` MV projection.

---

## P1 -- High

### 3. `DefaultExporter` strategy routing gap for the new `observabilityStrategy` property

The current ClickHouse implementation (`stores/clickhouse/src/storage/domains/observability/index.ts:188`) exposes a `tracingStrategy` getter. But the DuckDB implementation (`stores/duckdb/src/storage/domains/observability/index.ts:95`) exposes an `observabilityStrategy` getter.

The design doc (`shared.md`) says:

> Expected `observabilityStrategy` direction: preferred: `insert-only`, supported: `insert-only`

The `DefaultExporter` (`default.ts:41-61`) calls `observabilityStorage.observabilityStrategy`. But the current ClickHouse code has `tracingStrategy`, not `observabilityStrategy`. This is a naming mismatch between the two existing implementations.

**Inference**: The v-next implementation needs to use `observabilityStrategy` (matching the DuckDB convention and what `DefaultExporter` actually calls). The design doc doesn't flag this rename. If the implementer copies from the current ClickHouse code, they'll use the wrong property name and the exporter will fall through to defaults.

**Recommendation**: Add an explicit note that v-next must expose `observabilityStrategy` (not `tracingStrategy`), matching the base class API that `DefaultExporter` actually consumes.

### 4. Score and feedback record builders don't populate entity/context fields

The design acknowledges this (`shared.md` lines 74-75, `score-events.md` lines 59-60, `feedback-events.md` lines 67-68):

> the current shared record builders do not yet populate every typed field required by the `score_events` and `feedback_events` designs
> that upstream score/feedback record-builder enrichment should land separately

This is correctly scoped out, but the **physical DDL** for `score_events` and `feedback_events` includes columns (`entityType`, `entityId`, `entityName`, `userId`, `organizationId`, `environment`, `serviceName`) that the record builders will write as `null` until the upstream work lands. That means:

- Discovery queries that UNION across `span_events`, `metric_events`, and `log_events` won't include scores/feedback (the design says this is intentional -- good).
- But `listScores` and `listFeedback` filters on `entityType`, `environment`, etc. will match nothing until the record builders are enriched.
- If the v-next ClickHouse storage is deployed before the record-builder enrichment, score/feedback filtering will silently return empty results.

**Recommendation**: Either (a) document this as a known deployment ordering constraint, or (b) add a note that the v-next score/feedback filter implementation should short-circuit or warn when filtering on columns known to be unpopulated.

### 5. `hasChildError` query against `span_events` while listing from `trace_roots` -- cross-table join concern

`span-events.md` lines 162-164 and `trace-roots.md` line 43:

> compute it at query time as "any span in the same trace has `status = error`"
> when `hasChildError` is present, the query may use `span_events` for the child-span existence check while still using `trace_roots` as the main listing source

This means a `listTraces` query with `hasChildError=true` requires a correlated subquery from `trace_roots` into `span_events`. In ClickHouse, correlated subqueries can be expensive because MergeTree doesn't have traditional indexes for lookups. The `span_events` ORDER BY is `(traceId, endedAt, spanId)` which does make the traceId lookup efficient, but:

- The correlated subquery runs for **every candidate root row** in the result set. If the trace_roots table has 100K roots in the time window, that's 100K index lookups into `span_events`.
- ClickHouse's query planner doesn't always optimize correlated EXISTS into a semi-join.

**Recommendation**: This is probably acceptable for v0 since `hasChildError` is not the default filter path and result sets are paginated. But add an explicit performance note that this is a known O(N) subquery pattern and the refreshable helper structure is the intended optimization path.

### 6. No physical shape specified for `discovery_values` and `discovery_pairs` engine/ordering

`physical-types.md` specifies column types for discovery tables but does not specify `ENGINE`, `ORDER BY`, or `PARTITION BY`. The signal tables all have explicit physical shapes. Discovery tables need them too.

**Inference**: Since these are refreshable MVs that get fully rewritten on each refresh, the engine is probably just `MergeTree` with an ORDER BY that suits the query patterns (`(kind, key1, value)` for `discovery_values`, `(kind, key1, key2, value)` for `discovery_pairs`).

**Recommendation**: Add explicit physical shape for both discovery tables. Without this, the implementer has to guess.

---

## P2 -- Medium

### 7. `span_events` partitions by `toDate(endedAt)` but ORDER BY starts with `traceId`

`span-events.md`:

> `PARTITION BY toDate(endedAt)`
> `ORDER BY (traceId, endedAt, spanId)`

This means a `getTrace(traceId)` query must scan across all partitions because `traceId` is the first ORDER BY key but is not correlated with `endedAt` date. ClickHouse will skip partitions only if the query has a date filter. `getTrace` and `getSpan` typically don't have date filters -- they just have traceId/spanId.

This isn't necessarily wrong (the primary key index on `traceId` within each partition will still be efficient), but it means ClickHouse has to open every active partition's index to find the trace. For a table with 90 days of retention, that's 90 partition index lookups per trace fetch.

**Recommendation**: This is probably fine for v0 volumes. Document it as a known tradeoff. If trace-by-ID lookups become slow, the fix is either a secondary data skipping index on `traceId` or a different partitioning strategy.

### 8. `metadataSearch` construction -- promoted-key removal list is hard-coded and fragile

`span-events.md` line 117:

> before writing `metadataSearch`, remove keys already promoted into typed columns such as `userId`, `organizationId`, `resourceId`, `runId`, `sessionId`, `threadId`, `requestId`, `environment`, `source`, and `serviceName`

This list is defined in prose, not in code. The record builder (`record-builders.ts`) already extracts these fields from metadata, but the `metadataSearch` construction (which doesn't exist yet) needs to strip them. If this list drifts from the actual promoted columns, you get either:

- Duplicate data in `metadataSearch` (wasteful but not incorrect), or
- Missing data in `metadataSearch` (filters silently return no results).

**Recommendation**: Define the promoted-key set as a constant in code and reference it from both the record builder and the `metadataSearch` constructor. This is an implementation detail, but the design should mention it to prevent drift.

### 9. `feedback_events.value` as JSON-encoded `String` -- sorting and filtering implications

`physical-types.md` lines 222-224:

> `feedback.value` is `number | string` in the public API but should not be queryable in v0
> current v0 direction is to store the JSON-encoded representation in `String`

JSON-encoding means `"hello"` is stored as `"\"hello\""` and `42` is stored as `"42"`. This is fine for v0 if truly not queryable. But the DuckDB DDL (`ddl.ts:196`) stores `value VARCHAR NOT NULL` as a plain string. If the DuckDB implementation stores `"thumbs_up"` and the ClickHouse v-next stores `"\"thumbs_up\""`, the data is not portable between backends.

**Inference**: This may not matter if migration between backends isn't a goal, but it's a latent inconsistency.

**Recommendation**: Clarify whether the JSON encoding is the canonical storage format going forward (in which case DuckDB should align) or whether it's a ClickHouse-specific choice.

### 10. `trace_roots` ORDER BY `(startedAt, traceId)` but PARTITION BY `toDate(endedAt)`

The default `listTraces` sorts by `startedAt DESC`. With `PARTITION BY toDate(endedAt)`, ClickHouse needs to merge-sort across date partitions to produce a `startedAt`-ordered result. For most traces, `startedAt` and `endedAt` are on the same day, so this is fine. But for long-running traces (hours/days), the trace root ends up in an `endedAt` partition that doesn't correspond to its `startedAt`, making the sort less efficient.

This is probably a non-issue for the expected workload (most spans complete quickly), but it's worth noting.

### 11. No explicit ClickHouse `SETTINGS` or codec guidance

The design specifies engines and ORDER BY but doesn't mention:

- `index_granularity` (default 8192 is usually fine but worth calling out)
- Compression codecs for timestamps (`DoubleDelta`), Float64 (`Gorilla`), or LowCardinality strings
- `allow_nullable_key` if needed for ORDER BY columns (none of the ORDER BY columns are nullable, so this should be fine)

**Recommendation**: Either add a note saying "use ClickHouse defaults for v0" or specify codecs. The defaults are reasonable, so this is low priority.

### 12. Discovery refresh queries scan full source tables

`discovery.md` operational note acknowledges this:

> Refresh queries may still scan broad source ranges

For `metric_events` with months of data and many distinct label keys/values, the refresh query for `discovery_pairs` could be very expensive. The `UNION ALL` across three tables with `ARRAY JOIN` and `DISTINCT` is a heavy query.

**Recommendation**: Consider adding a time-window restriction to the refresh queries (e.g., only scan the last 7 days). The design already accepts eventual consistency, so limiting the discovery window is consistent with that stance. If not, at least document expected refresh query cost at various data volumes.

---

## P3 -- Low

### 13. `costUnit` as `LowCardinality(Nullable(String))` in `metric_events`

The shared design says `costUnit` is not a `LowCardinality` candidate (it's not in the explicit list in `shared.md` lines 168-177). But `physical-types.md` line 140 specifies `costUnit: LowCardinality(Nullable(String))`.

This is a minor inconsistency between the shared guidance and the physical types doc. `LowCardinality` for `costUnit` is probably fine (there are likely very few distinct cost units), but the docs disagree.

### 14. `score_events` and `feedback_events` missing context columns vs. DuckDB parity

The DuckDB DDL for `score_events` doesn't have `entityType`, `entityId`, `entityName`, `userId`, `organizationId`, `environment`, or `serviceName`. The v-next design adds them. This is an intentional schema expansion, not a parity mismatch, but it means the `ObservabilityStorage` interface types may need updating if they don't already include these fields in the score/feedback filter schemas.

### 15. `span_events` has no `eventType` column (correct) but `trace_roots` MV needs a filter

The incremental MV for `trace_roots` needs to filter `parentSpanId IS NULL`. Since v-next only stores completed spans (no start/end event pairs), there's no `eventType` to filter on. The MV just needs `WHERE parentSpanId IS NULL`. This is straightforward, but worth confirming there isn't a race condition where a child span is inserted before its root span -- in that case the root span would correctly appear in `trace_roots` when it's eventually inserted, so ordering doesn't matter for correctness.

### 16. Log `message` column -- no full-text search mentioned

`log_events` has a `message: String` column but no mention of full-text search, LIKE filtering, or substring matching. The DuckDB log implementation supports `message` in filters. If the public `listLogs` filter schema supports message filtering, the ClickHouse implementation needs to handle it (even if just with `LIKE` or `position()`).

**Inference**: I didn't see `message` in the log filter schema from the reference files, but if it exists in the public API, this is a gap.

---

## Design Quality Observations

### What's good

1. **Append-only MergeTree everywhere** -- This is the right call for ClickHouse. The current ClickHouse implementation's `ReplacingMergeTree` with read-modify-write updates is the single biggest performance problem, and killing it is correct.

2. **Insert-only tracing** -- Eliminating the start/end event pair model for ClickHouse is a major simplification. DuckDB's `arg_max(field, timestamp) FILTER (WHERE field IS NOT NULL)` reconstruction (`tracing.ts:66-67`) is clever but would be extremely expensive in ClickHouse at scale. Storing only the final span state is the right choice.

3. **`metadataRaw` / `metadataSearch` split** -- This is a pragmatic solution to the "metadata is a grab-bag but we need to filter on it" problem. The alternative (native JSON columns, full JSON path queries) would be over-engineering for v0.

4. **Discovery helper tables** -- Moving discovery off scan queries is correct. The current DuckDB implementation (`metrics.ts:625-681`) does `SELECT DISTINCT` directly on the signal tables, which doesn't scale.

5. **The design is internally consistent on the 90% path.** The table shapes are coherent. The column types are well-thought-out. The normalization rules are clear. The query routing (which table serves which API) is unambiguous.

### What's noisy or could be split

1. **The discovery doc is doing too much.** It's simultaneously defining two table schemas, a refresh mechanism, eight endpoint mappings, dimension semantics for each kind, source mappings, and refresh query shapes. Consider splitting the refresh query specification into a separate implementation reference or just letting the DDL/code be the source of truth for query shapes.

2. **The physical-types doc duplicates information from per-table docs.** Every per-table doc lists the logical shape, and then physical-types.md re-lists everything with concrete types. This is useful for DDL implementation but creates a maintenance surface where the two can drift. Consider having physical-types.md be the single source and having per-table docs reference it rather than re-listing fields.

3. **Repeated "important notes" and "intentional v0 limitations" sections** across every doc. These are useful individually but create a lot of surface area. A single "v0 limitations" section in shared.md that lists all of them would be easier to audit.

### Implementation traps specific to ClickHouse

1. **`Nullable` columns in `Map` values**: `Map(LowCardinality(String), String)` -- the value is non-nullable `String`. If the write path tries to insert `null` as a label value, ClickHouse will reject it. The normalization rules say to drop null values, but make sure the code path enforces this before insertion.

2. **`DateTime64(3, 'UTC')` and timezone handling**: The ClickHouse client library returns `DateTime64` as strings in `JSONEachRow` format. The read path needs to parse these back to `Date` objects. The current ClickHouse implementation uses `date_time_output_format: 'iso'` and `use_client_time_zone: 1` -- the v-next implementation needs to handle this consistently.

3. **Refreshable MV `REFRESH EVERY` syntax**: In ClickHouse Cloud, refreshable MVs use `CREATE MATERIALIZED VIEW ... REFRESH EVERY INTERVAL 1 MINUTE AS SELECT ...`. The `AS SELECT` must be a complete query, not incremental. Make sure the refresh query doesn't accidentally create duplicates within a refresh cycle (the outer `DISTINCT` handles this, but test it).

4. **Lightweight deletes are async**: `DELETE FROM table WHERE ...` in ClickHouse marks rows for deletion but doesn't remove them immediately. Subsequent `SELECT` queries may still see deleted rows until the next merge. The design mentions eventual consistency for deletes, but test carefully -- the `FINAL` keyword doesn't apply to MergeTree (only ReplacingMergeTree), so there's no way to force-exclude deleted rows on read.

5. **`TRUNCATE TABLE` on a table with an incremental MV**: Truncating `span_events` does NOT truncate `trace_roots` (the MV target). The `dangerouslyClearAll` implementation must truncate both tables. The design says this, but it's easy to forget in implementation.

6. **Large `Map` columns in ORDER BY queries**: ClickHouse stores `Map` columns as two parallel arrays. If `labels` or `metadataSearch` contain many entries, the row size grows and sort performance degrades. This is unlikely to be a problem at v0 volumes but worth monitoring.

---

## Unresolved Questions That Should Be Resolved Before Implementation

1. **Event span `endedAt` on read**: null or `startedAt`? (See P0 #2)
2. **`trace_roots` delete propagation mechanism**: Explicit lightweight delete or eventual via some other mechanism? (See P0 #1)
3. **Discovery table physical shapes**: ENGINE, ORDER BY, PARTITION BY? (See P1 #6)
4. **Time-window restriction on discovery refresh**: Full table scan or bounded? (See P2 #12)
5. **Deployment ordering**: Can v-next ClickHouse be deployed before score/feedback record-builder enrichment? What's the expected behavior? (See P1 #4)

---

## Summary

The design is solid. The core model decisions (append-only MergeTree, insert-only tracing, metadata split, discovery helpers) are all correct for ClickHouse. The table shapes are coherent and well-typed. The filter surfaces are clearly mapped. The design is implementable.

The two blocking issues are (1) the `trace_roots` delete/consistency story needs to be made explicit rather than implied, and (2) the event span `endedAt` read-path behavior needs a concrete decision. Both are small to resolve but will cause implementation confusion if left ambiguous.

The high-severity items are mostly about naming mismatches, deployment ordering, and missing physical specs for discovery tables -- all resolvable with a few sentences added to the design.

The design docs are slightly over-documented in aggregate (the same facts appear in 3-4 places), but that's a much better problem to have than under-documentation. The per-table docs are clear and implementable individually.
