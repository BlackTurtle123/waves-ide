require('ts-node').register({transpileOnly: true});
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {libs} = require('@waves/waves-transactions');
const {LedgerConnection} = require('../src/utils/ledger');
const {LedgerPreferencesStore, preferredLedgerAccount, ledgerSenderKeys} = require('../src/utils/ledger.preferences');
const {Waves} = require('@waves/ledger/lib/Waves');
const Transport = require('@ledgerhq/hw-transport-webusb').default;

function memoryStorage() {
    const values = new Map();
    return {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value)};
}
async function withDevice(run) {
    const previousWindow = Object.getOwnPropertyDescriptor(global, 'window');
    const previousNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
    const open = Transport.open;
    const read = Waves.prototype.getWalletPublicKey;
    const state = {device: 'A', calls: [], disconnect: undefined};
    try {
        Object.defineProperty(global, 'window', {value: {isSecureContext: true}, configurable: true});
        Object.defineProperty(global, 'navigator', {value: {usb: {requestDevice: async () => ({})}}, configurable: true});
        Transport.open = async () => ({close: async () => {}, setExchangeTimeout: () => {},
            decorateAppAPIMethods: () => {}, on: (_, callback) => state.disconnect = callback});
        Waves.prototype.getWalletPublicKey = async function(path, verify) {
            state.calls.push({path, verify});
            const publicKey = libs.crypto.publicKey('test only ' + state.device + path);
            return {publicKey, address: libs.crypto.address({publicKey}, this.networkCode)};
        };
        await run(state);
    } finally {
        Transport.open = open;
        Waves.prototype.getWalletPublicKey = read;
        if (previousWindow) Object.defineProperty(global, 'window', previousWindow); else delete global.window;
        if (previousNavigator) Object.defineProperty(global, 'navigator', previousNavigator); else delete global.navigator;
    }
}

test('reconnecting restores addresses beyond the first page and the signer without another address approval', async () => {
    await withDevice(async state => {
        const storage = memoryStorage();
        const connection = new LedgerConnection(storage);
        await connection.connect(87);
        await connection.discoverAccounts(10, 87);
        await connection.discoverAccounts(20, 87);
        const chosen = await connection.selectAccount(22, 87);
        connection.rememberSender(JSON.stringify({senderPublicKey: 'oracle-public-key'}));
        assert.equal(state.calls.filter(c => c.verify).length, 1);
        await connection.disconnect();
        const restored = new LedgerConnection(storage);
        const countBefore = state.calls.length;
        assert.equal((await restored.connect(87)).length, 30);
        assert.equal(state.calls.length - countBefore, 10, 'cached later pages do not require repeated scanning');
        assert.deepEqual(restored.preferredAccount(JSON.stringify({senderPublicKey: 'oracle-public-key'}), 87), chosen);
        await restored.selectAccount(22, 87);
        assert.equal(state.calls.filter(c => c.verify).length, 1, 'fresh public-key check reuses prior confirmation');
        await restored.selectAccount(22, 87, true);
        assert.equal(state.calls.filter(c => c.verify).length, 2, 'explicit Verify address always requests confirmation');
        assert.equal(restored.getAccount(87).index, 22);
        assert.equal(restored.getAccount(84), undefined);
        state.disconnect();
        assert.deepEqual(restored.getAccounts(87), []);
        assert.equal(restored.getAccount(87), undefined);
    });
});

test('another device or network cannot inherit selected accounts or address confirmations', async () => {
    await withDevice(async state => {
        const connection = new LedgerConnection(memoryStorage());
        await connection.connect(87);
        await connection.discoverAccounts(10, 87);
        await connection.selectAccount(12, 87);
        connection.rememberSender(JSON.stringify({senderPublicKey: 'contract'}));
        state.device = 'B';
        assert.equal((await connection.connect(87)).length, 10);
        assert.equal(connection.preferredAccount(JSON.stringify({senderPublicKey: 'contract'}), 87), undefined);
        await connection.selectAccount(2, 87);
        assert.equal(state.calls.filter(c => c.verify).length, 2);
        assert.equal((await connection.connect(84)).length, 10);
        assert.equal(connection.preferredAccount('', 84), undefined);
        await connection.selectAccount(2, 84);
        assert.equal(state.calls.filter(c => c.verify).length, 3);
    });
});

test('a changed derivation result cannot reuse a remembered address or confirmation', async () => {
    await withDevice(async state => {
        const connection = new LedgerConnection(memoryStorage());
        await connection.connect(87);
        await connection.selectAccount(3, 87);
        state.device = 'changed';
        await assert.rejects(connection.selectAccount(3, 87), /account changed/);
        assert.equal(connection.getAccount(87), undefined);
    });
});

test('automatic selection prefers a sender binding, then an exact sender, with no guess for conflicting batches', () => {
    const accounts = ['a', 'b', 'c'].map((publicKey, index) => ({publicKey, index}));
    const preferences = {accounts, verified: {}, selected: 'c', senders: {oracle: 'a', items: 'b'}};
    assert.equal(preferredLedgerAccount(preferences, ['oracle']).publicKey, 'a');
    assert.equal(preferredLedgerAccount(preferences, ['b']).publicKey, 'b');
    assert.equal(preferredLedgerAccount(preferences, ['unmapped-contract']).publicKey, 'c');
    assert.equal(preferredLedgerAccount(preferences, ['oracle', 'items']), undefined);
    assert.deepEqual(ledgerSenderKeys('[{"senderPublicKey":"oracle"},{"senderPublicKey":"oracle"}]'), ['oracle']);
    assert.deepEqual(ledgerSenderKeys('{'), []);
    assert.deepEqual(ledgerSenderKeys('[{"senderPublicKey":"oracle"},{}]'), []);
});

test('invalid cached addresses are ignored and unavailable storage does not block device use', async () => {
    const storage = memoryStorage();
    const store = new LedgerPreferencesStore(storage);
    store.save('profile', {accounts: [{index: 0, chainId: 87, address: 'invalid', publicKey: 'invalid'}], verified: {}, senders: {}});
    assert.deepEqual(store.load('profile', 87).accounts, []);
    await withDevice(async () => {
        const connection = new LedgerConnection({getItem: () => {throw Error('denied');}, setItem: () => {throw Error('full');}});
        await connection.connect(87);
        assert.equal((await connection.selectAccount(1, 87)).index, 1);
    });
});
