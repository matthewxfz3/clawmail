# Account Management

Operations for creating, listing, and deleting email accounts.

---

## account.create

**Create a new email account and return its token.**

The token is shown **only once** — store it securely. It's used for all subsequent operations on the account.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `local_part` | string | ✅ | The local part (before @) of the email address. Combined with the configured domain to form the full address. |

### Response

```json
{
  "email": "bot@mail.example.com",
  "token": "tok_abc123def456..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Full email address of the new account |
| `token` | string | **One-time token** for accessing this account. Store securely; not shown again. |

### Examples

#### Using X-API-Key header:
```bash
curl -X POST https://clawmail-mcp.example.com/mcp \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "create_account",
      "arguments": {
        "local_part": "agent-bot"
      }
    }
  }'
```

#### Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "type": "text",
    "text": "{\"email\":\"agent-bot@mail.example.com\",\"token\":\"tok_xyz789...\"}"
  }
}
```

### Permissions

- **Public** — available to all authenticated callers
- Rate limit: 10 per hour per account
- Does not require admin role

### Related

- [account.list](#accountlist) — list all accounts
- [account.delete](#accountdelete) — delete an account
- [token.manage](#tokenmanage) — manage account tokens

---

## account.list

**List all email accounts on the mail server.**

Requires **admin** role.

### Parameters

None

### Response

```json
{
  "accounts": [
    {
      "email": "alice@mail.example.com",
      "quotaUsed": 1024000,
      "quotaTotal": 10737418240
    },
    {
      "email": "bot@mail.example.com",
      "quotaUsed": 512000,
      "quotaTotal": 10737418240
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `accounts` | array | List of account objects |
| `accounts[].email` | string | Account email address |
| `accounts[].quotaUsed` | number | Storage used in bytes |
| `accounts[].quotaTotal` | number | Storage quota in bytes (1 GiB default) |

### Examples

#### Request:
```bash
curl -X POST https://clawmail-mcp.example.com/mcp \
  -H "X-API-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "list_accounts",
      "arguments": {}
    }
  }'
```

### Permissions

- **Admin only** — regular users cannot list all accounts
- Rate limit: 200 per minute

### Related

- [account.create](#accountcreate) — create new account
- [account.delete](#accountdelete) — delete an account
- [config.account](#configaccount) — configure account settings

---

## account.delete

**Permanently delete an email account.**

All emails, contacts, calendar events, and settings are deleted. This operation **cannot be undone**.

Requires **admin** role.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `local_part` | string | ✅ | The local part (before @) of the account to delete. |

### Response

```json
{
  "message": "Account 'bot@mail.example.com' deleted successfully"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Confirmation message |

### Examples

#### Request:
```bash
curl -X POST https://clawmail-mcp.example.com/mcp \
  -H "X-API-Key: admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "delete_account",
      "arguments": {
        "local_part": "bot"
      }
    }
  }'
```

### Permissions

- **Admin only** — regular users cannot delete accounts
- Rate limit: 200 per minute
- **Caution:** Deletes all account data permanently

### Related

- [account.create](#accountcreate) — create new account
- [account.list](#accountlist) — list all accounts

---

## Token Management

Accounts can have multiple tokens for secure access. Each token is scoped to a single account.

### Generating Tokens

When you create an account with `account.create`, a token is returned. You can create additional tokens programmatically:

See [token.manage](./configuration.md#tokenmanage) for details on creating and revoking tokens.

### Token Security

- **Treat tokens like passwords** — keep them confidential
- Tokens are **hashed** — never stored in plaintext
- Each token can be individually revoked
- Tokens do not expire; they remain valid until revoked or the account is deleted

### Token Storage

Tokens are stored as encrypted JMAP emails in the `_tokens` system mailbox of the `clawmail-system` account. They are also cached in-memory with a 60-second TTL for performance.

---

## Account Metadata

When you create an account, it gets:
- A unique opaque ID (used internally by JMAP)
- A default 1 GiB storage quota
- Default folder structure (Inbox, Sent, Drafts, Trash, Archive, Junk)
- Empty contact list, calendar, and settings

All account data is private to that account and inaccessible to other accounts (except via admin tools with explicit authorization).
