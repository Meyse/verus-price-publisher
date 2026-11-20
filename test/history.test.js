import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History } from '../src/history.js';

// 2026-11-20 14:00:00 UTC, a Friday. Day start 1795132800, Monday 2026-11-16 = 1794787200
// (checked with Python datetime).
const T0 = 1795183200;
const chain = { name: 'VRSC', id: 'iCHAIN', testnet: false };
const anchor = { currency: 'iDAI', basket: 'iBRIDGE' };
const retentionDays = { hour: 7, day: 400, week: 0 };

const prices = (map) => Object.fromEntries(
  Object.entries(map).map(([id, usd]) => [id, { name: `name-${id}`, usd }]),
);
const doc = (time, height, map) => ({ height, blockTime: time, prices: prices(map) });
const newHistory = (dir, options = {}) => new History({
  outDir: dir, chain, anchor, retentionDays, ...options,
});
const readJson = async (dir, resolution) => JSON.parse(
  await readFile(join(dir, 'v1', 'history', `${resolution}.json`), 'utf8'),
);

test('one sample per slot, from the first cycle at or after the slot start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-history-'));
  const history = newHistory(dir);
  assert.deepEqual(await history.record(doc(T0 + 10, 100, { iA: '1' }), T0 + 10), ['hour', 'day', 'week']);
  assert.deepEqual(await history.record(doc(T0 + 1800, 130, { iA: '2' }), T0 + 1800), []);
  assert.deepEqual(await history.record(doc(T0 + 3605, 160, { iA: '3' }), T0 + 3605), ['hour']);

  const hour = await readJson(dir, 'hour');
  assert.deepEqual(hour.time, [T0, T0 + 3600]);
  assert.deepEqual(hour.height, [100, 160]);
  assert.deepEqual(hour.blockTime, [T0 + 10, T0 + 3605]);
  assert.deepEqual(hour.usd.iA, [1, 3]);
  assert.deepEqual((await readJson(dir, 'day')).time, [1795132800]);
  assert.deepEqual((await readJson(dir, 'week')).time, [1794787200]);
});

test('a currency that appears or disappears gets null; prices keep 6 significant digits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-history-'));
  const history = newHistory(dir);
  await history.record(doc(T0, 1, { iA: '0.636937365967', iB: '2' }), T0);
  await history.record(doc(T0 + 3600, 2, { iA: '65556.1376757', iC: '0.00000260362219999' }), T0 + 3600);
  const hour = await readJson(dir, 'hour');
  assert.deepEqual(hour.usd, { iA: [0.636937, 65556.1], iB: [2, null], iC: [null, 0.00000260362] });
  assert.equal(hour.names.iB, 'name-iB');
});

test('retention trims the oldest samples', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-history-'));
  const history = newHistory(dir, { retentionDays: { hour: 1, day: 400, week: 0 } });
  for (let i = 0; i < 26; i += 1) {
    const t = T0 + i * 3600;
    await history.record(doc(t, i, i < 2 ? { iOLD: '5', iA: '1' } : { iA: '1' }), t);
  }
  const hour = await readJson(dir, 'hour');
  assert.equal(hour.time.length, 24); // 1 day of hourly samples
  assert.equal(hour.time[0], T0 + 2 * 3600);
  assert.equal(hour.usd.iOLD, undefined); // only in trimmed samples: removed
});

test('a restart continues without a duplicate; a changed anchor starts new files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-history-'));
  await newHistory(dir).record(doc(T0, 1, { iA: '1' }), T0);

  const restarted = newHistory(dir);
  await restarted.load(T0 + 60);
  assert.deepEqual(await restarted.record(doc(T0 + 60, 2, { iA: '2' }), T0 + 60), []);
  assert.deepEqual(await restarted.record(doc(T0 + 3600, 3, { iA: '3' }), T0 + 3600), ['hour']);
  assert.deepEqual((await readJson(dir, 'hour')).time, [T0, T0 + 3600]);

  const logs = [];
  const other = newHistory(dir, {
    anchor: { currency: 'iUSD', basket: 'iOTHER' }, log: (level, message) => logs.push(level + message),
  });
  await other.load(T0 + 7200);
  await other.record(doc(T0 + 7200, 4, { iA: '4' }), T0 + 7200);
  const hour = await readJson(dir, 'hour');
  assert.deepEqual(hour.time, [T0 + 7200]);
  assert.equal(hour.anchor.currency, 'iUSD');
  const files = (await readdir(join(dir, 'v1', 'history'))).sort();
  assert.deepEqual(files, ['day.json', `day.json.replaced-${T0 + 7200}`, 'hour.json',
    `hour.json.replaced-${T0 + 7200}`, 'week.json', `week.json.replaced-${T0 + 7200}`]);
  assert.equal(logs.length, 1);
});

test('a cycle whose block time is far from the clock records nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-history-'));
  const history = newHistory(dir);
  assert.deepEqual(await history.record(doc(T0 - 86400, 1, { iA: '1' }), T0), []); // daemon still syncing
  assert.equal(history.body('hour'), null);
});
