• Findings

  1. score_events and feedback_events are not implementable through the current Mastra write path. The design says those tables must satisfy the current public filter
     surface from row-local data, but DefaultExporter only writes what buildScoreRecord and buildFeedbackRecord emit, and those builders do not populate the required
     context fields. Until that upstream work lands, the storage layer cannot honor the design without inventing a second enrichment path. Refs: observability/clickhouse-
     design/shared.md:68, observability/clickhouse-design/score-events.md:53, observability/clickhouse-design/feedback-events.md:58, observability/mastra/src/exporters/
     default.ts:365, packages/core/src/storage/domains/observability/record-builders.ts:287, packages/_internal-core/src/storage/domains/observability/scores.ts:131,
     packages/_internal-core/src/storage/domains/observability/feedback.ts:140
  
  2. The trace contract divergence is too large to treat as a backend-local detail. Returning no running traces and aliasing parent* and root* filters to the root span’s
     own fields changes public API semantics, not just storage internals. If that is intentional, it needs an explicit product/API decision before implementation, because
     tests alone will only ossify a backend inconsistency. Refs: observability/clickhouse-design/shared.md:76, observability/clickhouse-design/span-events.md:159,
     packages/core/src/storage/domains/observability/tracing.ts:48, packages/_internal-core/src/storage/domains/shared.ts:145 
  
  3. Metadata and scope filtering are still underspecified enough to cause churn. The design wants explicit failures for non-string metadata values and non-indexed keys,
     but the current filter schema accepts arbitrary metadata values and does not expose which keys are indexed. It also never defines stable escaping/path rules for
     weird keys or key normalization rules for labels, so two implementations can both be “correct” and still disagree. Refs: observability/clickhouse-design/span-
     events.md:103, observability/clickhouse-design/shared.md:146, packages/core/src/storage/domains/observability/tracing.ts:71, stores/duckdb/src/storage/domains/
     observability/filters.ts:1
  
  4. The discovery design is internally loose at exactly the point where implementation needs precision. getTags(entityType) and getMetricLabelKeys(metricName) both
     require an extra dimension, but discovery_values only exposes one generic key1 and the docs never pin its meaning per kind. Inference: the refreshable-materialized-
     view plan also assumes concrete ClickHouse feature and operational behavior that is not version-pinned or specified here. Refs: observability/clickhouse-design/
     discovery.md:20, observability/clickhouse-design/physical-types.md:226
  
  5. Several ORDER BY choices are hostile to the stated read patterns. trace_roots is sorted by endedAt even though listTraces defaults to startedAt, and score_events and
     feedback_events are sorted by traceId, timestamp even though their list APIs are timestamp-first and often not trace-scoped. In ClickHouse, bad sort keys are a long-
     term tax, not a cosmetic issue. Refs: observability/clickhouse-design/trace-roots.md:24, packages/core/src/storage/domains/observability/tracing.ts:320,
     observability/clickhouse-design/score-events.md:42, packages/_internal-core/src/storage/domains/observability/scores.ts:151, observability/clickhouse-design/
     feedback-events.md:46, packages/_internal-core/src/storage/domains/observability/feedback.ts:161
  
  6. status is a naming trap in tracing. The physical tracing tables store status as only success|error, while the public trace surface uses success|error|running; the
     docs also say trace_roots stays close enough to return root rows directly. That combination is begging for read-path bugs and accidental API leakage of the wrong
     status semantics. Refs: observability/clickhouse-design/span-events.md:84, observability/clickhouse-design/trace-roots.md:15, observability/clickhouse-design/
     physical-types.md:27, packages/core/src/storage/domains/observability/tracing.ts:142
  
  7. The ClickHouse-specific decisions are not concrete enough where they matter most. The docs are specific about column lists, but vague about the risky mechanics:
     exact Map and Array filter predicates, JSON extraction against serialized blobs, delete behavior across helper tables, MV bootstrap/backfill, refresh orchestration,
     and retention config plumbing. For a storage design doc, that is backwards. Refs: observability/clickhouse-design/shared.md:192, observability/clickhouse-design/
     discovery.md:7, observability/clickhouse-design/physical-types.md:7
  
  8. The rollout plan is incomplete, so it is not realistic as written. It acknowledges upstream score/feedback enrichment as a separate dependency, but the rollout does
     not include that dependency, helper bootstrap, explicit filter error-contract work, or response-shaping compatibility work. That means implementation can “finish”
     the schema and still not be usable. Refs: observability/clickhouse-design/README.md:54, observability/clickhouse-design/shared.md:68

  Open Questions

  - Is backend-specific trace API divergence actually acceptable, or is v-next still supposed to preserve the shared observability contract?
  - Are the score/feedback record-builder changes part of the same milestone in practice? If not, those two signals should not be called “ready for v0”.
  - Inference: what exact ClickHouse feature set is assumed for Cloud here? The doc should pin that before leaning on refreshable MVs and aggressive LowCardinality/Map
    usage.

  Doc Shape

  - observability/clickhouse-design/README.md:25 is redundant with observability/clickhouse-design/shared.md:24 and adds noise like the AI review links. Implementers
    mostly need one short overview plus precise per-table specs.
  - Discovery refresh policy and delete/retention operations should probably be split into a follow-up implementation/ops doc. Right now the main design spends a lot of
    words on non-goals and limitations while still leaving the operational mechanics underdefined.

  Bottom line: the direction is reasonable for metrics/logs and mostly reasonable for tracing, but this design is not ready for implementation start as-is. The biggest
  blockers are the missing score/feedback write-path dependencies, unresolved trace contract divergence, and the lack of precise query/refresh/filter semantics for the
  ClickHouse-specific pieces.