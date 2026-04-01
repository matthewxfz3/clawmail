export interface EmailSummary {
    id: string;
    subject: string;
    from: string;
    to: string[];
    receivedAt: string;
    hasAttachment: boolean;
    preview: string;
    mailboxIds: string[];
}
export interface EmailDetail extends EmailSummary {
    htmlBody?: string;
    textBody?: string;
    headers: Record<string, string>;
}
export declare class JmapClient {
    private readonly accountId;
    constructor(accountId: string);
    private getSession;
    private request;
    private getMailboxId;
    listEmails(folder?: string, limit?: number): Promise<EmailSummary[]>;
    getEmail(emailId: string): Promise<EmailDetail>;
    deleteEmail(emailId: string): Promise<void>;
    searchEmails(query: string): Promise<EmailSummary[]>;
}
//# sourceMappingURL=jmap.d.ts.map