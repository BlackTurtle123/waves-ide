import { Buffer } from 'buffer';
import { libs } from '@waves/waves-transactions';

export const NODE_URL = 'https://nodes.wx.network';
export const CONFIG = '3PGWhtvCSz1TRJhe3BJSrvQigrtKuyXsgma';
export const ARKIMAL_DAOS = [
    {address: '3P6x6krU9yQNbnnCQuLvSihysVQDLpWUMxz', name: 'Arkimals Dao'},
    {address: '3PAnedq9FteKW1rxSaohM6Xk4D5zBSHkkW4', name: 'Arkimals funding for development'}
];
export const WAVES_DAO = '3PEwRcYNAUtoFvKpBhKoiwajnZfdoDR6h4h';
const ADDRESS_PATTERN = '3P[1-9A-HJ-NP-Za-km-z]{33}';
const skinKey = new RegExp(`^skin_(${ADDRESS_PATTERN})_(${ADDRESS_PATTERN})$`);
const withdrawalKey = new RegExp(`^(${ADDRESS_PATTERN})_(${ADDRESS_PATTERN})_withdraw_amount$`);
export interface Entry { key: string; type: string; value: any; }
export type State = {[key: string]: any};
export interface Position {
    dao: string; name: string; address: string; committed: number; withdrawing: number;
    claimable: number; locked: number; withdrawHeight?: number; exitHeight?: number;
    status: string; exitReason?: string; pendingCommit: number;
}
export interface Snapshot {
    height: number; timestamp: number; fetchedAt: number; address?: string;
    walletBalance?: number; positions: Position[];
    arkimals: {address: string; name: string; holders: Position[]}[];
}
export type Request = (path: string, body?: any) => Promise<any>;

export function validAddress(address: string): boolean {
    try { return libs.crypto.verifyAddress(address, {chainId: 87}); } catch (_) { return false; }
}
export function integer(value: any, label: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}; refresh or check the node.`);
    return value;
}
export function state(entries: Entry[]): State {
    if (!Array.isArray(entries)) throw new Error('The node did not return account data.');
    const result: State = Object.create(null);
    for (const entry of entries) {
        // Do not silently round chain integers. Negative sentinel values are kept.
        if (entry.type === 'integer' && !Number.isSafeInteger(entry.value)) throw new Error(`Unsafe integer in ${entry.key}`);
        result[entry.key] = entry.value;
    }
    return result;
}
export function amount(data: State, key: string, fallback = 0): number {
    return integer(data[key] === undefined ? fallback : data[key], key);
}
export function formatPwr(value: number): string {
    integer(value, 'PWR amount');
    const whole = Math.floor(value / 100000000).toLocaleString('en-US');
    const fraction = String(value % 100000000).padStart(8, '0').replace(/0+$/, '');
    return whole + (fraction ? '.' + fraction : '');
}
export function sum(values: number[]): number {
    return values.reduce((a, b) => integer(a + b, 'PWR total'), 0);
}
// Attachments are BSON, not JSON. Only decode the leading title string; never
// render descriptions as HTML or guess a name from unrelated binary content.
export function daoTitle(encoded: unknown): string | undefined {
    if (typeof encoded !== 'string' || !encoded.startsWith('base64:')) return undefined;
    try {
        const b = Buffer.from(encoded.slice(7), 'base64');
        if (b.length < 16 || b.readInt32LE(0) !== b.length || b[4] !== 2 || b.slice(5, 11).toString() !== 'title\0') return undefined;
        const length = b.readInt32LE(11);
        if (length < 2 || length > 1025 || 15 + length > b.length || b[14 + length] !== 0) return undefined;
        return b.slice(15, 14 + length).toString('utf8');
    } catch (_) { return undefined; }
}
export function operationBlock(config: State, op: string, address: string): string | undefined {
    // Match config.opAllowed's order, including the exception list.
    if (String(config.stoplist || '').includes(address)) return 'Account restricted by protocol';
    if (String(config.exc || '').includes(address)) return undefined;
    if (config.system_allowed === false || config[`op_${op}_allowed`] === false) return `${op} is paused by governance`;
    return undefined;
}
export function childPairs(children: State, withdrawals: State, wavesDao = WAVES_DAO): {dao: string; address: string}[] {
    const pairs = new Map<string, {dao: string; address: string}>();
    const add = (dao: string, address: string) => pairs.set(`${dao}:${address}`, {dao, address});
    Object.keys(children).forEach(key => {
        const match = skinKey.exec(key);
        if (match && amount(children, key) > 0) add(match[1], match[2]);
        const pending = new RegExp(`^pending_commit_amount_(${ADDRESS_PATTERN})$`).exec(key);
        if (pending && amount(children, key) > 0) {
            // Current acceptCommit assigns all miner rewards to wavesDAO; legacy
            // pending_commit_child keys can be absent or stale.
            add(wavesDao, pending[1]);
        }
    });
    Object.keys(withdrawals).forEach(key => {
        const match = withdrawalKey.exec(key);
        if (match && amount(withdrawals, key) > 0) add(match[1], match[2]);
    });
    return Array.from(pairs.values());
}
export function classifyPosition(input: {
    dao: string; name: string; address: string; committed: number; pendingCommit?: number;
    withdrawals: State; config: State; height: number; started: boolean;
    cooldown: number; kpiLock: number; safetyWindow: number; legacyUnlock?: number; mother?: boolean;
}): Position {
    const {dao, name, address, committed, withdrawals, config, height, started, cooldown, kpiLock, safetyWindow} = input;
    const key = `${dao}_${address}`;
    const withdrawing = amount(withdrawals, key + '_withdraw_amount');
    const withdrawHeight = withdrawals[key + '_withdraw_height'] === undefined ? undefined : amount(withdrawals, key + '_withdraw_height');
    if (withdrawing > 0 && withdrawHeight === undefined) throw new Error(`Withdrawal height missing for ${name}.`);
    const pendingCommit = input.pendingCommit || 0;
    const withdrawBlock = operationBlock(config, 'withdraw', address);
    let claimable = withdrawing > 0 && withdrawHeight! <= height && !withdrawBlock ? withdrawing : 0;
    const exitBlock = operationBlock(config, input.mother ? 'exit' : started ? 'exitChild' : 'undoCommit', address);
    const exitReason = exitBlock || (started && withdrawHeight !== undefined ? 'Claim the existing withdrawal before starting another exit' : undefined);
    const exitHeight = committed > 0 && !exitReason ? (started ? Math.max(height + cooldown,
        kpiLock > 0 ? kpiLock + safetyWindow : 0, input.legacyUnlock || 0) : height) : undefined;
    if (!started && !exitBlock) claimable = sum([claimable, committed]);
    const status = committed > 0 ? (exitReason || (started ? 'Exit required · cooldown starts when you exit' : 'Available to undo commitment')) :
        withdrawing > 0 ? (withdrawBlock || (withdrawHeight! <= height ? 'Ready to claim' : 'Withdrawal cooldown')) : 'Pending commitment';
    return {dao, name, address, committed, withdrawing, pendingCommit, claimable,
        locked: sum([committed, withdrawing, pendingCommit]) - claimable, withdrawHeight, exitHeight, status, exitReason};
}

export function nodeRequest(signal?: AbortSignal, base = NODE_URL): Request {
    return async (path, body) => {
        const response = await fetch(base + path, {signal, cache: 'no-store',
            ...(body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
        if (!response.ok) throw new Error(`Node request failed (${response.status}). Try Refresh.`);
        const data = await response.json();
        if (data.error !== undefined) throw new Error('The node could not evaluate the current contract. Try Refresh.');
        return data;
    };
}
async function read(request: Request, address: string, matches?: string): Promise<State> {
    if (!validAddress(address)) throw new Error('Protocol configuration contains an invalid mainnet address.');
    return state(await request(`/addresses/data/${address}${matches ? '?matches=' + encodeURIComponent(matches) : ''}`));
}
function contract(config: State, key: string): string {
    const value = config[key];
    if (typeof value !== 'string' || !validAddress(value)) throw new Error(`Protocol contract ${key} is missing or invalid.`);
    return value;
}
export async function loadSnapshot(address?: string, request: Request = nodeRequest()): Promise<Snapshot> {
    if (address && !validAddress(address)) throw new Error('Enter a valid Waves mainnet address.');
    const config = await read(request, CONFIG);
    const childrenAddress = contract(config, 'contract_children');
    const withdrawalAddress = contract(config, 'contract_withdrawal');
    const staker = contract(config, 'contract_staking');
    const voting = contract(config, 'contract_children_voting');
    const [children, withdrawals, block] = await Promise.all([
        read(request, childrenAddress, '^(skin_.*|attachments_.*|start_height_.*|pending_commit_.*)$'),
        read(request, withdrawalAddress, '.*_withdraw_(amount|height)$'), request('/blocks/headers/last')
    ]);
    const height = integer(block.height, 'block height');
    if (!validAddress(block.generator)) throw new Error('The node did not return a Waves mainnet block.');
    const wavesDao = config.wavesDAO || WAVES_DAO;
    if (!validAddress(wavesDao)) throw new Error('Invalid Waves DAO configuration.');
    const pairs = childPairs(children, withdrawals, wavesDao).filter(pair => pair.dao !== staker &&
        (pair.address === address || ARKIMAL_DAOS.some(dao => dao.address === pair.dao)));
    const daos = Array.from(new Set(pairs.map(pair => pair.dao)));
    const settings = new Map<string, State>();
    // Bounded concurrency: an account with many DAOs must not flood the node.
    for (let start = 0; start < daos.length; start += 4) {
        await Promise.all(daos.slice(start, start + 4).map(async dao =>
            settings.set(dao, await read(request, dao, '^(exit_cooldown|kpi_safety_window)$'))));
    }
    const kpi = pairs.length ? await read(request, voting, '^user_kpi_lock_.*$') : {};
    const positions = pairs.map(({dao, address: holder}) => classifyPosition({
        dao, address: holder, name: daoTitle(children['attachments_' + dao]) || (dao === wavesDao ? 'Waves DAO' : undefined) || ARKIMAL_DAOS.find(d => d.address === dao)?.name || dao,
        committed: amount(children, `skin_${dao}_${holder}`),
        pendingCommit: wavesDao === dao ? amount(children, `pending_commit_amount_${holder}`) : 0,
        withdrawals, config, height, started: children['start_height_' + dao] !== undefined,
        cooldown: amount(settings.get(dao)!, 'exit_cooldown', amount(config, childrenAddress + '_exit_cooldown', 129600)),
        safetyWindow: amount(settings.get(dao)!, 'kpi_safety_window', amount(config, childrenAddress + '_kpi_safety_window', 43200)),
        kpiLock: amount(kpi, `user_kpi_lock_${dao}_${holder}`)
    }));
    const own = positions.filter(p => p.address === address);
    let walletBalance: number | undefined;
    if (address) {
        const [advice, stake, motherKpi, balance] = await Promise.all([
            request(`/utils/script/evaluate/${staker}`, {expr: `adviseUser("${address}")`}),
            read(request, staker, `^${address}_shares_(lock|height)$`),
            read(request, contract(config, 'contract_voting'), `^user_kpi_lock_${address}$`),
            request(`/assets/balance/${address}/${config.powerAssetId}`)
        ]);
        const match = advice.result && advice.result.type === 'String' && /(?:^|, )staked: (\d+)(?:,|$)/.exec(advice.result.value);
        if (!match) throw new Error('The Mother DAO contract returned an unrecognized balance.');
        const committed = integer(Number(match[1]), 'Mother DAO stake');
        walletBalance = integer(balance.balance, 'wallet balance');
        const mother = classifyPosition({dao: staker, name: 'Mother DAO', address, committed, withdrawals, config, height,
            started: true, mother: true, cooldown: amount(config, staker + '_exit_cooldown', 43200),
            kpiLock: amount(motherKpi, 'user_kpi_lock_' + address), safetyWindow: amount(config, staker + '_kpi_safety_window', 43200),
            legacyUnlock: Math.max(amount(stake, address + '_shares_lock'), amount(stake, address + '_shares_height')) + amount(config, staker + '_min_lock_time')});
        own.unshift(mother);
    }
    return {height, timestamp: integer(block.timestamp, 'block timestamp'), fetchedAt: Date.now(), address, walletBalance,
        positions: own, arkimals: ARKIMAL_DAOS.map(dao => ({...dao, holders: positions.filter(p => p.dao === dao.address)
            .sort((a, b) => sum([b.committed, b.withdrawing, b.pendingCommit]) - sum([a.committed, a.withdrawing, a.pendingCommit]))}))};
}
