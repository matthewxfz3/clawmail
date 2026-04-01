export declare function toolCreateAccount(localPart: string): Promise<{
    email: string;
    message: string;
}>;
export declare function toolDeleteAccount(localPart: string): Promise<{
    message: string;
}>;
export declare function toolListAccounts(): Promise<{
    accounts: Array<{
        email: string;
        name: string;
    }>;
    count: number;
}>;
//# sourceMappingURL=accounts.d.ts.map