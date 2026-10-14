require('ts-node').register({transpileOnly: true});
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {libs, makeTxBytes, transfer, setScript, invokeScript} = require('@waves/waves-transactions');
const {signLedgerTransaction, signLedgerBatch} = require('../src/utils/ledger.transaction');

const seed = 'ledger regression fixture, never use for funds';
const otherSeed = 'multisignature sender regression fixture';
const account = {publicKey: libs.crypto.publicKey(seed), address: libs.crypto.address(seed, 84), chainId: 84, index: 0};
const timestamp = 1700000000000;
const sign = data => Promise.resolve(libs.crypto.signBytes(seed, data.dataBuffer));
const decimals = async () => 8;
const fixture = () => transfer({recipient: account.address, amount: '9007199254740993', timestamp, chainId: 84}, otherSeed);

test('preserves exact transaction bytes, large amounts, sender and existing proof slots', async () => {
    const tx = fixture();
    const before = JSON.stringify(tx);
    const bytes = makeTxBytes(tx);
    let signedBytes;
    const result = await signLedgerTransaction(tx, account, 84, 3, async data => {
        signedBytes = data.dataBuffer;
        return sign(data);
    }, decimals);
    assert.equal(JSON.stringify(tx), before);
    assert.deepEqual(signedBytes, bytes);
    assert.deepEqual(makeTxBytes(result), bytes);
    assert.equal(result.senderPublicKey, tx.senderPublicKey);
    assert.equal(result.timestamp, timestamp);
    assert.equal(String(result.amount), '9007199254740993');
    assert.equal(result.proofs[0], tx.proofs[0]);
    assert.deepEqual(result.proofs.slice(1, 3), ['', '']);
    assert.ok(libs.crypto.verifySignature(account.publicKey, bytes, result.proofs[3]));
});

for (const [name, create] of [
    ['set script', () => setScript({script: null, timestamp, chainId: 84}, otherSeed)],
    ['invoke script', () => invokeScript({dApp: account.address, call: {function: 'test', args: []}, timestamp, chainId: 84}, otherSeed)]
]) test(`${name} signatures verify against the original transaction`, async () => {
    const tx = create();
    const result = await signLedgerTransaction(tx, account, 84, 1, sign, decimals);
    assert.deepEqual(makeTxBytes(result), makeTxBytes(tx));
    assert.ok(libs.crypto.verifySignature(account.publicKey, makeTxBytes(tx), result.proofs[1]));
});

test('rejects a wrong-network transaction before asking the device to sign', async () => {
    let called = false;
    await assert.rejects(signLedgerTransaction({...fixture(), chainId: 87}, account, 84, 0,
        async () => {called = true; return '';}, decimals), /network must match/);
    assert.equal(called, false);
    await assert.rejects(signLedgerTransaction(fixture(), account, 87, 0, sign, decimals), /network must match/);
});

test('rejects signatures for changed bytes and leaves original proofs intact', async () => {
    const tx = fixture();
    const before = JSON.stringify(tx);
    await assert.rejects(signLedgerTransaction(tx, account, 84, 0,
        async () => libs.crypto.signBytes(seed, makeTxBytes({...tx, timestamp: timestamp + 1})), decimals), /does not match/);
    assert.equal(JSON.stringify(tx), before);
});

test('device rejection and cancellation do not mutate the transaction', async () => {
    const tx = fixture();
    const before = JSON.stringify(tx);
    await assert.rejects(signLedgerTransaction(tx, account, 84, 0, async () => {throw new Error('rejected');}, decimals), /rejected/);
    let cancelled = false;
    await assert.rejects(signLedgerTransaction(tx, account, 84, 0, async data => {
        cancelled = true; return sign(data);
    }, decimals, () => cancelled), /cancelled/);
    assert.equal(JSON.stringify(tx), before);
});

test('resolves token and sponsored fee precision without modifying amount or fee', async () => {
    const asset = libs.crypto.base58Encode(new Uint8Array(32).fill(1));
    const feeAsset = libs.crypto.base58Encode(new Uint8Array(32).fill(2));
    const tx = transfer({recipient: account.address, amount: 12345, assetId: asset, feeAssetId: feeAsset,
        fee: 100, timestamp, chainId: 84}, otherSeed);
    let metadata;
    const result = await signLedgerTransaction(tx, account, 84, 1, async data => {
        metadata = data; return sign(data);
    }, async id => id === asset ? 2 : 4);
    assert.equal(metadata.amountPrecision, 2);
    assert.equal(metadata.feePrecision, 4);
    assert.deepEqual(makeTxBytes(result), makeTxBytes(tx));
});

test('rejects invalid slots and incomplete transactions', async () => {
    for (const slot of [-1, 8, 1.5]) await assert.rejects(signLedgerTransaction(fixture(), account, 84, slot, sign, decimals), /proof index/);
    await assert.rejects(signLedgerTransaction({...fixture(), timestamp: undefined}, account, 84, 0, sign, decimals), /Prepare the transaction/);
});

test('batch signing is sequential and does not return partial approvals after rejection', async () => {
    let active = 0;
    let maximum = 0;
    const seen = [];
    const result = await signLedgerBatch([1, 2, 3], async value => {
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setTimeout(resolve, 5));
        seen.push(value); --active; return value * 2;
    }, () => false);
    assert.equal(maximum, 1);
    assert.deepEqual(result, [2, 4, 6]);
    assert.deepEqual(seen, [1, 2, 3]);
    const processed = [];
    await assert.rejects(signLedgerBatch([1, 2, 3], async value => {
        processed.push(value); if (value === 2) throw new Error('rejected'); return value;
    }, () => false), /rejected/);
    assert.deepEqual(processed, [1, 2]);
});
