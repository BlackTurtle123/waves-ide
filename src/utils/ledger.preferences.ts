import { libs } from '@waves/waves-transactions';
import { LedgerAccount } from './ledger.transaction';

export interface LedgerPreferences {
    accounts: LedgerAccount[];
    selected?: string;
    verified: {[index: string]: string};
    senders: {[publicKey: string]: string};
}
export interface LedgerStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}
const STORAGE_KEY = 'waves-ide-ledger-public-accounts-v1';
export const emptyLedgerPreferences = (): LedgerPreferences => ({accounts: [], verified: {}, senders: {}});

// Store public account information only. Profiles are isolated by network and the
// connected device's first public key; an account index alone is not an identity.
export class LedgerPreferencesStore {
    constructor(private storage?: LedgerStorage) {}
    private getStorage(): LedgerStorage | undefined {
        try { return this.storage || (typeof window !== 'undefined' ? window.localStorage : undefined); }
        catch (_) { return undefined; }
    }
    private read(): {[profile: string]: LedgerPreferences} {
        try { return JSON.parse(this.getStorage()!.getItem(STORAGE_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    }
    load(profile: string, chainId: number): LedgerPreferences {
        const saved = this.read()[profile];
        if (!saved || !Array.isArray(saved.accounts)) return emptyLedgerPreferences();
        try {
            const accounts = saved.accounts.slice(0, 1000);
            if (!accounts.every((account, index) => account.index === index && account.chainId === chainId
                && account.address === libs.crypto.address({publicKey: account.publicKey}, chainId))) return emptyLedgerPreferences();
            const verified: {[index: string]: string} = {};
            accounts.forEach(account => {
                if (saved.verified && saved.verified[account.index] === account.publicKey) verified[account.index] = account.publicKey;
            });
            const keys = accounts.map(account => account.publicKey);
            const senders: {[key: string]: string} = {};
            Object.keys(saved.senders || {}).forEach(sender => {
                if (keys.includes(saved.senders[sender])) senders[sender] = saved.senders[sender];
            });
            return {accounts, verified, senders, selected: keys.includes(saved.selected || '') ? saved.selected : undefined};
        } catch (_) { return emptyLedgerPreferences(); }
    }
    save(profile: string, preferences: LedgerPreferences): void {
        try { this.getStorage()!.setItem(STORAGE_KEY, JSON.stringify({...this.read(), [profile]: preferences})); }
        catch (_) { /* A blocked/full browser store must not prevent signing. */ }
    }
}

export function ledgerSenderKeys(value: string): string[] {
    try {
        const input = libs.marshall.json.parseTx(value);
        const txs = Array.isArray(input) ? input : [input];
        if (!txs.length || txs.some(tx => typeof tx.senderPublicKey !== 'string' || !tx.senderPublicKey)) return [];
        return Array.from(new Set(txs.map(tx => tx.senderPublicKey as string)));
    } catch (_) { return []; }
}

export function preferredLedgerAccount(preferences: LedgerPreferences, senders: string[]): LedgerAccount | undefined {
    const {accounts} = preferences;
    if (!senders.length) return accounts.find(account => account.publicKey === preferences.selected);
    const choices = senders.map(sender => {
        // A deliberate per-sender choice also supports a co-signer different from
        // the sender. Otherwise prefer the exact sender over the last-used wallet.
        return preferences.senders[sender]
            || (accounts.some(account => account.publicKey === sender) ? sender : preferences.selected);
    });
    if (!choices[0] || choices.some(key => key !== choices[0])) return undefined;
    return accounts.find(account => account.publicKey === choices[0]);
}
