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
