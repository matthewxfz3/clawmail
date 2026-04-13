# Webhooks

Operations for registering webhooks to receive notifications when account events occur.

---

## webhook.manage

**Register or unregister webhooks for account event notifications.**

Webhooks allow you to be notified in real-time when events occur in an account (e.g., new email arrives, event created, etc.). Instead of polling the API, webhooks push notifications to your endpoint.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `register`, `unregister`, `list`. |
| `webhook_id` | string | — | Webhook ID (required for `action='unregister'`). |
| `url` | string | — | HTTPS endpoint to receive webhook payloads (required for `action='register'`). |
| `events` | array | — | Event types to subscribe to (required for `action='register'`). |

### Supported Events

- `mail.received` — new email arrived in Inbox
- `mail.sent` — email sent from this account
- `mail.deleted` — email moved to Trash
- `event.created` — calendar event created
- `event.updated` — calendar event updated
- `event.deleted` — calendar event deleted
- `contact.created` — contact created
- `contact.updated` — contact updated
- `contact.deleted` — contact deleted

### Response

**Register:**
```json
{
  "webhook": {
    "id": "webhook-123",
    "url": "https://example.com/webhooks/clawmail",
    "events": ["mail.received", "event.created"],
    "created_at": "2026-04-13T12:00:00Z"
  },
  "message": "Webhook registered"
}
```

**List:**
```json
{
  "webhooks": [
    {
      "id": "webhook-123",
      "url": "https://example.com/webhooks/clawmail",
      "events": ["mail.received", "event.created"],
      "created_at": "2026-04-13T12:00:00Z",
      "last_triggered": "2026-04-13T12:30:00Z"
    }
  ],
  "total": 1
}
```

**Unregister:**
```json
{
  "message": "Webhook unregistered"
}
```

### Webhook Payload Format

When an event occurs, Clawmail POSTs a JSON payload to your webhook URL:

```json
{
  "event": "mail.received",
  "timestamp": "2026-04-13T12:45:00Z",
  "account": "bot@mail.example.com",
  "data": {
    "email_id": "jmap-id-123",
    "from": "sender@example.com",
    "subject": "Hello",
    "folder": "Inbox"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Event type (e.g., `"mail.received"`) |
| `timestamp` | string | ISO 8601 when event occurred |
| `account` | string | Account email address |
| `data` | object | Event-specific data (varies by event type) |

### Examples

Register webhook:
```json
{
  "name": "webhook.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "register",
    "url": "https://example.com/webhooks/clawmail",
    "events": ["mail.received", "event.created", "event.deleted"]
  }
}
```

List webhooks:
```json
{
  "name": "webhook.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "list"
  }
}
```

Unregister webhook:
```json
{
  "name": "webhook.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "unregister",
    "webhook_id": "webhook-123"
  }
}
```

### Webhook Endpoint Implementation

Your endpoint should:

1. **Accept POST requests** with JSON payload
2. **Respond with HTTP 2xx** (200, 201, 204, etc.) within 5 seconds
3. **Process the event** asynchronously if needed
4. **Verify authenticity** (optional but recommended — see below)

Example Node.js endpoint:

```javascript
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhooks/clawmail', (req, res) => {
  const { event, account, data, timestamp } = req.body;
  
  console.log(`Received ${event} for ${account} at ${timestamp}`);
  
  if (event === 'mail.received') {
    console.log(`New email from ${data.from}: ${data.subject}`);
    // Process the email
  }
  
  // Respond immediately to acknowledge receipt
  res.status(200).json({ status: 'received' });
});

app.listen(3000, () => console.log('Webhook server listening on :3000'));
```

### Retry Policy

If your webhook endpoint returns a non-2xx status or times out:
- **Retry 1:** After 5 seconds
- **Retry 2:** After 30 seconds
- **Retry 3:** After 5 minutes
- After 3 failed retries, the webhook is automatically disabled

Check the webhook's `last_triggered` timestamp to debug delivery issues.

### Security Considerations

- **Use HTTPS only** — webhooks transmit sensitive data
- **Validate origin** — check that requests come from your Clawmail instance
- **Rate limit** — webhooks can fire frequently; be prepared to handle throughput
- **Idempotency** — design your webhook handler to handle duplicate deliveries
- **Timeouts** — respond within 5 seconds or Clawmail will retry

### Permissions

- **User** can register webhooks for their own account
- **Admin** can register webhooks for any account
- Rate limit: 200 per minute

### Related

- [email.list](#emaillist) — polling alternative (less efficient)
- [event.manage](#eventmanage) — calendar event management
- [contact.manage](#contactmanage) — contact management

---

## Webhook Event Reference

### mail.received

**Triggered** when a new email arrives in the Inbox.

**Data fields:**
```json
{
  "email_id": "jmap-id-123",
  "from": "sender@example.com",
  "subject": "Hello",
  "folder": "Inbox",
  "hasAttachments": false
}
```

### mail.sent

**Triggered** when an email is sent from the account.

**Data fields:**
```json
{
  "email_id": "jmap-id-124",
  "to": ["recipient@example.com"],
  "subject": "Reply",
  "folder": "Sent"
}
```

### mail.deleted

**Triggered** when an email is moved to Trash.

**Data fields:**
```json
{
  "email_id": "jmap-id-125",
  "from": "sender@example.com",
  "subject": "Old email",
  "folder": "Trash"
}
```

### event.created

**Triggered** when a calendar event is created.

**Data fields:**
```json
{
  "eventId": "event-123",
  "title": "Team Meeting",
  "start": "2026-04-14T10:00:00Z",
  "attendees": ["alice@example.com"]
}
```

### event.updated

**Triggered** when a calendar event is updated.

**Data fields:**
```json
{
  "eventId": "event-123",
  "title": "Team Meeting",
  "changes": ["start", "attendees"]
}
```

### event.deleted

**Triggered** when a calendar event is deleted.

**Data fields:**
```json
{
  "eventId": "event-123",
  "title": "Team Meeting"
}
```

### contact.created

**Triggered** when a contact is created.

**Data fields:**
```json
{
  "contactId": "contact-123",
  "email": "alice@example.com",
  "name": "Alice Smith"
}
```

### contact.updated

**Triggered** when a contact is updated.

**Data fields:**
```json
{
  "contactId": "contact-123",
  "email": "alice@example.com",
  "changes": ["name", "notes"]
}
```

### contact.deleted

**Triggered** when a contact is deleted.

**Data fields:**
```json
{
  "contactId": "contact-123",
  "email": "alice@example.com"
}
```
