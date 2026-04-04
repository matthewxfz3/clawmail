import { JmapClient } from "../clients/jmap.js";

// ---------------------------------------------------------------------------
// Tool: list_folders
// ---------------------------------------------------------------------------

export async function toolListFolders(params: {
  account: string;
}): Promise<{
  folders: Array<{ id: string; name: string; role: string; totalEmails: number; unreadEmails: number }>;
  count: number;
}> {
  const client = new JmapClient(params.account);
  const all = await client.listMailboxes();
  // Exclude internal system mailboxes (prefixed with _)
  const folders = all.filter((m) => !m.name.startsWith("_"));
  return { folders, count: folders.length };
}

// ---------------------------------------------------------------------------
// Tool: create_folder
// ---------------------------------------------------------------------------

export async function toolCreateFolder(params: {
  account: string;
  name: string;
  parent_folder?: string;
}): Promise<{ folder_id: string; message: string }> {
  if (!params.name.trim()) throw new Error("Folder name must not be empty");
  const client = new JmapClient(params.account);
  const folderId = await client.createMailbox(params.name, params.parent_folder);
  return {
    folder_id: folderId,
    message: params.parent_folder
      ? `Folder "${params.name}" created under "${params.parent_folder}"`
      : `Folder "${params.name}" created`,
  };
}

// ---------------------------------------------------------------------------
// Tool: delete_folder
// ---------------------------------------------------------------------------

export async function toolDeleteFolder(params: {
  account: string;
  folder: string;
}): Promise<{ message: string }> {
  const client = new JmapClient(params.account);
  await client.deleteMailbox(params.folder);
  return { message: `Folder "${params.folder}" deleted` };
}

// ---------------------------------------------------------------------------
// Tool: move_email
// ---------------------------------------------------------------------------

export async function toolMoveEmail(params: {
  account: string;
  email_id: string;
  folder: string;
}): Promise<{ message: string }> {
  const client = new JmapClient(params.account);
  await client.moveEmail(params.email_id, params.folder);
  return { message: `Email ${params.email_id} moved to "${params.folder}"` };
}
