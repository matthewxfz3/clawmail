import { createHmac, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { toolListAccounts } from "./tools/accounts.js";
import { toolListEmails, toolReadEmail, toolDeleteEmail } from "./tools/mailbox.js";
import { toolSendEmail } from "./tools/send.js";
import { toolListEvents, type CalendarEvent } from "./tools/calendar.js";
import { toolListRules, type RuleCondition, type RuleAction, type MailboxRule } from "./tools/rules.js";
import { JmapClient } from "./clients/jmap.js";
import { getMetrics, getSamples, setInboxTotal, getAccountCreatedAt } from "./metrics.js";
import { buildAuthUrl, exchangeCode } from "./clients/google-meet.js";

// ---------------------------------------------------------------------------
// Session cookie — HMAC-SHA256 signed, 7-day expiry
// ---------------------------------------------------------------------------

const COOKIE_NAME = "clawmail_dash";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function effectivePassword(): string {
  return config.dashboard.password || config.stalwart.adminPassword;
}

function signSession(payload: string): string {
  const sig = createHmac("sha256", effectivePassword()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(cookie: string): boolean {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", effectivePassword()).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function makeSessionCookie(): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const value = signSession(payload);
  return `${COOKIE_NAME}=${value}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const cookieHeader = req.headers["cookie"] ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name.trim() !== COOKIE_NAME) continue;
    const value = rest.join("=");
    if (!verifySession(value)) return false;
    try {
      const payload = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString());
      return typeof payload.exp === "number" && payload.exp > Date.now();
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6f9;color:#1a1a2e;min-height:100vh}
  .topbar{background:#1a1a2e;color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  .topbar h1{font-size:1.1rem;font-weight:600;letter-spacing:.3px}
  .topbar span{font-size:.8rem;opacity:.6}
  .topbar a{color:#a0c4ff;font-size:.85rem;text-decoration:none}
  .topbar a:hover{text-decoration:underline}
  /* tabs */
  .tab-bar{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 24px;display:flex;gap:0}
  .tab-bar a{display:inline-block;padding:12px 20px;font-size:.88rem;font-weight:500;color:#666;text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px}
  .tab-bar a:hover{color:#1a1a2e}
  .tab-bar a.active{color:#4f46e5;border-bottom-color:#4f46e5;font-weight:600}
  /* layout */
  .container{max-width:960px;margin:28px auto;padding:0 16px;display:grid;gap:20px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:24px}
  .card h2{font-size:.9rem;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#666;margin-bottom:16px}
  /* status */
  .status-row{display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:.9rem}
  .status-row:last-child{border-bottom:none}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:4px}
  .dot.ok{background:#22c55e}.dot.warn{background:#f59e0b}.dot.fail{background:#ef4444}.dot.info{background:#94a3b8}
  .label{flex:1;color:#444}
  .badge{font-size:.75rem;font-weight:600;padding:2px 8px;border-radius:12px;color:#fff;white-space:nowrap}
  .badge.ok{background:#22c55e}.badge.warn{background:#f59e0b}.badge.fail{background:#ef4444}
  .row-detail{display:block;font-size:.75rem;color:#999;margin-top:1px;font-weight:400}
  .status-group{margin-bottom:8px}
  .status-group:last-child{margin-bottom:0}
  .group-heading{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#888;padding:10px 0 4px;border-bottom:1px solid #f0f0f0;margin-bottom:2px}
  /* tables */
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th{text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;color:#666;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#333;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  /* misc */
  .code-block{background:#1e1e2e;color:#cdd6f4;border-radius:8px;padding:16px;font-family:'JetBrains Mono',Menlo,monospace;font-size:.8rem;line-height:1.6;overflow-x:auto;white-space:pre}
  .key-row{display:flex;align-items:center;gap:8px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-family:monospace;font-size:.85rem;color:#333}
  .pill{display:inline-block;background:#eef2ff;color:#4f46e5;border-radius:12px;padding:2px 10px;font-size:.75rem;font-weight:600}
  .pill.green{background:#dcfce7;color:#16a34a}
  .pill.red{background:#fee2e2;color:#dc2626}
  .pill.amber{background:#fef3c7;color:#92400e}
  .pill.blue{background:#eff6ff;color:#1d4ed8}
  .pill.gray{background:#f1f5f9;color:#475569}
  td.mono{font-family:monospace;font-size:.82rem;color:#555}
  .empty{color:#999;font-size:.85rem;padding:8px 0}
  .url-display{font-family:monospace;font-size:.85rem;color:#4f46e5;word-break:break-all}
  /* account cards */
  .account-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
  .account-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px;transition:box-shadow .15s}
  .account-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.1)}
  .account-card .email{font-weight:600;font-size:.9rem;color:#1a1a2e;word-break:break-all}
  .account-card .actions{margin-top:12px;display:flex;gap:8px}
  .btn{display:inline-block;padding:6px 14px;border-radius:6px;font-size:.82rem;font-weight:600;text-decoration:none;cursor:pointer;border:none}
  .btn-primary{background:#4f46e5;color:#fff}
  .btn-primary:hover{background:#4338ca}
  .btn-danger{background:#fee2e2;color:#dc2626}
  .btn-danger:hover{background:#fecaca}
  /* inbox */
  .back-link{font-size:.85rem;color:#4f46e5;text-decoration:none;display:inline-flex;align-items:center;gap:4px;margin-bottom:16px}
  .back-link:hover{text-decoration:underline}
  .page-title{font-size:1.1rem;font-weight:700;color:#1a1a2e;margin-bottom:4px}
  .page-sub{font-size:.82rem;color:#888;margin-bottom:20px}
  .subject-link{color:#1a1a2e;text-decoration:none;font-weight:500}
  .subject-link:hover{color:#4f46e5;text-decoration:underline}
  .attach-icon{color:#f59e0b;font-size:.8rem}
  /* email detail */
  .email-meta{background:#f8f9fa;border-radius:8px;padding:16px;margin-bottom:20px}
  .email-meta-row{display:flex;gap:8px;font-size:.85rem;padding:3px 0}
  .email-meta-label{font-weight:600;color:#666;width:60px;flex-shrink:0}
  .email-body{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;font-size:.88rem;line-height:1.7;white-space:pre-wrap;word-break:break-word}
  /* metrics */
  .metric-big{font-size:2rem;font-weight:700;color:#1a1a2e;line-height:1}
  .metric-label{font-size:.78rem;color:#888;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
  .metric-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px;margin-bottom:20px}
  .metric-card{background:#f8f9fa;border-radius:8px;padding:16px}
  .warn-note{background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:10px 14px;font-size:.82rem;color:#92400e;margin-top:12px}
  td.num{text-align:right;font-family:monospace;color:#4f46e5;font-weight:600}
  td.err{text-align:right;font-family:monospace;color:#dc2626;font-weight:600}
  /* login */
  .login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f4f6f9}
  .login-card{background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1);padding:40px;width:100%;max-width:380px}
  .login-card h1{font-size:1.4rem;font-weight:700;margin-bottom:4px;color:#1a1a2e}
  .login-card p{color:#888;font-size:.88rem;margin-bottom:28px}
  label{display:block;font-size:.82rem;font-weight:600;color:#555;margin-bottom:4px}
  input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;outline:none;transition:border .15s}
  input:focus{border-color:#4f46e5}
  .field{margin-bottom:18px}
  button[type=submit]{width:100%;padding:11px;background:#1a1a2e;color:#fff;border:none;border-radius:6px;font-size:.95rem;font-weight:600;cursor:pointer}
  button[type=submit]:hover{background:#2d2d4e}
  .error-msg{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;padding:10px 14px;font-size:.85rem;margin-bottom:18px}
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Clawmail</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function topbar(extra = ""): string {
  return `<div class="topbar"><h1>Clawmail</h1><div style="display:flex;align-items:center;gap:20px"><span>${escHtml(config.domain)}</span>${extra}<a href="/dashboard/logout">Sign out</a></div></div>`;
}

function tabBar(active: string): string {
  const tabs = [
    { id: "overview",      label: "Overview",          href: "/dashboard" },
    { id: "inboxes",       label: "Inboxes",            href: "/dashboard?tab=inboxes" },
    { id: "metrics",       label: "Metrics",            href: "/dashboard?tab=metrics" },
    { id: "calendars",     label: "Calendars & Rules",  href: "/dashboard?tab=calendars" },
    { id: "integrations",  label: "⚙ Integrations",    href: "/dashboard?tab=integrations" },
  ];
  const links = tabs.map(t =>
    `<a href="${t.href}" class="${active === t.id ? "active" : ""}">${t.label}</a>`
  ).join("");
  return `<nav class="tab-bar">${links}</nav>`;
}

function loginPage(error?: string): string {
  const err = error ? `<div class="error-msg">${escHtml(error)}</div>` : "";
  return page("Login", `
    <div class="login-wrap">
      <div class="login-card">
        <h1>Clawmail</h1>
        <p>Sign in to the operator dashboard</p>
        ${err}
        <form method="POST" action="/dashboard/login">
          <div class="field"><label>Username</label><input type="text" name="user" autocomplete="username" required></div>
          <div class="field"><label>Password</label><input type="password" name="pass" autocomplete="current-password" required></div>
          <button type="submit">Sign in</button>
        </form>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Status check helpers (reused across tabs)
// ---------------------------------------------------------------------------

interface StatusItem {
  label: string;
  status: "ok" | "warn" | "fail" | "info";
  detail?: string;
}

interface StatusGroup {
  heading: string;
  items: StatusItem[];
}

const authHeader = () =>
  `Basic ${Buffer.from(`${config.stalwart.adminUser}:${config.stalwart.adminPassword}`).toString("base64")}`;

async function checkStalwartGroup(accountCount: number): Promise<StatusGroup> {
  const items: StatusItem[] = [];
  try {
    const res = await fetch(new URL("/api/principal", config.stalwart.url).toString(), {
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: authHeader() },
    });
    if (res.ok) {
      items.push({ label: "Management API", status: "ok", detail: config.stalwart.url });
    } else {
      const body = await res.text().catch(() => "");
      items.push({ label: "Management API", status: "warn", detail: `HTTP ${res.status} — ${body.slice(0, 120)}` });
    }
  } catch (e) {
    items.push({ label: "Management API", status: "fail", detail: String(e) });
  }
  try {
    const res = await fetch(new URL("/.well-known/jmap", config.stalwart.url).toString(), {
      signal: AbortSignal.timeout(4000),
      headers: { Authorization: authHeader(), Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json() as { apiUrl?: string };
      items.push({ label: "JMAP session", status: "ok", detail: data.apiUrl ?? "ok" });
    } else {
      items.push({ label: "JMAP session", status: "warn", detail: `HTTP ${res.status}` });
    }
  } catch (e) {
    items.push({ label: "JMAP session", status: "fail", detail: String(e) });
  }
  items.push({ label: "Active accounts", status: "info", detail: String(accountCount) });
  return { heading: "Stalwart Mail Server", items };
}

async function checkDnsGroup(): Promise<StatusGroup> {
  const { Resolver } = await import("node:dns/promises");
  const resolver = new Resolver();
  const items: StatusItem[] = [];
  try {
    const mx = await resolver.resolveMx(config.domain);
    if (mx.length > 0) {
      const top = mx.sort((a, b) => a.priority - b.priority)[0];
      items.push({ label: "MX record", status: "ok", detail: `${top.priority} ${top.exchange}` });
    } else {
      items.push({ label: "MX record", status: "warn", detail: "No records found" });
    }
  } catch (e) {
    items.push({ label: "MX record", status: "fail", detail: String(e) });
  }
  try {
    const txt = await resolver.resolveTxt(config.domain);
    const spf = txt.flat().find(r => r.startsWith("v=spf1"));
    items.push(spf
      ? { label: "SPF record", status: "ok", detail: spf.slice(0, 80) }
      : { label: "SPF record", status: "warn", detail: "Not found — outbound mail may be marked as spam" });
  } catch {
    items.push({ label: "SPF record", status: "warn", detail: "Lookup failed" });
  }
  try {
    const txt = await resolver.resolveTxt(`_dmarc.${config.domain}`);
    const dmarc = txt.flat().find(r => r.startsWith("v=DMARC1"));
    items.push(dmarc
      ? { label: "DMARC record", status: "ok", detail: dmarc.slice(0, 80) }
      : { label: "DMARC record", status: "warn", detail: "Not found — no DMARC policy set" });
  } catch {
    items.push({ label: "DMARC record", status: "warn", detail: "Not found — no DMARC policy set" });
  }
  return { heading: `DNS — ${config.domain}`, items };
}

function checkMcpServerGroup(): StatusGroup {
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  const upStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const mem = process.memoryUsage();
  const rss = `${Math.round(mem.rss / 1024 / 1024)} MB RSS / ${Math.round(mem.heapUsed / 1024 / 1024)} MB heap`;
  return {
    heading: "MCP Server (this process)",
    items: [
      { label: "Status", status: "ok", detail: "Running" },
      { label: "Node.js", status: "info", detail: process.version },
      { label: "Uptime", status: "info", detail: upStr },
      { label: "Memory", status: "info", detail: rss },
      { label: "API keys configured", status: config.auth.apiKeys.size > 0 ? "ok" : "warn", detail: config.auth.apiKeys.size > 0 ? `${config.auth.apiKeys.size} key(s)` : "No API keys — server is open" },
    ],
  };
}

function checkSendgridGroup(): StatusGroup {
  const hasKey = !!config.sendgrid.apiKey;
  const masked = config.sendgrid.apiKey.length > 10
    ? config.sendgrid.apiKey.slice(0, 6) + "••••••" + config.sendgrid.apiKey.slice(-4)
    : "not set";
  return {
    heading: "SendGrid Relay",
    items: [
      { label: "API key", status: hasKey ? "ok" : "fail", detail: hasKey ? masked : "SENDGRID_API_KEY not set" },
      { label: "Verified sender (FROM)", status: "info", detail: config.sendgrid.verifiedSender },
      { label: "SMTP host", status: "info", detail: "smtp.sendgrid.net:587" },
    ],
  };
}

function statusRow(item: StatusItem, indent = false): string {
  const badge = item.status !== "info"
    ? `<span class="badge ${item.status}">${item.status.toUpperCase()}</span>`
    : `<span style="font-size:.75rem;color:#888">${escHtml(item.detail ?? "")}</span>`;
  const labelDetail = item.status !== "info" && item.detail
    ? `<span class="row-detail">${escHtml(item.detail)}</span>` : "";
  return `<div class="status-row" style="${indent ? "padding-left:20px" : ""}"><div class="dot ${item.status}"></div><span class="label">${escHtml(item.label)}${labelDetail}</span>${badge}</div>`;
}

function statusGroup(group: StatusGroup): string {
  return `<div class="status-group"><div class="group-heading">${escHtml(group.heading)}</div>${group.items.map(i => statusRow(i, true)).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Tab: Overview
// ---------------------------------------------------------------------------

async function buildOverview(serviceUrl: string, accounts: Array<{ email: string; name: string }>): Promise<string> {
  const [stalwartG, dnsG] = await Promise.all([checkStalwartGroup(accounts.length), checkDnsGroup()]);
  const mcpG = checkMcpServerGroup();
  const sgG = checkSendgridGroup();

  const mcpUrl = `${serviceUrl}/mcp`;
  const allKeys = [...config.auth.apiKeys];
  const firstKey = allKeys[0] ?? "";

  const snippet = JSON.stringify({ mcpServers: { clawmail: { type: "http", url: mcpUrl, headers: { "X-API-Key": firstKey || "(no API key configured)" } } } }, null, 2);

  return `
    <div class="card">
      <h2>Connect your agent</h2>
      <p style="font-size:.85rem;color:#666;margin-bottom:14px">Paste this into your <code>mcp.json</code> or Claude Desktop config:</p>
      <div class="code-block">${escHtml(snippet)}</div>
      ${allKeys.length > 1 ? `<div style="margin-top:14px"><p style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:8px">All API keys (${allKeys.length})</p>${allKeys.map(k => `<div class="key-row" style="margin-bottom:6px"><span style="font-family:monospace;font-size:.82rem">${escHtml(k)}</span></div>`).join("")}</div>` : ""}
      ${allKeys.length === 0 ? `<p style="font-size:.82rem;color:#dc2626;margin-top:10px">No API keys configured — set MCP_API_KEYS env var.</p>` : ""}
    </div>
    <div class="card">
      <h2>System status</h2>
      ${statusGroup(mcpG)}${statusGroup(stalwartG)}${statusGroup(dnsG)}${statusGroup(sgG)}
    </div>
    <div class="card" style="display:flex;align-items:center;gap:24px">
      <div>
        <div style="font-size:3rem;font-weight:700;color:#1a1a2e;line-height:1">${accounts.length}</div>
        <div style="font-size:.8rem;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-top:4px">Active accounts</div>
      </div>
      <div style="flex:1">
        ${accounts.length === 0
          ? `<p style="color:#999;font-size:.85rem">No accounts yet — use the <code>create_account</code> MCP tool to provision one.</p>`
          : `<p style="color:#666;font-size:.85rem">Manage inboxes and browse emails in the <a href="/dashboard?tab=inboxes" style="color:#4f46e5">Inboxes</a> tab.</p>`}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Tab: Inboxes
// ---------------------------------------------------------------------------

async function buildInboxesTab(accounts: Array<{ email: string; name: string }>): Promise<string> {
  // Fetch inbox + sent counts for all accounts in parallel (capped at 50).
  const capped = accounts.slice(0, 50);
  const [inboxCounts, sentCounts] = await Promise.all([
    Promise.allSettled(
      capped.map(async (a) => {
        const count = await new JmapClient(a.email).countEmails("Inbox");
        return { email: a.email, count };
      })
    ),
    Promise.allSettled(
      capped.map(async (a) => {
        const count = await new JmapClient(a.email).countEmails("Sent");
        return { email: a.email, count };
      })
    ),
  ]);
  const countMap = new Map<string, number>();
  for (const r of inboxCounts) {
    if (r.status === "fulfilled") countMap.set(r.value.email, r.value.count);
  }
  const sentCountMap = new Map<string, number>();
  for (const r of sentCounts) {
    if (r.status === "fulfilled") sentCountMap.set(r.value.email, r.value.count);
  }

  // Test email form (shown first)
  const fromOptions = accounts.map(a =>
    `<option value="${escHtml(a.email)}">${escHtml(a.email)}</option>`
  ).join("");

  const testEmailForm = `
    <div class="card">
      <h2>Send test email</h2>
      <p style="font-size:.83rem;color:#666;margin-bottom:18px">Verify the send pipeline end-to-end.</p>
      <form method="POST" action="/dashboard/action/send-test-email" style="display:grid;gap:14px;max-width:520px">
        <div>
          <label>From account</label>
          ${accounts.length > 0
            ? `<select name="from" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff">${fromOptions}</select>`
            : `<input type="text" name="from" placeholder="agent@${escHtml(config.domain)}" required>`}
        </div>
        <div><label>To</label><input type="text" name="to" placeholder="recipient@example.com" required></div>
        <div><label>Subject</label><input type="text" name="subject" value="Test email from Clawmail" required></div>
        <div>
          <label>Body</label>
          <textarea name="body" rows="3" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.88rem;resize:vertical">Hello — this is a test email sent from the Clawmail dashboard.\n\nIf you received this, the send pipeline is working correctly.</textarea>
        </div>
        <div>
          <button type="submit" class="btn btn-primary" style="padding:9px 22px;font-size:.88rem">Send →</button>
        </div>
      </form>
    </div>`;

  // Account list (shown second)
  const accountList = accounts.length === 0
    ? `<div class="card"><h2>Agent accounts</h2><p class="empty">No accounts yet — use the <code>create_account</code> MCP tool to create one.</p></div>`
    : (() => {
        const rows = accounts.map((a, i) => {
          const ts = getAccountCreatedAt(a.email);
          const createdStr = ts
            ? new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
            : `<span style="color:#ccc">—</span>`;
          const received = countMap.has(a.email) ? String(countMap.get(a.email)) : `<span style="color:#ccc">—</span>`;
          const sentVal = sentCountMap.get(a.email);
          const sent = sentVal !== undefined ? String(sentVal) : `<span style="color:#ccc">—</span>`;
          return `
            <tr>
              <td style="color:#aaa;font-size:.78rem;width:28px;text-align:right;padding-right:12px">${i + 1}</td>
              <td><span style="font-weight:600;color:#1a1a2e">${escHtml(a.email)}</span></td>
              <td style="color:#888;font-size:.82rem;white-space:nowrap">${createdStr}</td>
              <td class="num">${sent}</td>
              <td class="num">${received}</td>
              <td style="width:120px;text-align:right">
                <a class="btn btn-primary" href="/dashboard/inbox?a=${encodeURIComponent(a.email)}" style="font-size:.78rem;padding:4px 12px">View inbox →</a>
              </td>
            </tr>`;
        }).join("");
        const cappedNote = accounts.length > 50
          ? `<p style="font-size:.72rem;color:#aaa;margin-top:8px">Inbox counts shown for first 50 of ${accounts.length} accounts.</p>`
          : "";
        return `
          <div class="card">
            <h2>Agent accounts (${accounts.length})</h2>
            <table>
              <thead>
                <tr>
                  <th style="width:28px"></th>
                  <th>Email address</th>
                  <th>Created</th>
                  <th style="text-align:right">Sent</th>
                  <th style="text-align:right">In inbox</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <p style="font-size:.72rem;color:#bbb;margin-top:10px">Created time only recorded for accounts provisioned during this server session.</p>
            ${cappedNote}
          </div>`;
      })();

  return testEmailForm + accountList;
}

// ---------------------------------------------------------------------------
// Tab: Metrics
// ---------------------------------------------------------------------------

async function buildMetricsTab(accounts: Array<{ email: string; name: string }>): Promise<string> {
  const m = getMetrics();
  const mcpG = checkMcpServerGroup();

  // Per-account email counts (capped at 20 to avoid overloading)
  const capped = accounts.slice(0, 20);
  const countResults = await Promise.allSettled(
    capped.map(async a => {
      const client = new JmapClient(a.email);
      const count = await client.countEmails("Inbox");
      return { email: a.email, count };
    })
  );
  const emailCounts = countResults.map((r, i) =>
    r.status === "fulfilled" ? r.value : { email: capped[i].email, count: -1 }
  );
  const totalEmails = emailCounts.reduce((s, c) => s + Math.max(0, c.count), 0);
  setInboxTotal(totalEmails); // keep the time-series sampler up to date

  // Process health mini-cards
  const uptimeSec = Math.floor(process.uptime());
  const h = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const mem = process.memoryUsage();

  const procCards = `
    <div class="metric-card"><div class="metric-big">${h > 0 ? `${h}h ${mins}m` : `${mins}m`}</div><div class="metric-label">Uptime</div></div>
    <div class="metric-card"><div class="metric-big">${Math.round(mem.rss / 1024 / 1024)}<span style="font-size:1rem;font-weight:400">MB</span></div><div class="metric-label">RSS Memory</div></div>
    <div class="metric-card"><div class="metric-big">${accounts.length}</div><div class="metric-label">Total accounts</div></div>
    <div class="metric-card"><div class="metric-big">${totalEmails}</div><div class="metric-label">Emails in inboxes${accounts.length > 20 ? " (top 20)" : ""}</div></div>
    <div class="metric-card"><div class="metric-big">${m.totalRequests}</div><div class="metric-label">MCP requests</div></div>
    <div class="metric-card"><div class="metric-big" style="color:${m.totalErrors > 0 ? "#dc2626" : "#22c55e"}">${m.totalErrors}</div><div class="metric-label">Total errors</div></div>
  `;

  // Tool breakdown table
  const TOOLS = ["create_account", "list_accounts", "delete_account", "list_emails", "read_email", "delete_email", "search_emails", "send_email"];
  const toolRows = TOOLS.map(tool => {
    const t = m.tools[tool] ?? { calls: 0, errors: 0, rateLimitHits: 0, lastCalledAt: null };
    const errRate = t.calls > 0 ? `${((t.errors / t.calls) * 100).toFixed(1)}%` : "—";
    const last = t.lastCalledAt ? new Date(t.lastCalledAt).toLocaleTimeString() : "—";
    return `<tr>
      <td><code>${escHtml(tool)}</code></td>
      <td class="num">${t.calls}</td>
      <td class="err">${t.errors}</td>
      <td style="text-align:right;font-family:monospace;color:${t.errors > 0 ? "#dc2626" : "#666"}">${errRate}</td>
      <td style="text-align:right;font-family:monospace;color:#f59e0b">${t.rateLimitHits}</td>
      <td style="text-align:right;color:#888;font-size:.82rem">${last}</td>
    </tr>`;
  }).join("");

  const startedAt = new Date(m.startedAt).toLocaleString();

  // Compact status summary
  const stalwartOk = await (async () => {
    try {
      const res = await fetch(new URL("/api/principal", config.stalwart.url).toString(), { signal: AbortSignal.timeout(3000), headers: { Authorization: authHeader() } });
      return res.ok;
    } catch { return false; }
  })();

  const inboxCountRows = emailCounts.map(c =>
    `<tr><td>${escHtml(c.email)}</td><td class="num">${c.count >= 0 ? c.count : "—"}</td></tr>`
  ).join("");

  return `
    <div class="card">
      <h2>System snapshot</h2>
      <div class="metric-grid">${procCards}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <span>MCP Server <span class="pill green">Online</span></span>
        <span>Stalwart <span class="pill ${stalwartOk ? "green" : "red"}">${stalwartOk ? "Online" : "Unreachable"}</span></span>
        <span>Node.js <span class="pill">${process.version}</span></span>
      </div>
    </div>

    <div class="card">
      <h2>Activity over time</h2>
      <p style="font-size:.78rem;color:#888;margin-bottom:16px">Sampled every 60 s — cumulative since process start. Hover for values.</p>
      <div style="position:relative;height:240px"><canvas id="chart-traffic"></canvas></div>
      <div style="margin-top:28px">
        <p style="font-size:.78rem;font-weight:600;color:#555;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px">Errors per sample interval</p>
        <div style="position:relative;height:140px"><canvas id="chart-errors"></canvas></div>
      </div>
      <div class="warn-note" style="margin-top:16px">⚠ Counters reset on instance restart. Sampling since: ${escHtml(startedAt)}</div>
    </div>

    <div class="card">
      <h2>MCP tool call breakdown</h2>
      <table>
        <thead><tr><th>Tool</th><th style="text-align:right">Calls</th><th style="text-align:right">Errors</th><th style="text-align:right">Error rate</th><th style="text-align:right">Rate limit hits</th><th style="text-align:right">Last called</th></tr></thead>
        <tbody>${toolRows}</tbody>
        <tfoot><tr style="background:#f8f9fa;font-weight:600">
          <td>Total</td>
          <td class="num">${m.totalRequests}</td>
          <td class="err">${m.totalErrors}</td>
          <td style="text-align:right;font-family:monospace">${m.totalRequests > 0 ? `${((m.totalErrors / m.totalRequests) * 100).toFixed(1)}%` : "—"}</td>
          <td style="text-align:right;font-family:monospace;color:#f59e0b">${m.totalRateLimitHits}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>

    <div class="card">
      <h2>Inbox sizes${accounts.length > 20 ? " (top 20 accounts)" : ""}</h2>
      <table>
        <thead><tr><th>Account</th><th style="text-align:right">Emails in inbox</th></tr></thead>
        <tbody>${inboxCountRows || `<tr><td colspan="2" class="empty">No accounts</td></tr>`}</tbody>
      </table>
      ${accounts.length > 20 ? `<p style="font-size:.78rem;color:#888;margin-top:8px">Showing first 20 of ${accounts.length} accounts.</p>` : ""}
    </div>

    <div class="card">
      <h2>Component status</h2>
      ${statusGroup(checkMcpServerGroup())}
      ${statusGroup(checkSendgridGroup())}
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script>
    (function() {
      fetch('/dashboard/metrics-data', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var s = data.samples;
          if (!s || s.length === 0) return;

          var labels = s.map(function(p) {
            return new Date(p.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          });

          // Plot 1 — Sent vs Received emails over time
          // sendEmailCalls = cumulative emails sent via MCP tool
          // inboxTotal     = absolute total emails across all inboxes (received proxy)
          new Chart(document.getElementById('chart-traffic'), {
            type: 'line',
            data: {
              labels: labels,
              datasets: [
                {
                  label: 'Emails sent (cumulative)',
                  data: s.map(function(p) { return p.sendEmailCalls; }),
                  borderColor: '#4f46e5',
                  backgroundColor: 'rgba(79,70,229,0.07)',
                  fill: true,
                  tension: 0.35,
                  pointRadius: 3,
                  pointHoverRadius: 6,
                },
                {
                  label: 'Emails in inboxes (received)',
                  data: s.map(function(p) { return p.inboxTotal; }),
                  borderColor: '#22c55e',
                  backgroundColor: 'rgba(34,197,94,0.07)',
                  fill: true,
                  tension: 0.35,
                  pointRadius: 3,
                  pointHoverRadius: 6,
                },
              ]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } },
                tooltip: {
                  enabled: true,
                  callbacks: {
                    label: function(ctx) { return ' ' + ctx.dataset.label + ': ' + ctx.parsed.y; }
                  }
                }
              },
              scales: {
                y: { beginAtZero: true, ticks: { precision: 0 } }
              }
            }
          });

          // Plot 2 — Errors per sample interval (bar)
          var errDeltas = s.map(function(p, i) {
            return i === 0 ? p.totalErrors : Math.max(0, p.totalErrors - s[i - 1].totalErrors);
          });

          new Chart(document.getElementById('chart-errors'), {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{
                label: 'Errors in interval',
                data: errDeltas,
                backgroundColor: 'rgba(239,68,68,0.60)',
                borderColor: '#ef4444',
                borderWidth: 1,
                borderRadius: 3,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  enabled: true,
                  callbacks: {
                    title: function(items) { return items[0].label; },
                    label: function(ctx) { return ' Errors: ' + ctx.parsed.y; }
                  }
                }
              },
              scales: {
                y: { beginAtZero: true, ticks: { precision: 0 } }
              }
            }
          });
        })
        .catch(function() { /* chart stays blank if fetch fails */ });
    })();
    </script>
  `;
}

// ---------------------------------------------------------------------------
// Calendars & Rules helpers
// ---------------------------------------------------------------------------

function formatCondition(cond: RuleCondition): string {
  const parts: string[] = [];
  if (cond.from !== undefined)             parts.push(`<span class="pill blue">from: ${escHtml(cond.from)}</span>`);
  if (cond.subject !== undefined)          parts.push(`<span class="pill blue">subject: ${escHtml(cond.subject)}</span>`);
  if (cond.hasAttachment !== undefined)    parts.push(`<span class="pill blue">${cond.hasAttachment ? "has attachment" : "no attachment"}</span>`);
  if (cond.olderThanDays !== undefined)    parts.push(`<span class="pill blue">older than ${cond.olderThanDays}d</span>`);
  return parts.join(" ") || `<span class="pill gray">any</span>`;
}

function formatAction(act: RuleAction): string {
  const parts: string[] = [];
  if (act.moveTo !== undefined)  parts.push(`<span class="pill green">→ ${escHtml(act.moveTo)}</span>`);
  if (act.markRead)              parts.push(`<span class="pill amber">mark read</span>`);
  if (act.delete)                parts.push(`<span class="pill red">delete</span>`);
  return parts.join(" ") || `<span class="pill gray">none</span>`;
}

function formatEventBadge(start: string): string {
  return new Date(start).getTime() > Date.now()
    ? `<span class="badge ok">upcoming</span>`
    : `<span style="background:#e5e7eb;color:#6b7280;font-size:.75rem;font-weight:600;padding:2px 8px;border-radius:12px">past</span>`;
}

function formatDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return escHtml(iso); }
}

/** Synchronous folder tab bar — pass pre-fetched mailboxes. Hides system mailboxes (name starts with _). */
function buildFolderTabBar(
  account: string,
  mailboxes: Array<{ name: string; role: string; totalEmails: number }>,
  activeFolder: string,
): string {
  const FOLDER_ORDER: Record<string, number> = { inbox: 0, sent: 1, drafts: 2, trash: 3, spam: 4 };
  const visible = mailboxes
    .filter(mb => !mb.name.startsWith("_"))
    .sort((a, b) => {
      const ra = FOLDER_ORDER[a.role] ?? 9;
      const rb = FOLDER_ORDER[b.role] ?? 9;
      return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
    });

  const folderLinks = visible.map(mb => {
    const isActive = mb.name.toLowerCase() === activeFolder.toLowerCase();
    const badge = mb.totalEmails > 0
      ? ` <span style="background:${isActive ? "rgba(255,255,255,0.3)" : "#e5e7eb"};color:${isActive ? "#fff" : "#444"};border-radius:10px;padding:1px 6px;font-size:.72rem">${mb.totalEmails}</span>`
      : "";
    return `<a href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=${encodeURIComponent(mb.name)}"
      style="display:inline-block;padding:5px 12px;border-radius:20px;font-size:.82rem;font-weight:${isActive ? "600" : "500"};text-decoration:none;${isActive ? "background:#4f46e5;color:#fff" : "background:#f1f3f5;color:#555"}">${escHtml(mb.name)}${badge}</a>`;
  }).join("");

  const calActive = activeFolder === "__calendar";
  const rulesActive = activeFolder === "__rules";

  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:18px">
      ${folderLinks}
      <span style="display:inline-block;width:1px;background:#e5e7eb;height:20px;margin:0 2px;align-self:center"></span>
      <a href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=__calendar"
        style="display:inline-block;padding:5px 12px;border-radius:20px;font-size:.82rem;font-weight:${calActive ? "600" : "500"};text-decoration:none;${calActive ? "background:#4f46e5;color:#fff" : "background:#f1f3f5;color:#555"}">📅 Calendar</a>
      <a href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=__rules"
        style="display:inline-block;padding:5px 12px;border-radius:20px;font-size:.82rem;font-weight:${rulesActive ? "600" : "500"};text-decoration:none;${rulesActive ? "background:#4f46e5;color:#fff" : "background:#f1f3f5;color:#555"}">⚙️ Rules</a>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tab: Calendars & Rules (account list → click into per-account view)
// ---------------------------------------------------------------------------

async function buildCalendarsTab(accounts: Array<{ email: string; name: string }>): Promise<string> {
  if (accounts.length === 0) {
    return `<div class="card"><h2>Calendars &amp; Rules</h2><p class="empty">No accounts yet — use the <code>create_account</code> MCP tool to create one.</p></div>`;
  }

  const capped = accounts.slice(0, 50);

  // Fetch event + rule counts for every account in parallel
  const [eventResults, ruleResults] = await Promise.all([
    Promise.allSettled(capped.map(async (a) => {
      const { events } = await toolListEvents({ account: a.email });
      return { email: a.email, events };
    })),
    Promise.allSettled(capped.map(async (a) => {
      const { count } = await toolListRules({ account: a.email });
      return { email: a.email, count };
    })),
  ]);

  const eventMap = new Map<string, CalendarEvent[]>();
  for (const r of eventResults) {
    if (r.status === "fulfilled") eventMap.set(r.value.email, r.value.events);
  }
  const ruleCountMap = new Map<string, number>();
  for (const r of ruleResults) {
    if (r.status === "fulfilled") ruleCountMap.set(r.value.email, r.value.count);
  }

  const rows = capped.map((a, i) => {
    const events = eventMap.get(a.email) ?? [];
    const ruleCount = ruleCountMap.get(a.email) ?? 0;
    const upcoming = events.filter(e => new Date(e.start).getTime() > Date.now());
    const nextEvent = upcoming.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0];
    const nextStr = nextEvent
      ? `<span style="font-weight:500">${escHtml(nextEvent.title)}</span> <span style="color:#888;font-size:.8rem">${formatDateShort(nextEvent.start)}</span>`
      : `<span style="color:#ccc;font-size:.82rem">—</span>`;
    const evBadge = events.length > 0
      ? `<span style="font-weight:600;color:#4f46e5">${events.length}</span><span style="color:#aaa;font-size:.78rem"> (${upcoming.length} upcoming)</span>`
      : `<span style="color:#ccc">0</span>`;
    const ruleBadge = ruleCount > 0
      ? `<span style="font-weight:600;color:#4f46e5">${ruleCount}</span>`
      : `<span style="color:#ccc">0</span>`;

    return `<tr>
      <td style="color:#aaa;font-size:.78rem;width:28px;text-align:right;padding-right:12px">${i + 1}</td>
      <td><span style="font-weight:600;color:#1a1a2e">${escHtml(a.email)}</span></td>
      <td>${evBadge}</td>
      <td>${nextStr}</td>
      <td>${ruleBadge}</td>
      <td style="text-align:right;white-space:nowrap">
        <a class="btn btn-primary" href="/dashboard/inbox?a=${encodeURIComponent(a.email)}&folder=__calendar" style="font-size:.78rem;padding:4px 10px;margin-right:4px">📅 Calendar</a>
        <a class="btn" href="/dashboard/inbox?a=${encodeURIComponent(a.email)}&folder=__rules" style="font-size:.78rem;padding:4px 10px;background:#f1f5f9;color:#475569">⚙️ Rules</a>
      </td>
    </tr>`;
  }).join("");

  const cappedNote = accounts.length > 50
    ? `<p style="font-size:.72rem;color:#aaa;margin-top:8px">Showing first 50 of ${accounts.length} accounts.</p>`
    : "";

  return `
    <div class="card">
      <h2>Agent accounts — calendars &amp; rules (${accounts.length})</h2>
      <table>
        <thead><tr>
          <th style="width:28px"></th>
          <th>Email address</th>
          <th>Events</th>
          <th>Next event</th>
          <th>Rules</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${cappedNote}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Sub-page: Account calendar
// ---------------------------------------------------------------------------

async function buildAccountCalendarPage(account: string): Promise<string> {
  const client = new JmapClient(account);
  const [eventsResult, mailboxesResult] = await Promise.allSettled([
    toolListEvents({ account }),
    client.listMailboxes(),
  ]);

  const events = eventsResult.status === "fulfilled" ? eventsResult.value.events : [];
  const fetchError = eventsResult.status === "rejected" ? String(eventsResult.reason) : null;
  const mailboxes = mailboxesResult.status === "fulfilled" ? mailboxesResult.value : [];

  const rows = fetchError
    ? `<tr><td colspan="5" style="color:#dc2626;padding:16px">Failed to load events: ${escHtml(fetchError)}</td></tr>`
    : events.length === 0
    ? `<tr><td colspan="5" class="empty" style="padding:32px;text-align:center">
        <div style="font-size:1.2rem;margin-bottom:8px">📅</div>
        <div style="font-weight:600">No calendar events</div>
        <div style="font-size:.82rem;color:#bbb;margin-top:4px">Use the <code>create_event</code> MCP tool to schedule events.</div>
      </td></tr>`
    : events.map(ev => {
        const desc = ev.description ? `<span class="row-detail">${escHtml(ev.description.slice(0, 80))}${ev.description.length > 80 ? "…" : ""}</span>` : "";
        const attendees = ev.attendees?.length
          ? `<span style="font-size:.78rem;color:#888">${ev.attendees.map(escHtml).join(", ")}</span>`
          : `<span style="color:#ccc;font-size:.78rem">—</span>`;
        return `<tr>
          <td>${escHtml(ev.title)}${desc}</td>
          <td style="white-space:nowrap;color:#555;font-size:.83rem">${formatDateShort(ev.start)}</td>
          <td style="white-space:nowrap;color:#555;font-size:.83rem">${formatDateShort(ev.end)}</td>
          <td>${attendees}</td>
          <td>${formatEventBadge(ev.start)}</td>
        </tr>`;
      }).join("");

  return page(`Calendar — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <div>
        <a class="back-link" href="/dashboard?tab=inboxes">← All accounts</a>
        <div class="page-title">${escHtml(account)}</div>
        <div class="page-sub">Calendar — ${events.length} event${events.length !== 1 ? "s" : ""}</div>
      </div>
      <div class="card" style="padding:20px 20px 0">
        ${buildFolderTabBar(account, mailboxes, "__calendar")}
        <div style="margin:0 -20px">
          <table>
            <thead><tr>
              <th style="padding-left:20px">Title</th>
              <th>Start</th>
              <th>End</th>
              <th>Attendees</th>
              <th>Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="height:16px"></div>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Sub-page: Account rules
// ---------------------------------------------------------------------------

async function buildAccountRulesPage(account: string): Promise<string> {
  const client = new JmapClient(account);
  const [rulesResult, mailboxesResult] = await Promise.allSettled([
    toolListRules({ account }),
    client.listMailboxes(),
  ]);

  const rules = rulesResult.status === "fulfilled" ? rulesResult.value.rules : [];
  const fetchError = rulesResult.status === "rejected" ? String(rulesResult.reason) : null;
  const mailboxes = mailboxesResult.status === "fulfilled" ? mailboxesResult.value : [];

  const rows = fetchError
    ? `<tr><td colspan="4" style="color:#dc2626;padding:16px">Failed to load rules: ${escHtml(fetchError)}</td></tr>`
    : rules.length === 0
    ? `<tr><td colspan="4" class="empty" style="padding:32px;text-align:center">
        <div style="font-size:1.2rem;margin-bottom:8px">⚙️</div>
        <div style="font-weight:600">No rules configured</div>
        <div style="font-size:.82rem;color:#bbb;margin-top:4px">Use the <code>create_rule</code> MCP tool to automate your inbox.</div>
      </td></tr>`
    : rules.map(rule => {
        const created = formatDateShort(rule.createdAt);
        return `<tr>
          <td style="font-weight:500">${escHtml(rule.name)}</td>
          <td>${formatCondition(rule.condition)}</td>
          <td>${formatAction(rule.action)}</td>
          <td style="white-space:nowrap;color:#888;font-size:.81rem">${escHtml(created)}</td>
        </tr>`;
      }).join("");

  return page(`Rules — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <div>
        <a class="back-link" href="/dashboard?tab=inboxes">← All accounts</a>
        <div class="page-title">${escHtml(account)}</div>
        <div class="page-sub">Rules — ${rules.length} active</div>
      </div>
      <div class="card" style="padding:20px 20px 0">
        ${buildFolderTabBar(account, mailboxes, "__rules")}
        <div style="margin:0 -20px">
          <table>
            <thead><tr>
              <th style="padding-left:20px">Rule name</th>
              <th>Condition</th>
              <th>Action</th>
              <th>Created</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="height:16px"></div>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Sub-page: Account inbox
// ---------------------------------------------------------------------------

async function buildInboxPage(account: string, folder = "Inbox"): Promise<string> {
  // Pseudo-folder interception for calendar and rules views
  if (folder === "__calendar") return buildAccountCalendarPage(account);
  if (folder === "__rules")    return buildAccountRulesPage(account);

  const client = new JmapClient(account);

  // Fetch mailboxes and emails in parallel
  const [mailboxesResult, emailsResult] = await Promise.allSettled([
    client.listMailboxes(),
    toolListEmails(account, folder, 50),
  ]);

  const mailboxes = mailboxesResult.status === "fulfilled" ? mailboxesResult.value : [];
  const emails = emailsResult.status === "fulfilled" ? emailsResult.value.emails : [];
  const emailsError = emailsResult.status === "rejected" ? String(emailsResult.reason) : null;

  const totalAcrossAll = mailboxes.filter(mb => !mb.name.startsWith("_")).reduce((s, m) => s + m.totalEmails, 0);

  // Folder tabs (reuses buildFolderTabBar — hides system mailboxes, appends Calendar + Rules)
  const folderTabs = buildFolderTabBar(account, mailboxes, folder);

  // Email rows
  const rows = emailsError
    ? `<tr><td colspan="3" style="padding:20px;color:#dc2626">Failed to load emails: ${escHtml(emailsError)}</td></tr>`
    : emails.length === 0
    ? `<tr><td colspan="3" class="empty" style="padding:28px;text-align:center">
        <div style="font-size:1.1rem;margin-bottom:8px">📭</div>
        <div style="font-weight:600;margin-bottom:4px">No emails in ${escHtml(folder)}</div>
        ${totalAcrossAll === 0
          ? `<div style="font-size:.82rem;color:#bbb;margin-top:4px">No emails found anywhere in this account — check that inbound delivery is working.</div>`
          : `<div style="font-size:.82rem;color:#888">This folder is empty. ${totalAcrossAll} email${totalAcrossAll !== 1 ? "s" : ""} exist in other folders — check the tabs above.</div>`}
      </td></tr>`
    : emails.map(e => {
        const date = new Date(e.receivedAt).toLocaleString();
        const attach = e.hasAttachment ? `<span class="attach-icon" title="Has attachment">📎 </span>` : "";
        return `<tr>
          <td>${attach}<a class="subject-link" href="/dashboard/email?a=${encodeURIComponent(account)}&id=${encodeURIComponent(e.id)}&folder=${encodeURIComponent(folder)}">${escHtml(e.subject)}</a>
            <br><span style="font-size:.75rem;color:#aaa">${escHtml(e.preview.slice(0, 90))}</span></td>
          <td style="white-space:nowrap;color:#666;font-size:.83rem;max-width:180px;overflow:hidden;text-overflow:ellipsis">${escHtml(e.from)}</td>
          <td style="white-space:nowrap;color:#999;font-size:.81rem">${escHtml(date)}</td>
        </tr>`;
      }).join("");

  const folderLabel = emailsResult.status === "fulfilled" ? `${escHtml(folder)} — ${emails.length} email${emails.length !== 1 ? "s" : ""}` : escHtml(folder);

  return page(`${folder} — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <div>
        <a class="back-link" href="/dashboard?tab=inboxes">← All accounts</a>
        <div class="page-title">${escHtml(account)}</div>
        <div class="page-sub">${folderLabel}</div>
      </div>
      <div class="card" style="padding:20px 20px 0">
        ${folderTabs}
        <div style="margin:0 -20px">
          <table>
            <thead><tr><th style="padding-left:20px">Subject</th><th>From</th><th>Received</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Sub-page: Email detail
// ---------------------------------------------------------------------------

async function buildEmailPage(account: string, emailId: string, folder = "Inbox"): Promise<string> {
  const email = await toolReadEmail(account, emailId);
  const date = new Date(email.receivedAt).toLocaleString();
  const body = email.textBody ?? email.htmlBody ?? "(no body)";
  const isHtml = !email.textBody && !!email.htmlBody;

  const bodyHtml = isHtml
    ? `<iframe srcdoc="${escHtml(body)}" sandbox="allow-same-origin" style="width:100%;min-height:400px;border:none;border-radius:8px" title="Email body"></iframe>`
    : `<div class="email-body">${escHtml(body)}</div>`;

  return page(`${email.subject} — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <div>
        <a class="back-link" href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=${encodeURIComponent(folder)}">← Back to ${escHtml(folder)}</a>
      </div>
      <div class="card">
        <div class="email-meta">
          <div class="email-meta-row"><span class="email-meta-label">Subject</span><span style="font-weight:600">${escHtml(email.subject)}</span></div>
          <div class="email-meta-row"><span class="email-meta-label">From</span><span>${escHtml(email.from)}</span></div>
          <div class="email-meta-row"><span class="email-meta-label">To</span><span>${escHtml(email.to.join(", "))}</span></div>
          <div class="email-meta-row"><span class="email-meta-label">Date</span><span>${escHtml(date)}</span></div>
          ${email.hasAttachment ? `<div class="email-meta-row"><span class="email-meta-label">Attach</span><span class="attach-icon">📎 Has attachment</span></div>` : ""}
        </div>
        ${bodyHtml}
        <div style="margin-top:20px">
          <form method="POST" action="/dashboard/action/delete-email" style="display:inline">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <button type="submit" class="btn btn-danger" onclick="return confirm('Move to Trash?')">🗑 Move to Trash</button>
          </form>
        </div>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Integrations page — Google Meet OAuth setup + Daily.co key setup
// ---------------------------------------------------------------------------

function encodeOAuthState(clientId: string, clientSecret: string): string {
  const data = Buffer.from(JSON.stringify({ clientId, clientSecret, ts: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", effectivePassword()).update(data).digest("hex").slice(0, 20);
  return `${data}.${sig}`;
}

function decodeOAuthState(state: string): { clientId: string; clientSecret: string } | null {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;
  const data = state.slice(0, dot);
  const sig  = state.slice(dot + 1);
  const expected = createHmac("sha256", effectivePassword()).update(data).digest("hex").slice(0, 20);
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString());
    if (Date.now() - parsed.ts > 15 * 60 * 1000) return null; // 15-min expiry
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch { return null; }
}

function buildIntegrationsPage(serviceUrl: string, flash?: { type: "ok" | "err"; msg: string }): string {
  const dailyConfigured  = config.daily.apiKey.length > 0;
  const meetConfigured   = config.googleMeet.refreshToken.length > 0;
  const meetCredsStored  = config.googleMeet.clientId.length > 0 && config.googleMeet.clientSecret.length > 0;

  const flashHtml = flash
    ? `<div style="margin-bottom:20px;padding:12px 16px;border-radius:8px;font-size:.88rem;font-weight:500;${flash.type === "ok" ? "background:#dcfce7;color:#166534;border:1px solid #86efac" : "background:#fee2e2;color:#991b1b;border:1px solid #fca5a5"}">${flash.type === "ok" ? "✓" : "✗"} ${escHtml(flash.msg)}</div>`
    : "";

  // ── Daily.co card ───────────────────────────────────────────────────────────
  const dailyStatus = dailyConfigured
    ? `<span class="badge ok">Connected</span>`
    : `<span class="badge" style="background:#94a3b8">Not configured</span>`;

  const maskedKey = dailyConfigured
    ? `••••••••${config.daily.apiKey.slice(-6)}`
    : "";

  const dailyCard = `
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <h2 style="margin-bottom:4px">Daily.co</h2>
          <div style="font-size:.82rem;color:#888">Instant video rooms — works without any Google account</div>
        </div>
        ${dailyStatus}
      </div>
      ${dailyConfigured ? `
        <div style="display:flex;align-items:center;gap:12px;background:#f8fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:16px">
          <span style="font-family:monospace;color:#555">${escHtml(maskedKey)}</span>
          <span class="pill green" style="font-size:.75rem">Active</span>
        </div>` : ""}
      <div style="background:#f8fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
        <div style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:12px">${dailyConfigured ? "Update API key" : "Setup (free tier available at daily.co)"}</div>
        <ol style="font-size:.83rem;color:#555;padding-left:18px;line-height:2">
          <li>Sign up at <strong>daily.co</strong> → Settings → Developers → API keys → Create key</li>
          <li>Run the commands below to store it:</li>
        </ol>
        <div class="code-block" style="margin-top:12px;font-size:.78rem">echo -n "YOUR_DAILY_API_KEY" | gcloud secrets ${dailyConfigured ? "versions add" : "create daily-api-key --data-file"} - --project=${escHtml(process.env.GOOGLE_CLOUD_PROJECT ?? "YOUR_PROJECT")}
<br>
gcloud run services update clawmail-mcp \\
&nbsp; --region us-west1 \\
&nbsp; --update-secrets=DAILY_API_KEY=daily-api-key:latest</div>
      </div>
    </div>`;

  // ── Google Meet card ────────────────────────────────────────────────────────
  const meetStatus = meetConfigured
    ? `<span class="badge ok">Connected</span>`
    : `<span class="badge" style="background:#94a3b8">Not connected</span>`;

  const callbackUrl = `${serviceUrl}/dashboard/integrations/google/callback`;

  const meetConnectedSection = meetConfigured ? `
    <div style="display:flex;align-items:center;gap:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:16px">
      <span style="font-size:1.1rem">✓</span>
      <div>
        <div style="font-size:.88rem;font-weight:600;color:#166534">Google Meet connected</div>
        <div style="font-size:.78rem;color:#16a34a;margin-top:2px">Calendar invites will automatically include a Google Meet link</div>
      </div>
    </div>
    <div style="font-size:.82rem;color:#666;margin-bottom:12px">To disconnect, remove the <code>GOOGLE_MEET_REFRESH_TOKEN</code> environment variable from Cloud Run.</div>` : "";

  const step1 = `
    <div style="margin-bottom:16px">
      <div style="font-size:.82rem;font-weight:700;color:#1a1a2e;margin-bottom:8px">Step 1 — Enable the Google Meet API &amp; create OAuth credentials</div>
      <ol style="font-size:.83rem;color:#555;padding-left:18px;line-height:2.2">
        <li>The Meet API is already enabled in your GCP project ✓</li>
        <li>Go to <a href="https://console.cloud.google.com/apis/credentials?project=${process.env.GOOGLE_CLOUD_PROJECT ?? ""}" target="_blank" style="color:#4f46e5">GCP Console → Credentials</a></li>
        <li>Click <strong>Create Credentials → OAuth client ID</strong></li>
        <li>Application type: <strong>Web application</strong></li>
        <li>Add this Authorized redirect URI:<br>
          <code style="background:#f1f5f9;padding:3px 8px;border-radius:4px;font-size:.82rem;color:#4f46e5">${escHtml(callbackUrl)}</code>
        </li>
        <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong></li>
      </ol>
    </div>`;

  const step2 = `
    <div>
      <div style="font-size:.82rem;font-weight:700;color:#1a1a2e;margin-bottom:8px">Step 2 — Enter credentials &amp; connect your Google account</div>
      ${meetCredsStored ? `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;font-size:.81rem;color:#92400e;margin-bottom:12px">OAuth credentials already saved. Click Connect below to re-authorize, or update the credentials first.</div>` : ""}
      <form method="POST" action="/dashboard/integrations/google/connect">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>
            <label style="font-size:.78rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Client ID</label>
            <input type="text" name="client_id" value="${escHtml(config.googleMeet.clientId)}" placeholder="123456789-abc.apps.googleusercontent.com"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.82rem;font-family:monospace">
          </div>
          <div>
            <label style="font-size:.78rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Client Secret</label>
            <input type="password" name="client_secret" value="${escHtml(config.googleMeet.clientSecret)}" placeholder="GOCSPX-••••••••••••••"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.82rem;font-family:monospace">
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Connect Google Account →</button>
        <div style="font-size:.78rem;color:#999;margin-top:8px">You'll be redirected to Google to authorize with your Google account.</div>
      </form>
    </div>`;

  const meetSetupSection = meetConfigured ? "" : `
    <div style="background:#f8fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
      ${step1}
      ${step2}
    </div>`;

  const meetCard = `
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <h2 style="margin-bottom:4px">Google Meet</h2>
          <div style="font-size:.82rem;color:#888">Auto-generate real Google Meet links (recognized natively by Google Calendar)</div>
        </div>
        ${meetStatus}
      </div>
      ${meetConnectedSection}
      ${meetSetupSection}
    </div>`;

  // ── Priority note ───────────────────────────────────────────────────────────
  const priorityNote = `
    <div class="card" style="margin-bottom:20px;background:#f8fafb">
      <h2>Video Link Priority</h2>
      <div style="font-size:.85rem;color:#555;line-height:2;margin-top:8px">
        When <code>send_event_invite</code> is called without an explicit <code>video_url</code>:<br>
        <strong>1.</strong> Google Meet <span class="pill ${meetConfigured ? "green" : "gray"}">${meetConfigured ? "active" : "not configured"}</span> &nbsp;→&nbsp;
        <strong>2.</strong> Daily.co <span class="pill ${dailyConfigured ? "green" : "gray"}">${dailyConfigured ? "active" : "not configured"}</span> &nbsp;→&nbsp;
        <strong>3.</strong> No video link
      </div>
    </div>`;

  return page("Integrations", `
    ${topbar()}
    ${tabBar("integrations")}
    <div class="container">
      ${flashHtml}
      ${priorityNote}
      ${meetCard}
      ${dailyCard}
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Main dashboard page (tab routing)
// ---------------------------------------------------------------------------

async function buildDashboard(serviceUrl: string, tab: string, flash?: { type: "ok" | "err"; msg: string }): Promise<string> {
  const accountsResult = await toolListAccounts().catch(() => ({ accounts: [] as Array<{ email: string; name: string }>, count: 0 }));
  const accounts = accountsResult.accounts;

  const flashBanner = flash
    ? `<div style="margin:12px 0 0;padding:10px 16px;border-radius:6px;font-size:.85rem;font-weight:500;${flash.type === "ok" ? "background:#dcfce7;color:#166534;border:1px solid #86efac" : "background:#fee2e2;color:#991b1b;border:1px solid #fca5a5"}">${flash.type === "ok" ? "✓" : "✗"} ${escHtml(flash.msg)}</div>`
    : "";

  let content: string;
  if (tab === "inboxes") {
    content = (flashBanner ? `<div>${flashBanner}</div>` : "") + await buildInboxesTab(accounts);
  } else if (tab === "metrics") {
    content = await buildMetricsTab(accounts);
  } else if (tab === "calendars") {
    content = await buildCalendarsTab(accounts);
  } else {
    content = await buildOverview(serviceUrl, accounts);
  }

  const activeTab = tab === "inboxes" ? "inboxes"
    : tab === "metrics" ? "metrics"
    : tab === "calendars" ? "calendars"
    : tab === "integrations" ? "integrations"
    : "overview";

  return page("Dashboard", `
    ${topbar()}
    ${tabBar(activeTab)}
    <div class="container">${content}</div>
  `);
}

// ---------------------------------------------------------------------------
// Form body / query string helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function parseFormBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

export async function handleDashboard(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // POST /dashboard/login
  if (path === "/dashboard/login" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const userOk = form["user"] === config.dashboard.user;
    const passOk = form["pass"] === effectivePassword();
    if (!userOk || !passOk) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginPage("Invalid username or password."));
      return;
    }
    res.writeHead(302, { "Set-Cookie": makeSessionCookie(), "Location": "/dashboard" });
    res.end();
    return;
  }

  // GET /dashboard/logout
  if (path === "/dashboard/logout") {
    res.writeHead(302, { "Set-Cookie": clearSessionCookie(), "Location": "/dashboard" });
    res.end();
    return;
  }

  // Auth gate for all other routes
  if (!isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPage());
    return;
  }

  // GET /dashboard/metrics-data — JSON endpoint for Chart.js
  if (path === "/dashboard/metrics-data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ samples: getSamples() }));
    return;
  }

  // GET /dashboard/debug/jmap?a=email — raw JMAP diagnostic (auth-gated)
  if (path === "/dashboard/debug/jmap") {
    const account = url.searchParams.get("a") ?? "";
    const result: Record<string, unknown> = { account };
    try {
      const client = new JmapClient(account);
      const mailboxes = await client.listMailboxes();
      result.mailboxes = mailboxes;
      result.totalEmails = mailboxes.reduce((s, m) => s + m.totalEmails, 0);
    } catch (e) {
      result.error = String(e);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // POST /dashboard/action/send-test-email
  if (path === "/dashboard/action/send-test-email" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const from = form["from"] ?? "";
    const to = form["to"] ?? "";
    const subject = form["subject"] ?? "Test email from Clawmail";
    const bodyText = form["body"] ?? "Test email.";
    try {
      await toolSendEmail({ fromAccount: from, to, subject, body: bodyText });
      res.writeHead(302, { "Location": `/dashboard?tab=inboxes&sent=1` });
    } catch (e) {
      const errMsg = encodeURIComponent(e instanceof Error ? e.message : String(e));
      res.writeHead(302, { "Location": `/dashboard?tab=inboxes&err=${errMsg}` });
    }
    res.end();
    return;
  }

  // POST /dashboard/action/delete-email
  if (path === "/dashboard/action/delete-email" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = form["a"] ?? "";
    const emailId = form["id"] ?? "";
    try {
      await toolDeleteEmail(account, emailId);
    } catch { /* ignore — redirect anyway */ }
    res.writeHead(302, { "Location": `/dashboard/inbox?a=${encodeURIComponent(account)}` });
    res.end();
    return;
  }

  // GET /dashboard/inbox?a=email&folder=Inbox
  if (path === "/dashboard/inbox") {
    const account = url.searchParams.get("a") ?? "";
    const folder = url.searchParams.get("folder") ?? "Inbox";
    if (!account) {
      res.writeHead(302, { "Location": "/dashboard?tab=inboxes" });
      res.end();
      return;
    }
    try {
      const html = await buildInboxPage(account, folder);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Error", `<div class="container" style="padding-top:40px"><div class="card"><p style="color:#dc2626">Error loading inbox: ${escHtml(String(e))}</p><a href="/dashboard?tab=inboxes" class="back-link">← Back</a></div></div>`));
    }
    return;
  }

  // GET /dashboard/email?a=email&id=jmapId&folder=Inbox
  if (path === "/dashboard/email") {
    const account = url.searchParams.get("a") ?? "";
    const emailId = url.searchParams.get("id") ?? "";
    const folder = url.searchParams.get("folder") ?? "Inbox";
    if (!account || !emailId) {
      res.writeHead(302, { "Location": "/dashboard?tab=inboxes" });
      res.end();
      return;
    }
    try {
      const html = await buildEmailPage(account, emailId, folder);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Error", `<div class="container" style="padding-top:40px"><div class="card"><p style="color:#dc2626">Error loading email: ${escHtml(String(e))}</p><a href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=${encodeURIComponent(folder)}" class="back-link">← Back</a></div></div>`));
    }
    return;
  }

  // ── Integrations routes ────────────────────────────────────────────────────

  const proto2 = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host2  = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers["host"] ?? `localhost:${config.port}`;
  const serviceUrl2 = `${proto2}://${host2}`;

  // GET /dashboard/integrations (alias → tab=integrations)
  if (path === "/dashboard/integrations") {
    res.writeHead(302, { "Location": "/dashboard?tab=integrations" });
    res.end();
    return;
  }

  // POST /dashboard/integrations/google/connect — build OAuth URL and redirect
  if (path === "/dashboard/integrations/google/connect" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const clientId     = (form["client_id"] ?? "").trim();
    const clientSecret = (form["client_secret"] ?? "").trim();
    if (!clientId || !clientSecret) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent("Client ID and Client Secret are required") });
      res.end();
      return;
    }
    const state       = encodeOAuthState(clientId, clientSecret);
    const redirectUri = `${serviceUrl2}/dashboard/integrations/google/callback`;
    const authUrl     = buildAuthUrl(clientId, redirectUri, state);
    res.writeHead(302, { "Location": authUrl });
    res.end();
    return;
  }

  // GET /dashboard/integrations/google/callback — exchange code for token
  if (path === "/dashboard/integrations/google/callback") {
    const code  = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? "";

    if (error) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent(`Google authorization denied: ${error}`) });
      res.end();
      return;
    }

    const creds = decodeOAuthState(state);
    if (!creds) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent("OAuth state invalid or expired — please try again") });
      res.end();
      return;
    }

    try {
      const redirectUri = `${serviceUrl2}/dashboard/integrations/google/callback`;
      const { refreshToken, email } = await exchangeCode({ code, clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri });

      // Show the token + setup commands — admin stores it permanently
      const gcpProject = process.env.GOOGLE_CLOUD_PROJECT ?? "YOUR_PROJECT";
      const html = page("Google Meet Connected", `
        ${topbar()}
        ${tabBar("integrations")}
        <div class="container">
          <div class="card">
            <div style="text-align:center;padding:12px 0 20px">
              <div style="font-size:2rem;margin-bottom:8px">🎉</div>
              <div style="font-size:1.1rem;font-weight:700;color:#166534">Authorized as ${escHtml(email)}</div>
              <div style="font-size:.85rem;color:#888;margin-top:4px">Copy your refresh token and run the commands below to activate Google Meet.</div>
            </div>

            <div style="margin-bottom:20px">
              <div style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:8px">Your refresh token (copy this):</div>
              <div style="display:flex;align-items:center;gap:8px">
                <code id="token" style="flex:1;background:#f8fafb;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;font-size:.78rem;word-break:break-all;color:#1a1a2e">${escHtml(refreshToken)}</code>
                <button onclick="navigator.clipboard.writeText(document.getElementById('token').textContent);this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)"
                  class="btn btn-primary" style="white-space:nowrap;flex-shrink:0">Copy</button>
              </div>
            </div>

            <div style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:8px">Run these commands to activate:</div>
            <div class="code-block" style="font-size:.78rem">
# Store credentials in Secret Manager
echo -n "${escHtml(creds.clientId)}" | gcloud secrets create google-meet-client-id --data-file=- --project=${escHtml(gcpProject)}
echo -n "${escHtml(creds.clientSecret)}" | gcloud secrets create google-meet-client-secret --data-file=- --project=${escHtml(gcpProject)}
echo -n "PASTE_REFRESH_TOKEN_HERE" | gcloud secrets create google-meet-refresh-token --data-file=- --project=${escHtml(gcpProject)}

# Update Cloud Run to use them
gcloud run services update clawmail-mcp --region us-west1 --project=${escHtml(gcpProject)} \\
  --update-secrets=GOOGLE_MEET_CLIENT_ID=google-meet-client-id:latest,\\
GOOGLE_MEET_CLIENT_SECRET=google-meet-client-secret:latest,\\
GOOGLE_MEET_REFRESH_TOKEN=google-meet-refresh-token:latest
            </div>

            <div style="margin-top:16px">
              <a href="/dashboard?tab=integrations" class="btn btn-primary">← Back to Integrations</a>
            </div>
          </div>
        </div>
      `);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) });
      res.end();
    }
    return;
  }

  // GET /dashboard (main tabbed view)
  const tab = url.searchParams.get("tab") ?? "overview";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers["host"] ?? `localhost:${config.port}`;
  const serviceUrl = `${proto}://${host}`;

  let flash: { type: "ok" | "err"; msg: string } | undefined;
  if (url.searchParams.get("sent") === "1") flash = { type: "ok", msg: "Test email sent successfully." };
  else if (url.searchParams.get("err")) flash = { type: "err", msg: url.searchParams.get("err")! };

  if (tab === "integrations") {
    const flashMsg = url.searchParams.get("err")
      ? { type: "err" as const, msg: url.searchParams.get("err")! }
      : url.searchParams.get("ok")
      ? { type: "ok" as const, msg: url.searchParams.get("ok")! }
      : undefined;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buildIntegrationsPage(serviceUrl2, flashMsg));
    return;
  }

  const html = await buildDashboard(serviceUrl, tab, flash);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
