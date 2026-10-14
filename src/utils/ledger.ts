// This IDE uses TypeScript 3.7; Ledger's declaration files use newer TS syntax.
// Keep the small transport boundary typed without importing those declarations.
interface LedgerTransport {
    close(): Promise<void>;
    setExchangeTimeout(timeout: number): void;
}
const TransportWebUSB: {open(device: any): Promise<LedgerTransport>} = require('@ledgerhq/hw-transport-webusb').default;
import { Waves } from '@waves/ledger/lib/Waves';
import { Buffer } from 'buffer';
import { libs } from '@waves/waves-transactions';
import { LedgerAccount, signLedgerTransaction } from './ledger.transaction';

export function ledgerUnavailableReason(): string | undefined {
    if (!window.isSecureContext) return 'Ledger needs HTTPS. Open this IDE at its HTTPS address.';
    if (!('usb' in navigator)) return 'Direct Ledger signing needs a browser with WebUSB, such as desktop Chrome.';
    return undefined;
}

export function ledgerError(error: any): string {
    const status = error && (error.statusCode || error.status);
    if (status === 0x5515) return 'Ledger is locked. Unlock it with your PIN on the device, open the Waves app, then reconnect.';
    if (status === 0x6985 || status === 0x9100) return 'Signing was rejected on Ledger. Your transaction was not changed.';
    if (status === 0x6986 || status === 0x6e00 || status === 0x6d00) return 'Unlock Ledger and open the Waves app, then reconnect.';
    if (status === 0x9104 || status === 0x9102) return 'The Ledger Waves app does not support this transaction type or version. Check for an app update.';
    return error && error.message ? error.message : 'Ledger could not sign. Unlock the device, open Waves, and close other applications using Ledger.';
}

const ADDRESS_PAGE_SIZE = 10;

export class LedgerConnection {
    private transport?: LedgerTransport;
    private waves?: Waves;
    private account?: LedgerAccount;
    private chainId?: number;
    private busy = false;

    async connect(chainId: number, cancelled: () => boolean = () => false): Promise<LedgerAccount[]> {
        const unavailable = ledgerUnavailableReason();
        if (unavailable) throw new Error(unavailable);
        if (this.busy) throw new Error('A Ledger operation is already in progress.');
        this.busy = true;
        try {
            // Invoke the chooser directly from the click, before any network requests.
            const device = await (navigator as any).usb.requestDevice({filters: [{vendorId: 0x2c97}]});
            await this.disconnect();
            if (cancelled()) throw new Error('Ledger connection cancelled.');
            this.transport = await TransportWebUSB.open(device);
            this.transport.setExchangeTimeout(120000);
            this.waves = new Waves(this.transport, chainId);
            this.chainId = chainId;
        } catch (error) {
            await this.disconnect();
            throw error;
        } finally {
            this.busy = false;
        }
        try {
            return await this.discoverAccounts(0, chainId, cancelled);
        } catch (error) {
            await this.disconnect();
            throw error;
        }
    }

    async discoverAccounts(start: number, chainId: number, cancelled: () => boolean = () => false): Promise<LedgerAccount[]> {
        this.checkConnection(chainId);
        if (!Number.isInteger(start) || start < 0 || start > 0x7fffffff - (ADDRESS_PAGE_SIZE - 1)) throw new Error('Invalid Ledger account range.');
        this.busy = true;
        try {
            const accounts: LedgerAccount[] = [];
            for (let index = start; index < start + ADDRESS_PAGE_SIZE; index++) {
                if (cancelled()) throw new Error('Ledger address loading cancelled.');
                accounts.push(await this.readAccount(index, chainId, false));
            }
            if (cancelled()) throw new Error('Ledger address loading cancelled.');
            return accounts;
        } finally {
            this.busy = false;
        }
    }

    async selectAccount(index: number, chainId: number): Promise<LedgerAccount> {
        this.checkConnection(chainId);
        if (!Number.isInteger(index) || index < 0 || index > 0x7fffffff) throw new Error('Invalid Ledger account.');
        this.busy = true;
        this.account = undefined;
        try {
            // Confirm the chosen address on the physical device before enabling signing.
            const account = await this.readAccount(index, chainId, true);
            this.account = account;
            return account;
        } finally {
            this.busy = false;
        }
    }

    private checkConnection(chainId: number): void {
        if (this.busy) throw new Error('A Ledger operation is already in progress.');
        if (!this.waves) throw new Error('Connect Ledger first.');
        if (this.chainId !== chainId) throw new Error('The selected network changed. Reconnect Ledger to load its addresses.');
    }

    private async readAccount(index: number, chainId: number, verify: boolean): Promise<LedgerAccount> {
        const user = await this.waves!.getWalletPublicKey(this.path(index), verify);
        if (user.address !== libs.crypto.address({publicKey: user.publicKey}, chainId)) {
            throw new Error('Ledger returned an address for a different network.');
        }
        return {address: user.address, publicKey: user.publicKey, index, chainId};
    }

    async disconnect(): Promise<void> {
        const transport = this.transport;
        this.transport = undefined;
        this.waves = undefined;
        this.chainId = undefined;
        this.account = undefined;
        if (transport) await transport.close().catch(() => undefined);
    }

    async sign(tx: any, nodeUrl: string, chainId: number, proofIndex: number, cancelled: () => boolean): Promise<any> {
        if (!this.account || !this.waves) throw new Error('Connect Ledger first.');
        if (this.busy) throw new Error('A Ledger operation is already in progress.');
        this.busy = true;
        const account = this.account;
        const waves = this.waves;
        try {
            const cache: {[asset: string]: number} = {};
            const decimals = async (asset?: string | null): Promise<number> => {
                if (!asset || asset === 'WAVES') return 8;
                if (cache[asset] != null) return cache[asset];
                const response = await fetch(`${nodeUrl.replace(/\/$/, '')}/assets/details/${encodeURIComponent(asset)}`);
                if (!response.ok) throw new Error('Could not load asset precision from the selected node.');
                const details = await response.json();
                if (!Number.isInteger(details.decimals) || details.decimals < 0 || details.decimals > 8) {
                    throw new Error('The selected node returned invalid asset precision.');
                }
                return cache[asset] = details.decimals;
            };
            return await signLedgerTransaction(tx, account, chainId, proofIndex,
                data => waves.signTransaction(this.path(account.index), {...data, dataBuffer: Buffer.from(data.dataBuffer)}),
                decimals, cancelled);
        } finally {
            this.busy = false;
        }
    }

    private path(index: number): string { return `44'/5741564'/0'/0'/${index}'`; }
}
