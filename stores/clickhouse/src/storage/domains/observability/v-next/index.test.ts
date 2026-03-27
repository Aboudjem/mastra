/**
 * Integration tests for the ClickHouse v-next observability storage domain.
 *
 * Mirrors the DuckDB observability test suite but adapted for v-next semantics:
 * - Insert-only model (no span updates)
 * - ReplacingMergeTree for tracing, append-only MergeTree for signals
 * - Discovery via helper tables (discovery_values / discovery_pairs)
 * - Label-key exclusion in grouped queries
 *
 * Requires a running ClickHouse instance. Use `docker compose up -d` in the
 * clickhouse store directory, or set CLICKHOUSE_URL/CLICKHOUSE_USERNAME/CLICKHOUSE_PASSWORD.
 */
import { EntityType, SpanType } from '@mastra/core/observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservabilityStorageClickhouseVNext } from '.';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe('ObservabilityStorageClickhouseVNext', () => {
  let storage: ObservabilityStorageClickhouseVNext;

  beforeAll(async () => {
    storage = new ObservabilityStorageClickhouseVNext({
      url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
      username: process.env.CLICKHOUSE_USERNAME || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || 'password',
    });
    await storage.init();
  });

  beforeEach(async () => {
    await storage.dangerouslyClearAll();
  });

  afterAll(async () => {
    await storage.dangerouslyClearAll();
  });

  // ==========================================================================
  // Strategy
  // ==========================================================================

  it('reports insert-only as preferred strategy', () => {
    expect(storage.observabilityStrategy).toEqual({
      preferred: 'insert-only',
      supported: ['insert-only'],
    });
  });

  // ==========================================================================
  // Span Events
  // ==========================================================================

  describe('span events', () => {
    const now = new Date();

    it('creates and reconstructs a completed span', async () => {
      await storage.createSpan({
        span: {
          traceId: 'trace-1',
          spanId: 'span-1',
          parentSpanId: null,
          name: 'agent-run',
          spanType: SpanType.AGENT_RUN,
          isEvent: false,
          entityType: EntityType.AGENT,
          entityId: 'agent-1',
          entityName: 'myAgent',
          userId: null,
          organizationId: null,
          resourceId: null,
          runId: null,
          sessionId: null,
          threadId: null,
          requestId: null,
          environment: 'test',
          source: null,
          serviceName: 'test-service',
          scope: null,
          attributes: { model: 'gpt-4' },
          metadata: { foo: 'bar' },
          tags: ['tag1', 'tag2'],
          links: null,
          input: { prompt: 'hello' },
          output: { answer: 'world' },
          error: null,
          startedAt: new Date('2026-01-01T00:00:00Z'),
          endedAt: new Date('2026-01-01T00:00:01Z'),
        },
      });

      const result = await storage.getSpan({ traceId: 'trace-1', spanId: 'span-1' });
      expect(result).not.toBeNull();
      const span = result!.span;
      expect(span.name).toBe('agent-run');
      expect(span.traceId).toBe('trace-1');
      expect(span.spanId).toBe('span-1');
      expect(span.spanType).toBe('agent_run');
      expect(span.entityType).toBe('agent');
      expect(span.entityName).toBe('myAgent');
      expect(span.environment).toBe('test');
      expect(span.serviceName).toBe('test-service');
      expect(span.attributes).toEqual({ model: 'gpt-4' });
      expect(span.metadata).toEqual({ foo: 'bar' });
      expect(span.tags).toEqual(expect.arrayContaining(['tag1', 'tag2']));
      expect(span.input).toEqual({ prompt: 'hello' });
      expect(span.output).toEqual({ answer: 'world' });
      expect(span.endedAt).toBeInstanceOf(Date);
    });

    it('does not support span updates (insert-only model)', async () => {
      await expect(
        storage.updateSpan({
          traceId: 'trace-1',
          spanId: 'span-1',
          updates: {
            output: { temp: 72 },
            endedAt: new Date('2026-01-01T00:00:01Z'),
          },
        }),
      ).rejects.toThrow('does not support updating spans');
    });

    it('batch creates spans and retrieves trace', async () => {
      await storage.batchCreateSpans({
        records: [
          {
            traceId: 'trace-3',
            spanId: 'root-span',
            parentSpanId: null,
            name: 'workflow-run',
            spanType: SpanType.WORKFLOW_RUN,
            isEvent: false,
            entityType: EntityType.WORKFLOW_RUN,
            entityId: 'wf-1',
            entityName: 'myWorkflow',
            userId: null,
            organizationId: null,
            resourceId: null,
            runId: null,
            sessionId: null,
            threadId: null,
            requestId: null,
            environment: 'production',
            source: null,
            serviceName: 'svc',
            scope: null,
            attributes: null,
            metadata: null,
            tags: ['v1'],
            links: null,
            input: null,
            output: null,
            error: null,
            startedAt: new Date('2026-01-01T00:00:00Z'),
            endedAt: new Date('2026-01-01T00:00:02Z'),
          },
          {
            traceId: 'trace-3',
            spanId: 'child-span',
            parentSpanId: 'root-span',
            name: 'agent-step',
            spanType: SpanType.AGENT_RUN,
            isEvent: false,
            entityType: EntityType.AGENT,
            entityId: 'agent-1',
            entityName: 'myAgent',
            userId: null,
            organizationId: null,
            resourceId: null,
            runId: null,
            sessionId: null,
            threadId: null,
            requestId: null,
            environment: 'production',
            source: null,
            serviceName: 'svc',
            scope: null,
            attributes: null,
            metadata: null,
            tags: null,
            links: null,
            input: null,
            output: null,
            error: null,
            startedAt: new Date('2026-01-01T00:00:01Z'),
            endedAt: new Date('2026-01-01T00:00:02Z'),
          },
        ],
      });

      const trace = await storage.getTrace({ traceId: 'trace-3' });
      expect(trace).not.toBeNull();
      expect(trace!.spans).toHaveLength(2);

      const rootResult = await storage.getRootSpan({ traceId: 'trace-3' });
      expect(rootResult).not.toBeNull();
      expect(rootResult!.span.name).toBe('workflow-run');
      expect(rootResult!.span.parentSpanId).toBeNull();

      const traces = await storage.listTraces({});
      expect(traces.spans.length).toBeGreaterThanOrEqual(1);
    });

    it('batch deletes traces', async () => {
      await storage.createSpan({
        span: {
          traceId: 'trace-del',
          spanId: 'span-del',
          parentSpanId: null,
          name: 'delete-me',
          spanType: SpanType.AGENT_RUN,
          isEvent: false,
          entityType: null,
          entityId: null,
          entityName: null,
          userId: null,
          organizationId: null,
          resourceId: null,
          runId: null,
          sessionId: null,
          threadId: null,
          requestId: null,
          environment: null,
          source: null,
          serviceName: null,
          scope: null,
          attributes: null,
          metadata: null,
          tags: null,
          links: null,
          input: null,
          output: null,
          error: null,
          startedAt: now,
          endedAt: new Date(now.getTime() + 1000),
        },
      });

      // Verify it exists first
      const before = await storage.getSpan({ traceId: 'trace-del', spanId: 'span-del' });
      expect(before).not.toBeNull();

      await storage.batchDeleteTraces({ traceIds: ['trace-del'] });

      const result = await storage.getSpan({ traceId: 'trace-del', spanId: 'span-del' });
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Logs
  // ==========================================================================

  describe('logs', () => {
    it('creates and lists logs', async () => {
      await storage.batchCreateLogs({
        logs: [
          {
            timestamp: new Date(),
            level: 'info',
            message: 'Test log message',
            data: { key: 'value' },
            traceId: 'trace-1',
            spanId: 'span-1',
            tags: ['test'],
            entityType: EntityType.AGENT,
            entityId: 'agent-1',
            entityName: 'myAgent',
            metadata: null,
          },
          {
            timestamp: new Date(),
            level: 'error',
            message: 'Error occurred',
            data: null,
            traceId: 'trace-1',
            spanId: null,
            tags: null,
            metadata: null,
          },
        ],
      });

      const result = await storage.listLogs({});
      expect(result.logs).toHaveLength(2);

      const filtered = await storage.listLogs({
        filters: { level: 'error' },
      });
      expect(filtered.logs).toHaveLength(1);
      expect(filtered.logs[0]!.message).toBe('Error occurred');
    });
  });

  // ==========================================================================
  // Metrics + OLAP
  // ==========================================================================

  describe('metrics', () => {
    beforeEach(async () => {
      await storage.batchCreateMetrics({
        metrics: [
          {
            timestamp: new Date('2026-01-01T00:00:00Z'),
            name: 'mastra_agent_duration_ms',
            value: 100,
            labels: { status: 'ok' },
            provider: 'openai',
            model: 'gpt-4o-mini',
            estimatedCost: 0.1,
            costUnit: 'usd',
            tags: ['prod'],
            entityType: EntityType.AGENT,
            entityName: 'weatherAgent',
          },
          {
            timestamp: new Date('2026-01-01T00:00:05Z'),
            name: 'mastra_agent_duration_ms',
            value: 200,
            labels: { status: 'ok' },
            provider: 'openai',
            model: 'gpt-4o-mini',
            estimatedCost: 0.2,
            costUnit: 'usd',
            tags: ['prod'],
            entityType: EntityType.AGENT,
            entityName: 'weatherAgent',
          },
          {
            timestamp: new Date('2026-01-01T00:00:10Z'),
            name: 'mastra_agent_duration_ms',
            value: 500,
            labels: { status: 'error' },
            provider: 'anthropic',
            model: 'claude-3-7-sonnet',
            estimatedCost: 0.5,
            costUnit: 'usd',
            tags: ['prod'],
            entityType: EntityType.AGENT,
            entityName: 'codeAgent',
          },
          {
            timestamp: new Date('2026-01-01T01:00:00Z'),
            name: 'mastra_tool_calls_started',
            value: 1,
            labels: {},
            tags: ['prod'],
            entityType: EntityType.TOOL,
            entityName: 'search',
          },
        ],
      });
    });

    it('getMetricAggregate returns sum', async () => {
      const result = await storage.getMetricAggregate({
        name: ['mastra_agent_duration_ms'],
        aggregation: 'sum',
      });
      expect(result.value).toBe(800); // 100 + 200 + 500
      expect(result.estimatedCost).toBeCloseTo(0.8);
      expect(result.costUnit).toBe('usd');
    });

    it('listMetrics returns paginated metric records with shared filters', async () => {
      const result = await storage.listMetrics({
        filters: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          tags: ['prod'],
        },
        pagination: { page: 0, perPage: 1 },
        orderBy: { field: 'timestamp', direction: 'ASC' },
      });

      expect(result.pagination.total).toBe(2);
      expect(result.pagination.hasMore).toBe(true);
      expect(result.metrics).toHaveLength(1);
      expect(result.metrics[0]!.provider).toBe('openai');
      expect(result.metrics[0]!.model).toBe('gpt-4o-mini');
      expect(result.metrics[0]!.estimatedCost).toBeCloseTo(0.1);
      expect(result.metrics[0]!.costUnit).toBe('usd');
      expect(result.metrics[0]!.tags).toEqual(['prod']);
      expect(result.metrics[0]!.labels).toEqual({ status: 'ok' });
    });

    it('getMetricAggregate returns avg', async () => {
      const result = await storage.getMetricAggregate({
        name: ['mastra_agent_duration_ms'],
        aggregation: 'avg',
      });
      expect(result.value).toBeCloseTo(266.67, 0);
    });

    it('getMetricAggregate returns count', async () => {
      const result = await storage.getMetricAggregate({
        name: ['mastra_agent_duration_ms'],
        aggregation: 'count',
      });
      expect(result.value).toBe(3);
    });

    it('getMetricBreakdown groups by entityName', async () => {
      const result = await storage.getMetricBreakdown({
        name: ['mastra_agent_duration_ms'],
        groupBy: ['entityName'],
        aggregation: 'avg',
      });
      expect(result.groups).toHaveLength(2);
      const weather = result.groups.find(g => g.dimensions.entityName === 'weatherAgent');
      const code = result.groups.find(g => g.dimensions.entityName === 'codeAgent');
      expect(weather).toBeDefined();
      expect(weather!.value).toBe(150); // (100+200)/2
      expect(weather!.estimatedCost).toBeCloseTo(0.3);
      expect(weather!.costUnit).toBe('usd');
      expect(code).toBeDefined();
      expect(code!.value).toBe(500);
      expect(code!.estimatedCost).toBeCloseTo(0.5);
      expect(code!.costUnit).toBe('usd');
    });

    it('getMetricBreakdown groups by label keys', async () => {
      const result = await storage.getMetricBreakdown({
        name: ['mastra_agent_duration_ms'],
        groupBy: ['status'],
        aggregation: 'count',
      });

      expect(result.groups).toHaveLength(2);
      const ok = result.groups.find(g => g.dimensions.status === 'ok');
      const error = result.groups.find(g => g.dimensions.status === 'error');

      expect(ok?.value).toBe(2);
      expect(ok?.estimatedCost).toBeCloseTo(0.3);
      expect(error?.value).toBe(1);
      expect(error?.estimatedCost).toBeCloseTo(0.5);
    });

    it('getMetricBreakdown excludes rows missing label keys (v-next design)', async () => {
      // The beforeEach inserts 3 mastra_agent_duration_ms rows with 'status' label.
      // Insert 2 more rows with a different label key ('foo-bar'), but NOT 'status'.
      await storage.batchCreateMetrics({
        metrics: [
          {
            timestamp: new Date('2026-01-01T00:00:20Z'),
            name: 'mastra_agent_duration_ms',
            value: 300,
            labels: { 'foo-bar': 'alpha' },
            entityType: EntityType.AGENT,
            entityName: 'weatherAgent',
          },
          {
            timestamp: new Date('2026-01-01T00:00:25Z'),
            name: 'mastra_agent_duration_ms',
            value: 400,
            labels: { 'foo-bar': 'beta' },
            entityType: EntityType.AGENT,
            entityName: 'codeAgent',
          },
        ],
      });

      // Group by 'foo-bar' — only the 2 rows with 'foo-bar' label should appear.
      // The 3 original rows with 'status' label (but no 'foo-bar') are excluded.
      const result = await storage.getMetricBreakdown({
        name: ['mastra_agent_duration_ms'],
        groupBy: ['foo-bar'],
        aggregation: 'count',
      });

      const alpha = result.groups.find(group => group.dimensions['foo-bar'] === 'alpha');
      const beta = result.groups.find(group => group.dimensions['foo-bar'] === 'beta');
      const missing = result.groups.find(group => group.dimensions['foo-bar'] === null);

      expect(alpha?.value).toBe(1);
      expect(beta?.value).toBe(1);
      // v-next design: rows missing the requested label key are excluded
      expect(missing).toBeUndefined();
    });

    it('getMetricTimeSeries returns bucketed data', async () => {
      const result = await storage.getMetricTimeSeries({
        name: ['mastra_agent_duration_ms'],
        interval: '1h',
        aggregation: 'sum',
      });
      expect(result.series.length).toBeGreaterThanOrEqual(1);
      const mainSeries = result.series[0]!;
      expect(mainSeries.points.length).toBeGreaterThanOrEqual(1);
      expect(mainSeries.costUnit).toBe('usd');
      expect(mainSeries.points[0]!.estimatedCost).toBeCloseTo(0.8);
    });

    it('getMetricTimeSeries keeps colliding display names as separate grouped series', async () => {
      await storage.batchCreateMetrics({
        metrics: [
          {
            timestamp: new Date('2026-01-01T02:00:00Z'),
            name: 'mastra_collision_metric',
            value: 10,
            labels: { segmentA: 'a', segmentB: 'b|c' },
            entityType: EntityType.TOOL,
            entityName: 'search',
          },
          {
            timestamp: new Date('2026-01-01T02:00:00Z'),
            name: 'mastra_collision_metric',
            value: 20,
            labels: { segmentA: 'a|b', segmentB: 'c' },
            entityType: EntityType.TOOL,
            entityName: 'search',
          },
        ],
      });

      const result = await storage.getMetricTimeSeries({
        name: ['mastra_collision_metric'],
        interval: '1h',
        aggregation: 'sum',
        groupBy: ['segmentA', 'segmentB'],
      });

      expect(result.series).toHaveLength(2);
      expect(result.series.every(series => series.name === 'a|b|c')).toBe(true);
      expect(result.series.map(series => series.points.length)).toEqual([1, 1]);
      expect(result.series.map(series => series.points[0]!.value).sort((left, right) => left - right)).toEqual([
        10, 20,
      ]);
    });

    it('filters metrics by canonical cost fields', async () => {
      const result = await storage.getMetricAggregate({
        name: ['mastra_agent_duration_ms'],
        aggregation: 'sum',
        filters: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          costUnit: 'usd',
        },
      });

      expect(result.value).toBe(300);
      expect(result.estimatedCost).toBeCloseTo(0.3);
    });

    it('getMetricPercentiles returns percentile series', async () => {
      const result = await storage.getMetricPercentiles({
        name: 'mastra_agent_duration_ms',
        percentiles: [0.5, 0.99],
        interval: '1h',
      });
      expect(result.series).toHaveLength(2);
      const p50 = result.series.find(s => s.percentile === 0.5);
      expect(p50).toBeDefined();
    });
  });

  // ==========================================================================
  // Discovery
  // ==========================================================================

  describe('discovery', () => {
    beforeEach(async () => {
      await storage.batchCreateMetrics({
        metrics: [
          {
            timestamp: new Date(),
            name: 'mastra_agent_duration_ms',
            value: 100,
            labels: { agent: 'weatherAgent', status: 'ok' },
            entityType: EntityType.AGENT,
            entityName: 'weatherAgent',
            serviceName: 'metric-service',
            environment: 'metric-env',
            tags: ['metric-tag'],
          },
          {
            timestamp: new Date(),
            name: 'mastra_tool_calls_started',
            value: 1,
            labels: { tool: 'search' },
            entityType: EntityType.TOOL,
            entityName: 'metricTool',
            serviceName: 'metric-service',
            environment: 'metric-env',
            tags: ['metric-tag'],
          },
        ],
      });

      await storage.batchCreateLogs({
        logs: [
          {
            timestamp: new Date(),
            level: 'info',
            message: 'discovery-log',
            data: null,
            entityType: EntityType.INPUT_PROCESSOR,
            entityName: 'logProcessor',
            serviceName: 'log-service',
            environment: 'log-env',
            tags: ['log-tag'],
            metadata: null,
          },
        ],
      });

      await storage.batchCreateSpans({
        records: [
          {
            traceId: 'disc-trace',
            spanId: 'disc-span',
            parentSpanId: null,
            name: 'test',
            spanType: SpanType.AGENT_RUN,
            isEvent: false,
            entityType: EntityType.AGENT,
            entityId: 'a-1',
            entityName: 'weatherAgent',
            userId: null,
            organizationId: null,
            resourceId: null,
            runId: null,
            sessionId: null,
            threadId: null,
            requestId: null,
            environment: 'production',
            source: null,
            serviceName: 'my-service',
            scope: null,
            attributes: null,
            metadata: null,
            tags: ['v1', 'experiment'],
            links: null,
            input: null,
            output: null,
            error: null,
            startedAt: new Date(),
            endedAt: new Date(Date.now() + 1000),
          },
        ],
      });

      // Trigger discovery refresh so helper tables are populated.
      // In production, discovery MVs refresh automatically on a schedule.
      // In tests, we trigger an immediate refresh after inserting data.
      await triggerDiscoveryRefresh();
    });

    it('getMetricNames returns distinct names', async () => {
      const result = await storage.getMetricNames({});
      expect(result.names).toContain('mastra_agent_duration_ms');
      expect(result.names).toContain('mastra_tool_calls_started');
    });

    it('getMetricNames filters by prefix', async () => {
      const result = await storage.getMetricNames({ prefix: 'mastra_agent' });
      expect(result.names).toContain('mastra_agent_duration_ms');
      expect(result.names).not.toContain('mastra_tool_calls_started');
    });

    it('getMetricLabelKeys returns label keys', async () => {
      const result = await storage.getMetricLabelKeys({ metricName: 'mastra_agent_duration_ms' });
      expect(result.keys).toContain('agent');
      expect(result.keys).toContain('status');
    });

    it('getMetricLabelValues returns values for a label key', async () => {
      const result = await storage.getMetricLabelValues({
        metricName: 'mastra_agent_duration_ms',
        labelKey: 'status',
      });
      expect(result.values).toContain('ok');
    });

    it('getEntityTypes returns distinct entity types', async () => {
      const result = await storage.getEntityTypes({});
      expect(result.entityTypes).toContain('agent');
      expect(result.entityTypes).toContain('tool');
      expect(result.entityTypes).toContain('input_processor');
    });

    it('getEntityNames returns entity names', async () => {
      const result = await storage.getEntityNames({ entityType: EntityType.AGENT });
      expect(result.names).toContain('weatherAgent');

      const toolNames = await storage.getEntityNames({ entityType: EntityType.TOOL });
      expect(toolNames.names).toContain('metricTool');

      const processorNames = await storage.getEntityNames({ entityType: EntityType.INPUT_PROCESSOR });
      expect(processorNames.names).toContain('logProcessor');
    });

    it('getServiceNames returns service names', async () => {
      const result = await storage.getServiceNames({});
      expect(result.serviceNames).toContain('my-service');
      expect(result.serviceNames).toContain('metric-service');
      expect(result.serviceNames).toContain('log-service');
    });

    it('getEnvironments returns environments', async () => {
      const result = await storage.getEnvironments({});
      expect(result.environments).toContain('production');
      expect(result.environments).toContain('metric-env');
      expect(result.environments).toContain('log-env');
    });

    it('getTags returns distinct tags', async () => {
      const result = await storage.getTags({});
      expect(result.tags).toContain('v1');
      expect(result.tags).toContain('experiment');
      expect(result.tags).toContain('metric-tag');
      expect(result.tags).toContain('log-tag');
    });
  });

  // ==========================================================================
  // Scores
  // ==========================================================================

  describe('scores', () => {
    it('creates and lists scores', async () => {
      await storage.createScore({
        score: {
          timestamp: new Date(),
          traceId: 'trace-1',
          spanId: null,
          scorerId: 'relevance',
          score: 0.85,
          reason: 'Good answer',
          experimentId: 'exp-1',
          metadata: { entityType: 'agent' },
        },
      });

      await storage.createScore({
        score: {
          timestamp: new Date(),
          traceId: 'trace-1',
          spanId: 'span-1',
          scorerId: 'factuality',
          score: 0.9,
          reason: null,
          experimentId: null,
          metadata: null,
        },
      });

      const result = await storage.listScores({});
      expect(result.scores).toHaveLength(2);

      const filtered = await storage.listScores({
        filters: { scorerId: 'relevance' },
      });
      expect(filtered.scores).toHaveLength(1);
      expect(filtered.scores[0]!.score).toBe(0.85);
    });
  });

  // ==========================================================================
  // Feedback
  // ==========================================================================

  describe('feedback', () => {
    it('creates and lists feedback', async () => {
      await storage.createFeedback({
        feedback: {
          timestamp: new Date(),
          traceId: 'trace-1',
          spanId: null,
          source: 'user',
          feedbackType: 'thumbs',
          value: 1,
          comment: 'Great!',
          experimentId: null,
          userId: 'user-1',
          sourceId: 'source-1',
          metadata: null,
        },
      });

      await storage.createFeedback({
        feedback: {
          timestamp: new Date(),
          traceId: 'trace-2',
          spanId: null,
          source: 'reviewer',
          feedbackType: 'rating',
          value: 4,
          comment: null,
          experimentId: 'exp-1',
          userId: 'user-2',
          sourceId: 'source-2',
          metadata: null,
        },
      });

      const result = await storage.listFeedback({});
      expect(result.feedback).toHaveLength(2);

      const filtered = await storage.listFeedback({
        filters: { source: 'user' },
      });
      expect(filtered.feedback).toHaveLength(1);
      expect(filtered.feedback[0]!.value).toBe(1);
      expect(filtered.feedback[0]!.userId).toBe('user-1');
      expect(filtered.feedback[0]!.sourceId).toBe('source-1');
    });

    it('batch creates feedback with mixed value types', async () => {
      await storage.batchCreateFeedback({
        feedbacks: [
          {
            timestamp: new Date('2026-01-01T00:00:00Z'),
            traceId: 'batch-trace-1',
            spanId: null,
            source: 'user',
            feedbackType: 'thumbs',
            value: 1,
            comment: 'Helpful',
            experimentId: null,
            userId: 'user-1',
            sourceId: 'source-1',
            metadata: null,
          },
          {
            timestamp: new Date('2026-01-01T00:00:01Z'),
            traceId: 'batch-trace-2',
            spanId: 'span-2',
            source: 'reviewer',
            feedbackType: 'rating',
            value: 4,
            comment: null,
            experimentId: 'exp-1',
            userId: 'user-2',
            sourceId: 'source-2',
            metadata: { category: 'quality' },
          },
          {
            timestamp: new Date('2026-01-01T00:00:02Z'),
            traceId: 'batch-trace-3',
            spanId: null,
            source: 'system',
            feedbackType: 'flag',
            value: 'needs-review',
            comment: 'Escalated',
            experimentId: null,
            userId: null,
            sourceId: 'source-3',
            metadata: { severity: 'high' },
          },
        ],
      });

      const result = await storage.listFeedback({
        orderBy: { field: 'timestamp', direction: 'ASC' },
      });

      expect(result.feedback).toHaveLength(3);
      expect(result.feedback).toEqual([
        expect.objectContaining({
          traceId: 'batch-trace-1',
          value: 1,
          comment: 'Helpful',
        }),
        expect.objectContaining({
          traceId: 'batch-trace-2',
          value: 4,
          comment: null,
        }),
        expect.objectContaining({
          traceId: 'batch-trace-3',
          value: 'needs-review',
          comment: 'Escalated',
        }),
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Trigger an immediate refresh of discovery materialized views.
 * In production these refresh on a schedule; in tests we need to trigger manually.
 * Uses a standalone client connection since the adapter's client is private.
 */
async function triggerDiscoveryRefresh(): Promise<void> {
  const { createClient } = await import('@clickhouse/client');
  const { MV_DISCOVERY_VALUES, MV_DISCOVERY_PAIRS } = await import('./ddl');

  const client = createClient({
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USERNAME || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || 'password',
  });

  try {
    await client.command({ query: `SYSTEM REFRESH VIEW ${MV_DISCOVERY_VALUES}` });
    await client.command({ query: `SYSTEM REFRESH VIEW ${MV_DISCOVERY_PAIRS}` });
  } finally {
    await client.close();
  }
}
