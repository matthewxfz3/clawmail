import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { listTokens, createToken, revokeToken } from "./tools/tokens.js";
import { toolListAccounts } from "./tools/accounts.js";
import { toolListEmails, toolReadEmail, toolDeleteEmail, toolMarkAsRead, toolMarkAsUnread, toolFlagEmail } from "./tools/mailbox.js";
import { toolMoveEmail, toolListFolders } from "./tools/folders.js";
import { toolSendEmail, toolSendEventInvite } from "./tools/send.js";
import { toolListEvents, type CalendarEvent } from "./tools/calendar.js";
import { toolListRules, type RuleCondition, type RuleAction, type MailboxRule } from "./tools/rules.js";
import { JmapClient } from "./clients/jmap.js";
import { getMetrics, getSamples, setInboxTotal, getAccountCreatedAt, getCallLog, getBatchLog } from "./metrics.js";
import { toolConfigureAccount, getAccountSettings } from "./tools/configure.js";
import { toolCreateFolder, toolDeleteFolder } from "./tools/folders.js";
import { buildAuthUrl, exchangeCode, isMeetConfigured, isMeetValid } from "./clients/google-meet.js";
import { readSecret, writeSecret } from "./clients/secret-manager.js";

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
// Server-side flash store
// Keeps sensitive values (e.g. token plaintexts) out of redirect URLs /
// browser history / HTTP access logs. Entries are one-time-read and expire
// after 5 minutes. Keyed by a random UUID set in the Location header.
//
// ⚠️  SINGLE-INSTANCE LIMITATION: this Map lives in process memory. When Cloud
// Run scales to more than one instance, the POST that creates a flash and the
// subsequent GET that reads it may be routed to different instances, causing
// the flash to appear missing (the token banner won't show). To guarantee
// correct behaviour, set `--min-instances=1` on the Cloud Run service so
// requests from the same browser session always land on the same instance.
// (The dashboard is a low-traffic operator tool so a single warm instance is
// sufficient and inexpensive.)
// ---------------------------------------------------------------------------

interface FlashEntry {
  msg: string;
  type: "ok" | "err";
  /** Plaintext token — present only for token-creation flash. Enables copy-to-clipboard UI. */
  token?: string;
  createdAt: number;
}

const flashStore = new Map<string, FlashEntry>();
const FLASH_TTL_MS = 5 * 60 * 1000;

function setFlash(msg: string, type: "ok" | "err" = "ok", extras?: { token?: string }): string {
  const id = randomUUID();
  flashStore.set(id, { msg, type, ...extras, createdAt: Date.now() });
  // Prune stale entries (linear scan is fine; the store is tiny).
  const now = Date.now();
  for (const [k, v] of flashStore) {
    if (now - v.createdAt > FLASH_TTL_MS) flashStore.delete(k);
  }
  return id;
}

function consumeFlash(id: string): Omit<FlashEntry, "createdAt"> | undefined {
  const entry = flashStore.get(id);
  if (!entry) return undefined;
  flashStore.delete(id); // one-time read
  if (Date.now() - entry.createdAt > FLASH_TTL_MS) return undefined;
  return { msg: entry.msg, type: entry.type, token: entry.token };
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
  :root{
    --bg:#f1f5f9;
    --surface:#ffffff;
    --surface2:#f8fafc;
    --border:#e2e8f0;
    --border-strong:#cbd5e1;
    --text:#0f172a;
    --text2:#475569;
    --text3:#94a3b8;
    --accent:#2563eb;
    --accent-light:#eff6ff;
    --accent-hover:#1d4ed8;
    --green:#059669;
    --green-light:#ecfdf5;
    --amber:#d97706;
    --amber-light:#fffbeb;
    --red:#dc2626;
    --red-light:#fef2f2;
    --purple:#7c3aed;
    --purple-light:#f5f3ff;
    --radius:10px;
    --shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);
    --shadow-md:0 4px 12px rgba(0,0,0,.08),0 1px 4px rgba(0,0,0,.04);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased}
  /* ── topbar ── */
  .topbar{background:var(--text);color:#fff;padding:0 24px;display:flex;align-items:stretch;justify-content:space-between;height:52px}
  .topbar-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:#fff}
  .topbar-logo{width:28px;height:28px;background:var(--accent);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:800;letter-spacing:-.5px;flex-shrink:0}
  .topbar h1{font-size:1rem;font-weight:700;letter-spacing:-.2px}
  .topbar-right{display:flex;align-items:center;gap:6px}
  .topbar-domain{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);color:rgba(255,255,255,.75);border-radius:6px;padding:3px 10px;font-size:.75rem;font-family:'JetBrains Mono',monospace;letter-spacing:.3px;cursor:pointer;transition:background .15s,color .15s}
  .topbar-domain:hover{background:rgba(255,255,255,.15);color:#fff}
  .topbar-domain-active{background:var(--accent);color:#fff !important;border-color:var(--accent) !important}
  .topbar-signout{color:rgba(255,255,255,.55);font-size:.82rem;text-decoration:none;padding:6px 10px;border-radius:6px;transition:background .15s}
  .topbar-signout:hover{background:rgba(255,255,255,.1);color:#fff}
  /* ── tab bar ── */
  .tab-bar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px;display:flex;gap:2px;align-items:flex-end}
  .tab-bar a{display:inline-flex;align-items:center;gap:5px;padding:11px 14px;font-size:.82rem;font-weight:500;color:var(--text3);text-decoration:none;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .15s;white-space:nowrap}
  .tab-bar a:hover{color:var(--text2)}
  .tab-bar a.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
  .tab-icon{font-size:.85rem;opacity:.8}
  /* ── layout ── */
  .container{max-width:980px;margin:24px auto;padding:0 20px;display:grid;gap:16px}
  .card{background:var(--surface);border-radius:var(--radius);border:1px solid var(--border);box-shadow:var(--shadow);padding:22px 24px}
  .card-title,.card h2{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.9px;color:var(--text3);margin-bottom:14px}
  /* ── status ── */
  .status-row{display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid var(--bg);font-size:.875rem}
  .status-row:last-child{border-bottom:none}
  .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:5px}
  .dot.ok{background:var(--green)}.dot.warn{background:var(--amber)}.dot.fail{background:var(--red)}.dot.info{background:var(--text3)}
  .label{flex:1;color:var(--text2)}
  .badge{font-size:.7rem;font-weight:700;padding:2px 8px;border-radius:20px;color:#fff;white-space:nowrap;letter-spacing:.3px}
  .badge.ok{background:var(--green)}.badge.warn{background:var(--amber)}.badge.fail{background:var(--red)}
  .row-detail{display:block;font-size:.72rem;color:var(--text3);margin-top:2px;font-weight:400}
  .status-group{margin-bottom:6px}
  .status-group:last-child{margin-bottom:0}
  .group-heading{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.9px;color:var(--text3);padding:10px 0 5px;border-bottom:1px solid var(--border);margin-bottom:4px}
  /* ── tables ── */
  table{width:100%;border-collapse:collapse;font-size:.86rem}
  th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);color:var(--text3);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.7px;background:var(--surface2)}
  td{padding:9px 12px;border-bottom:1px solid var(--bg);color:var(--text);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafcff}
  /* ── pills & badges ── */
  .pill{display:inline-block;border-radius:20px;padding:2px 9px;font-size:.72rem;font-weight:600;letter-spacing:.2px}
  .pill{background:var(--accent-light);color:var(--accent)}
  .pill.green{background:var(--green-light);color:var(--green)}
  .pill.red{background:var(--red-light);color:var(--red)}
  .pill.amber{background:var(--amber-light);color:var(--amber)}
  .pill.purple{background:var(--purple-light);color:var(--purple)}
  .pill.blue{background:var(--accent-light);color:var(--accent)}
  .pill.gray{background:var(--surface2);color:var(--text2);border:1px solid var(--border)}
  /* ── misc ── */
  .code-block{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:16px;font-family:'JetBrains Mono',Menlo,monospace;font-size:.78rem;line-height:1.65;overflow-x:auto;white-space:pre}
  .key-row{display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:9px 14px;font-family:'JetBrains Mono',monospace;font-size:.82rem;color:var(--text)}
  td.mono{font-family:'JetBrains Mono',monospace;font-size:.78rem;color:var(--text2)}
  td.num{text-align:right;font-family:'JetBrains Mono',monospace;color:var(--accent);font-weight:600}
  td.err{text-align:right;font-family:'JetBrains Mono',monospace;color:var(--red);font-weight:600}
  .empty{color:var(--text3);font-size:.85rem;padding:10px 0}
  .url-display{font-family:'JetBrains Mono',monospace;font-size:.82rem;color:var(--accent);word-break:break-all}
  .warn-note{background:var(--amber-light);border:1px solid #fde68a;border-radius:7px;padding:10px 14px;font-size:.82rem;color:#92400e;margin-top:12px}
  /* ── buttons ── */
  .btn{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:7px;font-size:.82rem;font-weight:600;text-decoration:none;cursor:pointer;border:none;transition:background .15s,box-shadow .15s}
  .btn-primary{background:var(--accent);color:#fff;box-shadow:0 1px 3px rgba(37,99,235,.3)}
  .btn-primary:hover{background:var(--accent-hover)}
  .btn-secondary{background:var(--surface);color:var(--text2);border:1px solid var(--border)}
  .btn-secondary:hover{background:var(--surface2)}
  .btn-danger{background:var(--red-light);color:var(--red);border:1px solid #fecaca}
  .btn-danger:hover{background:#fee2e2}
  /* ── account cards ── */
  .account-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
  .account-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px;transition:box-shadow .15s,border-color .15s}
  .account-card:hover{box-shadow:var(--shadow-md);border-color:var(--border-strong)}
  .account-card .email{font-weight:600;font-size:.875rem;color:var(--text);word-break:break-all;font-family:'JetBrains Mono',monospace}
  .account-card .actions{margin-top:12px;display:flex;gap:8px}
  /* ── navigation links ── */
  .back-link{font-size:.82rem;color:var(--accent);text-decoration:none;display:inline-flex;align-items:center;gap:4px;margin-bottom:16px;font-weight:500}
  .back-link:hover{text-decoration:underline}
  .page-title{font-size:1.05rem;font-weight:700;color:var(--text);margin-bottom:3px;letter-spacing:-.2px}
  .page-sub{font-size:.82rem;color:var(--text3);margin-bottom:20px}
  .subject-link{color:var(--text);text-decoration:none;font-weight:500}
  .subject-link:hover{color:var(--accent);text-decoration:underline}
  .attach-icon{color:var(--amber);font-size:.8rem}
  /* ── email detail ── */
  .email-meta{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:20px}
  .email-meta-row{display:flex;gap:8px;font-size:.84rem;padding:3px 0}
  .email-meta-label{font-weight:600;color:var(--text3);width:60px;flex-shrink:0}
  .email-body{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:22px;font-size:.875rem;line-height:1.75;white-space:pre-wrap;word-break:break-word;color:var(--text2)}
  /* ── metrics ── */
  .metric-big{font-size:2.2rem;font-weight:700;color:var(--text);line-height:1;letter-spacing:-.5px}
  .metric-label{font-size:.68rem;color:var(--text3);margin-top:5px;text-transform:uppercase;letter-spacing:.9px;font-weight:600}
  .metric-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px}
  .metric-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:18px}
  /* ── login ── */
  .login-wrap{display:flex;min-height:100vh;background:var(--text)}
  .login-left{flex:1;display:flex;flex-direction:column;justify-content:center;padding:48px;max-width:520px}
  .login-right{flex:1;background:linear-gradient(135deg,#1e3a5f 0%,#0f2744 40%,#091a33 100%);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
  .login-right::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 30% 50%,rgba(37,99,235,.25) 0%,transparent 60%)}
  .login-card{width:100%;max-width:380px}
  .login-brand{display:flex;align-items:center;gap:10px;margin-bottom:36px}
  .login-logo{width:36px;height:36px;background:var(--accent);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:800;color:#fff}
  .login-logo-text{font-size:1.1rem;font-weight:700;color:#fff;letter-spacing:-.2px}
  .login-card h2{font-size:1.35rem;font-weight:700;color:#fff;margin-bottom:6px;letter-spacing:-.3px}
  .login-card .subtitle{color:rgba(255,255,255,.45);font-size:.875rem;margin-bottom:28px}
  label{display:block;font-size:.78rem;font-weight:600;color:rgba(255,255,255,.5);margin-bottom:5px;letter-spacing:.3px;text-transform:uppercase}
  input[type=text],input[type=password]{width:100%;padding:11px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;font-size:.9rem;color:#fff;outline:none;transition:border .15s,background .15s;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
  input::placeholder{color:rgba(255,255,255,.25)}
  input:focus{border-color:rgba(37,99,235,.7);background:rgba(255,255,255,.09)}
  .field{margin-bottom:16px}
  button[type=submit]{width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:7px;font-size:.9rem;font-weight:700;cursor:pointer;letter-spacing:.1px;transition:background .15s,box-shadow .15s;font-family:'Plus Jakarta Sans',system-ui,sans-serif;box-shadow:0 2px 8px rgba(37,99,235,.4)}
  button[type=submit]:hover{background:var(--accent-hover);box-shadow:0 4px 14px rgba(37,99,235,.5)}
  .error-msg{background:rgba(220,38,38,.15);color:#fca5a5;border:1px solid rgba(220,38,38,.3);border-radius:7px;padding:10px 14px;font-size:.84rem;margin-bottom:16px}
  .login-hint{margin-top:24px;padding:12px 16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:8px;font-size:.78rem;color:rgba(255,255,255,.4);line-height:1.6}
  .login-hint code{background:rgba(255,255,255,.1);padding:1px 5px;border-radius:3px;font-family:'JetBrains Mono',monospace;color:rgba(255,255,255,.65);font-size:.76rem}
  .login-art-text{font-family:'JetBrains Mono',monospace;font-size:.78rem;color:rgba(255,255,255,.2);text-align:center;line-height:1.8;padding:32px;max-width:360px}
  /* ── calendar ── */
  .cal-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;font-size:.875rem}
  .cal-nav a{color:var(--accent);padding:4px 12px;border:1px solid var(--border);border-radius:6px;text-decoration:none;font-size:.82rem;font-weight:500}
  .cal-nav a:hover{background:var(--accent-light)}
  .cal-grid{display:grid;grid-template-columns:repeat(7,1fr);border-left:1px solid var(--border);border-top:1px solid var(--border)}
  .cal-header{padding:6px;font-size:.7rem;font-weight:700;color:var(--text3);text-align:center;background:var(--surface2);border-right:1px solid var(--border);border-bottom:1px solid var(--border)}
  .cal-cell{min-height:80px;padding:4px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);font-size:.75rem}
  .cal-cell.cal-other-month{background:var(--bg)}
  .cal-cell.cal-today{background:var(--accent-light)}
  .cal-day-num{font-size:.72rem;font-weight:600;color:var(--text3);margin-bottom:2px}
  details.cal-event{background:#dbeafe;border-radius:3px;margin-bottom:2px;font-size:.7rem;cursor:pointer}
  details.cal-event summary{padding:2px 5px;list-style:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1d4ed8;font-weight:500}
  details.cal-event summary::-webkit-details-marker{display:none}
  details.cal-event[open] summary{background:#bfdbfe;white-space:normal}
  details.cal-event.cal-past{background:var(--surface2)}
  details.cal-event.cal-past summary{color:var(--text3)}
  .cal-detail{padding:6px 8px;border-top:1px solid rgba(0,0,0,.06);background:var(--surface);font-size:.75rem;line-height:1.5;color:var(--text2)}
  /* ── week view ── */
  .week-container{border:1px solid var(--border);border-radius:7px;overflow:hidden;margin-top:4px}
  .week-head{display:grid;grid-template-columns:52px repeat(7,1fr);background:var(--surface2);border-bottom:2px solid var(--border);position:sticky;top:0;z-index:20}
  .week-head-cell{padding:7px 4px;text-align:center;font-size:.75rem;border-left:1px solid var(--border);line-height:1.4}
  .view-toggle{display:flex;gap:4px;margin-bottom:14px}
  .view-toggle a{padding:5px 16px;border-radius:6px;font-size:.8rem;font-weight:500;text-decoration:none;border:1px solid var(--border);color:var(--text2);background:var(--surface)}
  .view-toggle a.active{background:var(--accent);color:#fff;border-color:var(--accent)}
  /* ── week view extras (not covered by the block above) ── */
  .week-head-cell:first-child{border-left:none}
  .week-head-cell.week-today-hd{background:#ede9fe;color:var(--accent);font-weight:700}
  .week-scroll{overflow-y:auto;max-height:580px}
  .week-body{display:grid;grid-template-columns:52px repeat(7,1fr);position:relative}
  .week-time-col{display:flex;flex-direction:column;background:var(--surface2);border-right:1px solid var(--border)}
  .week-time-label{height:48px;padding:3px 6px 0 0;text-align:right;font-size:.68rem;color:var(--text3);flex-shrink:0}
  .week-day-col{position:relative;min-height:1152px;border-left:1px solid var(--border)}
  .week-day-col.week-today-col{background:#fdfcff}
  .week-hr{position:absolute;left:0;right:0;border-top:1px solid var(--bg);pointer-events:none}
  .week-hr.major{border-top-color:var(--border)}
  details.week-ev{position:absolute;border-radius:4px;overflow:hidden;font-size:.72rem;cursor:pointer;background:#dbeafe;border-left:3px solid #3b82f6;padding:2px 4px;z-index:1}
  details.week-ev summary{list-style:none;font-weight:500;color:#1d4ed8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
  details.week-ev summary::-webkit-details-marker{display:none}
  details.week-ev[open]{z-index:10;overflow:visible}
  details.week-ev[open] summary{white-space:normal}
  details.week-ev.past{background:var(--surface2);border-left-color:var(--text3)}
  details.week-ev.past summary{color:var(--text3)}
  .week-ev-detail{margin-top:3px;color:var(--text2);font-size:.71rem;line-height:1.4;background:var(--surface);border-radius:0 0 3px 3px;padding:4px;border-top:1px solid rgba(0,0,0,.06)}
  .week-now-line{position:absolute;left:0;right:0;height:0;border-top:2px solid var(--red);z-index:5;pointer-events:none}
  .week-now-dot{position:absolute;left:-5px;top:-5px;width:9px;height:9px;background:var(--red);border-radius:50%}
`;

function page(title: string, body: string): string {
  const favicon = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3Cstyle%3E.claw-bg%7Bfill:%231a2332%7D.claw-main%7Bfill:%23ffffff%7D.claw-accent%7Bfill:%2314b8a6%7D%3C/style%3E%3C/defs%3E%3Crect class='claw-bg' width='64' height='64'/%3E%3Cpath class='claw-main' d='M32 8 L42 16 L44 28 L32 32 L28 28 Z'/%3E%3Cpath class='claw-main' d='M20 14 L28 18 L30 32 L20 30 Z'/%3E%3Cpath class='claw-main' d='M44 18 L52 22 L50 34 L44 32 Z'/%3E%3Cpath class='claw-accent' d='M24 36 L40 36 L38 48 L26 48 Z'/%3E%3Cpath class='claw-main' d='M26 50 L38 50 L36 58 L28 58 Z'/%3E%3C/svg%3E`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Clawmail</title><link rel="icon" type="image/svg+xml" href="${favicon}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"><style>${CSS}</style></head><body>${body}</body></html>`;
}

function topbar(selectedDomain?: string): string {
  let domainBadges: string;

  if (config.allowedDomains.length === 1) {
    // Single domain — plain badge, no interactivity (same as today)
    domainBadges = `<span class="topbar-domain">${escHtml(config.allowedDomains[0])}</span>`;
  } else {
    // Multiple domains — clickable badges; "All" + one per domain
    const allActive = !selectedDomain;
    const allBadge = `<a href="/dashboard?tab=inboxes" class="topbar-domain${allActive ? " topbar-domain-active" : ""}" style="text-decoration:none">All domains</a>`;
    const domainLinks = config.allowedDomains.map(d => {
      const isActive = d === selectedDomain;
      return `<a href="/dashboard?tab=inboxes&domain=${encodeURIComponent(d)}" class="topbar-domain${isActive ? " topbar-domain-active" : ""}" style="text-decoration:none">${escHtml(d)}</a>`;
    }).join("");
    domainBadges = allBadge + domainLinks;
  }

  return `
    <div class="topbar">
      <a class="topbar-brand" href="/dashboard">
        <div class="topbar-logo">C</div>
        <h1>Clawmail</h1>
      </a>
      <div class="topbar-right">
        ${domainBadges}
        <a class="topbar-signout" href="/dashboard/logout">Sign out</a>
      </div>
    </div>`;
}

function tabBar(active: string): string {
  const tabs = [
    { id: "overview",      label: "Overview",          icon: "◈",  href: "/dashboard" },
    { id: "inboxes",       label: "Inboxes",            icon: "✉",  href: "/dashboard?tab=inboxes" },
    { id: "metrics",       label: "Metrics",            icon: "◎",  href: "/dashboard?tab=metrics" },
    { id: "tokens",        label: "Tokens",             icon: "⬡",  href: "/dashboard?tab=tokens" },
    { id: "calendars",     label: "Calendars",          icon: "▦",  href: "/dashboard?tab=calendars" },
    { id: "storage",       label: "Storage",            icon: "▣",  href: "/dashboard?tab=storage" },
    { id: "integrations",  label: "Integrations",       icon: "⚙",  href: "/dashboard?tab=integrations" },
  ];
  const links = tabs.map(t =>
    `<a href="${t.href}" class="${active === t.id ? "active" : ""}"><span class="tab-icon">${t.icon}</span>${t.label}</a>`
  ).join("");
  return `<nav class="tab-bar">${links}</nav>`;
}

function loginPage(error?: string): string {
  const err = error ? `<div class="error-msg">${escHtml(error)}</div>` : "";
  return page("Login", `
    <div class="login-wrap">
      <div class="login-left">
        <div class="login-card">
          <div class="login-brand">
            <div class="login-logo">C</div>
            <span class="login-logo-text">Clawmail</span>
          </div>
          <h2>Operator Dashboard</h2>
          <p class="subtitle">Sign in with your admin credentials to continue.</p>
          ${err}
          <form method="POST" action="/dashboard/login">
            <div class="field"><label>Username</label><input type="text" name="user" autocomplete="username" placeholder="admin" required></div>
            <div class="field"><label>Password</label><input type="password" name="pass" autocomplete="current-password" placeholder="••••••••" required></div>
            <button type="submit">Sign in →</button>
          </form>
          <div class="login-hint">
            Use <code>DASHBOARD_PASSWORD</code> if set, otherwise falls back to <code>STALWART_ADMIN_PASSWORD</code>.
          </div>
        </div>
      </div>
      <div class="login-right">
        <div class="login-art-text">
          create_account<br>
          list_emails<br>
          send_email<br>
          read_email<br>
          delete_email<br>
          search_emails<br>
          manage_token<br>
          list_accounts<br>
          delete_account
        </div>
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

async function buildInboxesTab(
  accounts: Array<{ email: string; name: string }>,
  selectedDomain?: string,
): Promise<string> {
  // Filter accounts by selected domain if one is specified
  const filteredAccounts = selectedDomain
    ? accounts.filter(a => a.email.toLowerCase().endsWith("@" + selectedDomain.toLowerCase()))
    : accounts;

  // Fetch inbox + sent counts for all accounts in parallel (capped at 50).
  const capped = filteredAccounts.slice(0, 50);
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
          <label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">From account</label>
          ${accounts.length > 0
            ? `<select name="from" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e">${fromOptions}</select>`
            : `<input type="text" name="from" placeholder="agent@${escHtml(config.domain)}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required>`}
        </div>
        <div><label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">To</label><input type="text" name="to" placeholder="recipient@example.com" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required></div>
        <div><label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">Subject</label><input type="text" name="subject" value="Test email from Clawmail" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required></div>
        <div>
          <label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">Body</label>
          <textarea name="body" rows="3" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.88rem;resize:vertical;color:#1a1a2e;background:#fff">Hello — this is a test email sent from the Clawmail dashboard.\n\nIf you received this, the send pipeline is working correctly.</textarea>
        </div>
        <div>
          <button type="submit" class="btn btn-primary" style="padding:9px 22px;font-size:.88rem">Send →</button>
        </div>
      </form>
    </div>`;

  // Test calendar invite form (with video URL auto-generation)
  const testCalendarForm = `
    <div class="card">
      <h2>Send test calendar invite</h2>
      <p style="font-size:.83rem;color:#666;margin-bottom:18px">Test video link auto-generation (Google Meet or Daily.co).</p>
      <form method="POST" action="/dashboard/action/send-test-calendar" style="display:grid;gap:14px;max-width:520px">
        <div>
          <label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">From account</label>
          ${accounts.length > 0
            ? `<select name="from" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e">${fromOptions}</select>`
            : `<input type="text" name="from" placeholder="agent@${escHtml(config.domain)}" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required>`}
        </div>
        <div><label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">To</label><input type="text" name="to" placeholder="recipient@example.com" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required></div>
        <div><label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">Event Title</label><input type="text" name="title" value="Test Meeting with Video" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div><label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">Start time</label><input type="datetime-local" name="start" value="2026-04-15T14:00" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required></div>
          <div><label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">End time</label><input type="datetime-local" name="end" value="2026-04-15T14:30" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required></div>
        </div>
        <div>
          <label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">Timezone (IANA format)</label>
          <input type="text" name="timezone" placeholder="e.g. America/Los_Angeles, Europe/London, UTC" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;background:#fff;color:#1a1a2e" required>
        </div>
        <div>
          <label style="color:#555;font-weight:600;font-size:.78rem;display:block;margin-bottom:4px">Description</label>
          <textarea name="description" rows="2" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.88rem;resize:vertical;color:#1a1a2e;background:#fff">Testing calendar invite with auto-generated video link (Google Meet or Daily.co).</textarea>
        </div>
        <div>
          <button type="submit" class="btn btn-primary" style="padding:9px 22px;font-size:.88rem">Send Calendar Invite →</button>
        </div>
      </form>
      <div style="font-size:.78rem;color:#888;margin-top:12px;padding:10px;background:#f8fafb;border-radius:6px">
        <strong>Note:</strong> If Google Meet is connected, a video link will auto-generate. Otherwise Daily.co will be used (if configured).
      </div>
    </div>`;

  // Domain filter bar — only shown when multiple domains exist
  let domainFilterBar = "";
  if (config.allowedDomains.length > 1) {
    const allActive = !selectedDomain;
    const tabs = [
      `<a href="/dashboard?tab=inboxes" class="${allActive ? "active" : ""}">All (${accounts.length})</a>`,
      ...config.allowedDomains.map(d => {
        const count = accounts.filter(a => a.email.toLowerCase().endsWith("@" + d)).length;
        const isActive = d === selectedDomain;
        return `<a href="/dashboard?tab=inboxes&domain=${encodeURIComponent(d)}" class="${isActive ? "active" : ""}">${escHtml(d)} (${count})</a>`;
      }),
    ].join("");
    domainFilterBar = `<div class="view-toggle" style="margin-bottom:14px">${tabs}</div>`;
  }

  // Account list (shown second)
  const accountList = filteredAccounts.length === 0
    ? `<div class="card"><h2>Agent accounts</h2><p class="empty">No accounts yet — use the <code>create_account</code> MCP tool to create one.</p></div>`
    : (() => {
        const rows = filteredAccounts.map((a, i) => {
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
        const cappedNote = filteredAccounts.length > 50
          ? `<p style="font-size:.72rem;color:#aaa;margin-top:8px">Inbox counts shown for first 50 of ${filteredAccounts.length} accounts.</p>`
          : "";
        return `
          <div class="card">
            <h2>Agent accounts (${filteredAccounts.length})</h2>
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

  return domainFilterBar + testEmailForm + testCalendarForm + accountList;
}

// ---------------------------------------------------------------------------
// Batch send history card (server-side rendered)
// ---------------------------------------------------------------------------

function buildBatchHistoryCard(): string {
  const log = getBatchLog();
  if (log.length === 0) {
    return `<div class="card"><h2>Batch send history</h2><p class="empty" style="margin:0">No batch sends recorded this session.</p></div>`;
  }
  const rows = [...log].reverse().map(e => {
    const failedStyle = e.failed > 0 ? "color:#dc2626;font-weight:600" : "";
    const errDetails = e.errors.length > 0
      ? `<details style="margin-top:4px"><summary style="cursor:pointer;font-size:.78rem;color:#888">Show ${e.errors.length} error(s)</summary><ul style="margin:6px 0 0 16px;font-size:.78rem;color:#dc2626">${e.errors.map(er => `<li>${escHtml(er)}</li>`).join("")}</ul></details>`
      : "";
    return `<tr>
      <td style="white-space:nowrap;font-size:.78rem;color:#888">${new Date(e.ts).toLocaleTimeString()}</td>
      <td style="font-size:.82rem">${escHtml(e.account)}</td>
      <td style="font-family:monospace;font-size:.82rem">${escHtml(e.template_id.slice(0, 12))}…</td>
      <td class="num">${e.total}</td>
      <td class="num" style="color:#22c55e">${e.sent}</td>
      <td class="num" style="${failedStyle}">${e.failed}${errDetails}</td>
    </tr>`;
  }).join("");
  return `<div class="card">
    <h2>Batch send history <span style="font-size:.75rem;color:#aaa;font-weight:400">(last ${log.length}, newest first)</span></h2>
    <table>
      <thead><tr><th>Time</th><th>Account</th><th>Template</th><th style="text-align:right">Total</th><th style="text-align:right">Sent</th><th style="text-align:right">Failed</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
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

  // Tool breakdown table — 25 live tools
  const TOOLS = [
    // Account
    "create_account", "list_accounts", "delete_account", "configure_account",
    // Email read
    "list_emails", "read_email", "search_emails",
    // Email mutations
    "update_email", "update_thread", "classify_email",
    // Send / compose
    "send_email", "reply_to_email", "forward_email",
    "send_event_invite", "cancel_event_invite", "respond_to_invite",
    // Drafts & batch
    "manage_draft", "send_batch",
    // Organization
    "manage_folder", "manage_rule", "manage_sender_list", "manage_event",
    // Storage / data
    "manage_contact", "manage_template", "manage_webhook",
  ];
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
      <div class="metric-grid">${procCards}<div class="metric-card"><div class="metric-big" style="color:#4f46e5">${TOOLS.length}</div><div class="metric-label">Tools available</div></div></div>
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

    <div class="card" id="error-log-card">
      <details>
        <summary style="cursor:pointer;font-size:1rem;font-weight:600;padding:2px 0" id="error-log-summary">Recent errors — loading…</summary>
        <div id="error-log-body" style="margin-top:12px"></div>
      </details>
    </div>

    <div class="card">
      <h2>Recent tool calls <span style="font-size:.75rem;color:#aaa;font-weight:400">(last 200, newest first)</span></h2>
      <div class="warn-note" style="margin-bottom:12px">⚠ Resets on process restart.</div>
      <div id="tool-log-body">Loading…</div>
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

    ${buildBatchHistoryCard()}

    <div class="card">
      <h2>Component status</h2>
      ${statusGroup(checkMcpServerGroup())}
      ${statusGroup(checkSendgridGroup())}
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <script>
    (function() {
      // Tool call log fetch
      fetch('/dashboard/tool-log', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var entries = data.entries || [];
          var errEntries = entries.filter(function(e) { return e.status === 'error'; });

          // Update error log summary
          var summary = document.getElementById('error-log-summary');
          if (errEntries.length === 0) {
            summary.innerHTML = '<span style="color:#22c55e">&#10003;</span> Recent errors \u2014 none';
          } else {
            summary.innerHTML = 'Recent errors \u2014 <span style="color:#dc2626;font-weight:700">' + errEntries.length + '</span>';
            var errBody = document.getElementById('error-log-body');
            errBody.innerHTML = '<table><thead><tr><th>Time</th><th>Tool</th><th>Account</th><th>Error</th></tr></thead><tbody>' +
              errEntries.map(function(e) {
                return '<tr style="background:#fff8f8"><td style="white-space:nowrap;font-size:.78rem;color:#888">' + new Date(e.ts).toLocaleTimeString() + '</td>' +
                  '<td><code>' + e.tool + '</code></td>' +
                  '<td style="font-size:.82rem;color:#888">' + (e.account || '\u2014') + '</td>' +
                  '<td style="color:#dc2626;font-size:.82rem">' + (e.errorMsg || '') + '</td></tr>';
              }).join('') + '</tbody></table>';
          }

          // Tool call log table
          var logBody = document.getElementById('tool-log-body');
          if (entries.length === 0) {
            logBody.innerHTML = '<p style="color:#888;font-size:.88rem">No tool calls recorded yet.</p>';
            return;
          }
          logBody.innerHTML = '<table><thead><tr><th>Time</th><th>Tool</th><th>Account</th><th style="text-align:right">ms</th><th>Status</th></tr></thead><tbody>' +
            entries.slice(0, 200).map(function(e) {
              var statusHtml = e.status === 'ok'
                ? '<span class="pill green">ok</span>'
                : e.status === 'ratelimit'
                ? '<span class="pill" style="background:#fef3c7;color:#92400e">rate limit</span>'
                : e.status === 'denied'
                ? '<span class="pill" style="background:#ffedd5;color:#9a3412">denied</span>'
                : '<span class="pill red">error</span>';
              var errDetail = e.errorMsg ? '<div style="font-size:.75rem;color:#dc2626;margin-top:1px">' + e.errorMsg.slice(0, 120) + '</div>' : '';
              return '<tr><td style="white-space:nowrap;font-size:.78rem;color:#888">' + new Date(e.ts).toLocaleTimeString() + '</td>' +
                '<td><code>' + e.tool + '</code>' + errDetail + '</td>' +
                '<td style="font-size:.82rem;color:#888">' + (e.account || '\u2014') + '</td>' +
                '<td class="num" style="font-family:monospace">' + e.durationMs + '</td>' +
                '<td>' + statusHtml + '</td></tr>';
            }).join('') + '</tbody></table>';
        })
        .catch(function() {
          document.getElementById('tool-log-body').textContent = 'Failed to load log.';
          document.getElementById('error-log-summary').textContent = 'Recent errors \u2014 unavailable';
        });

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

  const calActive = activeFolder === "_calendar";
  const rulesActive = activeFolder === "_rules";

  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:18px">
      ${folderLinks}
      <span style="display:inline-block;width:1px;background:#e5e7eb;height:20px;margin:0 2px;align-self:center"></span>
      <a href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=_calendar"
        style="display:inline-block;padding:5px 12px;border-radius:20px;font-size:.82rem;font-weight:${calActive ? "600" : "500"};text-decoration:none;${calActive ? "background:#4f46e5;color:#fff" : "background:#f1f3f5;color:#555"}">📅 Calendar</a>
      <a href="/dashboard/inbox?a=${encodeURIComponent(account)}&folder=_rules"
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
        <a class="btn btn-primary" href="/dashboard/inbox?a=${encodeURIComponent(a.email)}&folder=_calendar" style="font-size:.78rem;padding:4px 10px;margin-right:4px">📅 Calendar</a>
        <a class="btn" href="/dashboard/inbox?a=${encodeURIComponent(a.email)}&folder=_rules" style="font-size:.78rem;padding:4px 10px;background:#f1f5f9;color:#475569;margin-right:4px">⚙️ Rules</a>
        <a class="btn" href="/dashboard/folders?a=${encodeURIComponent(a.email)}" style="font-size:.78rem;padding:4px 10px;background:#f1f5f9;color:#475569;margin-right:4px">📁 Folders</a>
        <a class="btn" href="/dashboard/account-settings?a=${encodeURIComponent(a.email)}" style="font-size:.78rem;padding:4px 10px;background:#f1f5f9;color:#475569">⚙ Settings</a>
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

async function buildAccountCalendarPage(account: string, month?: string, view?: string, week?: string, userTimezone?: string): Promise<string> {
  const now = new Date();
  const isWeek  = view === "week";
  const monthStr = month && /^\d{4}-\d{2}$/.test(month)
    ? month
    : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const weekStr  = week ?? now.toISOString().slice(0, 10);
  const tz = userTimezone ?? "UTC";

  const client = new JmapClient(account);
  const [eventsResult, mailboxesResult] = await Promise.allSettled([
    toolListEvents({ account }),
    client.listMailboxes(),
  ]);

  const events = eventsResult.status === "fulfilled" ? eventsResult.value.events : [];
  const fetchError = eventsResult.status === "rejected" ? String(eventsResult.reason) : null;
  const mailboxes = mailboxesResult.status === "fulfilled" ? mailboxesResult.value : [];

  const base = `/dashboard/inbox?a=${encodeURIComponent(account)}&folder=_calendar`;
  const toggleHtml = `<div class="view-toggle">
    <a href="${base}&month=${monthStr}"${!isWeek ? ` class="active"` : ""}>Month</a>
    <a href="${base}&view=week&week=${weekStr}"${isWeek ? ` class="active"` : ""}>Week</a>
  </div>`;

  // Timezone selector
  const tzOptions = COMMON_TIMEZONES.map(tzOpt =>
    `<option value="${escHtml(tzOpt)}"${tzOpt === tz ? " selected" : ""}>${escHtml(tzOpt)}</option>`
  ).join("");
  const tzSelectorHtml = `<form method="POST" action="/dashboard/action/set-timezone" style="display:inline-block;margin-bottom:12px">
    <label style="font-size:.85rem;color:#666;margin-right:6px">Timezone:</label>
    <select name="timezone" onchange="this.form.submit()" style="padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:.85rem;cursor:pointer">
      ${tzOptions}
    </select>
    <input type="hidden" name="return_url" value="${escHtml(`/dashboard/inbox?a=${encodeURIComponent(account)}&folder=_calendar${isWeek ? `&view=week&week=${weekStr}` : `&month=${monthStr}`}`)}">
  </form>`;

  const gridOrError = fetchError
    ? `<div style="padding:24px;color:#dc2626">Failed to load events: ${escHtml(fetchError)}</div>`
    : isWeek
      ? buildWeekView(events, weekStr, account, tz)
      : buildCalendarGrid(events, monthStr, account, tz);

  return page(`Calendar — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <div>
        <a class="back-link" href="/dashboard?tab=inboxes">← All accounts</a>
        <div class="page-title">${escHtml(account)}</div>
        <div class="page-sub">Calendar — ${events.length} event${events.length !== 1 ? "s" : ""} (viewing in ${escHtml(tz)})</div>
      </div>
      <div class="card" style="padding:20px">
        ${buildFolderTabBar(account, mailboxes, "_calendar")}
        ${tzSelectorHtml}
        ${toggleHtml}
        ${gridOrError}
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
        ${buildFolderTabBar(account, mailboxes, "_rules")}
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

async function buildInboxPage(account: string, folder = "Inbox", month?: string, view?: string, week?: string, userTimezone?: string): Promise<string> {
  // Pseudo-folder interception for calendar and rules views
  if (folder === "_calendar") return buildAccountCalendarPage(account, month, view, week, userTimezone);
  if (folder === "_rules")    return buildAccountRulesPage(account);

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
  const [email, foldersResult] = await Promise.all([
    toolReadEmail(account, emailId),
    toolListFolders({ account }).catch(() => ({ folders: [], count: 0 })),
  ]);
  const date = new Date(email.receivedAt).toLocaleString();
  // Fall back to preview if textBody/htmlBody are empty (e.g., calendar invites)
  const body = email.textBody ?? email.htmlBody ?? email.preview ?? "(no body)";
  const isHtml = !email.textBody && !!email.htmlBody;
  const folderOptions = foldersResult.folders
    .map(f => `<option value="${escHtml(f.name)}"${f.name === folder ? " selected" : ""}>${escHtml(f.name)}</option>`)
    .join("");

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
        <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <form method="POST" action="/dashboard/action/mark-read" style="display:inline">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <input type="hidden" name="folder" value="${escHtml(folder)}">
            <button type="submit" class="btn" style="background:#f1f5f9;color:#475569;font-size:.83rem">✓ Mark read</button>
          </form>
          <form method="POST" action="/dashboard/action/mark-unread" style="display:inline">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <input type="hidden" name="folder" value="${escHtml(folder)}">
            <button type="submit" class="btn" style="background:#f1f5f9;color:#475569;font-size:.83rem">○ Mark unread</button>
          </form>
          <form method="POST" action="/dashboard/action/flag-email" style="display:inline">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <input type="hidden" name="folder" value="${escHtml(folder)}">
            <input type="hidden" name="flagged" value="true">
            <button type="submit" class="btn" style="background:#fef9c3;color:#854d0e;font-size:.83rem">⭐ Flag</button>
          </form>
          <form method="POST" action="/dashboard/action/flag-email" style="display:inline">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <input type="hidden" name="folder" value="${escHtml(folder)}">
            <input type="hidden" name="flagged" value="false">
            <button type="submit" class="btn" style="background:#f1f5f9;color:#6b7280;font-size:.83rem">☆ Unflag</button>
          </form>
          <form method="POST" action="/dashboard/action/move-email" style="display:inline;display:flex;align-items:center;gap:4px">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <select name="folder" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:.83rem;color:#374151">
              ${folderOptions}
            </select>
            <button type="submit" class="btn" style="background:#f1f5f9;color:#475569;font-size:.83rem">→ Move</button>
          </form>
          <form method="POST" action="/dashboard/action/delete-email" style="display:inline">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="id" value="${escHtml(emailId)}">
            <button type="submit" class="btn btn-danger" onclick="return confirm('Move to Trash?')" style="font-size:.83rem">🗑 Trash</button>
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

async function buildIntegrationsPage(serviceUrl: string, flash?: { type: "ok" | "err"; msg: string }): Promise<string> {
  // Read live state from Secret Manager (falls back to env vars)
  const [smClientId, smClientSecret, smRefreshToken, smDailyKey, meetValid] = await Promise.all([
    readSecret("google-meet-client-id"),
    readSecret("google-meet-client-secret"),
    readSecret("google-meet-refresh-token"),
    readSecret("daily-api-key"),
    isMeetValid(),  // Check if the refresh token is actually valid
  ]);

  const dailyConfigured  = (config.daily.apiKey || smDailyKey || "").length > 0;
  const meetConfigured   = (config.googleMeet.refreshToken || smRefreshToken || "").length > 0;
  const meetCredsStored  = (config.googleMeet.clientId || smClientId || "").length > 0
                        && (config.googleMeet.clientSecret || smClientSecret || "").length > 0;
  const storedClientId   = config.googleMeet.clientId || smClientId || "";

  const flashHtml = flash
    ? `<div style="margin-bottom:16px;padding:12px 16px;border-radius:var(--radius);font-size:.88rem;font-weight:500;${flash.type === "ok" ? "background:var(--green-light);color:#065f46;border:1px solid #6ee7b7" : "background:var(--red-light);color:#991b1b;border:1px solid #fca5a5"}">${flash.type === "ok" ? "✓" : "✗"} ${escHtml(flash.msg)}</div>`
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
        <div style="font-size:.82rem;font-weight:600;color:#555;margin-bottom:10px">${dailyConfigured ? "Update API key" : "Setup (free tier available at daily.co)"}</div>
        <ol style="font-size:.83rem;color:#555;padding-left:18px;line-height:2;margin-bottom:14px">
          <li>Sign up at <strong>daily.co</strong> → Settings → Developers → API keys → Create key</li>
          <li>Paste it below — saved automatically, no commands needed</li>
        </ol>
        <form method="POST" action="/dashboard/integrations/daily/save" style="display:flex;gap:8px;align-items:flex-end">
          <div style="flex:1">
            <label style="font-size:.78rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Daily.co API Key</label>
            <input type="password" name="api_key" placeholder="••••••••••••••••••••" autocomplete="off"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.85rem;font-family:monospace">
          </div>
          <button type="submit" class="btn btn-primary" style="white-space:nowrap">${dailyConfigured ? "Update Key" : "Save Key"}</button>
        </form>
      </div>
    </div>`;

  // ── Google Meet card ────────────────────────────────────────────────────────
  const meetStatus = meetValid
    ? `<span class="badge ok">Connected</span>`
    : meetConfigured
    ? `<span class="badge" style="background:#dc2626">Token expired</span>`
    : `<span class="badge" style="background:#94a3b8">Not connected</span>`;

  const callbackUrl = `${serviceUrl}/dashboard/integrations/google/callback`;

  const meetConnectedSection = meetValid ? `
    <div style="display:flex;align-items:center;gap:12px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:16px">
      <span style="font-size:1.1rem">✓</span>
      <div>
        <div style="font-size:.88rem;font-weight:600;color:#166534">Google Meet connected</div>
        <div style="font-size:.78rem;color:#16a34a;margin-top:2px">Calendar invites will automatically include a Google Meet link</div>
      </div>
    </div>
    <div style="font-size:.82rem;color:#666;margin-bottom:12px">To disconnect, remove the <code>GOOGLE_MEET_REFRESH_TOKEN</code> environment variable from Cloud Run.</div>`
    : meetConfigured ? `
    <div style="display:flex;align-items:center;gap:12px;background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:16px">
      <span style="font-size:1.1rem">⚠</span>
      <div>
        <div style="font-size:.88rem;font-weight:600;color:#991b1b">Refresh token expired</div>
        <div style="font-size:.78rem;color:#dc2626;margin-top:2px">Re-authorize below to restore Google Meet video links</div>
      </div>
    </div>` : "";

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
            <input type="text" name="client_id" value="${escHtml(storedClientId)}" placeholder="123456789-abc.apps.googleusercontent.com"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.82rem;font-family:monospace;color:#1a1a2e;background:#fff">
          </div>
          <div>
            <label style="font-size:.78rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Client Secret</label>
            <input type="password" name="client_secret" value="${escHtml(config.googleMeet.clientSecret)}" placeholder="GOCSPX-••••••••••••••"
              style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.82rem;font-family:monospace;color:#1a1a2e;background:#fff">
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Connect Google Account →</button>
        <div style="font-size:.78rem;color:#999;margin-top:8px">You'll be redirected to Google to authorize with your Google account.</div>
      </form>
    </div>`;

  const meetSetupSection = meetValid ? "" : `
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
// Tab: Storage — system mailbox health + deep inspect
// ---------------------------------------------------------------------------

const SYSTEM_MAILBOX_PREFIXES: Record<string, string> = {
  calendar:  "CAL:",
  contacts:  "CONTACT:",
  templates: "TEMPLATE:",
  tokens:    "TOKEN:",
  webhooks:  "WEBHOOK:",
  scheduled: "SCHEDULED:",
  rules:     "RULE:",
  whitelist: "WHITELIST:",
  blacklist: "BLACKLIST:",
};

// ---------------------------------------------------------------------------
// Tokens tab
// ---------------------------------------------------------------------------

async function buildTokensTab(accounts: Array<{ email: string; name: string }>): Promise<string> {
  // Load all tokens from the store
  let allTokens: Awaited<ReturnType<typeof listTokens>> = [];
  let loadError = "";
  try {
    allTokens = await listTokens();
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  // Build per-account token rows
  const accountEmails = new Set(accounts.map((a) => a.email.toLowerCase()));
  const tokenRows = allTokens.map((t) => {
    const isKnownAccount = accountEmails.has(t.account.toLowerCase());
    const roleBadge = t.role === "admin"
      ? `<span class="pill purple">admin</span>`
      : `<span class="pill blue">user</span>`;
    return `
      <tr>
        <td class="mono">${escHtml(t.tokenId.slice(0, 8))}…</td>
        <td class="mono" style="font-size:.8rem">${escHtml(t.account)}${!isKnownAccount ? ' <span class="pill amber" style="vertical-align:middle">unknown</span>' : ""}</td>
        <td>${roleBadge}</td>
        <td style="color:var(--text2);font-size:.82rem">${escHtml(t.label ?? "—")}</td>
        <td style="color:var(--text3);font-size:.78rem;white-space:nowrap">${escHtml(new Date(t.createdAt).toLocaleDateString())}</td>
        <td>
          <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px">
            <form method="POST" action="/dashboard/tokens/generate" style="margin:0">
              <input type="hidden" name="account" value="${escHtml(t.account)}">
              <input type="hidden" name="label" value="regen">
              <button type="submit" class="btn btn-secondary" title="Generate a new token for this account" style="font-size:.75rem;padding:4px 10px;white-space:nowrap">
                + Token
              </button>
            </form>
            <form method="POST" action="/dashboard/tokens/revoke" style="margin:0"
                  onsubmit="return confirm('Revoke this token? The agent will immediately lose access.')">
              <input type="hidden" name="token_id" value="${escHtml(t.tokenId)}">
              <button type="submit" class="btn btn-danger" style="font-size:.75rem;padding:4px 10px;white-space:nowrap">
                Revoke
              </button>
            </form>
          </div>
        </td>
      </tr>`;
  }).join("");

  const tokensTable = allTokens.length > 0
    ? `<table><thead><tr>
         <th>ID</th><th>Account</th><th>Role</th><th>Label</th><th>Created</th><th></th>
       </tr></thead><tbody>${tokenRows}</tbody></table>`
    : `<p class="empty">${loadError ? `Error loading tokens: ${escHtml(loadError)}` : "No tokens yet. Create accounts to auto-generate tokens, or use the form below."}</p>`;

  // Build account options for the generate form
  const accountOptions = accounts
    .map((a) => `<option value="${escHtml(a.email)}">${escHtml(a.email)}</option>`)
    .join("");

  // ---------------------------------------------------------------------------
  // Admin tokens section — reveal via server-side fetch (plaintext never in DOM).
  // ---------------------------------------------------------------------------
  const adminTokenList = [...config.auth.adminTokens];
  const adminTokensHtml = config.auth.adminTokens.size > 0
    ? `<div class="card" style="border-left:3px solid var(--purple)">
         <h2 style="margin-bottom:4px">Static Admin Tokens</h2>
         <p style="color:var(--text3);font-size:.82rem;margin-bottom:14px">
           From <code>MCP_ADMIN_TOKENS</code> — bypass all account scoping. Treat these as root credentials.
         </p>
         <div style="display:flex;flex-direction:column;gap:8px">
           ${adminTokenList.map((tok, i) => {
             // Only store the masked preview — never the plaintext — in the DOM.
             // The Reveal button fetches /dashboard/tokens/reveal?i=N from the server,
             // which returns the plaintext only when the session cookie is valid.
             const masked = tok.slice(0, 8) + "••••••••••••••••••••••••" + tok.slice(-6);
             const safeId = `adm-${i}`;
             return `
               <div style="display:flex;align-items:center;gap:8px;background:var(--purple-light);border:1px solid #ddd6fe;border-radius:7px;padding:9px 12px">
                 <code id="${safeId}-display" data-index="${i}" data-masked="${escHtml(masked)}"
                   style="flex:1;font-size:.8rem;word-break:break-all;font-family:'JetBrains Mono',monospace;color:var(--purple)">${escHtml(masked)}</code>
                 <button onclick="toggleAdminToken('${safeId}')" id="${safeId}-eye" class="btn btn-secondary" style="flex-shrink:0;padding:4px 10px;font-size:.76rem">
                   Reveal
                 </button>
                 <button onclick="copyAdminToken('${safeId}')" id="${safeId}-copy" class="btn btn-primary" style="flex-shrink:0;padding:4px 10px;font-size:.76rem;background:var(--purple)" disabled>
                   Copy
                 </button>
               </div>`;
           }).join("")}
         </div>
       </div>
       <script>
         async function toggleAdminToken(id) {
           const el = document.getElementById(id + '-display');
           const eye = document.getElementById(id + '-eye');
           const copyBtn = document.getElementById(id + '-copy');
           if (el.dataset.revealed === '1') {
             el.textContent = el.dataset.masked;
             delete el.dataset.revealed;
             eye.textContent = 'Reveal';
             copyBtn.disabled = true;
             return;
           }
           eye.textContent = '…';
           eye.disabled = true;
           try {
             const res = await fetch('/dashboard/tokens/reveal?i=' + el.dataset.index);
             if (!res.ok) throw new Error('Unauthorized');
             const { token } = await res.json();
             el.textContent = token;
             el.dataset.revealed = '1';
             el.dataset.live = token;
             eye.textContent = 'Hide';
             copyBtn.disabled = false;
           } catch {
             eye.textContent = 'Reveal';
           } finally {
             eye.disabled = false;
           }
         }
         function copyAdminToken(id) {
           const el = document.getElementById(id + '-display');
           const tok = el.dataset.live;
           if (!tok) return;
           navigator.clipboard.writeText(tok).then(() => {
             const btn = document.getElementById(id + '-copy');
             btn.textContent = 'Copied!';
             setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
           });
         }
       </script>`
    : `<div class="card" style="border-left:3px solid var(--border)">
         <h2 style="margin-bottom:4px">Static Admin Tokens</h2>
         <p style="color:var(--text3);font-size:.85rem;margin:0">
           No <code>MCP_ADMIN_TOKENS</code> configured. Set this env var to add a permanent admin credential.
         </p>
       </div>`;

  return `
    <div style="display:grid;gap:16px">
      <div class="card">
        <h2>Account Tokens</h2>
        <p style="color:var(--text3);font-size:.84rem;margin-bottom:16px">
          Per-account credentials returned by <code>create_account</code>.
          Agents pass them as the <code>token</code> parameter.
          Tokens are stored hashed — use <strong>+ Token</strong> to issue a fresh one.
        </p>
        ${tokensTable}
      </div>

      <div class="card">
        <h2>Generate New Token</h2>
        <form method="POST" action="/dashboard/tokens/generate" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:200px">
            <label style="display:block;font-size:.78rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px">Account</label>
            <select name="account" required style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:.88rem;background:var(--surface);color:var(--text);font-family:'Plus Jakarta Sans',system-ui,sans-serif">
              <option value="">— select account —</option>
              ${accountOptions}
            </select>
          </div>
          <div style="flex:1;min-width:160px">
            <label style="display:block;font-size:.78rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.3px;margin-bottom:5px">Label (optional)</label>
            <input type="text" name="label" placeholder="e.g. agent-v2"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:.88rem;background:var(--surface);color:var(--text);font-family:'Plus Jakarta Sans',system-ui,sans-serif">
          </div>
          <button type="submit" class="btn btn-primary" style="white-space:nowrap">
            Generate Token
          </button>
        </form>
      </div>

      ${adminTokensHtml}
    </div>
  `;
}

async function buildStorageTab(accounts: Array<{ email: string; name: string }>): Promise<string> {
  const capped = accounts.slice(0, 20);

  // Summary table: per-account system mailbox item counts
  const summaryRows: string[] = [];
  for (const acct of capped) {
    const client = new JmapClient(acct.email);
    const counts: Record<string, number> = {};
    await Promise.allSettled(
      Object.entries(SYSTEM_MAILBOX_PREFIXES).map(async ([key, prefix]) => {
        const items = await client.listSystemEmails("_" + key).catch(() => [] as Array<{ subject: string; body: string; id: string }>);
        counts[key] = items.filter(i => i.subject.startsWith(prefix)).length;
      })
    );
    const cells = ["calendar","contacts","templates","tokens","webhooks","scheduled","rules","whitelist","blacklist"]
      .map(k => `<td class="num">${counts[k] ?? "—"}</td>`).join("");
    summaryRows.push(`<tr><td style="font-size:.85rem">${escHtml(acct.email)}</td>${cells}</tr>`);
  }

  const accountOptions = accounts.map(a => `<option value="${escHtml(a.email)}">${escHtml(a.email)}</option>`).join("");

  return `
    <div class="card">
      <h2>System mailbox summary${capped.length < accounts.length ? ` (top ${capped.length})` : ""}</h2>
      <table>
        <thead><tr><th>Account</th><th style="text-align:right">Calendar</th><th style="text-align:right">Contacts</th><th style="text-align:right">Templates</th><th style="text-align:right">Tokens</th><th style="text-align:right">Webhooks</th><th style="text-align:right">Scheduled</th><th style="text-align:right">Rules</th><th style="text-align:right">Whitelist</th><th style="text-align:right">Blacklist</th></tr></thead>
        <tbody>${summaryRows.join("") || `<tr><td colspan="10" class="empty">No accounts</td></tr>`}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Deep inspect account</h2>
      <div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">Account</label>
          <select id="inspect-account">${accountOptions}</select>
        </div>
        <button class="btn btn-primary" onclick="inspectAccount()">Inspect</button>
      </div>
      <div id="inspect-result" style="display:none"></div>
    </div>

    <script>
    function inspectAccount() {
      var acct = document.getElementById('inspect-account').value;
      var panel = document.getElementById('inspect-result');
      panel.style.display = 'block';
      panel.innerHTML = '<p style="color:#888">Loading…</p>';
      fetch('/dashboard/storage-data?account=' + encodeURIComponent(acct), { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          var html = '';
          // Warnings
          var warns = [];
          Object.keys(d.mailboxes || {}).forEach(function(k) {
            if (d.mailboxes[k].parseErrors > 0) warns.push(k + ' (' + d.mailboxes[k].parseErrors + ' parse error(s))');
          });
          if (warns.length) html += '<div class="warn-note" style="margin-bottom:12px">⚠ Parse errors detected in: ' + warns.join(', ') + ' — some entries may be silently skipped</div>';
          if ((d.mailboxes.webhooks || {}).count > 0) html += '<div class="warn-note" style="margin-bottom:12px">⚠ Webhook delivery is not yet implemented — these webhooks will never fire</div>';
          if ((d.mailboxes.scheduled || {}).count > 0) html += '<div class="warn-note" style="margin-bottom:12px">⚠ No internal scheduler — scheduled drafts require an external cron to fire</div>';
          if (d.errors && d.errors.length) html += '<div style="margin-bottom:12px;color:#dc2626;font-size:.82rem">Fetch errors: ' + d.errors.join('; ') + '</div>';

          // Counts grid
          var mb = d.mailboxes || {};
          html += '<div class="metric-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">';
          ['contacts','templates','rules','whitelist','blacklist'].forEach(function(k) {
            html += '<div class="metric-card"><div class="metric-big">' + ((mb[k] || {}).count || 0) + '</div><div class="metric-label">' + k + '</div></div>';
          });
          html += '</div>';

          // Webhooks table
          if ((mb.webhooks || {}).items && mb.webhooks.items.length) {
            html += '<h3 style="font-size:.9rem;margin-bottom:8px">Registered webhooks</h3><table><thead><tr><th>URL</th><th>Events</th><th>Registered</th></tr></thead><tbody>';
            mb.webhooks.items.forEach(function(w) {
              html += '<tr><td style="font-size:.82rem;word-break:break-all">' + w.url + '</td><td style="font-size:.78rem">' + (w.events || []).join(', ') + '</td><td style="font-size:.78rem;white-space:nowrap">' + new Date(w.createdAt).toLocaleDateString() + '</td></tr>';
            });
            html += '</tbody></table>';
          }

          // Scheduled drafts table
          if ((mb.scheduled || {}).items && mb.scheduled.items.length) {
            html += '<h3 style="font-size:.9rem;margin:16px 0 8px">Scheduled drafts</h3><table><thead><tr><th>Subject</th><th>To</th><th>Send at</th></tr></thead><tbody>';
            mb.scheduled.items.forEach(function(s) {
              var sendAt = s.send_at ? new Date(s.send_at).toLocaleString() : '—';
              var isPast = s.send_at && new Date(s.send_at) < new Date();
              html += '<tr><td style="font-size:.82rem">' + s.subject + '</td><td style="font-size:.78rem;color:#888">' + (s.to || []).slice(0,3).join(', ') + '</td><td style="font-size:.78rem;' + (isPast ? 'color:#dc2626' : '') + '">' + sendAt + (isPast ? ' (past!)' : '') + '</td></tr>';
            });
            html += '</tbody></table>';
          }

          panel.innerHTML = html;
        })
        .catch(function(e) { panel.innerHTML = '<p style="color:#dc2626">Failed to load: ' + e + '</p>'; });
    }
    </script>
  `;
}

// ---------------------------------------------------------------------------
// Page: Account Settings
// ---------------------------------------------------------------------------

async function buildAccountSettingsPage(account: string, flash?: { ok?: string; err?: string }): Promise<string> {
  const settings = await getAccountSettings(account).catch(() => ({} as Record<string, string>));
  const flashHtml = flash?.ok
    ? `<div style="margin-bottom:16px;padding:10px 16px;border-radius:6px;background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:.85rem">✓ ${escHtml(flash.ok)}</div>`
    : flash?.err
    ? `<div style="margin-bottom:16px;padding:10px 16px;border-radius:6px;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;font-size:.85rem">✗ ${escHtml(flash.err)}</div>`
    : "";

  const vacEnabled = !!(settings["vacation_reply"]);

  return page(`Account Settings — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <a class="back-link" href="/dashboard?tab=inboxes">← All accounts</a>
      <div class="page-title">${escHtml(account)}</div>
      <div class="page-sub">Account Settings</div>
      ${flashHtml}

      <div class="card">
        <h2>Display Name</h2>
        <p style="font-size:.82rem;color:#888;margin-bottom:12px">Stored in Stalwart — current value not readable from dashboard.</p>
        <form method="POST" action="/dashboard/action/configure-account" style="display:flex;gap:10px;align-items:flex-end">
          <input type="hidden" name="a" value="${escHtml(account)}">
          <input type="hidden" name="setting" value="display_name">
          <div style="flex:1"><label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">New display name</label>
            <input type="text" name="value" placeholder="e.g. Jane Smith" style="width:100%"></div>
          <button type="submit" class="btn btn-primary">Save</button>
        </form>
      </div>

      <div class="card">
        <h2>Email Signature</h2>
        <form method="POST" action="/dashboard/action/configure-account">
          <input type="hidden" name="a" value="${escHtml(account)}">
          <input type="hidden" name="setting" value="signature">
          <div style="margin-bottom:10px"><label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">Signature (plain text)</label>
            <textarea name="value" rows="4" style="width:100%;resize:vertical">${escHtml(settings["signature"] ?? "")}</textarea></div>
          <div style="display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Save</button>
            <button type="submit" name="value" value="" class="btn">Clear</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Vacation Reply <span class="pill ${vacEnabled ? "green" : "gray"}">${vacEnabled ? "Enabled" : "Disabled"}</span></h2>
        <form method="POST" action="/dashboard/action/configure-account">
          <input type="hidden" name="a" value="${escHtml(account)}">
          <input type="hidden" name="setting" value="vacation_reply">
          <div style="margin-bottom:10px"><label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">Auto-reply message</label>
            <textarea name="value" rows="4" style="width:100%;resize:vertical">${escHtml(settings["vacation_reply"] ?? "")}</textarea></div>
          <div style="display:flex;gap:8px">
            <button type="submit" class="btn btn-primary">Enable / Update</button>
            <button type="submit" name="value" value="" class="btn">Disable (clear)</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2>Email Forwarding</h2>
        <form method="POST" action="/dashboard/action/configure-account" style="display:flex;gap:10px;align-items:flex-end">
          <input type="hidden" name="a" value="${escHtml(account)}">
          <input type="hidden" name="setting" value="forwarding">
          <div style="flex:1"><label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">Forward to address</label>
            <input type="email" name="value" value="${escHtml(settings["forwarding"] ?? "")}" placeholder="forward@example.com" style="width:100%"></div>
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="submit" name="value" value="" class="btn">Disable</button>
        </form>
      </div>

      <div class="card">
        <h2>Account Status</h2>
        <p style="font-size:.82rem;color:#666;margin-bottom:12px">Suspending disables inbound delivery without deleting the account.</p>
        <div style="display:flex;gap:10px">
          <form method="POST" action="/dashboard/action/configure-account">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="setting" value="suspend">
            <button type="submit" class="btn btn-danger" onclick="return confirm('Suspend ${escHtml(account)}? Inbound delivery will stop.')">Suspend account</button>
          </form>
          <form method="POST" action="/dashboard/action/configure-account">
            <input type="hidden" name="a" value="${escHtml(account)}">
            <input type="hidden" name="setting" value="reactivate">
            <button type="submit" class="btn btn-primary">Reactivate account</button>
          </form>
        </div>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Page: Folder Management
// ---------------------------------------------------------------------------

const SYSTEM_ROLES = new Set(["inbox", "sent", "drafts", "trash", "spam", "junk", "archive"]);

async function buildFoldersPage(account: string, flash?: { ok?: string; err?: string }): Promise<string> {
  const client = new JmapClient(account);
  const mailboxes = await client.listMailboxes().catch(() => [] as Array<{ id: string; name: string; role: string; totalEmails: number; unreadEmails: number }>);
  const visible = mailboxes.filter(m => !m.name.startsWith("_"));

  const flashHtml = flash?.ok
    ? `<div style="margin-bottom:16px;padding:10px 16px;border-radius:6px;background:#dcfce7;color:#166534;border:1px solid #86efac;font-size:.85rem">✓ ${escHtml(flash.ok)}</div>`
    : flash?.err
    ? `<div style="margin-bottom:16px;padding:10px 16px;border-radius:6px;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;font-size:.85rem">✗ ${escHtml(flash.err)}</div>`
    : "";

  const userFolders = visible.filter(m => !SYSTEM_ROLES.has((m.role ?? "").toLowerCase()));
  const folderOptions = userFolders.map(m => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`).join("");

  const rows = visible
    .sort((a, b) => {
      const aSystem = SYSTEM_ROLES.has((a.role ?? "").toLowerCase());
      const bSystem = SYSTEM_ROLES.has((b.role ?? "").toLowerCase());
      if (aSystem !== bSystem) return aSystem ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map(m => {
      const isSystem = SYSTEM_ROLES.has((m.role ?? "").toLowerCase());
      const nameCell = isSystem
        ? `<span style="font-weight:600">${escHtml(m.name)}</span>`
        : `<details><summary style="cursor:pointer;font-weight:500">${escHtml(m.name)} <span style="color:#aaa;font-size:.8em">✎</span></summary>
            <form method="POST" action="/dashboard/action/rename-folder" style="display:flex;gap:6px;margin-top:6px">
              <input type="hidden" name="a" value="${escHtml(account)}">
              <input type="hidden" name="folder" value="${escHtml(m.name)}">
              <input type="text" name="new_name" value="${escHtml(m.name)}" required style="flex:1">
              <button type="submit" class="btn btn-primary" style="font-size:.78rem;padding:3px 10px">Rename</button>
            </form>
          </details>`;
      const roleCell = m.role ? `<span class="pill gray" style="font-size:.72rem">${escHtml(m.role)}</span>` : `<span style="color:#aaa">—</span>`;
      const actionsCell = isSystem ? "" : `
        <form method="POST" action="/dashboard/action/delete-folder" style="display:inline">
          <input type="hidden" name="a" value="${escHtml(account)}">
          <input type="hidden" name="folder" value="${escHtml(m.name)}">
          <button type="submit" class="btn btn-danger" style="font-size:.78rem;padding:3px 10px"
            onclick="return confirm('Delete folder ${escHtml(m.name)} and all its contents?')">Delete</button>
        </form>`;
      return `<tr>
        <td>${nameCell}</td>
        <td>${roleCell}</td>
        <td class="num">${m.totalEmails}</td>
        <td class="num">${m.unreadEmails}</td>
        <td style="text-align:right">${actionsCell}</td>
      </tr>`;
    }).join("");

  return page(`Folders — ${account}`, `
    ${topbar()}
    ${tabBar("inboxes")}
    <div class="container">
      <a class="back-link" href="/dashboard?tab=inboxes">← All accounts</a>
      <div class="page-title">${escHtml(account)}</div>
      <div class="page-sub">Folder Management — ${visible.length} folders</div>
      ${flashHtml}

      <div class="card">
        <h2>New Folder</h2>
        <form method="POST" action="/dashboard/action/create-folder" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <input type="hidden" name="a" value="${escHtml(account)}">
          <div><label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">Folder name</label>
            <input type="text" name="folder_name" required></div>
          <div><label style="display:block;font-size:.82rem;font-weight:600;margin-bottom:4px">Parent folder (optional)</label>
            <select name="parent_folder"><option value="">— top level —</option>${folderOptions}</select></div>
          <button type="submit" class="btn btn-primary">Create</button>
        </form>
      </div>

      <div class="card">
        <h2>Folders (${visible.length})</h2>
        <table>
          <thead><tr><th>Name</th><th>Role</th><th style="text-align:right">Emails</th><th style="text-align:right">Unread</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="5" class="empty">No folders</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

/** Common IANA timezone names for dashboard selector */
const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Hong_Kong",
  "Asia/Singapore",
  "Australia/Sydney",
];

/** Extract user's timezone preference from cookie, default to UTC */
function getUserTimezonePreference(req: IncomingMessage): string {
  const cookieHeader = req.headers["cookie"] ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name.trim() === "dashboardTimezone") {
      const value = rest.join("=").trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return "UTC";
      }
    }
  }
  return "UTC";
}

/** Get the timezone for an event, defaulting to UTC */
function eventTz(ev: CalendarEvent): string {
  return ev.timezone || "UTC";
}

/** Convert event time to user's timezone. Returns time string and user's timezone. */
function convertEventTimeToUser(eventDate: Date, eventTz: string, userTz: string): { time: string; tz: string } {
  // If user's timezone is same as event timezone, no conversion needed
  if (userTz === eventTz) {
    const time = eventDate.toLocaleTimeString([], { timeZone: eventTz, hour: "2-digit", minute: "2-digit" });
    return { time, tz: userTz };
  }

  // Convert: first get UTC time, then format in user's timezone
  const time = eventDate.toLocaleTimeString([], { timeZone: userTz, hour: "2-digit", minute: "2-digit" });
  return { time, tz: userTz };
}

function buildCalendarGrid(events: CalendarEvent[], monthStr: string, account: string, userTimezone: string = "UTC"): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthStr);
  const now = new Date();
  const year  = match ? parseInt(match[1], 10) : now.getFullYear();
  const month = match ? parseInt(match[2], 10) : now.getMonth() + 1;

  const firstDay = new Date(year, month - 1, 1);
  const lastDay  = new Date(year, month, 0);

  // Build date → events map (events can span multiple days, cap at 14 days)
  // Use event timezone for day bucketing, not UTC
  const byDay = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const startD = new Date(ev.start);
    const endD   = new Date(ev.end);
    const tz = eventTz(ev);

    // Convert to local date strings in event's timezone
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const startLocalStr = formatter.format(startD);
    const endLocalStr = formatter.format(endD);

    // Parse YYYY-MM-DD strings
    const startParts = startLocalStr.split("-").map(x => parseInt(x, 10));
    const endParts = endLocalStr.split("-").map(x => parseInt(x, 10));

    const cursor = new Date(startParts[0], startParts[1] - 1, startParts[2]);
    const endDay = new Date(endParts[0], endParts[1] - 1, endParts[2]);

    let span = 0;
    while (cursor <= endDay && span++ < 15) {
      const key = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(cursor);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(ev);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  // Find Monday on or before 1st of month
  const dow = (firstDay.getDay() + 6) % 7; // 0=Mon
  const totalCells = lastDay.getDate() + dow > 35 ? 42 : 35;
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() - dow);

  const todayStr = now.toISOString().slice(0, 10);
  const cells: string[] = [];
  const cursor = new Date(gridStart);
  for (let i = 0; i < totalCells; i++) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const inMonth = cursor.getMonth() === month - 1;
    const isToday = dateStr === todayStr;
    const dayEvents = byDay.get(dateStr) ?? [];

    const badges = dayEvents.map(ev => {
      const isPast = new Date(ev.end) < now;
      const titleShort = ev.title.length > 28 ? ev.title.slice(0, 26) + "…" : ev.title;
      const eventTzValue = eventTz(ev);
      const { time: displayTime, tz: displayTz } = convertEventTimeToUser(new Date(ev.start), eventTzValue, userTimezone);
      const descHtml = ev.description ? `<div style="margin-top:3px;color:#666">${escHtml(ev.description.slice(0, 100))}</div>` : "";
      const attHtml  = ev.attendees?.length ? `<div style="margin-top:3px;color:#888;font-size:.75rem">Attendees: ${escHtml(ev.attendees.slice(0, 5).join(", "))}</div>` : "";
      const tzLabel = displayTz !== "UTC" ? ` ${displayTz}` : "";
      const detailStart = new Date(ev.start).toLocaleString([], { timeZone: userTimezone });
      const detailEnd = new Date(ev.end).toLocaleTimeString([], { timeZone: userTimezone, hour: "2-digit", minute: "2-digit" });
      return `<details class="cal-event${isPast ? " cal-past" : ""}">
        <summary>${escHtml(displayTime)}${escHtml(tzLabel)} ${escHtml(titleShort)}</summary>
        <div class="cal-detail">
          <div><strong>${escHtml(ev.title)}</strong></div>
          <div style="color:#888;font-size:.78rem">${escHtml(detailStart)} – ${escHtml(detailEnd)}</div>
          ${descHtml}${attHtml}
        </div>
      </details>`;
    }).join("");

    cells.push(`<div class="cal-cell${inMonth ? "" : " cal-other-month"}${isToday ? " cal-today" : ""}">
      <div class="cal-day-num">${isToday ? `<div style="background:#4f46e5;color:#fff;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:.72rem">${cursor.getDate()}</div>` : cursor.getDate()}</div>
      ${badges}
    </div>`);

    cursor.setDate(cursor.getDate() + 1);
  }

  const prevMonth = new Date(year, month - 2, 1);
  const nextMonth = new Date(year, month, 1);
  const prevStr   = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}`;
  const nextStr   = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
  const monthLabel = firstDay.toLocaleString("default", { month: "long", year: "numeric" });
  const base = `/dashboard/inbox?a=${encodeURIComponent(account)}&folder=_calendar`;

  return `
    <div class="cal-nav">
      <a href="${base}&month=${prevStr}">‹ Prev</a>
      <strong>${escHtml(monthLabel)}</strong>
      <a href="${base}&month=${nextStr}">Next ›</a>
    </div>
    <div class="cal-grid">
      <div class="cal-header">Mon</div><div class="cal-header">Tue</div>
      <div class="cal-header">Wed</div><div class="cal-header">Thu</div>
      <div class="cal-header">Fri</div><div class="cal-header">Sat</div>
      <div class="cal-header">Sun</div>
      ${cells.join("")}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Calendar week view helper
// ---------------------------------------------------------------------------

function buildWeekView(events: CalendarEvent[], weekDateStr: string, account: string, userTimezone: string = "UTC"): string {
  const HOUR_PX = 48;
  const now = new Date();

  // Normalise anchor → Monday of that week
  let anchor = new Date(weekDateStr + "T12:00:00");
  if (isNaN(anchor.getTime())) anchor = new Date();
  const dow = (anchor.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - dow);
  monday.setHours(0, 0, 0, 0);

  const days: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  // Map each event to the days of this week it falls on
  const byDay = new Map<string, CalendarEvent[]>();
  for (const d of days) byDay.set(d.toISOString().slice(0, 10), []);
  for (const ev of events) {
    const evStart = new Date(ev.start);
    const evEnd   = new Date(ev.end);
    for (const d of days) {
      const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(d); dayEnd.setHours(23, 59, 59, 999);
      if (evStart <= dayEnd && evEnd >= dayStart) {
        byDay.get(d.toISOString().slice(0, 10))!.push(ev);
      }
    }
  }

  // Header row
  const todayStr = now.toISOString().slice(0, 10);
  const dayHeaders = days.map(d => {
    const ds = d.toISOString().slice(0, 10);
    const isToday = ds === todayStr;
    const dayName = d.toLocaleString("default", { weekday: "short" });
    const dayNum  = d.getDate();
    const numHtml = isToday
      ? `<span style="background:#4f46e5;color:#fff;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem">${dayNum}</span>`
      : `<span style="font-weight:600;font-size:.88rem">${dayNum}</span>`;
    return `<div class="week-head-cell${isToday ? " week-today-hd" : ""}">${escHtml(dayName)}<br>${numHtml}</div>`;
  }).join("");

  // Time labels (left gutter)
  const timeLabels = Array.from({ length: 24 }, (_, h) => {
    const label = h === 0 ? "" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
    return `<div class="week-time-label">${escHtml(label)}</div>`;
  }).join("");

  // Hour grid lines (reused per column)
  const hourLines = Array.from({ length: 24 }, (_, h) =>
    `<div class="week-hr${h % 1 === 0 ? " major" : ""}" style="top:${h * HOUR_PX}px"></div>`
  ).join("");

  // Current-time line (today column only)
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const nowTop  = Math.round((nowMins / 60) * HOUR_PX);

  // Build one day column with event blocks
  function renderDayCol(d: Date): string {
    const ds       = d.toISOString().slice(0, 10);
    const isToday  = ds === todayStr;
    const dayEvs   = byDay.get(ds) ?? [];
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(d); dayEnd.setHours(23, 59, 59, 999);

    // Helper: convert a Date to minutes in a specific timezone's day
    function toLocalMinutes(date: Date, tz: string, dayStart: Date, dayEnd: Date): number {
      // Clamp to day boundaries first
      let d = date;
      if (d < dayStart) d = dayStart;
      if (d > dayEnd) d = dayEnd;

      // Get local time parts in the specified timezone
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      });
      const parts = formatter.formatToParts(d);
      const hour = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
      const minute = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
      return hour * 60 + minute;
    }

    // Lane assignment for overlap handling
    type Slot = { startMins: number; endMins: number; lane: number; ev: CalendarEvent };
    const slots: Slot[] = dayEvs.map(ev => {
      const tz = eventTz(ev);
      const cs = new Date(ev.start) < dayStart ? dayStart : new Date(ev.start);
      const ce = new Date(ev.end)   > dayEnd   ? dayEnd   : new Date(ev.end);
      const startMins = toLocalMinutes(cs, tz, dayStart, dayEnd);
      const endMins   = Math.max(startMins + 15, toLocalMinutes(ce, tz, dayStart, dayEnd));
      return { startMins, endMins, lane: -1, ev };
    });
    slots.sort((a, b) => a.startMins - b.startMins);

    const laneEnds: number[] = [];
    for (const s of slots) {
      let lane = laneEnds.findIndex(e => e <= s.startMins);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(s.endMins); }
      else laneEnds[lane] = s.endMins;
      s.lane = lane;
    }
    const numLanes = Math.max(1, laneEnds.length);

    const evBlocks = slots.map(({ ev, startMins, endMins, lane }) => {
      const top    = Math.round((startMins / 60) * HOUR_PX);
      const height = Math.round(((endMins - startMins) / 60) * HOUR_PX);
      const leftPct  = numLanes > 1 ? (lane / numLanes) * 96 + 1 : 1;
      const widthStr = numLanes > 1 ? `${96 / numLanes}%` : "calc(100% - 2px)";
      const isPast   = new Date(ev.end) < now;
      const tz = eventTz(ev);
      const timeStr  = new Date(ev.start).toLocaleTimeString([], { timeZone: tz, hour: "2-digit", minute: "2-digit" });
      const endStr   = new Date(ev.end).toLocaleTimeString([], { timeZone: tz, hour: "2-digit", minute: "2-digit" });
      const descHtml = ev.description ? `<div style="margin-top:2px;color:#555">${escHtml(ev.description.slice(0, 100))}</div>` : "";
      const attHtml  = ev.attendees?.length ? `<div style="color:#888;margin-top:2px">👤 ${escHtml(ev.attendees.slice(0, 3).join(", "))}</div>` : "";
      return `<details class="week-ev${isPast ? " past" : ""}" style="top:${top}px;min-height:${height}px;left:${leftPct.toFixed(1)}%;width:${widthStr}">
        <summary>${escHtml(timeStr)} ${escHtml(ev.title)}</summary>
        <div class="week-ev-detail">
          <strong>${escHtml(ev.title)}</strong><br>
          <span style="color:#888">${escHtml(timeStr)} – ${escHtml(endStr)}</span>
          ${descHtml}${attHtml}
        </div>
      </details>`;
    }).join("");

    const nowLine = isToday
      ? `<div class="week-now-line" style="top:${nowTop}px"><span class="week-now-dot"></span></div>`
      : "";

    return `<div class="week-day-col${isToday ? " week-today-col" : ""}">${hourLines}${nowLine}${evBlocks}</div>`;
  }

  const dayCols = days.map(renderDayCol).join("");

  // Nav
  const prevMonday = new Date(monday); prevMonday.setDate(monday.getDate() - 7);
  const nextMonday = new Date(monday); nextMonday.setDate(monday.getDate() + 7);
  const prevStr    = prevMonday.toISOString().slice(0, 10);
  const nextStr    = nextMonday.toISOString().slice(0, 10);
  const base       = `/dashboard/inbox?a=${encodeURIComponent(account)}&folder=_calendar`;
  const weekLabel  = `${monday.toLocaleDateString("default", { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString("default", { month: "short", day: "numeric", year: "numeric" })}`;

  const scrollId  = `ws${monday.getTime()}`;
  const scrollTop = Math.round(8 * HOUR_PX); // scroll to 8 AM by default

  return `
    <div class="cal-nav">
      <a href="${base}&view=week&week=${prevStr}">‹ Prev</a>
      <strong>${escHtml(weekLabel)}</strong>
      <a href="${base}&view=week&week=${nextStr}">Next ›</a>
    </div>
    <div class="week-container">
      <div class="week-head">
        <div class="week-head-cell" style="background:#fafafa"></div>
        ${dayHeaders}
      </div>
      <div class="week-scroll" id="${escHtml(scrollId)}">
        <div class="week-body">
          <div class="week-time-col">${timeLabels}</div>
          ${dayCols}
        </div>
      </div>
    </div>
    <script>document.getElementById(${JSON.stringify(scrollId)}).scrollTop=${scrollTop};</script>
  `;
}

// ---------------------------------------------------------------------------
// Main dashboard page (tab routing)
// ---------------------------------------------------------------------------

async function buildDashboard(serviceUrl: string, tab: string, flash?: Omit<FlashEntry, "createdAt">, selectedDomain?: string): Promise<string> {
  const accountsResult = await toolListAccounts().catch(() => ({ accounts: [] as Array<{ email: string; name: string }>, count: 0 }));
  const accounts = accountsResult.accounts;

  let flashBanner = "";
  if (flash) {
    const isOk = flash.type === "ok";
    const bannerCls = isOk
      ? "background:var(--green-light);color:#065f46;border:1px solid #6ee7b7"
      : "background:var(--red-light);color:#991b1b;border:1px solid #fca5a5";
    if (flash.token) {
      flashBanner = `
        <div style="padding:14px 16px;border-radius:var(--radius);font-size:.88rem;${bannerCls}">
          <div style="font-weight:600;margin-bottom:10px">${isOk ? "✓" : "✗"} ${escHtml(flash.msg)}</div>
          <div style="display:flex;gap:8px;align-items:center;background:rgba(0,0,0,.07);border-radius:7px;padding:9px 12px">
            <code id="flash-token" style="flex:1;font-size:.8rem;word-break:break-all;user-select:all;font-family:'JetBrains Mono',monospace">${escHtml(flash.token)}</code>
            <button onclick="copyFlashToken()" id="flash-copy-btn" class="btn btn-primary" style="flex-shrink:0;font-size:.76rem;padding:5px 12px">
              Copy
            </button>
          </div>
          <div style="margin-top:8px;font-size:.76rem;opacity:.75;font-weight:500">⚠ Save this token — it will not be shown again.</div>
        </div>
        <script>
          function copyFlashToken() {
            const t = document.getElementById('flash-token').textContent;
            navigator.clipboard.writeText(t).then(() => {
              const btn = document.getElementById('flash-copy-btn');
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
            }).catch(() => {
              document.getElementById('flash-token').select && document.getElementById('flash-token').select();
            });
          }
        </script>`;
    } else {
      flashBanner = `<div style="padding:12px 16px;border-radius:var(--radius);font-size:.88rem;font-weight:500;white-space:pre-wrap;word-break:break-all;${bannerCls}">${isOk ? "✓" : "✗"} ${escHtml(flash.msg)}</div>`;
    }
  }

  let content: string;
  if (tab === "inboxes") {
    content = (flashBanner ? `<div>${flashBanner}</div>` : "") + await buildInboxesTab(accounts, selectedDomain);
  } else if (tab === "metrics") {
    content = await buildMetricsTab(accounts);
  } else if (tab === "tokens") {
    content = (flashBanner ? `<div>${flashBanner}</div>` : "") + await buildTokensTab(accounts);
  } else if (tab === "calendars") {
    content = await buildCalendarsTab(accounts);
  } else if (tab === "storage") {
    content = await buildStorageTab(accounts);
  } else {
    content = await buildOverview(serviceUrl, accounts);
  }

  const activeTab = tab === "inboxes" ? "inboxes"
    : tab === "metrics" ? "metrics"
    : tab === "tokens" ? "tokens"
    : tab === "calendars" ? "calendars"
    : tab === "storage" ? "storage"
    : tab === "integrations" ? "integrations"
    : "overview";

  return page("Dashboard", `
    ${topbar(selectedDomain)}
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

  // GET /dashboard/tool-log — recent tool call log (newest first)
  if (path === "/dashboard/tool-log") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ entries: [...getCallLog()].reverse() }));
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

  // POST /dashboard/action/set-timezone
  if (path === "/dashboard/action/set-timezone" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const tz = form["timezone"] ?? "UTC";
    const returnUrl = form["return_url"] ?? "/dashboard";
    // Validate timezone by attempting to use it
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      const encodedTz = encodeURIComponent(tz);
      res.writeHead(302, {
        "Set-Cookie": `dashboardTimezone=${encodedTz}; Path=/dashboard; SameSite=Lax; Max-Age=31536000`,
        "Location": returnUrl,
      });
    } catch {
      // Invalid timezone, redirect without setting cookie
      res.writeHead(302, { "Location": returnUrl });
    }
    res.end();
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

  // POST /dashboard/action/send-test-calendar
  if (path === "/dashboard/action/send-test-calendar" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const from = form["from"] ?? "";
    const to = form["to"] ?? "";
    const title = form["title"] ?? "Test Meeting";
    const description = form["description"] ?? "Test calendar invite with auto-generated video link";
    const startStr = form["start"] ?? "2026-04-15T14:00";
    const endStr = form["end"] ?? "2026-04-15T14:30";
    const timezone = form["timezone"] ?? "UTC";
    try {
      // Parse datetime-local format as local time in the given timezone, then convert to UTC
      // datetime-local gives "YYYY-MM-DDTHH:MM" which represents local time (no timezone info)
      // We need to interpret it in the user's timezone and convert to ISO string
      const convertLocalToUtc = (localDateStr: string, tz: string): string => {
        // Create a date assuming the string is UTC (temporary)
        const tempDate = new Date(localDateStr + ":00Z");
        // Use Intl to get the offset for the target timezone
        const formatter = new Intl.DateTimeFormat("en-US", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          timeZone: tz,
        });
        const parts = formatter.formatToParts(tempDate);
        const tzDate = new Date(
          parseInt(parts.find(p => p.type === "year")!.value),
          parseInt(parts.find(p => p.type === "month")!.value) - 1,
          parseInt(parts.find(p => p.type === "day")!.value),
          parseInt(parts.find(p => p.type === "hour")!.value),
          parseInt(parts.find(p => p.type === "minute")!.value),
          parseInt(parts.find(p => p.type === "second")!.value),
        );
        const offset = tempDate.getTime() - tzDate.getTime();
        const utcDate = new Date(new Date(localDateStr + ":00").getTime() + offset);
        return utcDate.toISOString();
      };
      const start = convertLocalToUtc(startStr, timezone);
      const end = convertLocalToUtc(endStr, timezone);
      await toolSendEventInvite({
        fromAccount: from,
        to,
        title,
        start,
        end,
        description,
        timezone,
      });
      res.writeHead(302, { "Location": `/dashboard?tab=inboxes&ok=${encodeURIComponent("Calendar invite sent! Check the email for the video link.")}` });
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
    const returnFolder = form["folder"] ?? "Inbox";
    try {
      await toolDeleteEmail(account, emailId);
    } catch { /* ignore — redirect anyway */ }
    res.writeHead(302, { "Location": `/dashboard/inbox?a=${encodeURIComponent(account)}&folder=${encodeURIComponent(returnFolder)}` });
    res.end();
    return;
  }

  // POST /dashboard/action/mark-read
  if (path === "/dashboard/action/mark-read" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = form["a"] ?? "";
    const emailId = form["id"] ?? "";
    const returnFolder = form["folder"] ?? "Inbox";
    try { await toolMarkAsRead(account, emailId); } catch { /* ignore */ }
    res.writeHead(302, { "Location": `/dashboard/email?a=${encodeURIComponent(account)}&id=${encodeURIComponent(emailId)}&folder=${encodeURIComponent(returnFolder)}` });
    res.end();
    return;
  }

  // POST /dashboard/action/mark-unread
  if (path === "/dashboard/action/mark-unread" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = form["a"] ?? "";
    const emailId = form["id"] ?? "";
    const returnFolder = form["folder"] ?? "Inbox";
    try { await toolMarkAsUnread(account, emailId); } catch { /* ignore */ }
    res.writeHead(302, { "Location": `/dashboard/email?a=${encodeURIComponent(account)}&id=${encodeURIComponent(emailId)}&folder=${encodeURIComponent(returnFolder)}` });
    res.end();
    return;
  }

  // POST /dashboard/action/flag-email
  if (path === "/dashboard/action/flag-email" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = form["a"] ?? "";
    const emailId = form["id"] ?? "";
    const returnFolder = form["folder"] ?? "Inbox";
    const flagged = form["flagged"] === "true";
    try { await toolFlagEmail(account, emailId, flagged); } catch { /* ignore */ }
    res.writeHead(302, { "Location": `/dashboard/email?a=${encodeURIComponent(account)}&id=${encodeURIComponent(emailId)}&folder=${encodeURIComponent(returnFolder)}` });
    res.end();
    return;
  }

  // POST /dashboard/action/move-email
  if (path === "/dashboard/action/move-email" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = form["a"] ?? "";
    const emailId = form["id"] ?? "";
    const targetFolder = form["folder"] ?? "Inbox";
    try { await toolMoveEmail({ account, email_id: emailId, folder: targetFolder }); } catch { /* ignore */ }
    res.writeHead(302, { "Location": `/dashboard/inbox?a=${encodeURIComponent(account)}&folder=${encodeURIComponent(targetFolder)}` });
    res.end();
    return;
  }

  // GET /dashboard/inbox?a=email&folder=Inbox
  if (path === "/dashboard/inbox") {
    const account = url.searchParams.get("a") ?? "";
    const folder = url.searchParams.get("folder") ?? "Inbox";
    const month = url.searchParams.get("month") ?? undefined;
    const view  = url.searchParams.get("view")  ?? undefined;
    const week  = url.searchParams.get("week")  ?? undefined;
    if (!account) {
      res.writeHead(302, { "Location": "/dashboard?tab=inboxes" });
      res.end();
      return;
    }
    try {
      const userTimezone = getUserTimezonePreference(req);
      const html = await buildInboxPage(account, folder, month, view, week, userTimezone);
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

  // GET /dashboard/account-settings?a=<email>
  if (path === "/dashboard/account-settings") {
    const account = url.searchParams.get("a") ?? "";
    if (!account) { res.writeHead(302, { "Location": "/dashboard?tab=inboxes" }); res.end(); return; }
    const flash = url.searchParams.get("ok") ? { ok: url.searchParams.get("ok")! }
      : url.searchParams.get("err") ? { err: url.searchParams.get("err")! } : undefined;
    try {
      const html = await buildAccountSettingsPage(account, flash);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Error", `<div class="container" style="padding-top:40px"><div class="card"><p style="color:#dc2626">Error: ${escHtml(String(e))}</p><a href="/dashboard?tab=inboxes" class="back-link">← Back</a></div></div>`));
    }
    return;
  }

  // GET /dashboard/folders?a=<email>
  if (path === "/dashboard/folders") {
    const account = url.searchParams.get("a") ?? "";
    if (!account) { res.writeHead(302, { "Location": "/dashboard?tab=inboxes" }); res.end(); return; }
    const flash = url.searchParams.get("ok") ? { ok: url.searchParams.get("ok")! }
      : url.searchParams.get("err") ? { err: url.searchParams.get("err")! } : undefined;
    try {
      const html = await buildFoldersPage(account, flash);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page("Error", `<div class="container" style="padding-top:40px"><div class="card"><p style="color:#dc2626">Error: ${escHtml(String(e))}</p><a href="/dashboard?tab=inboxes" class="back-link">← Back</a></div></div>`));
    }
    return;
  }

  // GET /dashboard/storage-data?account=<email> — JSON endpoint for storage inspect panel
  if (path === "/dashboard/storage-data") {
    const account = url.searchParams.get("account") ?? "";
    if (!account) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "missing account" })); return; }
    try {
      const client = new JmapClient(account);
      const prefixes: Record<string, string> = {
        contacts:  "CONTACT:",
        templates: "TEMPLATE:",
        webhooks:  "WEBHOOK:",
        scheduled: "SCHEDULED:",
        rules:     "RULE:",
        whitelist: "WHITELIST:",
        blacklist: "BLACKLIST:",
      };
      const results = await Promise.allSettled(
        Object.entries(prefixes).map(async ([key, prefix]) => {
          const items = await client.listSystemEmails(key === "contacts" ? "_contacts"
            : key === "templates" ? "_templates"
            : key === "webhooks"  ? "_webhooks"
            : key === "scheduled" ? "_scheduled"
            : key === "rules"     ? "_rules"
            : key === "whitelist" ? "_whitelist"
            : "_blacklist");
          let parseErrors = 0;
          for (const item of items) {
            if (item.subject?.startsWith(prefix)) {
              try { JSON.parse(item.body || "{}"); } catch { parseErrors++; }
            }
          }
          return { key, count: items.length, parseErrors };
        })
      );
      const data: Record<string, { count: number; parseErrors: number }> = {};
      for (const r of results) {
        if (r.status === "fulfilled") data[r.value.key] = { count: r.value.count, parseErrors: r.value.parseErrors };
        else data["error"] = { count: 0, parseErrors: 0 };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // POST /dashboard/action/configure-account
  if (path === "/dashboard/action/configure-account" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = (form["a"] ?? "").trim();
    const setting = (form["setting"] ?? "").trim();
    const value   = form["value"] ?? "";
    if (!account || !setting) {
      res.writeHead(302, { "Location": "/dashboard?tab=inboxes" }); res.end(); return;
    }
    try {
      await toolConfigureAccount({ account, setting: setting as Parameters<typeof toolConfigureAccount>[0]["setting"], value: value || undefined });
      const ok = setting === "suspend" ? "Account suspended" : setting === "reactivate" ? "Account reactivated" : `${setting} updated`;
      res.writeHead(302, { "Location": `/dashboard/account-settings?a=${encodeURIComponent(account)}&ok=${encodeURIComponent(ok)}` });
    } catch (e) {
      res.writeHead(302, { "Location": `/dashboard/account-settings?a=${encodeURIComponent(account)}&err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}` });
    }
    res.end();
    return;
  }

  // POST /dashboard/action/create-folder
  if (path === "/dashboard/action/create-folder" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = (form["a"] ?? "").trim();
    const folderName = (form["folder_name"] ?? "").trim();
    const parentFolder = (form["parent_folder"] ?? "").trim() || undefined;
    if (!account || !folderName) { res.writeHead(302, { "Location": "/dashboard?tab=inboxes" }); res.end(); return; }
    try {
      await toolCreateFolder({ account, name: folderName, parent_folder: parentFolder });
      res.writeHead(302, { "Location": `/dashboard/folders?a=${encodeURIComponent(account)}&ok=${encodeURIComponent(`Folder "${folderName}" created`)}` });
    } catch (e) {
      res.writeHead(302, { "Location": `/dashboard/folders?a=${encodeURIComponent(account)}&err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}` });
    }
    res.end();
    return;
  }

  // POST /dashboard/action/rename-folder
  if (path === "/dashboard/action/rename-folder" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = (form["a"] ?? "").trim();
    const folder  = (form["folder"] ?? "").trim();
    const newName = (form["new_name"] ?? "").trim();
    if (!account || !folder || !newName) { res.writeHead(302, { "Location": "/dashboard?tab=inboxes" }); res.end(); return; }
    try {
      const client = new JmapClient(account);
      await client.renameMailbox(folder, newName);
      res.writeHead(302, { "Location": `/dashboard/folders?a=${encodeURIComponent(account)}&ok=${encodeURIComponent(`Folder renamed to "${newName}"`)}` });
    } catch (e) {
      res.writeHead(302, { "Location": `/dashboard/folders?a=${encodeURIComponent(account)}&err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}` });
    }
    res.end();
    return;
  }

  // POST /dashboard/action/delete-folder
  if (path === "/dashboard/action/delete-folder" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = (form["a"] ?? "").trim();
    const folder  = (form["folder"] ?? "").trim();
    if (!account || !folder) { res.writeHead(302, { "Location": "/dashboard?tab=inboxes" }); res.end(); return; }
    try {
      await toolDeleteFolder({ account, folder });
      res.writeHead(302, { "Location": `/dashboard/folders?a=${encodeURIComponent(account)}&ok=${encodeURIComponent(`Folder "${folder}" deleted`)}` });
    } catch (e) {
      res.writeHead(302, { "Location": `/dashboard/folders?a=${encodeURIComponent(account)}&err=${encodeURIComponent(e instanceof Error ? e.message : String(e))}` });
    }
    res.end();
    return;
  }

  // ── Token routes ───────────────────────────────────────────────────────────

  // GET /dashboard/tokens/reveal?i=N — server-side reveal for static admin token N.
  // Plaintext is returned via authenticated JSON fetch; never embedded in HTML.
  if (path === "/dashboard/tokens/reveal" && req.method === "GET") {
    const idxStr = url.searchParams.get("i") ?? "";
    const idx = parseInt(idxStr, 10);
    const adminTokenList = [...config.auth.adminTokens];
    if (isNaN(idx) || idx < 0 || idx >= adminTokenList.length) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ token: adminTokenList[idx] }));
    return;
  }

  // POST /dashboard/tokens/generate — create a new token for an account
  if (path === "/dashboard/tokens/generate" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const account = (form["account"] ?? "").trim();
    const label   = (form["label"] ?? "").trim() || undefined;
    if (!account) {
      res.writeHead(302, { "Location": "/dashboard?tab=tokens&err=" + encodeURIComponent("Account is required") });
      res.end();
      return;
    }
    try {
      const { plaintext } = await createToken(account, "user", label);
      // Store the plaintext in the server-side flash store (not in the URL) so it
      // never appears in browser history, HTTP access logs, or Referer headers.
      const msg = `Token created for ${account}${label ? ` (${label})` : ""}`;
      const flashId = setFlash(msg, "ok", { token: plaintext });
      res.writeHead(302, { "Location": "/dashboard?tab=tokens&flash=" + flashId });
    } catch (e) {
      res.writeHead(302, { "Location": "/dashboard?tab=tokens&err=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) });
    }
    res.end();
    return;
  }

  // POST /dashboard/tokens/revoke — revoke a token by ID
  if (path === "/dashboard/tokens/revoke" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const tokenId = (form["token_id"] ?? "").trim();
    if (!tokenId) {
      res.writeHead(302, { "Location": "/dashboard?tab=tokens&err=" + encodeURIComponent("token_id is required") });
      res.end();
      return;
    }
    try {
      const ok = await revokeToken(tokenId);
      if (ok) {
        res.writeHead(302, { "Location": "/dashboard?tab=tokens&ok=" + encodeURIComponent(`Token ${tokenId.slice(0, 8)}… revoked`) });
      } else {
        res.writeHead(302, { "Location": "/dashboard?tab=tokens&err=" + encodeURIComponent(`Token not found: ${tokenId}`) });
      }
    } catch (e) {
      res.writeHead(302, { "Location": "/dashboard?tab=tokens&err=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) });
    }
    res.end();
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

  // POST /dashboard/integrations/daily/save — save Daily.co key to Secret Manager
  if (path === "/dashboard/integrations/daily/save" && req.method === "POST") {
    const body = await readBody(req);
    const form = parseFormBody(body);
    const apiKey = (form["api_key"] ?? "").trim();
    if (!apiKey) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent("API key must not be empty") });
      res.end();
      return;
    }
    try {
      await writeSecret("daily-api-key", apiKey);
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&ok=" + encodeURIComponent("Daily.co API key saved — active immediately") });
    } catch (e) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) });
    }
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

      // Auto-save all three credentials to Secret Manager
      await Promise.all([
        writeSecret("google-meet-client-id",     creds.clientId),
        writeSecret("google-meet-client-secret",  creds.clientSecret),
        writeSecret("google-meet-refresh-token",  refreshToken),
      ]);

      res.writeHead(302, { "Location": "/dashboard?tab=integrations&ok=" + encodeURIComponent(`Google Meet connected as ${email}`) });
      res.end();
    } catch (e) {
      res.writeHead(302, { "Location": "/dashboard?tab=integrations&err=" + encodeURIComponent(e instanceof Error ? e.message : String(e)) });
      res.end();
    }
    return;
  }

  // GET /dashboard (main tabbed view)
  const tab = url.searchParams.get("tab") ?? "overview";
  const selectedDomain = url.searchParams.get("domain") ?? undefined;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers["host"] ?? `localhost:${config.port}`;
  const serviceUrl = `${proto}://${host}`;

  let flash: Omit<FlashEntry, "createdAt"> | undefined;
  const flashId = url.searchParams.get("flash");
  if (flashId) {
    flash = consumeFlash(flashId);
  } else if (url.searchParams.get("sent") === "1") {
    flash = { type: "ok", msg: "Test email sent successfully." };
  } else if (url.searchParams.get("ok")) {
    flash = { type: "ok", msg: url.searchParams.get("ok")! };
  } else if (url.searchParams.get("err")) {
    flash = { type: "err", msg: url.searchParams.get("err")! };
  }

  if (tab === "integrations") {
    const flashMsg = url.searchParams.get("err")
      ? { type: "err" as const, msg: url.searchParams.get("err")! }
      : url.searchParams.get("ok")
      ? { type: "ok" as const, msg: url.searchParams.get("ok")! }
      : undefined;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await buildIntegrationsPage(serviceUrl2, flashMsg));
    return;
  }

  const html = await buildDashboard(serviceUrl, tab, flash, selectedDomain);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
