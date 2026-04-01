/**
 * Create a new individual account in Stalwart.
 * Throws if an account with the given localPart already exists.
 */
export declare function createAccount(localPart: string): Promise<{
    email: string;
}>;
/**
 * Permanently delete an account from Stalwart.
 */
export declare function deleteAccount(localPart: string): Promise<void>;
/**
 * List all individual accounts managed by Stalwart.
 */
export declare function listAccounts(): Promise<Array<{
    name: string;
    email: string;
    description?: string;
}>>;
/**
 * Return true if an account with the given localPart exists.
 */
export declare function accountExists(localPart: string): Promise<boolean>;
//# sourceMappingURL=stalwart-mgmt.d.ts.map