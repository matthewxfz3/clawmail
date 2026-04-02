import { createHmac, timingSafeEqual } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { toolListAccounts } from "./tools/accounts.js";

// ---------------------------------------------------------------------------
// Session cookie — HMAC-SHA256 signed, 7-day expiry
// ---------------------------------------------------------------------------

const COOKIE_NAME = "clawmail_dash";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signSession(payload: string): string {
  const sig = createHmac("sha256", config.dashboard.password || "dev")
    .update(payload)
    .digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(cookie: string): boolean {
  const dot = cookie.lastIndexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac("sha256", config.dashboard.password || "dev")
    .update(payload)
    .digest("hex");
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
  if (!config.dashboard.password) return true; // no password set → open
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

const CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6f9;color:#1a1a2e;min-height:100vh}
  .topbar{background:#1a1a2e;color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
  .topbar h1{font-size:1.1rem;font-weight:600;letter-spacing:.3px}
  .topbar span{font-size:.8rem;opacity:.6}
  .topbar a{color:#a0c4ff;font-size:.85rem;text-decoration:none}
  .topbar a:hover{text-decoration:underline}
  .container{max-width:900px;margin:32px auto;padding:0 16px;display:grid;gap:20px}
  .card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:24px}
  .card h2{font-size:.9rem;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:#666;margin-bottom:16px}
  .status-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f0f0f0;font-size:.9rem}
  .status-row:last-child{border-bottom:none}
  .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot.ok{background:#22c55e}.dot.warn{background:#f59e0b}.dot.fail{background:#ef4444}.dot.info{background:#94a3b8}
  .status-group{margin-bottom:8px}
  .status-group:last-child{margin-bottom:0}
  .group-heading{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.7px;color:#888;padding:10px 0 4px 0;border-bottom:1px solid #f0f0f0;margin-bottom:2px}
  .row-detail{display:block;font-size:.75rem;color:#999;margin-top:1px;font-weight:400}
  .label{flex:1;color:#444}
  .badge{font-size:.75rem;font-weight:600;padding:2px 8px;border-radius:12px;color:#fff}
  .badge.ok{background:#22c55e}.badge.warn{background:#f59e0b}.badge.fail{background:#ef4444}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th{text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;color:#666;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.5px}
  td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#333}
  tr:last-child td{border-bottom:none}
  .code-block{background:#1e1e2e;color:#cdd6f4;border-radius:8px;padding:16px;font-family:'JetBrains Mono',Menlo,monospace;font-size:.8rem;line-height:1.6;overflow-x:auto;white-space:pre}
  .key-row{display:flex;align-items:center;gap:8px;background:#f8f9fa;border:1px solid #e5e7eb;border-radius:6px;padding:8px 12px;font-family:monospace;font-size:.85rem;color:#333}
  .key-row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pill{display:inline-block;background:#eef2ff;color:#4f46e5;border-radius:12px;padding:2px 10px;font-size:.75rem;font-weight:600}
  .empty{color:#999;font-size:.85rem;padding:8px 0}
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
  .url-display{font-family:monospace;font-size:.85rem;color:#4f46e5;word-break:break-all}
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

function loginPage(error?: string): string {
  const err = error
    ? `<div class="error-msg">${escHtml(error)}</div>`
    : "";
  return page("Clawmail — Login", `
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

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Dashboard data
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

  // Management API
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

  // JMAP session
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

  // MX
  try {
    const mx = await resolver.resolveMx(config.domain);
    if (mx.length > 0) {
      const top = mx.sort((a, b) => a.priority - b.priority)[0];
      items.push({ label: "MX record", status: "ok", detail: `${top.priority} ${top.exchange}` });
    } else {
      items.push({ label: "MX record", status: "warn", detail: "No records found — inbound mail will not be delivered" });
    }
  } catch (e) {
    items.push({ label: "MX record", status: "fail", detail: `Lookup failed: ${String(e)}` });
  }

  // SPF
  try {
    const txt = await resolver.resolveTxt(config.domain);
    const spf = txt.flat().find(r => r.startsWith("v=spf1"));
    if (spf) {
      items.push({ label: "SPF record", status: "ok", detail: spf.slice(0, 80) });
    } else {
      items.push({ label: "SPF record", status: "warn", detail: "Not found — outbound mail may be marked as spam" });
    }
  } catch {
    items.push({ label: "SPF record", status: "warn", detail: "Lookup failed" });
  }

  // DMARC
  try {
    const txt = await resolver.resolveTxt(`_dmarc.${config.domain}`);
    const dmarc = txt.flat().find(r => r.startsWith("v=DMARC1"));
    if (dmarc) {
      items.push({ label: "DMARC record", status: "ok", detail: dmarc.slice(0, 80) });
    } else {
      items.push({ label: "DMARC record", status: "warn", detail: "Not found — no DMARC policy set" });
    }
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
  const uptimeStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const mem = process.memoryUsage();
  const rss = `${Math.round(mem.rss / 1024 / 1024)} MB RSS / ${Math.round(mem.heapUsed / 1024 / 1024)} MB heap`;

  return {
    heading: "MCP Server (this process)",
    items: [
      { label: "Status", status: "ok", detail: "Running" },
      { label: "Node.js", status: "info", detail: process.version },
      { label: "Uptime", status: "info", detail: uptimeStr },
      { label: "Memory", status: "info", detail: rss },
      { label: "API keys configured", status: config.auth.apiKeys.size > 0 ? "ok" : "warn", detail: config.auth.apiKeys.size > 0 ? `${config.auth.apiKeys.size} key(s)` : "No API keys — server is open" },
    ],
  };
}

function checkSendgridGroup(): StatusGroup {
  const hasKey = !!config.sendgrid.apiKey && config.sendgrid.apiKey !== "SG.your-sendgrid-api-key";
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
  const dotClass = item.status === "info" ? "info" : item.status;
  const badgeHtml = item.status !== "info"
    ? `<span class="badge ${item.status}">${item.status.toUpperCase()}</span>`
    : `<span style="font-size:.75rem;color:#888">${escHtml(item.detail ?? "")}</span>`;
  const labelDetail = item.status !== "info" && item.detail
    ? `<span class="row-detail">${escHtml(item.detail)}</span>`
    : "";
  const indentStyle = indent ? "padding-left:20px" : "";
  return `<div class="status-row" style="${indentStyle}"><div class="dot ${dotClass}"></div><span class="label">${escHtml(item.label)}${labelDetail}</span>${badgeHtml}</div>`;
}

function statusGroup(group: StatusGroup): string {
  const rows = group.items.map(item => statusRow(item, true)).join("");
  return `
    <div class="status-group">
      <div class="group-heading">${escHtml(group.heading)}</div>
      ${rows}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Dashboard page renderer
// ---------------------------------------------------------------------------

async function buildDashboard(serviceUrl: string): Promise<string> {
  const accountsResult = await toolListAccounts().catch(() => ({ accounts: [] as Array<{ email: string; name: string }>, count: 0 }));
  const accounts = accountsResult.accounts;

  const [stalwartGroup, dnsGroup] = await Promise.all([
    checkStalwartGroup(accounts.length),
    checkDnsGroup(),
  ]);
  const mcpGroup = checkMcpServerGroup();
  const sendgridGroup = checkSendgridGroup();

  const mcpUrl = `${serviceUrl}/mcp`;
  const firstKey = [...config.auth.apiKeys][0] ?? "(no API key configured)";
  const maskedKey = firstKey.length > 8
    ? firstKey.slice(0, 4) + "••••••••" + firstKey.slice(-4)
    : "••••••••";

  const snippet = JSON.stringify({
    mcpServers: {
      clawmail: {
        type: "http",
        url: mcpUrl,
        headers: { "X-API-Key": "<your-api-key>" },
      },
    },
  }, null, 2);

  const accountRows = accounts.length === 0
    ? `<tr><td colspan="2" class="empty">No accounts yet — use the <code>create_account</code> tool to add one.</td></tr>`
    : accounts.map(a => `<tr><td>${escHtml(a.email)}</td><td><span class="pill">active</span></td></tr>`).join("");

  return page("Clawmail Dashboard", `
    <div class="topbar">
      <h1>Clawmail Dashboard</h1>
      <div style="display:flex;align-items:center;gap:20px">
        <span>${escHtml(config.domain)}</span>
        <a href="/dashboard/logout">Sign out</a>
      </div>
    </div>
    <div class="container">

      <div class="card">
        <h2>Connect your agent</h2>
        <p style="font-size:.85rem;color:#666;margin-bottom:14px">Add this to your <code>mcp.json</code> or Claude Desktop config:</p>
        <div class="code-block">${escHtml(snippet)}</div>
        <p style="font-size:.82rem;color:#888;margin-top:10px">Replace <code>&lt;your-api-key&gt;</code> with one of the keys below.</p>
        <div style="margin-top:16px">
          <p style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:8px">MCP endpoint</p>
          <div class="url-display">${escHtml(mcpUrl)}</div>
        </div>
        <div style="margin-top:16px">
          <p style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:8px">API key (masked)</p>
          <div class="key-row"><span>${escHtml(maskedKey)}</span>${config.auth.apiKeys.size > 1 ? `<span style="font-size:.78rem;color:#999">+${config.auth.apiKeys.size - 1} more</span>` : ""}</div>
        </div>
      </div>

      <div class="card">
        <h2>System status</h2>
        ${statusGroup(mcpGroup)}
        ${statusGroup(stalwartGroup)}
        ${statusGroup(dnsGroup)}
        ${statusGroup(sendgridGroup)}
      </div>

      <div class="card">
        <h2>Accounts (${accounts.length})</h2>
        <table>
          <thead><tr><th>Email address</th><th>Status</th></tr></thead>
          <tbody>${accountRows}</tbody>
        </table>
      </div>

    </div>
  `);
}

// ---------------------------------------------------------------------------
// Request handler — call from index.ts for /dashboard* paths
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseFormBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
  }
  return out;
}

export async function handleDashboard(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // POST /dashboard/login
  if (path === "/dashboard/login" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);

    const userOk = form["user"] === config.dashboard.user;
    const passOk = config.dashboard.password === ""
      || form["pass"] === config.dashboard.password;

    if (!userOk || !passOk) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginPage("Invalid username or password."));
      return;
    }

    res.writeHead(302, {
      "Set-Cookie": makeSessionCookie(),
      "Location": "/dashboard",
    });
    res.end();
    return;
  }

  // GET /dashboard/logout
  if (path === "/dashboard/logout") {
    res.writeHead(302, {
      "Set-Cookie": clearSessionCookie(),
      "Location": "/dashboard",
    });
    res.end();
    return;
  }

  // All other /dashboard* routes require auth
  if (!isAuthenticated(req)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginPage());
    return;
  }

  // GET /dashboard
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined)
    ?? req.headers["host"]
    ?? `localhost:${config.port}`;
  const serviceUrl = `${proto}://${host}`;

  const html = await buildDashboard(serviceUrl);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
