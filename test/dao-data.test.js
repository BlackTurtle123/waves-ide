require('ts-node').register({transpileOnly: true});
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {libs} = require('@waves/waves-transactions');
const {ARKIMAL_DAOS, CONFIG, WAVES_DAO, childPairs, classifyPosition, daoTitle, formatPwr, loadSnapshot, operationBlock, state, validAddress} = require('../src/dao/data');
const dao = ARKIMAL_DAOS[0].address;
const user = libs.crypto.address('dao test only', 87);
const other = libs.crypto.address('other dao test only', 87);
const base = {dao, name: 'DAO', address: user, committed: 100000000, withdrawals: {}, config: {}, height: 100,
    started: true, cooldown: 30, kpiLock: 0, safetyWindow: 20};

test('accepts only checksum-valid mainnet addresses', () => {
    assert.equal(validAddress(user), true);
    assert.equal(validAddress(libs.crypto.address('dao test only', 84)), false);
    assert.equal(validAddress(user.slice(0, -1) + (user.endsWith('1') ? '2' : '1')), false);
    assert.equal(validAddress('"), invoke('), false);
});
test('holder discovery ignores historical exited records, locks and zeros; keeps withdrawal-only and pending balances', () => {
    const children = {[`skin_${dao}_${user}`]: 100, [`skin_${dao}_${other}_period_0_exited`]: 999,
        [`skin_unlock_period_${dao}_${other}`]: 10, [`skin_${dao}_${other}`]: 0,
        [`pending_commit_amount_${other}`]: 50, [`pending_commit_child_${other}`]: ARKIMAL_DAOS[1].address};
    const withdrawals = {[`${dao}_${other}_withdraw_amount`]: 5};
    assert.deepEqual(childPairs(children, withdrawals), [{dao, address: user}, {dao: WAVES_DAO, address: other}, {dao, address: other}]);
});
test('active stake is not claimable and uses the longest of cooldown, legacy and KPI locks', () => {
    const p = classifyPosition({...base, mother: true, legacyUnlock: 140, kpiLock: 150});
    assert.equal(p.claimable, 0); assert.equal(p.locked, base.committed); assert.equal(p.exitHeight, 170);
    assert.match(p.status, /Exit required/);
});
test('claim becomes available at the exact recorded height, never before', () => {
    const withdrawals = {[`${dao}_${user}_withdraw_amount`]: 70, [`${dao}_${user}_withdraw_height`]: 101};
    const waiting = classifyPosition({...base, committed: 0, withdrawals});
    assert.equal(waiting.claimable, 0); assert.equal(waiting.locked, 70);
    const ready = classifyPosition({...base, committed: 0, withdrawals, height: 101});
    assert.equal(ready.claimable, 70); assert.equal(ready.locked, 0); assert.equal(ready.status, 'Ready to claim');
});
test('pre-start commitments can be undone without cooldown, including cancelled DAOs', () => {
    const p = classifyPosition({...base, started: false});
    assert.equal(p.claimable, base.committed); assert.equal(p.locked, 0); assert.equal(p.exitHeight, 100);
});
test('an existing parked withdrawal prevents a second exit, including a zero-amount slot', () => {
    const p = classifyPosition({...base, withdrawals: {[`${dao}_${user}_withdraw_amount`]: 20, [`${dao}_${user}_withdraw_height`]: 99}});
    assert.equal(p.claimable, 20); assert.equal(p.locked, base.committed); assert.equal(p.exitHeight, undefined);
    assert.match(p.exitReason, /existing withdrawal/);
    assert.equal(classifyPosition({...base, withdrawals: {[`${dao}_${user}_withdraw_height`]: 99}}).exitHeight, undefined);
});
test('pauses, exceptions and stoplist follow on-chain precedence', () => {
    assert.match(operationBlock({system_allowed: false}, 'exit', user), /paused/);
    assert.equal(operationBlock({system_allowed: false, exc: user}, 'exit', user), undefined);
    assert.match(operationBlock({stoplist: user, exc: user}, 'exit', user), /restricted/);
    const p = classifyPosition({...base, committed: 0, config: {op_withdraw_allowed: false}, withdrawals: {[`${dao}_${user}_withdraw_amount`]: 20, [`${dao}_${user}_withdraw_height`]: 99}});
    assert.equal(p.claimable, 0); assert.equal(p.locked, 20);
    assert.equal(classifyPosition({...base, started: false, config: {op_undoCommit_allowed: false}}).claimable, 0);
});
test('pending funds are locked and never silently dropped', () => {
    const p = classifyPosition({...base, committed: 0, pendingCommit: 23});
    assert.equal(p.locked, 23); assert.equal(p.claimable, 0); assert.equal(p.status, 'Pending commitment');
});
test('missing heights and imprecise integers fail closed', () => {
    assert.throws(() => classifyPosition({...base, withdrawals: {[`${dao}_${user}_withdraw_amount`]: 10}}), /height missing/);
    assert.throws(() => state([{key: 'balance', type: 'integer', value: 9007199254740992}]), /Unsafe/);
    assert.equal(formatPwr(100000001), '1.00000001'); assert.equal(formatPwr(123456789000), '1,234.56789');
});
test('reads bounded BSON titles and ignores malformed metadata', () => {
    const title = Buffer.from('Arkimals Dao\0');
    const b = Buffer.alloc(16 + title.length); b.writeInt32LE(b.length); b[4] = 2; b.write('title\0', 5); b.writeInt32LE(title.length, 11); title.copy(b, 15);
    assert.equal(daoTitle('base64:' + b.toString('base64')), 'Arkimals Dao');
    assert.equal(daoTitle('base64:AAAA'), undefined);
});

const staker = '3P86ne9inVG1Cf4smrEGSdcXyBuEApPcMAc';
const childrenAddress = '3PBLPmkM3ThytNj6QeJyLTX154if8S6Cea5';
const withdrawal = '3P3H6njgBvE7SYf2UZxDnrRpmaDRw8qybp7';
const voting = '3PJPW1rknfSxCKjUwRp1Upg7Yxhe7VerDqg';
const motherVoting = '3PM6Wsfm2ePMqbY5PQXMSDVpYfYgzHPWRhQ';
function entries(obj) {return Object.entries(obj).map(([key, value]) => ({key, type: typeof value === 'number' ? 'integer' : 'string', value}));}
function fixtureRequest(failAddress) {
    const data = {
        [CONFIG]: {contract_staking: staker, contract_children: childrenAddress, contract_withdrawal: withdrawal,
            contract_children_voting: voting, contract_voting: motherVoting, powerAssetId: 'PWR'},
        [childrenAddress]: {[`skin_${dao}_${user}`]: 100, [`skin_${dao}_${other}_period_0_exited`]: 888,
            [`start_height_${dao}`]: 10, [`skin_${ARKIMAL_DAOS[1].address}_${other}`]: 50},
        [withdrawal]: {[`${staker}_${user}_withdraw_amount`]: 7, [`${staker}_${user}_withdraw_height`]: 90,
            [`${dao}_${other}_withdraw_amount`]: 12, [`${dao}_${other}_withdraw_height`]: 110},
        [staker]: {}, [voting]: {}, [motherVoting]: {}, [dao]: {}, [ARKIMAL_DAOS[1].address]: {}
    };
    return async (path) => {
        if (path === '/blocks/headers/last') return {height: 100, timestamp: 100000, generator: user};
        if (path.startsWith('/utils/script/evaluate/')) return {result: {type: 'String', value: `height: 100, account: ${user}, staked: 250, voting_power: 100`}};
        if (path.startsWith('/assets/balance/')) return {balance: 123};
        const address = path.split('/')[3].split('?')[0];
        if (address === failAddress) throw Error('node unavailable');
        assert.ok(data[address], `unexpected request ${path}`);
        return entries(data[address]);
    };
}
test('full snapshot includes authoritative Mother stake, withdrawal-only holders and each Arkimal DAO', async () => {
    const result = await loadSnapshot(user, fixtureRequest());
    assert.equal(result.positions.length, 2);
    assert.equal(result.positions[0].committed, 250); // not raw shares
    assert.equal(result.positions[0].claimable, 7);
    assert.equal(result.walletBalance, 123);
    assert.equal(result.arkimals[0].holders.length, 2);
    assert.equal(result.arkimals[0].holders.find(h => h.address === other).committed, 0);
    assert.equal(result.arkimals[1].holders.length, 1);
});
test('public holder tables work without login; a node failure never becomes a false zero balance', async () => {
    const result = await loadSnapshot(undefined, fixtureRequest());
    assert.equal(result.positions.length, 0); assert.equal(result.arkimals[0].holders.length, 2);
    await assert.rejects(loadSnapshot(user, fixtureRequest(withdrawal)), /node unavailable/);
});
