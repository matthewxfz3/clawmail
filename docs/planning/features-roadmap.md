# Clawmail — Agent Feature Roadmap

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done

---

## Architecture Principles

MCP gives you three primitives. Use all three — most servers only implement tools because
they're familiar, but Resources and Prompts exist precisely because not everything should be a tool.

```
Tools     → actions  (state changes, writes, side effects)
Resources → data     (reads, subscriptions, live state)
Prompts   → workflows (parameterized multi-step patterns)
```

### Rules for this codebase

| Rule | Rationale |
|---|---|
| **Tools = verbs with side effects only** | If the operation is "give me data," it's a Resource |
| **≤ 30 tools total** | Each tool costs ~75 tokens of context overhead on every request; 100 tools = 7,500 wasted tokens |
| **Consolidate CRUD with `action` params** | 5 tools for one entity → 1 tool with `action: "create"\|"update"\|"delete"\|"list"` |
| **Rich params over proliferating tools** | `search_emails(query, mode, fields, after, before)` > separate tools per filter type |
| **Prompts for multi-step workflows** | `triage_inbox` should be a Prompt, not a compound tool |
| **Resources for all read/list operations** | `list_emails`, `get_thread`, `list_contacts` → Resources |
| **Descriptions say when NOT to use a tool** | Prevents wrong-tool selection when options look similar |

---

## Target Architecture

| Primitive | Count | Purpose |
|---|---|---|
| Tools | ~26 | Actions: send, delete, create, update |
| Resources | ~9 | Data: inbox, threads, contacts, calendar |
| Prompts | ~7 | Workflows: triage, draft reply, schedule meeting |
| **Total** | **~41** | vs. 100+ tools-only approach |

---

## Implementation Todo

### P0 — Correctness Fixes
- [x] Structured error envelopes — `{ ok, error: { code, message, retryable } }` on all tools (`lib/errors.ts`)
- [x] Idempotency keys — `idempotency_key` param on `send_email`, `reply_to_email`, `forward_email`; 24h in-memory TTL store (`lib/idempotency.ts`)
- [x] `REDIS_URL` config wired — ready for distributed rate limiter when Memorystore is provisioned
- [ ] Distributed rate limiter — replace in-memory `Map` in `index.ts:67` with Redis sliding window (requires `ioredis` + `REDIS_URL`)
- [ ] `list_emails` fields param — add `fields` param to trim response to `id,subject,from,date,is_read` by default
- [ ] Auto-apply rules on inbound — move `apply_rules` trigger server-side; tool becomes "apply to historical mail" only
- [ ] `normalizeError()` across all tool `catch` blocks — currently still using `errContent(err.message)` in most tools

### MCP Resources
- [x] Declare `resources: {}` capability in `createMcpServer()`
- [x] `email://inbox/{account}` — live inbox view, up to 50 summaries
- [x] `email://thread/{account}/{thread_id}` — full thread ordered oldest-first; `JmapClient.getThread()` added
- [x] `email://drafts/{account}` — pending drafts list (manage_draft stores in JMAP Drafts mailbox, readable via list_emails)
- [ ] `email://sent/{account}` — recent sent mail
- [ ] `email://contact/{account}/{address}` — contact record + notes + history
- [ ] `email://contacts/{account}` — full address book
- [ ] `calendar://events/{account}` — upcoming events
- [ ] `account://status/{account}` — quota, unread count, send volume, rate limit headroom
- [x] `account://config/{account}` — folders, labels, rules, whitelist/blacklist, settings snapshot

### MCP Prompts
- [ ] Declare `prompts: {}` capability in `createMcpServer()`
- [ ] `triage_inbox` — inbox resource → classify × N → rank → return
- [ ] `draft_reply` — thread resource → compose → manage_draft
- [ ] `summarize_thread` — thread resource → compress → return
- [ ] `schedule_meeting` — check_availability × N → find slot → draft invite
- [ ] `onboard_persona` — create_account → configure_account × 3
- [ ] `process_inbox` — apply rules → sender list → digest
- [ ] `cold_outreach` — manage_contact → manage_template → send_batch

### Tool Consolidation
- [x] `update_email(action: ...)` — replaces mark_as_read, mark_as_unread, flag_email, move_email, delete_email + bulk ops (7 → 1); `email_ids: string|string[]`
- [x] `classify_email(as: ...)` — replaces mark_as_spam, mark_as_not_spam (2 → 1)
- [x] `manage_folder(action: ...)` — replaces create_folder, delete_folder + new rename (2 → 1); `JmapClient.renameMailbox()` added
- [x] `manage_rule(action: ...)` — replaces create_rule, delete_rule, apply_rules (3 → 1); list → `account://config` Resource
- [x] `manage_sender_list(list, action: ...)` — replaces add/remove whitelist/blacklist (4 → 1)
- [x] `manage_event(action: ...)` — replaces create_event, update_event, delete_event (3 → 1)
- [x] `configure_account(setting: ...)` — display_name via Stalwart PATCH; signature/vacation_reply/forwarding via `_settings` mailbox; suspend/reactivate via permissions
- [x] `manage_draft(action: ...)` — create/update/send/delete/schedule; JMAP Drafts mailbox + `_scheduled` system store; `JmapClient.saveDraft()` + `updateDraft()` added
- [x] `respond_to_invite` — iCalendar METHOD:REPLY with PARTSTAT; threads reply to organizer via original email headers
- [x] `manage_contact(action: ...)` — create/update/delete via `_contacts` system mailbox
- [x] `update_thread(action: ...)` — archive/delete/mute/add_label/remove_label; `JmapClient.updateThread()` added
- [x] `manage_template(action: ...)` — create/update/delete via `_templates` system mailbox; `{{variable}}` substitution
- [x] `send_batch` — send template to up to 500 recipients with per-recipient variable injection
- [x] `manage_webhook(action: ...)` — register/unregister with HMAC secret via `_webhooks` system mailbox
- [x] Remove 34 deprecated tools — 45 → 25 tool surface

---

## P0 — Fix Before Building

> Correctness bugs in current code. Undermine every other tool. Fix first.

| # | Issue | Location | Problem | Fix |
|---|---|---|---|---|
| 1 | **In-memory rate limiter** | `index.ts:67` | Cloud Run N instances each have independent state — limits are unenforceable | Move to Redis/Memorystore |
| 2 | **Non-machine-readable errors** | `index.ts:107` | Agents string-parse human error messages | `{ ok: false, error: { code, message, retryable } }` on all tools |
| 3 | **No idempotency on sends** | `send_email` et al. | Agent retry on network failure → duplicate emails | `idempotency_key` param; Redis store 24h TTL |
| 4 | **`list_emails` returns full previews** | `tools/mailbox.ts` | Full body snippets on every poll burns context | Add `fields` param; default `id,subject,from,date,is_read` |
| 5 | **Rules/spam are manual-trigger** | `tools/rules.ts` | Agents forget to call `apply_rules` | Auto-apply server-side on inbound; tools become "apply to historical mail" only |
| 6 | **Inconsistent error text** | All tools | Mix of formats across files | Single `normalizeError()` wrapping all `catch` blocks |

---

# Tools (~25 target)

Organized by domain. Each tool is a **state-changing action** — no pure reads.

---

## Account

| Tool | Params | Replaces | Status |
|---|---|---|---|
| `create_account` ✓ | `local_part`, `template?` | — | done (now returns scoped `token`) |
| `delete_account` ✓ | `local_part` | — | done (now revokes all tokens on deletion) |
| `manage_token` ✓ | `action: "create"\|"list"\|"revoke"`, `account?`, `token_id?`, `label?` | `list_api_keys`, `revoke_api_key` from Infrastructure section | done |
| `configure_account` | `account`, `setting: "display_name"\|"signature"\|"availability_window"\|"vacation_reply"\|"forwarding"`, `value` | set_display_name, create_signature, set_availability_window, set_vacation_reply, set_forwarding_rule — 5 tools → 1 | [ ] |
| `suspend_account` | `account`, `action: "suspend"\|"reactivate"` | suspend_account, reactivate_account — 2 → 1 | [ ] |
| `manage_account_template` | `action: "create"\|"delete"\|"list"\|"apply"`, `name?`, `config?`, `account?` | create_account_template, provision_from_template — 2 → 1 | [ ] |

---

## Email — Write

| Tool | Params | Notes | Status |
|---|---|---|---|
| `send_email` ✓ | `from_account`, `to`, `subject`, `body`, `body_html?`, `attachments?`, `cc?`, `bcc?`, `reply_to?`, `priority?`, `list_unsubscribe?`, `idempotency_key?` | Add `body_html`, `reply_to`, `priority`, `list_unsubscribe`, `idempotency_key` to existing tool | [~] |
| `reply_to_email` ✓ | `from_account`, `email_id`, `body`, `reply_all?`, `idempotency_key?` | Add `idempotency_key` | [~] |
| `forward_email` ✓ | `from_account`, `email_id`, `to`, `body?`, `idempotency_key?` | Add `idempotency_key` | [~] |

---

## Email — State

| Tool | Params | Replaces | Status |
|---|---|---|---|
| `update_email` | `account`, `email_id`, `action: "mark_read"\|"mark_unread"\|"flag"\|"unflag"\|"archive"\|"move"\|"delete"`, `folder?` | mark_as_read, mark_as_unread, flag_email, move_email, delete_email — 5 tools → 1 | [ ] |
| `bulk_update_emails` ✓ | `account`, `email_ids[]`, `action`, `folder?` | bulk_move_emails, bulk_delete_emails, bulk_add_label — consolidate further | [~] |
| `update_thread` | `account`, `thread_id`, `action: "archive"\|"delete"\|"mute"\|"label"\|"set_metadata"`, `label?`, `metadata?` | archive_thread, delete_thread, label_thread, mute_thread, set_thread_metadata — 5 → 1 | [ ] |
| `classify_email` | `account`, `email_id`, `as: "spam"\|"not_spam"` | mark_as_spam, mark_as_not_spam — 2 → 1 | [ ] |
| `manage_label` | `account`, `action: "add"\|"remove"`, `email_id`, `label` | add_label, remove_label — 2 → 1 (list_labels → Resource) | [ ] |

---

## Email — Search & Drafts

| Tool | Params | Notes | Status |
|---|---|---|---|
| `search_emails` ✓ | `account`, `query`, `mode?: "text"\|"semantic"`, `fields?`, `after?`, `before?`, `from?`, `has_attachment?`, `in_folder?`, `is_unread?`, `include_spam?` | Extend existing; operators baked in as params, not a separate tool per operator | [~] |
| `manage_draft` | `account`, `action: "create"\|"update"\|"send"\|"delete"`, `draft_id?`, `subject?`, `body?`, `to?`, `idempotency_key?` | create_draft, update_draft, send_draft, delete_draft — 4 → 1 (list_drafts → Resource) | [ ] |

---

## Folders & Rules

| Tool | Params | Replaces | Status |
|---|---|---|---|
| `manage_folder` ✓ | `account`, `action: "create"\|"delete"\|"rename"`, `folder`, `new_name?` | create_folder, delete_folder — 2 → 1 (list_folders → Resource) | [~] |
| `manage_rule` | `account`, `action: "create"\|"delete"\|"apply"`, `rule_id?`, `name?`, `condition?`, `rule_action?` | create_rule, list_rules, delete_rule, apply_rules — 4 → 1 (list → Resource) | [ ] |
| `manage_sender_list` | `account`, `list: "whitelist"\|"blacklist"`, `action: "add"\|"remove"`, `address` | add_to_whitelist, remove_from_whitelist, add_to_blacklist, remove_from_blacklist — 4 → 1 (list → Resource) | [ ] |

---

## Calendar

| Tool | Params | Notes | Status |
|---|---|---|---|
| `create_event` ✓ | `account`, `title`, `start`, `end`, `description?`, `attendees?`, `recurrence?`, `location?` | Add `recurrence` RRULE param | [~] |
| `update_event` ✓ | `account`, `event_id`, `...fields` | — | done |
| `delete_event` ✓ | `account`, `event_id` | — | done |
| `send_event_invite` ✓ | `from_account`, `to`, `title`, `start`, `end`, `...` | — | done |
| `cancel_event_invite` ✓ | `from_account`, `to`, `uid`, `...` | — | done |
| `respond_to_invite` | `account`, `email_id`, `response: "accept"\|"decline"\|"propose"`, `proposed_time?` | accept_event_invite, decline_event_invite, propose_new_time — 3 → 1 | [ ] |

---

## Contacts

| Tool | Params | Replaces | Status |
|---|---|---|---|
| `manage_contact` | `account`, `action: "create"\|"update"\|"delete"`, `email`, `name?`, `notes?`, `vip?`, `metadata?` | add_contact, update_contact, delete_contact — 3 → 1 (get/list → Resource) | [ ] |

---

## Outreach & Webhooks

| Tool | Params | Replaces | Status |
|---|---|---|---|
| `send_batch` | `account`, `template_id`, `list_id`, `idempotency_key?` | — | [ ] |
| `manage_template` | `account`, `action: "create"\|"update"\|"delete"`, `template_id?`, `name?`, `subject?`, `body?` | create_template, update_template, delete_template — 3 → 1 (list → Resource) | [ ] |
| `manage_webhook` | `action: "register"\|"unregister"`, `url?`, `events?`, `secret?`, `webhook_id?` | register_webhook, unregister_webhook — 2 → 1 (list → Resource) | [ ] |
| `schedule_send` | `account`, `draft_id`, `send_at` | schedule_send, cancel_scheduled_send (use delete action on draft) | [ ] |

---

## Total Tool Count

| Domain | Tools |
|---|---|
| Account | 6 |
| Email write | 3 |
| Email state | 5 |
| Search & drafts | 2 |
| Folders & rules | 3 |
| Calendar | 6 |
| Contacts | 1 |
| Outreach & webhooks | 4 |
| **Total** | **30** |

*Current live tool count is 26 (including `manage_token`). The table above reflects planned consolidations not yet implemented.*

---

# Resources (~9)

> These replace all "list" and "get" polling tools. Agents read once or subscribe for push.
> Implement via `resources/list` + `resources/read` + `resources/subscribe` in `index.ts`.

| URI | Returns | Replaces |
|---|---|---|
| `email://inbox/{account}` | Paginated unread list (id, subject, from, date, is_read only by default) | list_emails, get_unread_count |
| `email://thread/{account}/{thread_id}` | Ordered message array for a thread | get_thread, batch_read |
| `email://drafts/{account}` | Pending drafts list | list_drafts |
| `email://sent/{account}` | Recent sent mail | (no current equivalent) |
| `email://contact/{account}/{address}` | Contact record + notes + history | get_contact, get_contact_notes |
| `email://contacts/{account}` | Full address book | list_contacts |
| `calendar://events/{account}` | Upcoming events | list_events, get_event |
| `account://status/{account}` | Quota, unread count, send volume, rate limit headroom | get_inbox_health, get_quota_status, get_send_volume, get_rate_limit_status |
| `account://config/{account}` | Folders, labels, rules, whitelist/blacklist, webhooks | list_folders, list_labels, list_rules, list_whitelist, list_blacklist, list_webhooks |

**Webhook event types** — `register_webhook` supports granular subscriptions:

| Event | Trigger |
|---|---|
| `mail.received` | New inbound message |
| `mail.replied` | Reply on a tracked outbound thread |
| `mail.bounced` | Hard or soft delivery failure |
| `mail.opened` | Recipient opened (tracking pixel) |
| `calendar.rsvp_received` | Attendee accepted / declined |
| `account.quota_warning` | Storage at 80% / 95% |
| `thread.sla_breached` | Thread past response-time SLA |

All webhook payloads include `X-Clawmail-Signature` HMAC-SHA256 for verification.

---

# Prompts (~7)

> Multi-step workflows exposed as parameterized templates via `prompts/list` + `prompts/get`.
> Agent calls one prompt instead of chaining 5–10 tools.

| Prompt | Arguments | Tool chain it replaces |
|---|---|---|
| `triage_inbox` | `account`, `max_items?` | inbox resource → classify × N → rank → return |
| `draft_reply` | `account`, `email_id`, `intent` | thread resource → compose → manage_draft |
| `summarize_thread` | `account`, `thread_id` | thread resource → compress → return |
| `schedule_meeting` | `organizer`, `attendees[]`, `duration_min` | check_availability × N → find slot → draft invite |
| `onboard_persona` | `local_part`, `display_name`, `bio`, `template?` | create_account → configure_account × 3 |
| `process_inbox` | `account` | manage_rule(apply) → manage_sender_list → return digest |
| `cold_outreach` | `account`, `contact_email`, `goal`, `sequence_days?` | manage_contact → manage_template → send_batch |

---

# Consolidation Map

> How the ~100 planned tools collapse into the architecture above.
> Use this when triaging what to build next.

| Was planned as | Now lives in |
|---|---|
| `mark_as_read`, `mark_as_unread`, `flag_email`, `move_email`, `delete_email` | `update_email(action: ...)` |
| `archive_thread`, `delete_thread`, `label_thread`, `mute_thread`, `set_thread_metadata` | `update_thread(action: ...)` |
| `mark_as_spam`, `mark_as_not_spam` | `classify_email(as: ...)` |
| `add_label`, `remove_label` | `manage_label(action: ...)` |
| `create_folder`, `delete_folder` | `manage_folder(action: ...)` |
| `list_folders`, `list_labels`, `list_rules`, `list_whitelist`, `list_blacklist` | `account://config/{account}` Resource |
| `create_rule`, `list_rules`, `delete_rule`, `apply_rules` | `manage_rule(action: ...)` |
| `add_to_whitelist`, `remove_from_whitelist`, `add_to_blacklist`, `remove_from_blacklist` | `manage_sender_list(list:, action: ...)` |
| `list_emails`, `get_unread_count`, `get_inbox_health` | `email://inbox/{account}` Resource |
| `get_thread`, `batch_read`, `read_email`, `get_body_text` | `email://thread/{account}/{id}` Resource |
| `list_drafts` | `email://drafts/{account}` Resource |
| `create_draft`, `update_draft`, `send_draft`, `delete_draft` | `manage_draft(action: ...)` |
| `get_contact`, `list_contacts`, `get_contact_notes` | `email://contact/{account}/{addr}` Resource |
| `add_contact`, `update_contact`, `delete_contact`, `set_contact_notes` | `manage_contact(action: ...)` |
| `list_events`, `get_event`, `check_availability` | `calendar://events/{account}` Resource |
| `accept_event_invite`, `decline_event_invite`, `propose_new_time` | `respond_to_invite(response: ...)` |
| `set_display_name`, `create_signature`, `set_availability_window`, `set_vacation_reply` | `configure_account(setting: ...)` |
| `suspend_account`, `reactivate_account` | `suspend_account(action: ...)` |
| `create_account_template`, `provision_from_template` | `manage_account_template(action: ...)` |
| `register_webhook`, `unregister_webhook`, `list_webhooks` | `manage_webhook(action: ...)` (list → Resource) |
| `create_template`, `update_template`, `delete_template`, `list_templates` | `manage_template(action: ...)` (list → Resource) |
| `triage_inbox`, `get_inbox_digest`, `get_thread_digest`, `process_inbox` | Prompts |
| `draft_reply`, `summarize_thread`, `schedule_meeting`, `onboard_persona` | Prompts |
| `score_urgency`, `classify_intent`, `match_tone`, `score_draft` | Server-side via MCP Sampling (E3) — not tools |
| `get_quota_status`, `get_send_volume`, `get_rate_limit_status` | `account://status/{account}` Resource |
| `list_api_keys`, `revoke_api_key` | Admin REST API — not MCP tools |
| `export_audit_log`, `export_mailbox` | Admin REST API — not MCP tools |
| `search_emails` operators | Rich params on existing `search_emails` |
| `create_saved_search`, `run_saved_search` | `search_emails(save_as?, run_saved?)` params |
| `set_sla`, `get_sla_status` | `update_thread(action: "set_sla")` + `account://status` Resource |

---

# Remaining Feature Work

Features not yet captured in the tool/resource/prompt set above.

## Still Needed as Tools

| Tool | Why a tool (not resource/prompt) | Status |
|---|---|---|
| `validate_attachment` | Pre-flight check before send — side-effect-free but too dynamic for a resource | [ ] |
| `send_batch` | Write operation on many recipients | [ ] |
| `schedule_send` | Schedules a future side effect | [ ] |
| `poll_since(account, cursor)` | Stateless incremental sync for agents that can't use SSE/WebSocket | [ ] |
| `inject_inbound` | Sandbox only — creates fake inbound message | [ ] |
| `manage_shared_mailbox` | `action: "create"\|"grant"\|"revoke"` | [ ] |

## Infrastructure (not MCP tools)

These belong in admin APIs, server config, or infra — not exposed as MCP tools to agents.

| Feature | Where it lives |
|---|---|
| API key scoping & rotation | Admin REST `/admin/keys` |
| GDPR erasure (`delete_contact_data`) | Admin REST `/admin/compliance` |
| Rate limiter (distributed) | Redis + `index.ts` refactor |
| JMAP Push (RFC 8620 §7) | Stalwart config + `index.ts` WebSocket handler |
| JMAP batch operations | `clients/jmap.ts` internal optimization |
| Sieve scripting | Stalwart config + optional admin tool |
| CalDAV exposure | Stalwart config (already supported) |
| Multi-domain | Terraform + `stalwart/config.toml` |
| Send queue + backpressure | Redis queue + worker in `index.ts` |
| SDKs / CLI | Separate repos |
| `/metrics` endpoint | Add to `index.ts` HTTP router |

## Server-Side Intelligence (MCP Sampling, not tools)

These should run automatically on inbound delivery via `sampling/createMessage` — not require the agent to call a tool.

| Feature | Trigger | Output |
|---|---|---|
| Auto-classify intent | Inbound message | `metadata.intent` on message |
| Auto-score urgency | Inbound message | `metadata.urgency: 1–5` |
| Auto-detect sender type | Inbound message | `metadata.sender_type: "github"\|"human"\|...` |
| Auto-detect OOO | Inbound message | `metadata.is_ooo: true`, `metadata.return_date?` |
| Auto-detect auto-reply | Inbound message | `metadata.is_auto_reply: true` — suppress reply loop |
| Auto-summarize thread | Thread reaches 5+ messages | `thread_metadata.summary` |

## Loop Prevention (server-side logic, not tools)

These should be enforced by the server, not by asking agents to call tools.

| Protection | Implementation |
|---|---|
| Auto-reply loop breaker | Check `Auto-Submitted` header before send; refuse if same thread has > 3 auto-replies in 1h |
| Mailing list guard | Check `List-Id` / `Precedence: list` headers; suppress auto-replies |
| Self-reply guard | Refuse `reply_to_email` if sender == original sender |

---

# Already Implemented (45 tools — migration targets)

These will be gradually consolidated into the new architecture.
Existing tool names remain working during migration (deprecate, don't break).

| Tools | File | Migration target |
|---|---|---|
| `create_account`, `list_accounts`, `delete_account`, `manage_token` | `accounts.ts`, `tokens.ts` | keep, add `configure_account` |
| `list_emails`, `read_email`, `delete_email`, `search_emails` | `mailbox.ts` | `email://inbox` Resource + `update_email` + extend `search_emails` |
| `mark_as_read`, `mark_as_unread`, `flag_email` | `mailbox.ts` | → `update_email(action: ...)` |
| `bulk_move_emails`, `bulk_delete_emails`, `bulk_add_label` | `mailbox.ts` | → extend `bulk_update_emails` |
| `list_folders`, `create_folder`, `delete_folder`, `move_email` | `folders.ts` | → `manage_folder` + `account://config` Resource |
| `add_label`, `remove_label`, `list_labels`, `search_by_label` | `labels.ts` | → `manage_label` + `account://config` Resource |
| `send_email`, `reply_to_email`, `forward_email` | `send.ts` | extend params in place |
| `send_event_invite`, `cancel_event_invite` | `send.ts` | keep |
| `create_event`, `list_events`, `get_event`, `update_event`, `delete_event` | `calendar.ts` | add `recurrence`; list/get → Resource |
| `check_availability` | `calendar.ts` | → `calendar://events` Resource + `find_meeting_time` logic in `schedule_meeting` Prompt |
| `mark_as_spam`, `mark_as_not_spam` | `spam.ts` | → `classify_email(as: ...)` |
| `create_rule`, `list_rules`, `delete_rule`, `apply_rules` | `rules.ts` | → `manage_rule(action: ...)` |
| `add_to_whitelist`, `remove_from_whitelist`, `list_whitelist` | `filters.ts` | → `manage_sender_list` |
| `add_to_blacklist`, `remove_from_blacklist`, `list_blacklist` | `filters.ts` | → `manage_sender_list` |
| `apply_spam_filter` | `filters.ts` | → auto-apply server-side (see P0 #5) |

---

*Last updated: 2026-04-12*
