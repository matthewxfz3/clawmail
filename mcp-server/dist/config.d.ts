export declare const config: {
    readonly domain: string;
    readonly stalwart: {
        readonly url: string;
        readonly adminUser: string;
        readonly adminPassword: string;
    };
    readonly auth: {
        readonly apiKeys: Set<string>;
    };
    readonly limits: {
        readonly maxAttachmentBytes: number;
        readonly sendEmailPerMinute: 20;
        readonly createAccountPerHour: 10;
        readonly readOpsPerMinute: 200;
    };
    readonly port: number;
};
//# sourceMappingURL=config.d.ts.map