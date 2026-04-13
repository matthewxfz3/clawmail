# Configuration

Operations for configuring account settings and managing access tokens.

---

## config.account

**Configure account settings: display name, signature, vacation reply, forwarding, and more.**

Manage how the account presents itself and handles incoming/outgoing email.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `get`, `set`. |
| `display_name` | string | — | Display name for outgoing emails. |
| `signature` | string | — | Email signature appended to outgoing messages. |
| `vacation_reply` | string | — | Auto-reply message when account is on vacation (empty string to disable). |
| `forward_to` | string | — | Forward all incoming emails to this address (empty string to disable). |
| `status` | enum | — | One of: `active`, `suspended`. Suspended accounts cannot send/receive. |

### Response

**Get:**
```json
{
  "settings": {
    "display_name": "Alice Smith",
    "signature": "Best regards,\nAlice",
    "vacation_reply": null,
    "forward_to": null,
    "status": "active",
    "whitelist": [
      { "id": "entry-1", "address": "trusted@example.com" }
    ],
    "blacklist": [
      { "id": "entry-2", "address": "spam@badomain.com" }
    ],
    "quota": {
      "used": 1024000,
      "total": 10737418240
    }
  }
}
```

**Set:**
```json
{
  "message": "Settings updated",
  "settings": {
    "display_name": "Alice Smith",
    "signature": "Updated signature"
  }
}
```

### Examples

Get all settings:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "get"
  }
}
```

Set display name:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "set",
    "display_name": "Alice Smith"
  }
}
```

Set email signature:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "set",
    "signature": "Best regards,\nAlice Smith\nProduct Manager\nAcme Corp"
  }
}
```

Enable vacation reply:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "set",
    "vacation_reply": "I'm out of office and will return on April 20. For urgent matters, please contact support@acme.com"
  }
}
```

Disable vacation reply:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "set",
    "vacation_reply": ""
  }
}
```

Forward all emails:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "set",
    "forward_to": "forwarding@example.com"
  }
}
```

Suspend account:
```json
{
  "name": "config.account",
  "arguments": {
    "token": "tok_abc123...",
    "action": "set",
    "status": "suspended"
  }
}
```

### Permissions

- **User** can configure their own account
- **Admin** can configure any account
- Rate limit: 200 per minute

### Related

- [sender.manage_list](#sendermanage_list) — manage whitelist/blacklist
- [token.manage](#tokenmanage) — manage account tokens
- [account.list](#accountlist) — view account quota and metadata

---

## token.manage

**Create or revoke account access tokens.**

Tokens are per-account credentials for API access. Each token can be individually revoked without affecting other tokens.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `token` | string | Optional* | Account token (required if not using `X-API-Key`). |
| `action` | enum | ✅ | One of: `create`, `list`, `revoke`. |
| `display_name` | string | — | Human-readable name for the token (e.g., `"Bot#1"`, `"CI/CD Pipeline"`). Required for `action='create'`. |
| `token_to_revoke` | string | — | Token to revoke (required for `action='revoke'`). |

### Response

**Create:**
```json
{
  "token": "tok_xyz789abc...",
  "display_name": "Bot#1",
  "created_at": "2026-04-13T12:00:00Z",
  "message": "Token created. Store this token securely — it won't be shown again."
}
```

**List:**
```json
{
  "tokens": [
    {
      "id": "token-1",
      "display_name": "Bot#1",
      "created_at": "2026-04-13T11:00:00Z",
      "last_used": "2026-04-13T12:30:00Z"
    },
    {
      "id": "token-2",
      "display_name": "CI/CD Pipeline",
      "created_at": "2026-04-10T10:00:00Z",
      "last_used": "2026-04-13T08:00:00Z"
    }
  ],
  "total": 2
}
```

**Revoke:**
```json
{
  "message": "Token revoked successfully"
}
```

### Examples

Create token:
```json
{
  "name": "token.manage",
  "arguments": {
    "token": "tok_existing_token...",
    "action": "create",
    "display_name": "Backup Bot"
  }
}
```

List tokens:
```json
{
  "name": "token.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "list"
  }
}
```

Revoke token:
```json
{
  "name": "token.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "revoke",
    "token_to_revoke": "tok_old_token_to_revoke..."
  }
}
```

### Permissions

- **User** can create/revoke their own tokens
- **Admin** can create/revoke tokens for any account
- Rate limit: 200 per minute

### Token Security

- **Never commit tokens to version control** — use environment variables or secret management
- **Treat tokens like passwords** — keep them confidential
- **Rotate tokens regularly** — revoke old tokens and create new ones
- **Monitor usage** — check `last_used` timestamps to detect compromise
- **Revoke immediately** if a token is exposed — the old token becomes invalid instantly

### Token Storage Best Practices

```bash
# Bad: hardcoded in code
TOKEN="tok_abc123"  # Don't do this!

# Good: environment variable
export CLAWMAIL_TOKEN="$CLAWMAIL_TOKEN"
curl ... -H "Authorization: Bearer $CLAWMAIL_TOKEN"

# Good: secret management
# Store in 1Password, HashiCorp Vault, AWS Secrets Manager, etc.
```

### Related

- [account.create](#accountcreate) — returns the initial token
- [config.account](#configaccount) — view account configuration
