Design Review: ClickHouse v-Next Observability

  Critical Findings

  1. listTraces default sort doesn't match trace_roots ORDER BY

  Severity: High | trace-roots.md, physical-types.md

  trace_roots is ORDER BY (endedAt, traceId) but ListTracesArgs defaults to orderBy: { field: 'startedAt', direction: 'DESC' }. The most common query pattern (default
  trace listing) cannot use the ClickHouse sort key. This means every default listTraces call does a full sort on unsorted data.

  Options: (a) change the default sort to endedAt DESC in the public API (breaking), (b) change trace_roots ORDER BY to (startedAt, traceId) (loses endedAt optimization),
   or (c) accept the perf hit. This needs an explicit decision before implementation.

  2. Score and feedback context columns will always be NULL in v0

  Severity: High | score-events.md, feedback-events.md, record-builders.ts:288-321

  The design adds entityType, entityId, entityName, userId, organizationId, environment, serviceName to score and feedback tables. The filter schemas (scoresFilterSchema,
   feedbackFilterSchema) already support filtering on these. But CreateScoreRecord and CreateFeedbackRecord don't carry these fields, and buildScoreRecord() /
  buildFeedbackRecord() don't populate them.

  The design acknowledges this upstream gap ("should land separately"), but doesn't explicitly state that every filter on these columns returns zero rows in v0. This
  needs to be called out as a v0 limitation per table, not just in the shared doc. If the upstream record-builder work doesn't land before v-next ships, users filtering
  scores by entityType will silently get empty results.

  3. Discovery refresh SQL is entirely unspecified

  Severity: High | discovery.md

  The design specifies schemas, refresh cadences, and endpoint mappings for discovery_values and discovery_pairs, but says nothing about the actual refresh SQL. This is
  the hardest part of discovery to implement:

  - discovery_values needs a UNION ALL across span_events, metric_events, and log_events for entity types, service names, environments
  - Tag discovery needs ARRAY JOIN to explode Array(LowCardinality(String)) tags
  - Metric label key discovery needs mapKeys() extraction from Map(LowCardinality(String), String) labels
  - discovery_pairs needs similar multi-source UNIONs for entityType->entityName and metricName+labelKey->labelValue

  This is 100+ lines of non-trivial ClickHouse SQL. Without specifying it (or at least the source-table-to-kind mapping and array/map explosion strategy), the implementor
   will make ad hoc decisions that may not match the endpoint mapping.

  4. getTrace(traceId) scans all partitions

  Severity: Medium-High | span-events.md, physical-types.md

  span_events is PARTITION BY toDate(endedAt), ORDER BY (traceId, endedAt, spanId). getTrace filters only by traceId. Since traceId is the first sort key but NOT the
  partition key, ClickHouse must check every partition's sort index. For tables with months of data, this means touching many partition granules.

  This is a known ClickHouse trade-off when you partition by time but sort by ID. The design should acknowledge it explicitly and/or note that getTrace callers may want
  to add a time-range hint in a future version.

  Medium Findings

  5. Refreshable MVs have availability gaps

  Severity: Medium | discovery.md

  ClickHouse refreshable materialized views (CREATE MATERIALIZED VIEW ... REFRESH EVERY ...) atomically swap the target table on each refresh. During the refresh
  computation, the old data is still readable. However, if the refresh fails or the computation is slow, the data can become stale beyond the configured interval.

  More importantly: on first startup, the discovery tables are empty until the first refresh completes. A 1-minute refresh cadence for discovery_values means UI pickers
  show nothing for up to a minute after init. The design should note this cold-start behavior and whether a manual initial refresh should be triggered in init().

  6. batchUpdateSpans disposition is unspecified

  Severity: Medium | shared.md

  The ObservabilityStorage interface includes batchUpdateSpans. With insert-only strategy, the DefaultExporter won't call it during normal operation. But the method still
   exists in the interface. Should v-next:
  - Throw "not implemented"?
  - Implement it (load + re-insert, like current ClickHouse)?
  - Leave the base class default?

  The current ClickHouse impl has a working but expensive batchUpdateSpans. The design should state whether v-next keeps or drops it.

  7. hasChildError subquery cost at scale

  Severity: Medium | span-events.md, trace-roots.md

  hasChildError is computed as "any span in the same trace has status = error" by subquerying span_events. For a listTraces page of 10 traces, this is 10 correlated
  subqueries (or one EXISTS per row). On a table with millions of spans, without a secondary index on (traceId, status), this can be slow.

  The design correctly defers optimization, but the v0 subquery approach should use a semi-join pattern (WHERE traceId IN (SELECT traceId FROM span_events WHERE status =
  'error')) rather than per-row EXISTS for the filtered listing case. Worth noting in the design.

  8. metadataSearch write-path normalization doesn't exist yet

  Severity: Medium | span-events.md, record-builders.ts

  The design specifies a complex normalization for metadataSearch: flatten nested objects into dot-path keys, keep only non-empty string leaves, strip promoted fields
  (userId, organizationId, etc.). This logic doesn't exist in buildCreateSpanRecord(). It needs to be added either in the record builder (affecting all backends) or in
  the ClickHouse write path specifically.

  This is a significant piece of new code that the design treats as a given but that doesn't exist anywhere yet.

  9. scope naming collision in discovery tables

  Severity: Low-Medium | discovery.md, physical-types.md

  discovery_values.scope is a LowCardinality(String) meaning "source family" (e.g., cross-signal, metric). Meanwhile, span_events.scope, metric_events.scope, etc. are
  JSON payload columns. Same name, completely different semantics. Not a functional issue since they're in different tables, but it will cause confusion during
  implementation and debugging. Consider renaming the discovery column to signalScope or sourceScope.

  Low Findings / Implementation Traps

  10. DuckDB SQL functions don't translate directly

  The DuckDB reference uses time_bucket(), percentile_cont() WITHIN GROUP, arg_max(), json_keys(), json_extract_string(). ClickHouse equivalents:
  - time_bucket() → toStartOfInterval()
  - percentile_cont(p) WITHIN GROUP (ORDER BY value) → quantile(p)(value) or quantileExact(p)(value)
  - arg_max() → argMax() (same concept, different casing)
  - json_keys() → JSONExtractKeys() or mapKeys() for Map columns
  - json_extract_string() → JSONExtractString() for JSON strings, direct map access for Map columns

  Not a design issue, but an implementation gotcha that matters because the DuckDB code is the primary parity reference.

  11. feedback.value JSON encoding trap

  Severity: Low | feedback-events.md, physical-types.md

  feedback.value is number | string in the public API, stored as String with JSON encoding. The implementor must remember to JSON.stringify() on write and JSON.parse() on
   read. If forgotten, string values get double-quoted ('"thumbs_up"' instead of "thumbs_up"). Worth a targeted test case.

  12. Event span endedAt normalization placement

  Severity: Low | span-events.md, shared.md

  The design says "normalize event spans so endedAt = startedAt when isEvent = true and endedAt is null". This normalization could happen in: (a) the record builder, (b)
  the ClickHouse write path, or (c) a DEFAULT expression in DDL. The design doesn't specify where. Given that it's ClickHouse-specific behavior (DuckDB stores start/end
  events differently), it should happen in the ClickHouse write path, not the shared record builder.

  Consistency Issues

  13. observabilityStrategy vs tracingStrategy naming

  The design says the strategy getter should return { preferred: 'insert-only', supported: ['insert-only'] }. The base class has both observabilityStrategy (newer, used
  by DefaultExporter) and tracingStrategy (deprecated). The current ClickHouse impl overrides tracingStrategy. The DuckDB impl overrides observabilityStrategy. The design
   should specify which property v-next overrides. Based on reading DefaultExporter, it should be observabilityStrategy.

  14. span_events lacks parentEntityType/Id/Name and rootEntityType/Id/Name

  The SpanRecord type includes parentEntityType, parentEntityId, parentEntityName, rootEntityType, rootEntityId, rootEntityName. The v-next span_events DDL omits them.
  The design implicitly handles this by saying trace filters treat parent/root entity fields as aliases of the root span's entity fields. But getSpan() and getTrace()
  return SpanRecord objects - what values do those fields get on read? The design should state they're returned as null from span_events reads, or document the read-path
  shaping explicitly.

  Document Structure Feedback

  Redundancy: The "Core v0 Decisions" section in README.md overlaps heavily with the "Core v0 Model" in shared.md. The README should be a pure index; move all decisions
  to shared.md.

  Discovery deserves more depth: Discovery is the riskiest part of this design (refresh SQL, cold-start, staleness) but gets the least specification. It would benefit
  from being split into two docs: one for the table schemas/endpoint mapping (keep) and one for the refresh-SQL specification (add).

  Physical types doc is excellent: Having a standalone, exhaustive column-type reference is unusually good. It removes ambiguity during DDL implementation. Keep this
  pattern.

  The "Intentional v0 Limitations" sections are valuable. They set clear scope boundaries. The score and feedback docs should add: "context columns (entityType, userId,
  etc.) will be NULL until upstream record-builder enrichment lands."

  Summary Assessment

  The design is internally consistent, well-structured, and makes sound ClickHouse-specific decisions (append-only MergeTree over ReplacingMergeTree, insert-only routing,
   metadataRaw/metadataSearch split, LowCardinality choices). The per-table physical types doc is a strong implementation anchor.

  The main risks before implementation starts are:
  1. The listTraces default sort vs. trace_roots ORDER BY mismatch (finding #1) - needs a decision
  2. Discovery refresh SQL is entirely unspecified (finding #3) - needs at minimum a skeleton
  3. The metadataSearch normalization code doesn't exist yet (finding #8) - needs to be scoped as a work item
  4. Score/feedback columns will be dead weight until upstream enrichment lands (finding #2) - needs explicit acknowledgment

  Everything else is implementable as written or has clear enough direction to resolve during implementation.
  