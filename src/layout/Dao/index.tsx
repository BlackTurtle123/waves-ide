import React, {useEffect, useRef, useState} from 'react';
import {inject, observer} from 'mobx-react';
import {Link} from 'react-router-dom';
import {AccountsStore} from '@stores';
import {ledgerConnection, ledgerError, ledgerUnavailableReason} from '@utils/ledger';
import {LedgerAccount} from '@utils/ledger.transaction';
import {formatPwr, loadSnapshot, nodeRequest, Position, Snapshot, sum, validAddress} from '../../dao/data';
import styles from './styles.less';

const explorer = (address: string) => `https://w8.io/${address}`;
function Address({value}: {value: string}) {
    return <a className={styles.address} href={explorer(value)} target="_blank" rel="noopener noreferrer" title={value}>{value}</a>;
}
function Unlock({position: p, snapshot}: {position: Position; snapshot: Snapshot}) {
    const target = p.withdrawing > 0 ? p.withdrawHeight : p.exitHeight;
    if (target === undefined) return <span>—</span>;
    const remaining = Math.max(0, target - snapshot.height);
    const date = new Date(snapshot.timestamp + remaining * 60000);
    return <><span>{remaining === 0 ? 'Now' : `~${date.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'})}`}</span>
        <small>{p.withdrawing > 0 ? 'Withdrawal' : 'If exited now'} · block {target.toLocaleString('en-US')}</small>
        {remaining > 0 && <small>{remaining.toLocaleString('en-US')} blocks remaining</small>}</>;
}
function Status({p}: {p: Position}) {
    return <><span className={p.claimable > 0 ? styles.ready : styles.waiting}>{p.status}</span>
        {p.committed > 0 && p.withdrawing > 0 && <small>Also {formatPwr(p.withdrawing)} PWR in withdrawal{p.claimable > 0 ? ' · ready to claim' : ''}</small>}
        {p.pendingCommit > 0 && <small>{formatPwr(p.pendingCommit)} PWR pending commitment</small>}</>;
}
function downloadCsv(holders: Position[], name: string) {
    const rows = [['DAO', 'Address', 'Committed PWR', 'Withdrawal PWR', 'Claimable PWR', 'Locked PWR', 'Pending PWR', 'Withdrawal height', 'Exit now height', 'Status'],
        ...holders.map(p => [p.name, p.address, formatPwr(p.committed), formatPwr(p.withdrawing), formatPwr(p.claimable), formatPwr(p.locked),
            formatPwr(p.pendingCommit), String(p.withdrawHeight || ''), String(p.exitHeight || ''), p.status])];
    const csv = rows.map(row => row.map(cell => '"' + (/^[=+\-@]/.test(cell) ? "'" : '') + cell.replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = name + '.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const Dao = inject('accountsStore')(observer(({accountsStore}: {accountsStore?: AccountsStore}) => {
    const initialLedger = ledgerConnection.getAccount(87);
    const initialIde = accountsStore!.activeAccount;
    const [address, setAddress] = useState(initialLedger?.address || (initialIde?.chainId === 'W' ? initialIde.address : ''));
    const [source, setSource] = useState(initialLedger ? 'Ledger' : initialIde?.chainId === 'W' ? 'IDE account' : '');
    const [input, setInput] = useState('');
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [walletError, setWalletError] = useState('');
    const [busy, setBusy] = useState(false);
    const [ledgerAccounts, setLedgerAccounts] = useState<LedgerAccount[]>(ledgerConnection.getAccounts(87));
    const [ledgerStatus, setLedgerStatus] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [filter, setFilter] = useState('');
    const mounted = useRef(true);
    const pending = useRef(false);
    const keeper = useRef<any>();
    const keeperListener = useRef<any>();
    const ideAccounts = accountsStore!.accountGroups.W?.accounts || [];
    const select = (next: string, from: string) => {
        if (from !== 'Keeper Wallet' && keeperListener.current) {keeper.current?.off?.('update', keeperListener.current); keeperListener.current = undefined;}
        setSnapshot(undefined); setAddress(next); setSource(from); setWalletError('');};
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; if (keeperListener.current) keeper.current?.off?.('update', keeperListener.current); };
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        let current = true;
        setLoading(true); setError(''); setSnapshot(undefined);
        const timeout = setTimeout(() => controller.abort(), 45000);
        loadSnapshot(address || undefined, nodeRequest(controller.signal)).then(data => {
            if (current) setSnapshot(data);
        }).catch(e => {if (current) setError(e.name === 'AbortError' ? 'The node took too long to respond. Try Refresh.' : e.message);})
            .finally(() => {clearTimeout(timeout); if (current) setLoading(false);});
        return () => {current = false; clearTimeout(timeout); controller.abort();};
    }, [address, refresh]);
    useEffect(() => {
        if (source !== 'Ledger') return;
        const timer = setInterval(() => {
            if (pending.current) return;
            const account = ledgerConnection.getAccount(87);
            if (account?.address !== address) {
                setSource('Watch address · Ledger disconnected'); setLedgerAccounts([]);
            }
        }, 1500);
        return () => clearInterval(timer);
    }, [source, address]);
    const ledgerTask = async (task: () => Promise<void>) => {
        if (pending.current) return;
        pending.current = true; setBusy(true); setWalletError('');
        try {await task();} catch (e) {if (mounted.current) setWalletError(ledgerError(e));}
        finally {pending.current = false; if (mounted.current) {setBusy(false); setLedgerStatus('');}}
    };
    const connectLedger = () => ledgerTask(async () => {
        setLedgerStatus('Unlock Ledger and open the Waves app. Choose your device.');
        const accounts = await ledgerConnection.connect(87, () => !mounted.current);
        if (mounted.current) setLedgerAccounts(accounts);
    });
    const selectLedger = (index: number) => ledgerTask(async () => {
        setLedgerStatus('Confirm this address on Ledger if prompted.');
        const account = await ledgerConnection.selectAccount(index, 87);
        if (mounted.current) select(account.address, 'Ledger');
    });
    const moreLedger = () => ledgerTask(async () => {
        setLedgerStatus('Loading the next ten Ledger addresses…');
        const more = await ledgerConnection.discoverAccounts(ledgerAccounts.length, 87, () => !mounted.current);
        if (mounted.current) setLedgerAccounts([...ledgerAccounts, ...more]);
    });
    const connectKeeper = async () => {
        setWalletError('');
        const api = (window as any).KeeperWallet || (window as any).WavesKeeper;
        if (!api) {setWalletError('Install Keeper Wallet, then reload this page.'); return;}
        try {
            const use = (s: any) => {
                if (!mounted.current) return;
                if (!s.account || !validAddress(s.account.address)) {
                    select('', ''); setWalletError('Select a Waves mainnet account in Keeper Wallet.'); return;
                }
                select(s.account.address, 'Keeper Wallet');
            };
            const s = await api.publicState();
            if (!mounted.current) return;
            if (keeperListener.current) keeper.current?.off?.('update', keeperListener.current);
            keeper.current = api; keeperListener.current = use;
            api.on?.('update', use); use(s);
        } catch (e) {setWalletError(e.message || 'Keeper connection was rejected.');}
    };
    const disconnect = async () => {
        if (pending.current) return;
        if (source === 'Ledger') await ledgerConnection.disconnect();
        if (keeperListener.current) keeper.current?.off?.('update', keeperListener.current);
        keeperListener.current = undefined;
        setLedgerAccounts([]); select('', '');
    };
    const unavailable = ledgerUnavailableReason();
    const mother = snapshot?.positions.find(p => p.name === 'Mother DAO');
    return <main className={styles.page}>
        <div className={styles.shell}>
            <nav className={styles.nav}><Link to="/">← Waves IDE</Link><span className={styles.network}><i/> WAVES MAINNET</span><a href="https://pwrdao.com" target="_blank" rel="noopener noreferrer">PWRDAO ↗</a></nav>
            <header className={styles.hero}><div><div className={styles.eyebrow}>POWER DAO / ACCOUNT EXPLORER</div><h1>Know where your<br/><em>PWR stands.</em></h1><p>Every DAO. Every cooldown. One clear view of your power.</p></div><div className={styles.heroMark} aria-hidden="true">P<span>↗</span></div></header>
            <section className={styles.connect} aria-label="Account connection">
                <div><h2>{address ? 'Your account' : 'Choose your account'}</h2><p>Connect Ledger or Keeper, use an IDE account, or look up a public address.</p></div>
                <div className={styles.buttons}><button className={styles.primary} disabled={busy || !!unavailable} title={unavailable} onClick={connectLedger}>Connect Ledger</button><button disabled={busy} onClick={connectKeeper}>Keeper Wallet</button>{address && <button disabled={busy} onClick={disconnect}>Disconnect</button>}</div>
                {unavailable && <small>{unavailable}</small>}
                {ledgerAccounts.length > 0 && <div className={styles.ledger}><label>Ledger address <select disabled={busy} value={source === 'Ledger' ? address : ''} onChange={e => {
                    const account = ledgerAccounts.find(a => a.address === e.target.value); if (account) void selectLedger(account.index);
                }}><option value="">Choose an address…</option>{ledgerAccounts.map(a => <option key={a.address} value={a.address}>#{a.index} · {a.address}</option>)}</select></label><button disabled={busy} onClick={moreLedger}>Load 10 more</button></div>}
                {ideAccounts.length > 0 && <label className={styles.ideSelect}>IDE account <select disabled={busy} value={source === 'IDE account' ? address : ''} onChange={e => e.target.value && select(e.target.value, 'IDE account')}><option value="">Choose a mainnet account…</option>{ideAccounts.map(a => <option key={a.address} value={a.address}>{a.label} · {a.address}</option>)}</select></label>}
                <form className={styles.lookup} onSubmit={e => {e.preventDefault(); const next = input.trim(); if (!validAddress(next)) setWalletError('Enter a valid Waves mainnet address.'); else select(next, 'Watch address');}}><input aria-label="Waves mainnet address" placeholder="Or paste a Waves address (3P…)" value={input} onChange={e => setInput(e.target.value)} disabled={busy}/><button disabled={busy || !input.trim()} type="submit">Look up</button></form>
                {address && <div className={styles.selected}><span>{source}</span><Address value={address}/></div>}
                {ledgerStatus && <p role="status">{ledgerStatus}</p>}{walletError && <p className={styles.error} role="alert">{walletError}</p>}
                <small>Read-only · No seed phrase, signature, or transaction needed.</small>
            </section>
            <div className={styles.refresh}><span>{loading ? 'Reading current on-chain positions…' : snapshot ? `Updated ${new Date(snapshot.fetchedAt).toLocaleTimeString()} · block ${snapshot.height.toLocaleString('en-US')}` : 'Data unavailable'}</span><button disabled={loading} onClick={() => setRefresh(refresh + 1)}>↻ Refresh</button></div>
            {error && <div className={styles.error} role="alert">{error} No balances are shown until a complete refresh succeeds.</div>}
            {loading && <div className={styles.loading} role="status"><span/> Loading DAO balances and withdrawal locks</div>}
            {snapshot && <>
                {address && mother && <section aria-label="Your PWR positions">
                    <div className={styles.sectionHeading}><h2>Your PWR</h2><span>{snapshot.positions.filter(p => sum([p.committed, p.withdrawing, p.pendingCommit]) > 0).length} DAOs with a balance</span></div>
                    <div className={styles.stats}>
                        <div><small>IN YOUR WALLET</small><strong>{formatPwr(snapshot.walletBalance!)} <b>PWR</b></strong><p>Liquid wallet balance</p></div>
                        <div><small>MOTHER DAO STAKE</small><strong>{formatPwr(mother.committed)} <b>PWR</b></strong><p>Exit required to start withdrawal</p></div>
                        <div className={styles.claimStat}><small>MOTHER DAO · CLAIMABLE NOW</small><strong>{formatPwr(mother.claimable)} <b>PWR</b></strong><p>Cooldown completed, ready to withdraw</p></div>
                        <div><small>MOTHER DAO · NOT WITHDRAWABLE YET</small><strong>{formatPwr(mother.locked)} <b>PWR</b></strong><p>Includes active stake and withdrawal cooldown</p></div>
                    </div>
                    <div className={styles.tableWrap}><table><thead><tr><th>DAO</th><th>Committed PWR</th><th>In withdrawal</th><th>Claimable now</th><th>Not withdrawable yet</th><th>Availability</th></tr></thead><tbody>{snapshot.positions.map(p => <tr key={p.dao}><td><a href={p.name === 'Mother DAO' ? 'https://pwrdao.com/profile' : `https://pwrdao.com/dao/${p.dao}`} target="_blank" rel="noopener noreferrer">{p.name} ↗</a><Status p={p}/></td><td>{formatPwr(p.committed)}</td><td>{formatPwr(p.withdrawing)}</td><td className={styles.green}>{formatPwr(p.claimable)}</td><td>{formatPwr(p.locked)}</td><td><Unlock position={p} snapshot={snapshot}/></td></tr>)}</tbody></table></div>
                    <p className={styles.note}>Active Mother DAO stake requires an exit, followed by a cooldown. “If exited now” is an estimate; it does not count down until you exit. Existing withdrawals use their recorded unlock height. Governance pauses and account restrictions are included.</p>
                </section>}
                <section aria-label="Arkimal DAO holders">
                    <div className={styles.sectionHeading}><div><div className={styles.eyebrow}>PUBLIC HOLDER AUDIT</div><h2>Inside the Arkimal DAOs</h2></div><input aria-label="Filter holder addresses" placeholder="Filter by holder address…" value={filter} onChange={e => setFilter(e.target.value)}/></div>
                    <p className={styles.note}>All remaining commitments and withdrawals, including PWR that is already claimable. Historical exit records and zero balances are excluded.</p>
                    {snapshot.arkimals.map(dao => {
                        const holders = dao.holders.filter(p => p.address.toLowerCase().includes(filter.trim().toLowerCase()));
                        return <article className={styles.daoCard} key={dao.address}><div className={styles.daoHeading}><div><h3>{dao.name}</h3><Address value={dao.address}/></div><button onClick={() => downloadCsv(dao.holders, dao.name)}>Export CSV ↓</button></div>
                            <div className={styles.daoTotals}><span><strong>{dao.holders.length}</strong> holders remaining</span><span><strong>{formatPwr(sum(dao.holders.map(p => p.locked)))}</strong> PWR not withdrawable yet</span><span className={styles.green}><strong>{formatPwr(sum(dao.holders.map(p => p.claimable)))}</strong> PWR claimable now</span></div>
                            <div className={styles.tableWrap}><table><thead><tr><th>Holder</th><th>Committed PWR</th><th>In withdrawal</th><th>Claimable now</th><th>Status / availability</th></tr></thead><tbody>{holders.map(p => <tr key={p.address}><td><Address value={p.address}/><button className={styles.textButton} onClick={() => {select(p.address, 'Watch address'); window.scrollTo(0, 0);}}>View all DAOs ↗</button></td><td>{formatPwr(p.committed)}</td><td>{formatPwr(p.withdrawing)}</td><td className={styles.green}>{formatPwr(p.claimable)}</td><td><Status p={p}/><Unlock position={p} snapshot={snapshot}/></td></tr>)}</tbody></table>{holders.length === 0 && <p className={styles.empty}>{dao.holders.length ? 'No addresses match this filter.' : 'No PWR commitments or withdrawals remain in this DAO.'}</p>}</div>
                        </article>;
                    })}
                </section>
                <footer className={styles.footnote}>Amounts come directly from Waves mainnet contract state. Dates assume ~1 minute per block and may change. Block heights determine unlocks. Eligibility shown here does not guarantee transaction execution or account signing authority. <a href="https://pwrdao.com/contracts" target="_blank" rel="noopener noreferrer">Protocol contracts ↗</a></footer>
            </>}
        </div>
    </main>;
}));
export default Dao;
