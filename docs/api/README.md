# Clawmail MCP API Reference

Complete API documentation for the Clawmail MCP (Model Context Protocol) server. All tools support two-layer authentication: service-level (`X-API-Key` header) and account-level (tool `token` parameter).

---

## Quick Reference Table

| Name | Input | Output | Usage | Permission |
|------|-------|--------|-------|-----------|
| [account.create](#accountcreate) | `local_part` (string) | `{ email, token }` | Create new email account | **Public** — all authenticated |
| [account.list](#accountlist) | — | `{ accounts: [...] }` | List all accounts | **Admin** only |
| [account.delete](#accountdelete) | `local_part` (string) | `{ message }` | Delete account permanently | **Admin** only |
| [email.list](#emaillist) | `account?`, `token?`, `folder?`, `limit?` | `{ emails: [...], total }` | List emails in folder | **User** for own account, **Admin** for any |
| [email.read](#emailread) | `account?`, `token?`, `email_id` (string) | Full email object | Read single email content | **User** for own account, **Admin** for any |
| [email.search](#emailsearch) | `account?`, `token?`, `query` (string), `include_spam?` | `{ emails: [...], total }` | Full-text search emails | **User** for own account, **Admin** for any |
| [email.send](#emailsend) | `from_account?`, `token?`, `to`, `subject`, `body`, `cc?`, `bcc?`, `idempotency_key?` | `{ message, queued_at }` | Send email | **User** for own account, **Admin** for any |
| [email.update](#emailupdate) | `account?`, `token?`, `email_ids`, `action`, `folder?`, `label?` | Success/bulk status | Mark read/unread, flag, archive, move, delete, label | **User** for own account, **Admin** for any |
| [email.classify](#emailclassify) | `account?`, `token?`, `email_id`, `as` (enum) | `{ message }` | Move to/from spam | **User** for own account, **Admin** for any |
| [email.reply](#emailreply) | `from_account?`, `token?`, `email_id`, `body`, `reply_all?`, `idempotency_key?` | `{ message, queued_at }` | Reply with threading | **User** for own account, **Admin** for any |
| [email.forward](#emailforward) | `from_account?`, `token?`, `email_id`, `to`, `body?`, `idempotency_key?` | `{ message, queued_at }` | Forward email | **User** for own account, **Admin** for any |
| [email.thread](#emailthread) | `account?`, `token?`, `thread_id`, `action`, `label?` | Bulk status | Archive, delete, mute, label entire conversation | **User** for own account, **Admin** for any |
| [folder.manage](#foldermanage) | `account?`, `token?`, `action`, `folder`, `new_name?`, `parent_folder?` | `{ message }` | Create, delete, rename folder | **User** for own account, **Admin** for any |
| [event.manage](#eventmanage) | `account?`, `token?`, `action`, `event_id?`, `title?`, `start`, `end`, `timezone?`, `attendees?`, `description?` | Event object | Create, update, delete calendar event | **User** for own account, **Admin** for any |
| [event.send_invite](#eventsend_invite) | `from_account?`, `token?`, `to`, `title`, `start`, `end`, `timezone?`, `description?`, `location?`, `uid?`, `video_url?` | `{ message, uid, video_url, queued_at }` | Send calendar invitation (auto-creates sender's event) | **User** for own account, **Admin** for any |
| [event.cancel_invite](#eventcancel_invite) | `from_account?`, `token?`, `to`, `uid`, `title`, `start`, `end`, `sequence?` | `{ message }` | Cancel previous invite | **User** for own account, **Admin** for any |
| [event.respond](#eventrespond) | `account?`, `token?`, `uid`, `organizer`, `title`, `start`, `end`, `response` (enum), `comment?` | `{ message }` | Accept/decline/tentative | **User** for own account, **Admin** for any |
| [rule.manage](#rulemanage) | `account?`, `token?`, `action`, `rule_id?`, `name?`, `condition?`, `rule_action?`, `folder?` | Rule object or status | Create, delete, or apply mailbox rules | **User** for own account, **Admin** for any |
| [sender.manage_list](#sendermanage_list) | `account?`, `token?`, `list` (enum), `action`, `address?`, `entry_id?` | Status | Add/remove whitelist or blacklist entries | **User** for own account, **Admin** for any |
| [contact.manage](#contactmanage) | `account?`, `token?`, `action`, `email`, `name?`, `notes?`, `vip?`, `metadata?`, `contact_id?` | Contact object | Create, update, delete contact | **User** for own account, **Admin** for any |
| [draft.manage](#draftmanage) | `account?`, `token?`, `action`, `draft_id?`, `to`, `subject?`, `body?`, `schedule_at?` | Draft object or status | Create, update, send, delete, schedule draft | **User** for own account, **Admin** for any |
| [template.manage](#templatemanage) | `account?`, `token?`, `action`, `template_id?`, `name?`, `subject?`, `body?`, `variables?` | Template object or status | Create, update, delete email template | **User** for own account, **Admin** for any |
| [template.send_batch](#templatesend_batch) | `account?`, `token?`, `template_id`, `recipients`, `variables?`, `idempotency_key?` | `{ sent, queued_at }` | Send template to recipients with variable substitution | **User** for own account, **Admin** for any |
| [webhook.manage](#webhookmanage) | `account?`, `token?`, `action`, `webhook_id?`, `url?`, `events?` | Webhook object or status | Register/unregister webhook notifications | **User** for own account, **Admin** for any |
| [config.account](#configaccount) | `account?`, `token?`, `action`, `display_name?`, `signature?`, `vacation_reply?`, `forward_to?`, `status?` | Settings object | Configure account settings | **User** for own account, **Admin** for any |
| [token.manage](#tokenmanage) | `token?`, `action`, `display_name?` | Token object or status | Create or revoke account tokens | **User** (for own account) or **Admin** |

---

## Tools by Category

- [Account Management](#account-management) — `account.*`
- [Email Operations](#email-operations) — `email.*`
- [Folder Management](#folder-management) — `folder.*`
- [Calendar & Events](#calendar--events) — `event.*`
- [Rules & Filters](#rules--filters) — `rule.*`, `sender.*`
- [Contacts](#contacts) — `contact.*`
- [Drafts & Templates](#drafts--templates) — `draft.*`, `template.*`
- [Configuration](#configuration) — `config.*`, `token.*`
- [Webhooks](#webhooks) — `webhook.*`

---

## Authentication

### Service-Level Authentication (`X-API-Key` header)
- Required for all requests unless using account `token` parameter
- Proves the caller is allowed to connect to this MCP endpoint
- Maps to a role: **admin** (full access) or **user** (scoped to bound account)
- Default: development mode allows unauthenticated access as admin

### Account-Level Authentication (`token` parameter)
- Per-account credential returned by `account.create`
- Proves ownership of a specific account
- Can be used instead of `X-API-Key` for account-scoped operations
- **Never share tokens** — treat them like passwords

### Authorization Rules

| Operation | Admin | User (bound to account) | User (different account) |
|-----------|-------|------------------------|--------------------------|
| `account.create` | ✅ | ✅ | ✅ |
| `account.list` | ✅ | ❌ | ❌ |
| `account.delete` | ✅ | ❌ | ❌ |
| `email.*` (on own account) | ✅ | ✅ | ❌ |
| `email.*` (on other accounts) | ✅ | ❌ | ❌ |
| Other account-scoped tools | ✅ | ✅ (own account only) | ❌ |

---

## Detailed Documentation

- [Account Management](./account-management.md)
- [Email Operations](./email-operations.md)
- [Folder Management](./folder-management.md)
- [Calendar & Events](./calendar-events.md)
- [Rules & Filters](./rules-filters.md)
- [Contacts](./contacts.md)
- [Drafts & Templates](./drafts-templates.md)
- [Configuration](./configuration.md)
- [Webhooks](./webhooks.md)

---

## Rate Limits

| Operation | Limit | Window |
|-----------|-------|--------|
| `account.create` | 10 per account | 1 hour |
| Write operations (send, update, etc.) | 60 per minute | 1 minute |
| Read operations (list, search, etc.) | 200 per minute | 1 minute |
| `manage_rule` (apply) | 20 per minute | 1 minute |

Rate limit keys are per-account (not per API key), so one agent cannot exhaust the bucket for others.

---

## Error Handling

All errors follow this format:

```json
{
  "type": "error",
  "error": {
    "type": "ERROR_CODE",
    "message": "Human-readable error message",
    "sessionId": "..."
  }
}
```

Common error codes:
- `AUTHORIZATION_ERROR` — caller lacks permission
- `VALIDATION_ERROR` — invalid input parameters
- `RATE_LIMIT_EXCEEDED` — too many requests
- `NOT_FOUND` — resource not found
- `ALREADY_EXISTS` — resource already exists
- `SEND_FAILED` — email delivery failed

---

## Idempotency

Send operations support optional `idempotency_key` parameter to prevent duplicate sends on retry:
- Results cached for **24 hours**
- Key must be unique per send operation
- Applies to: `send_email`, `reply_to_email`, `forward_email`, `send_batch`

Example:
```json
{
  "name": "send_email",
  "arguments": {
    "token": "tok_...",
    "to": "user@example.com",
    "subject": "Hello",
    "body": "Test message",
    "idempotency_key": "send-123-unique-key"
  }
}
```

---

## Pagination

List operations return up to a default limit. Use `limit` parameter to control:
- `limit`: 1–100 (default: 20)

Example:
```json
{
  "name": "email.list",
  "arguments": {
    "token": "tok_...",
    "limit": 50
  }
}
```

---

## Timezone Support

Calendar operations support optional `timezone` parameter with IANA timezone names:
- `"America/Los_Angeles"`, `"Europe/London"`, `"Asia/Tokyo"`, etc.
- Defaults to **UTC** if omitted
- Calendar invites display in the specified timezone to recipients

Example:
```json
{
  "name": "event.send_invite",
  "arguments": {
    "token": "tok_...",
    "to": "user@example.com",
    "title": "Team Meeting",
    "start": "2026-04-14T10:00:00Z",
    "end": "2026-04-14T11:00:00Z",
    "timezone": "America/Los_Angeles"
  }
}
```

---

## Video Call Integration

Calendar invites can include video call URLs. The system supports:
1. **Explicit URL** — pass `video_url` parameter
2. **Google Meet** (if configured) — auto-creates a meeting room
3. **Daily.co** (if configured) — auto-creates a video room
4. **None** — invitation is call-free

Video rooms auto-expire at the event end time.
