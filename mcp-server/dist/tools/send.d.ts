export interface SendEmailParams {
    fromAccount: string;
    to: string | string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
}
export declare function toolSendEmail(params: SendEmailParams): Promise<{
    message: string;
    queued_at: string;
}>;
//# sourceMappingURL=send.d.ts.map