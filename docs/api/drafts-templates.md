# Drafts & Templates

Operations for managing email drafts and reusable email templates.

---

## draft.manage

**Manage email drafts: create, update, send, delete, or schedule for future delivery.**

Drafts are unsent emails stored in the Drafts folder. You can schedule drafts to send at a specific time (requires external trigger).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `create`, `update`, `send`, `delete`, `schedule`. |
| `draft_id` | string | — | Draft ID (required for `update`, `send`, `delete`, `schedule`). |
| `to` | string or array | — | Recipient addresses (required for `create`). |
| `subject` | string | — | Email subject. |
| `body` | string | — | Email body. |
| `schedule_at` | string | — | ISO 8601 time to send (for `action='schedule'`). |

### Response

**Create/Update:**
```json
{
  "draft": {
    "id": "draft-123",
    "to": ["recipient@example.com"],
    "subject": "Hello",
    "body": "Draft content..."
  },
  "message": "Draft created"
}
```

**Send:**
```json
{
  "message": "Draft sent",
  "queued_at": "2026-04-13T12:00:00Z"
}
```

**Schedule:**
```json
{
  "message": "Draft scheduled to send at 2026-04-15T09:00:00Z",
  "scheduled_at": "2026-04-15T09:00:00Z"
}
```

### Examples

Create draft:
```json
{
  "name": "draft.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "to": ["recipient@example.com"],
    "subject": "Meeting notes",
    "body": "Here are the notes from today's meeting..."
  }
}
```

Send draft:
```json
{
  "name": "draft.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "send",
    "draft_id": "draft-123"
  }
}
```

Schedule draft:
```json
{
  "name": "draft.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "schedule",
    "draft_id": "draft-123",
    "schedule_at": "2026-04-15T09:00:00Z"
  }
}
```

Update draft:
```json
{
  "name": "draft.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "update",
    "draft_id": "draft-123",
    "subject": "Updated subject"
  }
}
```

Delete draft:
```json
{
  "name": "draft.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "delete",
    "draft_id": "draft-123"
  }
}
```

### Permissions

- **User** can manage their own drafts
- **Admin** can manage any account's drafts
- Rate limit: 200 per minute

### Notes

- **Scheduled drafts** are stored locally. You need an external trigger (cron job, webhook, etc.) to actually send them at the scheduled time.
- **Drafts folder** in the mailbox stores your drafts.

### Related

- [email.send](#emailsend) — send a new email immediately
- [template.manage](#templatemanage) — create reusable templates
- [template.send_batch](#templatesend_batch) — send templated emails in bulk

---

## template.manage

**Manage reusable email templates.**

Templates use `{{variable_name}}` placeholders that are filled in by `send_batch`. You can create templates with dynamic content.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `create`, `update`, `delete`, `get`, `list`. |
| `template_id` | string | — | Template ID (required for `update`, `delete`, `get`). |
| `name` | string | — | Template name (required for `create`). |
| `subject` | string | — | Email subject (supports variables like `"Welcome {{name}}"`) |
| `body` | string | — | Email body (supports variables). |
| `variables` | array | — | List of variable names used in the template (e.g., `["name", "company"]`). |

### Response

**Create/Update:**
```json
{
  "template": {
    "id": "template-123",
    "name": "Welcome email",
    "subject": "Welcome {{name}}!",
    "body": "Hi {{name}},\n\nWelcome to {{company}}!",
    "variables": ["name", "company"]
  },
  "message": "Template created"
}
```

**List:**
```json
{
  "templates": [
    {
      "id": "template-123",
      "name": "Welcome email",
      "subject": "Welcome {{name}}!",
      "variables": ["name", "company"]
    }
  ],
  "total": 1
}
```

### Examples

Create template:
```json
{
  "name": "template.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "name": "Sales follow-up",
    "subject": "Quick follow-up, {{prospect_name}}",
    "body": "Hi {{prospect_name}},\n\nJust wanted to follow up on our conversation about {{product}}.\n\nLooking forward to hearing from you!\n\nBest regards",
    "variables": ["prospect_name", "product"]
  }
}
```

Update template:
```json
{
  "name": "template.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "update",
    "template_id": "template-123",
    "body": "Hi {{prospect_name}},\n\nJust wanted to follow up about {{product}}.\n\nLet's chat soon!"
  }
}
```

List templates:
```json
{
  "name": "template.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "list"
  }
}
```

Delete template:
```json
{
  "name": "template.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "delete",
    "template_id": "template-123"
  }
}
```

### Permissions

- **User** can manage their own templates
- **Admin** can manage any account's templates
- Rate limit: 200 per minute

### Variable Syntax

- Variables in templates use `{{variable_name}}` format
- The special variable `{{email}}` is always available in `send_batch` (recipient email address)
- Variable names are case-sensitive
- Missing variables are replaced with empty strings

### Related

- [template.send_batch](#templatesend_batch) — send template to multiple recipients with variable substitution
- [draft.manage](#draftmanage) — manage individual drafts
- [email.send](#emailsend) — send a custom email

---

## template.send_batch

**Send a template email to multiple recipients with variable substitution.**

Perfect for bulk outreach, newsletters, and campaigns where you want to personalize each email.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `template_id` | string | ✅ | Template ID from `template.manage`. |
| `recipients` | array | ✅ | List of recipient objects with email and variables. |
| `recipients[].email` | string | ✅ | Email address. |
| `recipients[].variables` | object | — | Variables to substitute in this recipient's email (e.g., `{"name": "Alice", "company": "Acme"}`). |
| `idempotency_key` | string | — | Unique key for deduplication. Results cached 24h. |

### Response

```json
{
  "sent": 2,
  "failed": 0,
  "queued_at": "2026-04-13T12:00:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sent` | number | Count of successfully sent emails |
| `failed` | number | Count of failed sends |
| `queued_at` | string | ISO 8601 timestamp |

### Examples

Send template to list:
```json
{
  "name": "template.send_batch",
  "arguments": {
    "token": "tok_abc123...",
    "template_id": "template-123",
    "recipients": [
      {
        "email": "alice@example.com",
        "variables": { "name": "Alice", "company": "Acme Corp" }
      },
      {
        "email": "bob@example.com",
        "variables": { "name": "Bob", "company": "Beta Inc" }
      }
    ],
    "idempotency_key": "batch-2026-04-13-001"
  }
}
```

### Permissions

- **User** can send batches from their own account
- **Admin** can send batches from any account
- Rate limit: 60 per minute per account

### Special Variables

- `{{email}}` — automatically substituted with the recipient's email address
- All other variables must be provided in the `recipients[].variables` object

### Related

- [template.manage](#templatemanage) — create/manage templates
- [email.send](#emailsend) — send custom email
- [contact.manage](#contactmanage) — manage recipient contacts
