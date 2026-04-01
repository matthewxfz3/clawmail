import { JmapClient } from "../clients/jmap.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
function buildClient(account) {
    return new JmapClient(account);
}
// ---------------------------------------------------------------------------
// Tool: list_emails
// ---------------------------------------------------------------------------
export async function toolListEmails(account, folder, limit) {
    const effectiveFolder = folder ?? "Inbox";
    const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const client = buildClient(account);
    const emails = await client.listEmails(effectiveFolder, effectiveLimit);
    return {
        emails,
        count: emails.length,
        folder: effectiveFolder,
    };
}
// ---------------------------------------------------------------------------
// Tool: read_email
// ---------------------------------------------------------------------------
export async function toolReadEmail(account, emailId) {
    const client = buildClient(account);
    return client.getEmail(emailId);
}
// ---------------------------------------------------------------------------
// Tool: delete_email
// ---------------------------------------------------------------------------
export async function toolDeleteEmail(account, emailId) {
    const client = buildClient(account);
    await client.deleteEmail(emailId);
    return { message: `Email ${emailId} moved to Trash` };
}
// ---------------------------------------------------------------------------
// Tool: search_emails
// ---------------------------------------------------------------------------
export async function toolSearchEmails(account, query) {
    const client = buildClient(account);
    const emails = await client.searchEmails(query);
    return {
        emails,
        count: emails.length,
        query,
    };
}
//# sourceMappingURL=mailbox.js.map