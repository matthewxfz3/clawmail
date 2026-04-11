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
  /** Latest known total emails across all inboxes — updated externally on each metrics page load. */
  inboxTotal: number;
}

const store: MetricsStore = {
  startedAt: Date.now(),
  tools: {},
  totalRequests: 0,
  totalErrors: 0,
  totalRateLimitHits: 0,
  inboxTotal: 0,
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
  inboxTotal: number;          // absolute total emails across all inboxes at sample time
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
    inboxTotal: store.inboxTotal,
  };
  samples.push(snap);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

/** Account creation registry — tracks when accounts were created this session. */
const accountRegistry = new Map<string, number>(); // email → createdAt ms

/** Per-account send counter — tracks send_email calls this session. */
const accountSendCounts = new Map<string, number>(); // email → send count

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

/** Update the running inbox total — call whenever inbox counts are fetched. */
export function setInboxTotal(n: number): void {
  store.inboxTotal = n;
}

/** Record that an account was created in this session. */
export function recordAccountCreated(email: string): void {
  accountRegistry.set(email, Date.now());
}

/** Returns the creation timestamp for an account created in this session, or undefined. */
export function getAccountCreatedAt(email: string): number | undefined {
  return accountRegistry.get(email);
}

/** Increment the send counter for a given account. */
export function recordAccountSend(email: string): void {
  accountSendCounts.set(email, (accountSendCounts.get(email) ?? 0) + 1);
}

/** Returns the number of emails sent from this account in this session. */
export function getAccountSendCount(email: string): number {
  return accountSendCounts.get(email) ?? 0;
}

export function getMetrics(): Readonly<MetricsStore> {
  return store;
}

export function getSamples(): ReadonlyArray<MetricsSample> {
  return samples;
}

// ---------------------------------------------------------------------------
// Tool call log — ring buffer of last 200 entries (newest at end)
// ---------------------------------------------------------------------------

export interface ToolCallEntry {
  ts: number;
  tool: string;
  account: string;
  durationMs: number;
  status: "ok" | "error" | "ratelimit" | "denied";
  errorMsg?: string;
}

const CALL_LOG_MAX = 200;
const callLog: ToolCallEntry[] = [];

export function recordCallEntry(entry: ToolCallEntry): void {
  callLog.push(entry);
  if (callLog.length > CALL_LOG_MAX) callLog.splice(0, callLog.length - CALL_LOG_MAX);
}

export function getCallLog(): ReadonlyArray<ToolCallEntry> {
  return callLog;
}

export function getRecentErrors(): ReadonlyArray<ToolCallEntry> {
  return callLog.filter((e) => e.status === "error").slice(-50).reverse();
}

// ---------------------------------------------------------------------------
// Batch send log — ring buffer of last 20 entries
// ---------------------------------------------------------------------------

export interface BatchSendEntry {
  ts: number;
  account: string;
  template_id: string;
  total: number;
  sent: number;
  failed: number;
  errors: string[];
}

const BATCH_LOG_MAX = 20;
const batchLog: BatchSendEntry[] = [];

export function recordBatchSend(entry: BatchSendEntry): void {
  batchLog.push(entry);
  if (batchLog.length > BATCH_LOG_MAX) batchLog.splice(0, batchLog.length - BATCH_LOG_MAX);
}

export function getBatchLog(): ReadonlyArray<BatchSendEntry> {
  return batchLog;
}
