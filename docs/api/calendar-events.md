# Calendar & Events

Operations for managing calendar events and sending/receiving invitations.

---

## event.manage

**Create, update, or delete calendar events stored in the account.**

Calendar events are stored as structured emails in the private `_calendar` mailbox. When you create an event, it appears in the account's calendar.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Full email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `action` | enum | ✅ | One of: `create`, `update`, `delete`. |
| `event_id` | string | — | Event ID (required for `update` or `delete`). |
| `title` | string | — | Event title (required for `create`). |
| `start` | string | — | ISO 8601 start time (required for `create`). Example: `"2026-04-14T10:00:00Z"`. |
| `end` | string | — | ISO 8601 end time (required for `create`, must be after start). |
| `timezone` | string | — | IANA timezone name (e.g., `"America/Los_Angeles"`). Defaults to UTC. |
| `attendees` | array | — | Email addresses of attendees. |
| `description` | string | — | Event description. |

### Response

**Create/Update:**
```json
{
  "event": {
    "eventId": "abc123",
    "title": "Team Meeting",
    "start": "2026-04-14T10:00:00Z",
    "end": "2026-04-14T11:00:00Z",
    "timezone": "America/Los_Angeles",
    "attendees": ["alice@example.com"],
    "description": null,
    "createdAt": "2026-04-13T09:00:00Z"
  },
  "message": "Event 'Team Meeting' created"
}
```

**Delete:**
```json
{
  "message": "Event 'abc123' deleted"
}
```

### Examples

Create event:
```json
{
  "name": "event.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "create",
    "title": "Team Standup",
    "start": "2026-04-14T09:00:00Z",
    "end": "2026-04-14T09:30:00Z",
    "timezone": "America/New_York",
    "attendees": ["alice@example.com", "bob@example.com"],
    "description": "Daily standup meeting"
  }
}
```

Update event:
```json
{
  "name": "event.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "update",
    "event_id": "abc123",
    "end": "2026-04-14T10:00:00Z"
  }
}
```

Delete event:
```json
{
  "name": "event.manage",
  "arguments": {
    "token": "tok_abc123...",
    "action": "delete",
    "event_id": "abc123"
  }
}
```

### Permissions

- **User** can create events in their own calendar
- **Admin** can create events in any account's calendar
- Rate limit: 200 per minute

### Timezone Support

The `timezone` parameter uses IANA timezone names:
- `"America/Los_Angeles"`, `"America/Denver"`, `"America/Chicago"`, `"America/New_York"`
- `"Europe/London"`, `"Europe/Paris"`, `"Europe/Berlin"`
- `"Asia/Tokyo"`, `"Asia/Hong_Kong"`, `"Asia/Singapore"`
- `"Australia/Sydney"`, `"UTC"`

When a timezone is specified, the event is stored with that timezone context. The Clawmail dashboard displays events in your preferred timezone.

### Related

- [event.send_invite](#eventsend_invite) — send invitation for a new event
- [event.cancel_invite](#eventcancel_invite) — cancel a sent invitation
- [event.respond](#eventrespond) — accept/decline/tentative

---

## event.send_invite

**Send a calendar invitation email that auto-appears in calendar apps.**

This tool:
1. **Sends an iCalendar invitation email** to recipients
2. **Automatically creates the event** in the sender's calendar (like Gmail/Outlook)
3. Optionally creates a video call room (Google Meet or Daily.co)
4. Recipients can accept/decline via their calendar app

Calendar apps that support RFC 5545 (Google Calendar, Outlook, Apple Calendar, etc.) will automatically import the event and allow attendees to RSVP directly.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from_account` | string | Optional* | Local part or full address to send from. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `to` | string or array | ✅ | Recipient address(es) — they become attendees. |
| `title` | string | ✅ | Event title. |
| `start` | string | ✅ | ISO 8601 start time (e.g., `"2026-04-14T14:00:00Z"`). |
| `end` | string | ✅ | ISO 8601 end time (must be after start). |
| `timezone` | string | — | IANA timezone name (defaults to UTC). Recipients' calendar will display in this timezone. |
| `description` | string | — | Event description shown in the invite. |
| `location` | string | — | Location or video call URL. |
| `uid` | string | — | Stable event UID — reuse the same UID to send an update for an existing invite. |
| `video_url` | string | — | Explicit video call URL. If omitted and configured, auto-creates a Google Meet or Daily.co room. |

### Response

```json
{
  "message": "Calendar invite 'Investor Meeting' sent from bot@mail.example.com to investor@example.com",
  "queued_at": "2026-04-13T11:45:00Z",
  "uid": "abc123@mail.example.com",
  "video_url": "https://meet.google.com/abc-defg-hij"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Confirmation message |
| `queued_at` | string | ISO 8601 timestamp |
| `uid` | string | Event UID (save this to update/cancel later) |
| `video_url` | string or null | Video call URL (if created or provided) |

### Examples

Basic invitation (no video):
```json
{
  "name": "event.send_invite",
  "arguments": {
    "token": "tok_abc123...",
    "to": "investor@example.com",
    "title": "Investor Meeting Preparation",
    "start": "2026-04-14T17:00:00Z",
    "end": "2026-04-14T18:00:00Z",
    "timezone": "America/Los_Angeles",
    "description": "Discuss Q2 roadmap"
  }
}
```

With auto-created video room:
```json
{
  "name": "event.send_invite",
  "arguments": {
    "token": "tok_abc123...",
    "to": ["alice@example.com", "bob@example.com"],
    "title": "Team Sync",
    "start": "2026-04-15T09:00:00Z",
    "end": "2026-04-15T10:00:00Z",
    "timezone": "America/New_York"
  }
}
```

Explicit video URL:
```json
{
  "name": "event.send_invite",
  "arguments": {
    "token": "tok_abc123...",
    "to": "user@example.com",
    "title": "1:1 Sync",
    "start": "2026-04-14T15:00:00Z",
    "end": "2026-04-14T15:30:00Z",
    "video_url": "https://zoom.us/j/123456789"
  }
}
```

Update existing invite (reuse UID):
```json
{
  "name": "event.send_invite",
  "arguments": {
    "token": "tok_abc123...",
    "to": "user@example.com",
    "title": "Team Sync (Rescheduled)",
    "start": "2026-04-16T09:00:00Z",
    "end": "2026-04-16T10:00:00Z",
    "uid": "original-uid-from-previous-send"
  }
}
```

### Behavior

1. **Email sent immediately** via SendGrid SMTP
2. **Event created in sender's calendar** (visible in Clawmail dashboard)
3. **Calendar client import** — recipients' calendar apps auto-import and prompt to accept/decline
4. **Video room created** (if configured and not explicitly provided) — expires at event end time
5. **Timezone display** — calendar apps show event in the specified timezone with proper offset handling

### Permissions

- **User** can send invites from their own account
- **Admin** can send invites from any account
- Rate limit: 60 per minute per account

### Video Room Integration

The system supports:
1. **Explicit URL** — pass `video_url` parameter
2. **Google Meet** (if `GOOGLE_MEET_API_KEY` configured) — auto-creates a meeting room
3. **Daily.co** (if `DAILY_API_KEY` configured) — auto-creates a video room
4. **None** — invitation is call-free

Video rooms auto-expire at the event end time.

### Related

- [event.manage](#eventmanage) — create/update/delete events in your calendar
- [event.cancel_invite](#eventcancel_invite) — cancel a sent invitation
- [event.respond](#eventrespond) — accept/decline/tentative to an invitation
- [email.send](#emailsend) — send a regular email

---

## event.cancel_invite

**Cancel a previously sent calendar invitation.**

Sends an iCalendar METHOD:CANCEL message to recipients. Their calendar apps automatically remove the event from their calendars.

Requires the same UID used when sending the original invite.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from_account` | string | Optional* | Organizer address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `to` | string or array | ✅ | Original recipient addresses (same as the original invite). |
| `uid` | string | ✅ | The event UID from the original `event.send_invite` response. |
| `title` | string | ✅ | Event title (should match the original). |
| `start` | string | ✅ | Event start time (must match the original). |
| `end` | string | ✅ | Event end time (must match the original). |
| `sequence` | number | — | Sequence number (default: 1). Increment if sending multiple cancellations for the same UID. |

### Response

```json
{
  "message": "Cancellation sent for 'Team Sync' to alice@example.com, bob@example.com"
}
```

### Examples

```json
{
  "name": "event.cancel_invite",
  "arguments": {
    "token": "tok_abc123...",
    "to": ["alice@example.com", "bob@example.com"],
    "uid": "abc123@mail.example.com",
    "title": "Team Sync",
    "start": "2026-04-15T09:00:00Z",
    "end": "2026-04-15T10:00:00Z"
  }
}
```

### Permissions

- **User** can cancel invites sent from their own account
- **Admin** can cancel invites from any account
- Rate limit: 60 per minute per account

### Related

- [event.send_invite](#eventsend_invite) — send an invitation
- [event.respond](#eventrespond) — respond to an invitation
- [email.send](#emailsend) — send a regular email

---

## event.respond

**Accept, decline, or tentatively accept a calendar invitation.**

Sends an iCalendar response email to the event organizer.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `account` | string | Optional* | Your email address. Required if not using `token`. |
| `token` | string | Optional* | Account token. |
| `uid` | string | ✅ | Event UID from the invitation (call `email.read` to get it). |
| `organizer` | string | ✅ | Organizer's email address. |
| `title` | string | ✅ | Event title. |
| `start` | string | ✅ | ISO 8601 start time. |
| `end` | string | ✅ | ISO 8601 end time. |
| `response` | enum | ✅ | One of: `accept`, `decline`, `tentative`. |
| `comment` | string | — | Optional comment to include in your response. |

### Response

```json
{
  "message": "Response 'accepted' sent to organizer@example.com"
}
```

### Examples

Accept:
```json
{
  "name": "event.respond",
  "arguments": {
    "token": "tok_abc123...",
    "uid": "abc123@example.com",
    "organizer": "organizer@example.com",
    "title": "Team Sync",
    "start": "2026-04-15T09:00:00Z",
    "end": "2026-04-15T10:00:00Z",
    "response": "accept"
  }
}
```

Tentative with comment:
```json
{
  "name": "event.respond",
  "arguments": {
    "token": "tok_abc123...",
    "uid": "abc123@example.com",
    "organizer": "organizer@example.com",
    "title": "Team Sync",
    "start": "2026-04-15T09:00:00Z",
    "end": "2026-04-15T10:00:00Z",
    "response": "tentative",
    "comment": "I might have a conflict; will confirm by EOD"
  }
}
```

### Permissions

- **User** can respond to invitations for their own account
- **Admin** can respond on behalf of any account
- Rate limit: 60 per minute per account

### Related

- [email.read](#emailread) — read invitation emails and extract details
- [event.send_invite](#eventsend_invite) — send an invitation
- [event.manage](#eventmanage) — manage your own calendar events
