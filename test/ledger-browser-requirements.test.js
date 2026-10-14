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
    assert.match(ledgerError({statusCode: 0x9104}), /does not support/);
});
