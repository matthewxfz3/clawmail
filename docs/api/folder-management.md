# Folder Management

Operations for creating, organizing, and managing mailbox folders.

---

## folder.manage

**Create, delete, or rename mailbox folders.**

Folders organize emails in an account's mailbox. You can create nested folder hierarchies by specifying a `parent_folder`.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `create`, `delete`, `rename`. |
| `folder` | string | ✅ | Folder name (for create/delete/rename). |
| `new_name` | string | — | New folder name (required for `action='rename'`). |
| `parent_folder` | string | — | Parent folder name (optional for `action='create'` to nest folders). |

### Response

```json
{
  "message": "Folder 'Projects' created successfully"
}
```

### Examples

Create folder:
```json
{
  "name": "folder.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "folder": "Projects"
  }
}
```

Create nested folder:
```json
{
  "name": "folder.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "folder": "Q2-2026",
    "parent_folder": "Projects"
  }
}
```

Rename folder:
```json
{
  "name": "folder.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "rename",
    "folder": "Projects",
    "new_name": "Active Projects"
  }
}
```

Delete folder:
```json
{
  "name": "folder.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "delete",
    "folder": "Old Projects"
  }
}
```

### Permissions

- **User** can manage folders in their own account
- **Admin** can manage folders in any account
- Rate limit: 200 per minute

### System Folders

These folders exist by default and cannot be deleted:
- `Inbox` — incoming emails
- `Sent` — emails you've sent
- `Drafts` — unsent emails
- `Trash` — deleted emails (permanently deleted after retention period)
- `Archive` — archived emails
- `Junk` — spam emails

### Related

- [email.update](#emailupdate) — move emails to folders
- [email.list](#emaillist) — list emails in a folder
- [rule.manage](#rulemanage) — create rules that move emails
