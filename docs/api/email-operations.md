# Email Operations

Operations for sending, reading, searching, and managing emails.

---

## email.list

**List emails in a mailbox folder.**

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address (e.g., `bot@mail.example.com`). Required if not using `token`. |
| `token` | string | Optional* | Account token. Alternative to `account` + `X-API-Key`. |
| `folder` | string | — | Mailbox folder name (default: `Inbox`). Examples: `Sent`, `Drafts`, `Archive`, `Junk`. |
| `limit` | number | — | Max emails to return (1–100, default: 20). |

*Either `account` or `token` is required.

### Response

```json
{
  "emails": [
    {
      "id": "jmap-id-123",
      "from": "sender@example.com",
      "subject": "Hello",
      "date": "2026-04-13T10:30:00Z",
      "hasAttachments": false,
      "isRead": false,
      "preview": "This is the email body preview...",
      "labels": ["important"]
    }
  ],
  "total": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `emails` | array | List of email summaries |
| `emails[].id` | string | JMAP email ID (used in other operations) |
| `emails[].from` | string | Sender address |
| `emails[].subject` | string | Email subject |
| `emails[].date` | string | ISO 8601 timestamp |
| `emails[].hasAttachments` | boolean | True if email has file attachments |
| `emails[].isRead` | boolean | Read status |
| `emails[].preview` | string | First 200 chars of body |
| `emails[].labels` | array | Custom labels applied to this email |
| `total` | number | Total emails in folder (not affected by limit) |

### Examples

```json
{
  "name": "email.list",
  "arguments": {
    "token": "tok_abc123...",
    "folder": "Inbox",
    "limit": 10
  }
}
```

### Permissions

- **User** can list their own account emails
- **Admin** can list any account's emails
- Rate limit: 200 per minute

### Related

- [email.read](#emailread) — get full email content
- [email.search](#emailsearch) — search emails
- [email.update](#emailupdate) — mark read, flag, move, delete

---

## email.read

**Retrieve the full content of a specific email.**

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. Alternative to `account`. |
| `email_id` | string | ✅ | The JMAP email ID from `email.list` response. |

### Response

```json
{
  "id": "jmap-id-123",
  "from": "sender@example.com",
  "to": ["recipient@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Hello",
  "body": "Full email body text here...",
  "htmlBody": "<html><body>HTML version...</body></html>",
  "date": "2026-04-13T10:30:00Z",
  "attachments": [
    {
      "filename": "document.pdf",
      "mimeType": "application/pdf",
      "size": 102400
    }
  ],
  "isRead": true,
  "isFlagged": false,
  "labels": ["important", "project-alpha"],
  "inReplyTo": null,
  "references": [],
  "threadId": "thread-456"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | JMAP email ID |
| `from` | string | Sender address |
| `to`, `cc`, `bcc` | array | Recipient addresses |
| `subject` | string | Email subject |
| `body` | string | Plain-text body |
| `htmlBody` | string | HTML body (if present) |
| `date` | string | ISO 8601 timestamp |
| `attachments` | array | List of attached files |
| `attachments[].filename` | string | File name |
| `attachments[].mimeType` | string | MIME type |
| `attachments[].size` | number | Size in bytes |
| `isRead` | boolean | Read status |
| `isFlagged` | boolean | Flag status |
| `labels` | array | Applied custom labels |
| `inReplyTo` | string | Message-ID of the email being replied to (if applicable) |
| `references` | array | List of Message-IDs in the thread chain |
| `threadId` | string | Conversation thread ID |

### Examples

```json
{
  "name": "email.read",
  "arguments": {
    "token": "tok_abc123...",
    "email_id": "jmap-id-123"
  }
}
```

### Permissions

- **User** can read their own account emails
- **Admin** can read any account's emails
- Rate limit: 200 per minute

### Related

- [email.list](#emaillist) — list emails
- [email.search](#emailsearch) — search by keywords
- [email.reply](#emailreply) — reply to an email

---

## email.search

**Full-text search across emails in an account.**

Search covers subject, body, and attachments by default. Junk/spam folder is excluded unless you set `include_spam: true`.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. Alternative to `account`. |
| `query` | string | ✅ | Search query (keywords). Examples: `"from:alice"`, `"subject:invoice"`, `"2026-04"`. |
| `include_spam` | boolean | — | Include Junk folder in results (default: false). |

### Response

```json
{
  "emails": [
    {
      "id": "jmap-id-234",
      "from": "alice@example.com",
      "subject": "Invoice #2026-04",
      "date": "2026-04-10T14:22:00Z",
      "preview": "Invoice for April services...",
      "isRead": true
    }
  ],
  "total": 3
}
```

Same structure as [email.list](#emaillist).

### Examples

```json
{
  "name": "email.search",
  "arguments": {
    "token": "tok_abc123...",
    "query": "from:alice invoice",
    "include_spam": false
  }
}
```

### Permissions

- **User** can search their own account
- **Admin** can search any account
- Rate limit: 200 per minute

### Related

- [email.list](#emaillist) — list emails by folder
- [email.read](#emailread) — get full content

---

## email.send

**Send an email from a local account to one or more recipients.**

Uses SendGrid SMTP relay for delivery. Supports idempotency keys to prevent duplicate sends on retry.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from_account` | string | Optional* | Local part or full email address (e.g., `bot` or `bot@mail.example.com`). Required if not using `token`. |
| `token` | string | Optional* | Account token. Alternative to `from_account`. |
| `to` | string or array | ✅ | Recipient address(es). Single string or array of strings. |
| `subject` | string | ✅ | Email subject line. |
| `body` | string | ✅ | Plain-text body (max 1 MiB). |
| `cc` | array | — | CC recipient addresses. |
| `bcc` | array | — | BCC recipient addresses. |
| `idempotency_key` | string | — | Unique key for deduplication. Results cached 24h. |

### Response

```json
{
  "message": "Email sent to recipient@example.com",
  "queued_at": "2026-04-13T11:45:00Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Confirmation message |
| `queued_at` | string | ISO 8601 timestamp when email was queued |

### Examples

```json
{
  "name": "email.send",
  "arguments": {
    "token": "tok_abc123...",
    "to": "alice@example.com",
    "subject": "Hello Alice",
    "body": "This is a test email.",
    "cc": ["bob@example.com"],
    "idempotency_key": "send-2026-04-13-001"
  }
}
```

### Permissions

- **User** can send from their own account
- **Admin** can send from any account
- Rate limit: 60 per minute per account

### Related

- [email.reply](#emailreply) — reply to an email
- [email.forward](#emailforward) — forward an email
- [event.send_invite](#eventsend_invite) — send calendar invitation
- [template.send_batch](#templatesend_batch) — send templated emails

---

## email.update

**Update email state in bulk or single operations.**

Supports: mark read/unread, flag/unflag, archive, move to folder, delete, add/remove labels.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. Alternative to `account`. |
| `email_ids` | string or array | ✅ | Single email ID or array of IDs for bulk operations. |
| `action` | string | ✅ | One of: `mark_read`, `mark_unread`, `flag`, `unflag`, `archive`, `move`, `delete`, `add_label`, `remove_label`. |
| `folder` | string | — | Destination folder (required for `action='move'`). |
| `label` | string | — | Label name (required for `add_label` or `remove_label`). |

### Response

**Single email:**
```json
{
  "message": "Email marked as read"
}
```

**Bulk operation:**
```json
{
  "succeeded": 10,
  "failed": 1,
  "total": 11
}
```

### Examples

Single email:
```json
{
  "name": "email.update",
  "arguments": {
    "token": "tok_abc123...",
    "email_ids": "jmap-id-123",
    "action": "mark_read"
  }
}
```

Bulk operation (flag 50 emails):
```json
{
  "name": "email.update",
  "arguments": {
    "token": "tok_abc123...",
    "email_ids": ["id-1", "id-2", "id-3"],
    "action": "flag"
  }
}
```

Move to folder:
```json
{
  "name": "email.update",
  "arguments": {
    "token": "tok_abc123...",
    "email_ids": "jmap-id-123",
    "action": "move",
    "folder": "Archive"
  }
}
```

### Permissions

- **User** can update their own account emails
- **Admin** can update any account's emails
- Rate limit: 200 per minute

### Related

- [email.classify](#emailclassify) — move to/from spam
- [email.thread](#emailthread) — update entire conversation
- [folder.manage](#foldermanage) — create/delete folders

---

## email.classify

**Move an email to Junk (spam) or back to Inbox (not spam).**

Convenience method for spam classification.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `email_id` | string | ✅ | JMAP email ID. |
| `as` | enum | ✅ | One of: `spam` (move to Junk) or `not_spam` (move to Inbox). |

### Response

```json
{
  "message": "Email moved to Junk"
}
```

### Examples

```json
{
  "name": "email.classify",
  "arguments": {
    "token": "tok_abc123...",
    "email_id": "jmap-id-123",
    "as": "spam"
  }
}
```

### Permissions

- **User** can classify their own emails
- **Admin** can classify any account's emails
- Rate limit: 200 per minute

### Related

- [email.update](#emailupdate) — move to any folder
- [sender.manage_list](#sendermanage_list) — whitelist/blacklist senders

---

## email.reply

**Reply to an email with proper threading.**

The reply includes threading headers (`In-Reply-To`, `References`) so it appears in the same conversation thread in the recipient's mail client.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from_account` | string | Optional* | Local part or full address to reply from. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `email_id` | string | ✅ | JMAP email ID of the email to reply to. |
| `body` | string | ✅ | Reply body text. |
| `reply_all` | boolean | — | If true, reply to all original recipients (To + CC). Default: false (reply to sender only). |
| `idempotency_key` | string | — | Unique key for deduplication. Results cached 24h. |

### Response

```json
{
  "message": "Reply sent",
  "queued_at": "2026-04-13T12:00:00Z"
}
```

### Examples

Reply to sender only:
```json
{
  "name": "email.reply",
  "arguments": {
    "token": "tok_abc123...",
    "email_id": "jmap-id-123",
    "body": "Thanks for your message!"
  }
}
```

Reply to all:
```json
{
  "name": "email.reply",
  "arguments": {
    "token": "tok_abc123...",
    "email_id": "jmap-id-123",
    "body": "Thanks all!",
    "reply_all": true,
    "idempotency_key": "reply-2026-04-13-001"
  }
}
```

### Permissions

- **User** can reply from their own account
- **Admin** can reply from any account
- Rate limit: 60 per minute per account

### Related

- [email.send](#emailsend) — send a new email
- [email.forward](#emailforward) — forward an email
- [email.read](#emailread) — read the email being replied to

---

## email.forward

**Forward an email to new recipients.**

The forwarded email includes 'Fwd:' in the subject and quotes the original message.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from_account` | string | Optional* | Local part or full address to forward from. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `email_id` | string | ✅ | JMAP email ID of the email to forward. |
| `to` | string or array | ✅ | Recipient address(es) to forward to. |
| `body` | string | — | Optional introductory text before the forwarded message. |
| `idempotency_key` | string | — | Unique key for deduplication. Results cached 24h. |

### Response

```json
{
  "message": "Email forwarded to newuser@example.com",
  "queued_at": "2026-04-13T12:15:00Z"
}
```

### Examples

```json
{
  "name": "email.forward",
  "arguments": {
    "token": "tok_abc123...",
    "email_id": "jmap-id-123",
    "to": ["alice@example.com", "bob@example.com"],
    "body": "Please see the message below from our customer."
  }
}
```

### Permissions

- **User** can forward from their own account
- **Admin** can forward from any account
- Rate limit: 60 per minute per account

### Related

- [email.send](#emailsend) — send a new email
- [email.reply](#emailreply) — reply to an email

---

## email.thread

**Update all emails in a conversation thread at once.**

Apply an action to the entire thread instead of individual emails.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `thread_id` | string | ✅ | Thread ID (from email.read response). |
| `action` | string | ✅ | One of: `archive`, `delete`, `mute`, `add_label`, `remove_label`. |
| `label` | string | — | Label name (required for `add_label` or `remove_label`). |

### Response

```json
{
  "message": "Thread archived (5 emails)"
}
```

### Examples

```json
{
  "name": "email.thread",
  "arguments": {
    "token": "tok_abc123...",
    "thread_id": "thread-456",
    "action": "archive"
  }
}
```

### Permissions

- **User** can update their own thread
- **Admin** can update any thread
- Rate limit: 200 per minute

### Related

- [email.update](#emailupdate) — update individual emails
- [email.list](#emaillist) — list emails by folder
