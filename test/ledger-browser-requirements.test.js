require('ts-node').register({transpileOnly: true});
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ledgerUnavailableReason, LedgerConnection, ledgerError} = require('../src/utils/ledger');

test('requires a secure browser context and WebUSB', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(global, 'window');
    const previousNavigator = Object.getOwnPropertyDescriptor(global, 'navigator');
    try {
        Object.defineProperty(global, 'window', {value: {isSecureContext: false}, configurable: true});
        Object.defineProperty(global, 'navigator', {value: {}, configurable: true});
        assert.match(ledgerUnavailableReason(), /HTTPS/);
        global.window.isSecureContext = true;
        assert.match(ledgerUnavailableReason(), /WebUSB/);
        global.navigator.usb = {};
        assert.equal(ledgerUnavailableReason(), undefined);
    } finally {
        if (previousWindow) Object.defineProperty(global, 'window', previousWindow); else delete global.window;
        if (previousNavigator) Object.defineProperty(global, 'navigator', previousNavigator); else delete global.navigator;
    }
});

test('cannot sign before a Ledger account has been connected', async () => {
    await assert.rejects(new LedgerConnection().sign({}, '', 84, 0, () => false), /Connect Ledger first/);
});

test('device rejection, locked app and unsupported versions have actionable messages', () => {
    assert.match(ledgerError({statusCode: 0x6985}), /rejected/);
    assert.match(ledgerError({status: 0x9100}), /rejected/);
    assert.match(ledgerError({statusCode: 0x6986}), /Unlock Ledger/);
    assert.match(ledgerError({statusCode: 0x5515}), /locked.*PIN.*Waves/);
    assert.match(ledgerError({statusCode: 0x9104}), /does not support/);
});

const {libs} = require('@waves/waves-transactions');
function addressDevice() {
    const connection = new LedgerConnection();
    const calls = [];
    connection.chainId = 84;
    connection.waves = {
        getWalletPublicKey: async (path, verify) => {
            calls.push({path, verify});
            const publicKey = libs.crypto.publicKey('test only Ledger address ' + path);
            return {publicKey, address: libs.crypto.address({publicKey}, 84)};
        }
    };
    return {connection, calls};
}

test('loads address pages sequentially without confirmation and confirms only the chosen address', async () => {
    const {connection, calls} = addressDevice();
    const first = await connection.discoverAccounts(0, 84);
    const next = await connection.discoverAccounts(10, 84);
    assert.deepEqual(first.map(a => a.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(next.map(a => a.index), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal(new Set([...first, ...next].map(a => a.address)).size, 20);
    assert.equal(calls.every(call => call.verify === false), true);
    assert.equal(calls[7].path, "44'/5741564'/0'/0'/7'");
    await assert.rejects(connection.sign({}, '', 84, 0, () => false), /Connect Ledger first/);
    assert.deepEqual(await connection.selectAccount(12, 84), next[2]);
    assert.deepEqual(calls[20], {path: calls[12].path, verify: true});
    assert.deepEqual(connection.account, next[2]);
});

test('changing networks requires reconnecting before loading or choosing addresses', async () => {
    const {connection, calls} = addressDevice();
    await assert.rejects(connection.discoverAccounts(0, 87), /network changed/);
    await assert.rejects(connection.selectAccount(0, 87), /network changed/);
    assert.equal(calls.length, 0);
});

test('cancelling address discovery stops subsequent device requests', async () => {
    const {connection, calls} = addressDevice();
    await assert.rejects(connection.discoverAccounts(0, 84, () => calls.length === 2), /cancelled/);
    assert.equal(calls.length, 2);
    assert.equal(connection.busy, false);
});

test('rejecting a new address clears the previous signing account', async () => {
    const {connection} = addressDevice();
    await connection.selectAccount(0, 84);
    connection.waves.getWalletPublicKey = async () => { throw new Error('rejected'); };
    await assert.rejects(connection.selectAccount(1, 84), /rejected/);
    await assert.rejects(connection.sign({}, '', 84, 0, () => false), /Connect Ledger first/);
    assert.equal(connection.busy, false);
});

test('address discovery rejects an address from a different network', async () => {
    const {connection} = addressDevice();
    const publicKey = libs.crypto.publicKey('test only wrong network');
    connection.waves.getWalletPublicKey = async () => ({publicKey, address: libs.crypto.address({publicKey}, 87)});
    await assert.rejects(connection.discoverAccounts(0, 84), /different network/);
});
