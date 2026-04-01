import type { EmailSummary, EmailDetail } from "../clients/jmap.js";
export declare function toolListEmails(account: string, folder?: string, limit?: number): Promise<{
    emails: EmailSummary[];
    count: number;
    folder: string;
}>;
export declare function toolReadEmail(account: string, emailId: string): Promise<EmailDetail>;
export declare function toolDeleteEmail(account: string, emailId: string): Promise<{
    message: string;
}>;
export declare function toolSearchEmails(account: string, query: string): Promise<{
    emails: EmailSummary[];
    count: number;
    query: string;
}>;
//# sourceMappingURL=mailbox.d.ts.map