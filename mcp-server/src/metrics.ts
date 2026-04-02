// ---------------------------------------------------------------------------
// In-memory metrics store — resets on process restart (Cloud Run is stateless)
// ---------------------------------------------------------------------------

export interface ToolMetrics {
  calls: number;
  errors: number;
  rateLimitHits: number;
  lastCalledAt: number | null;
}

interface MetricsStore {
  startedAt: number;
  tools: Record<string, ToolMetrics>;
  totalRequests: number;
  totalErrors: number;
  totalRateLimitHits: number;
}

const store: MetricsStore = {
  startedAt: Date.now(),
  tools: {},
  totalRequests: 0,
  totalErrors: 0,
  totalRateLimitHits: 0,
};

// ---------------------------------------------------------------------------
// Time-series sampling — one snapshot per minute, rolling 120-sample window
// ---------------------------------------------------------------------------

export interface MetricsSample {
  ts: number;                  // unix ms
  totalRequests: number;
  totalErrors: number;
  totalRateLimitHits: number;
  sendEmailCalls: number;      // cumulative send_email invocations
  createAccountCalls: number;  // cumulative create_account invocations
  deleteAccountCalls: number;  // cumulative delete_account invocations
}

const MAX_SAMPLES = 120;
const samples: MetricsSample[] = [];

function takeSample(): void {
  const snap: MetricsSample = {
    ts: Date.now(),
    totalRequests: store.totalRequests,
    totalErrors: store.totalErrors,
    totalRateLimitHits: store.totalRateLimitHits,
    sendEmailCalls: store.tools["send_email"]?.calls ?? 0,
    createAccountCalls: store.tools["create_account"]?.calls ?? 0,
    deleteAccountCalls: store.tools["delete_account"]?.calls ?? 0,
  };
  samples.push(snap);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

// Seed immediately so the chart always has at least one data point.
takeSample();
setInterval(takeSample, 60_000).unref(); // .unref() so this doesn't prevent clean shutdown

function getOrCreate(tool: string): ToolMetrics {
  if (!store.tools[tool]) {
    store.tools[tool] = { calls: 0, errors: 0, rateLimitHits: 0, lastCalledAt: null };
  }
  return store.tools[tool];
}

export function recordCall(tool: string): void {
  const m = getOrCreate(tool);
  m.calls++;
  m.lastCalledAt = Date.now();
  store.totalRequests++;
}

export function recordError(tool: string): void {
  const m = getOrCreate(tool);
  m.errors++;
  store.totalErrors++;
}

export function recordRateLimit(tool: string): void {
  const m = getOrCreate(tool);
  m.rateLimitHits++;
  store.totalRateLimitHits++;
}

export function getMetrics(): Readonly<MetricsStore> {
  return store;
}

export function getSamples(): ReadonlyArray<MetricsSample> {
  return samples;
}
