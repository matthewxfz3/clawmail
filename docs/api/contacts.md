# Contacts

Operations for managing account contacts.

---

## contact.manage

**Manage contacts for an account.**

Contacts are stored privately per account and can be used by batch sending tools to reference recipient details.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `create`, `update`, `delete`, `get`, `list`. |
| `contact_id` | string | — | Contact ID (required for `update`, `delete`, `get`). |
| `email` | string | — | Email address (required for `create`). |
| `name` | string | — | Display name. |
| `notes` | string | — | Private notes about the contact. |
| `vip` | boolean | — | Mark as VIP (important contact). |
| `metadata` | object | — | Custom key-value metadata. |

### Response

**Create/Update:**
```json
{
  "contact": {
    "id": "contact-123",
    "email": "alice@example.com",
    "name": "Alice Smith",
    "notes": "Product manager at Acme Corp",
    "vip": true,
    "metadata": { "company": "acme", "role": "PM" }
  },
  "message": "Contact created"
}
```

**List:**
```json
{
  "contacts": [
    {
      "id": "contact-123",
      "email": "alice@example.com",
      "name": "Alice Smith",
      "vip": true
    }
  ],
  "total": 1
}
```

**Get:**
```json
{
  "contact": {
    "id": "contact-123",
    "email": "alice@example.com",
    "name": "Alice Smith",
    "notes": "Product manager",
    "vip": true,
    "metadata": { "company": "acme" }
  }
}
```

### Examples

Create contact:
```json
{
  "name": "contact.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "email": "alice@example.com",
    "name": "Alice Smith",
    "notes": "Key stakeholder for project X",
    "vip": true,
    "metadata": { "company": "Acme Inc", "team": "Product" }
  }
}
```

Update contact:
```json
{
  "name": "contact.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "update",
    "contact_id": "contact-123",
    "notes": "Now VP of Product"
  }
}
```

List all contacts:
```json
{
  "name": "contact.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "list"
  }
}
```

Delete contact:
```json
{
  "name": "contact.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "delete",
    "contact_id": "contact-123"
  }
}
```

### Permissions

- **User** can manage their own contacts
- **Admin** can manage any account's contacts
- Rate limit: 200 per minute

### Related

- [template.send_batch](#templatesend_batch) — use contacts in batch sends
- [email.send](#emailsend) — send to email addresses
