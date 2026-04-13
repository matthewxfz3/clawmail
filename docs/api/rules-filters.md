# Rules & Filters

Operations for creating mailbox rules and managing sender whitelists/blacklists.

---

## rule.manage

**Create, delete, or apply mailbox rules.**

Rules automatically process incoming emails based on conditions. When a rule matches an email, it performs one or more actions.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `create`, `delete`, `apply`. |
| `rule_id` | string | — | Rule ID (required for `action='delete'`). |
| `name` | string | — | Rule name (required for `action='create'`). |
| `condition` | object | — | Match conditions (required for `create`). See below. |
| `rule_action` | object | — | Actions to take (required for `create`). See below. |
| `folder` | string | — | Folder to scan (optional for `action='apply'`, default: Inbox). |

### Condition Object

```json
{
  "from": "string (optional)",
  "subject": "string (optional)",
  "hasAttachment": "boolean (optional)",
  "olderThanDays": "number (optional)"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `from` | string | Substring match on sender address (e.g., `"@company.com"`) |
| `subject` | string | Substring match on subject line |
| `hasAttachment` | boolean | true = has files; false = no files |
| `olderThanDays` | number | Match emails older than N days |

### Action Object

```json
{
  "moveTo": "string (optional)",
  "markRead": "boolean (optional)",
  "delete": "boolean (optional)"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `moveTo` | string | Move matched emails to this folder |
| `markRead` | boolean | true = mark as read; false = mark as unread |
| `delete` | boolean | true = move to Trash |

### Response

```json
{
  "rule": {
    "id": "rule-123",
    "name": "Archive old reports",
    "condition": { "subject": "report", "olderThanDays": 30 },
    "action": { "moveTo": "Archive" }
  },
  "message": "Rule 'Archive old reports' created"
}
```

### Examples

Create rule (archive emails older than 30 days with "report" in subject):
```json
{
  "name": "rule.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "name": "Archive old reports",
    "condition": {
      "subject": "report",
      "olderThanDays": 30
    },
    "rule_action": {
      "moveTo": "Archive"
    }
  }
}
```

Create rule (auto-mark company emails as read):
```json
{
  "name": "rule.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "name": "Mark company emails as read",
    "condition": {
      "from": "@mycompany.com"
    },
    "rule_action": {
      "markRead": true
    }
  }
}
```

Apply rule to existing emails in a folder:
```json
{
  "name": "rule.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "apply",
    "folder": "Inbox"
  }
}
```

Delete rule:
```json
{
  "name": "rule.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "delete",
    "rule_id": "rule-123"
  }
}
```

### Permissions

- **User** can create rules for their own account
- **Admin** can create rules for any account
- Rate limit: 200 per minute (apply: 20 per minute)

### Related

- [sender.manage_list](#sendermanage_list) — whitelist/blacklist senders
- [email.classify](#emailclassify) — manually classify email as spam
- [folder.manage](#foldermanage) — create folders for organizing emails

---

## sender.manage_list

**Manage spam whitelist and blacklist.**

Control which senders' emails are trusted (whitelist) or blocked (blacklist).

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `list` | enum | ✅ | One of: `whitelist`, `blacklist`. |
| `action` | enum | ✅ | One of: `add`, `remove`. |
| `address` | string | — | Email address or @domain.com pattern (required for `action='add'`). |
| `entry_id` | string | — | Entry ID from config (required for `action='remove'`). |

### Response

```json
{
  "message": "Added alice@example.com to whitelist"
}
```

### Examples

Whitelist a sender:
```json
{
  "name": "sender.manage_list",
  "arguments": {
    "token": "tok_abc123...",
    "list": "whitelist",
    "action": "add",
    "address": "trusted@example.com"
  }
}
```

Whitelist entire domain:
```json
{
  "name": "sender.manage_list",
  "arguments": {
    "token": "tok_abc123...",
    "list": "whitelist",
    "action": "add",
    "address": "@mycompany.com"
  }
}
```

Blacklist a sender:
```json
{
  "name": "sender.manage_list",
  "arguments": {
    "token": "tok_abc123...",
    "list": "blacklist",
    "action": "add",
    "address": "spam@badomain.com"
  }
}
```

Remove from whitelist (use entry ID from account config):
```json
{
  "name": "sender.manage_list",
  "arguments": {
    "token": "tok_abc123...",
    "list": "whitelist",
    "action": "remove",
    "entry_id": "entry-456"
  }
}
```

### Permissions

- **User** can manage their own whitelist/blacklist
- **Admin** can manage any account's lists
- Rate limit: 200 per minute

### Related

- [rule.manage](#rulemanage) — create rules for complex conditions
- [email.classify](#emailclassify) — manually classify email as spam
- [config.account](#configaccount) — view whitelist/blacklist entries
