import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { History } from '../src/history.js';
import { Publisher } from '../src/publisher.js';
import { fakeDaemon, VRSC } from './fake-daemon.js';

const H = 3600;
const HOUR14 = 1795183200; // 2026-11-20 14:00 UTC, a Friday (see test/history.test.js)
const BRIDGE = 'i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx'; // Bridge.vETH, the anchor basket
const PURE = 'iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY';
const SWITCH = 'i4Xr5TAMrDTD99H69EemhjDxJ4ktNskUtc';
const MONDAY = 1794787200; // 2026-11-16 00:00 UTC
// Worked example (test/prices.test.js): VRSC = 11.76339915 / 18.46869061 = 0.636937365967.
// With VRSC at 36.93738122 in Bridge.vETH: 11.76339915 / 36.93738122 = 0.318468682984.
const doubled = (state) => ({
  ...state,
  reservecurrencies: state.reservecurrencies.map((r) => (r.currencyid === VRSC ? { ...r, priceinreserve: 36.93738122 } : r)),
});

async function service(t, daemon, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-fill-'));
  const s = { dir, logs: [], sleeps: [] };
  s.config = loadConfig({ chain: 'VRSC', env: { VERUS_RPC_URL: `http://127.0.0.1:${daemon.port}`, OUT_DIR: dir, ...env } });
  s.start = async (clock, options = {}) => {
    s.publisher = new Publisher(s.config, {
      now: () => clock * 1000,
      log: (level, message) => s.logs.push(`${level} ${message}`),
      sleep: async (ms) => { s.sleeps.push(ms); },
      ...options,
    });
    await s.publisher.loadExisting();
    return s.publisher;
  };
  s.file = async (resolution) => JSON.parse(await readFile(join(dir, 'v1', 'history', `${resolution}.json`), 'utf8'));
  return s;
}

const fillCalls = (daemon) => daemon.requests.filter((r) => r.method === 'getcurrencystate');

test('history fill: first start and a gap after a restart are filled from past states, one call per basket', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  // The chain starts at 10:59:30; a block every 60 s, but none from 16:00 to 18:00.
  const G = HOUR14 - 3 * H - 30;
  daemon.blockTime = (h) => G + 60 * h + (h > 300 ? 2 * H : 0);
  // Before height 50 Pure was not live (pre-launch) and Switch held Pure at half its VRSC
  // price in reserve. Live "auto" rules then leave Pure out of the basket list, and Pure
  // gets the reserve price 2.88260379 / 1.441301895 x 0.636937365967 = 1.273874731934.
  daemon.stateAt = (id, h, state) => {
    if (id === BRIDGE && h >= 350) return doubled(state);
    if (id === PURE && h < 50) return { ...state, flags: 3 };
    if (id === SWITCH && h < 50) {
      return { ...state, reservecurrencies: [...state.reservecurrencies, { currencyid: PURE, weight: 0.25, reserves: 5000, priceinreserve: 1.441301895 }] };
    }
    return state;
  };
  const usdAt = (h) => (h >= 350 ? 0.318469 : 0.636937);
  daemon.height = 190; // 14:09:30

  // Fill off: today's behaviour, no getcurrencystate call.
  const off = await service(t, daemon, { HISTORY_FILL: 'off' });
  await (await off.start(HOUR14 + 600)).tick();
  assert.equal(off.publisher.fill, null);
  assert.deepEqual((await off.file('hour')).time, [HOUR14]);
  assert.equal(fillCalls(daemon).length, 0);

  // First start, empty history: one call maps time to height, then one call per basket.
  const s = await service(t, daemon);
  await (await s.start(HOUR14 + 600)).tick();
  await s.publisher.fill.running;
  assert.equal(fillCalls(daemon).length, 1 + 4); // 4 local baskets in the fixture
  assert.deepEqual(s.sleeps, [1000, 1000, 1000, 1000]); // a pause before each call after the first

  // The service stops at 14:10 and starts again at 20:10.
  daemon.height = 430; // 20:09:30
  daemon.hash = 'cc';
  const before = fillCalls(daemon).length;
  await (await s.start(HOUR14 + 6 * H + 600)).tick();
  await s.publisher.fill.running;
  assert.equal(fillCalls(daemon).length - before, 4); // one call per basket, no mapping call
  const hour = await s.file('hour');
  // 16:00 and 17:00 have no block: they stay missing. No value is invented.
  assert.deepEqual(hour.time, [11, 12, 13, 14, 15, 18, 19, 20].map((h) => HOUR14 + (h - 14) * H));
  hour.time.forEach((slot, i) => {
    assert.equal(hour.blockTime[i], daemon.blockTime(hour.height[i])); // a real block
    if (slot === HOUR14 || slot === HOUR14 + 6 * H) return; // live samples
    // The first grid block at or after the slot start; the grid is 15 minutes or finer.
    assert.ok(hour.blockTime[i] >= slot && hour.blockTime[i] < slot + 15 * 60 + 60, `slot ${slot}`);
    assert.equal(hour.usd[VRSC][i], usdAt(hour.height[i]));
  });
  assert.ok(hour.usd[VRSC].includes(0.318469) && hour.usd[VRSC].includes(0.636937));
  assert.equal(hour.height[0], 1);
  assert.equal(hour.usd[PURE][0], 1.27387);
  // Same states, same prices: a filled sample on the fixture states equals the live sample at 14:00.
  const at = (slot) => Object.fromEntries(Object.entries(hour.usd).map(([id, series]) => [id, series[hour.time.indexOf(slot)]]));
  assert.deepEqual(at(HOUR14 - H), at(HOUR14));
  assert.ok(Object.keys(at(HOUR14)).length > 5);
  assert.deepEqual((await s.file('day')).time, [HOUR14 - 14 * H]); // no block on Thursday
  assert.deepEqual(s.logs.filter((l) => l.startsWith('error')), []);
});

test('history fill: a failed call stops the run, files stay valid, publishing goes on; the next start fills the rest', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  const G = HOUR14 - 4 * 24 * H; // the chain starts on Monday 14:00
  daemon.blockTime = (h) => G + 60 * h;
  daemon.height = 5770; // 14:10
  // Calls of the hour grid (step 15) below height 2000 fail: the second segment of the run.
  daemon.failRange = ([, range]) => {
    const [start, , step] = range.split(',').map(Number);
    return step === 15 && start < 2000;
  };
  const s = await service(t, daemon);
  await (await s.start(HOUR14 + 600)).tick();
  await s.publisher.fill.running;
  assert.equal(s.logs.filter((l) => l.startsWith('error history fill stopped')).length, 1);
  const partial = await s.file('hour');
  assert.equal(partial.time.length, 61); // the first segment (60 slots) and the live sample
  assert.equal(partial.time[0], HOUR14 - 60 * H);

  // Publishing goes on; the fill is off until a restart.
  const calls = fillCalls(daemon).length;
  daemon.height = 5772;
  daemon.hash = 'bb';
  assert.equal(await s.publisher.tick({ force: true }), true);
  assert.equal(fillCalls(daemon).length, calls);

  // Restart (the fill starts after the first cycle that publishes a block). A cycle while
  // the fill pauses: the fill makes no call until the cycle ends.
  daemon.failRange = null;
  daemon.height = 5773;
  daemon.hash = 'cc';
  const gates = [];
  await (await s.start(HOUR14 + 720, { sleep: () => new Promise((resolve) => { gates.push(resolve); }) })).tick();
  for (let i = 0; i < 400 && !gates.length; i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); }); // socket I/O
  assert.equal(gates.length, 1); // the fill made its first call and pauses
  daemon.height = 5774;
  daemon.hash = 'dd';
  const first = daemon.requests.length;
  const cycle = s.publisher.tick({ force: true });
  gates.shift()(); // the pause ends while the cycle runs
  assert.equal(await cycle, true);
  const during = daemon.requests.slice(first).map((r) => r.method);
  assert.ok(during.includes('getcurrency'));
  assert.ok(!during.includes('getcurrencystate'), during.join(','));
  while (s.publisher.fill.running) {
    if (gates.length) gates.shift()();
    await new Promise((resolve) => { setImmediate(resolve); });
  }

  // Valid files (none moved aside), and every hour since the chain start has a sample.
  assert.deepEqual((await readdir(join(s.dir, 'v1', 'history'))).sort(), ['day.json', 'hour.json', 'week.json']);
  const hour = await s.file('hour');
  assert.deepEqual(hour.time, Array.from({ length: 97 }, (_, i) => G + i * H));
  assert.deepEqual((await s.file('day')).time, [16, 17, 18, 19, 20].map((d) => HOUR14 - 14 * H - (20 - d) * 24 * H));
  assert.equal(s.logs.filter((l) => l.startsWith('error')).length, 1);
});

test('history fill: grid estimates that miss, and a chain that starts in the middle of a day', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  // A sample at A, then 7 days without the service: blocks every 80 s for 83 hours, then
  // every 40 s. A straight line between the two known blocks misses by hours.
  const A = HOUR14 - 166 * H + 600;
  const slow = (83 * H) / 80;
  daemon.blockTime = (h) => (h <= 60 ? A - H + 60 * h : h <= 60 + slow ? A + 80 * (h - 60) : A + 83 * H + 40 * (h - 60 - slow));
  daemon.height = 60;
  const s = await service(t, daemon, { HISTORY_FILL: '0' });
  await (await s.start(A + 30)).tick();
  s.config = loadConfig({ chain: 'VRSC', env: { VERUS_RPC_URL: `http://127.0.0.1:${daemon.port}`, OUT_DIR: s.dir } });
  daemon.height = 60 + slow + 83 * 90;
  daemon.hash = 'bb';
  await (await s.start(HOUR14 + 630)).tick();
  await s.publisher.fill.running;
  // Every hour of the 7 days has a block, so every hour has a sample.
  assert.deepEqual((await s.file('hour')).time, Array.from({ length: 168 }, (_, i) => HOUR14 - (167 - i) * H));

  // A chain that starts on Monday at 02:00; Wednesday 13:10. Monday's day slot starts in an
  // hour segment before the chain; its sample comes from its own day grid.
  const other = await fakeDaemon();
  t.after(() => other.server.close());
  const G = MONDAY + 2 * H - 30;
  other.blockTime = (h) => G + 60 * h;
  const clock = MONDAY + 2 * 24 * H + 13 * H + 600;
  other.height = Math.floor((clock - 30 - G) / 60);
  const m = await service(t, other);
  await (await m.start(clock)).tick();
  await m.publisher.fill.running;
  const day = await m.file('day');
  assert.deepEqual(day.time, [MONDAY, MONDAY + 24 * H, MONDAY + 48 * H]);
  assert.equal(day.height[0], 1); // the first block, at 02:00:30
  assert.equal((await m.file('hour')).time[0], MONDAY + 2 * H);
});

test('history: a live cycle with no new slot does not wait behind a fill write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-fill-'));
  const history = new History({
    outDir: dir, chain: { name: 'VRSC', id: VRSC, testnet: false }, anchor: { currency: 'iDAI', basket: BRIDGE },
    retentionDays: { hour: 7, day: 400, week: 0 },
  });
  const sample = (time) => ({ height: time, blockTime: time, prices: { [VRSC]: { name: 'VRSC', usd: '0.5' } } });
  assert.deepEqual(await history.record(sample(HOUR14), HOUR14), ['hour', 'day', 'week']);
  let release;
  const write = history.serial(() => new Promise((resolve) => { release = resolve; })); // a slow fill write
  const waited = new Promise((_, reject) => { setTimeout(() => reject(new Error('the cycle waited')), 500).unref(); });
  assert.deepEqual(await Promise.race([history.record(sample(HOUR14 + 60), HOUR14 + 60), waited]), []);
  release();
  await write;
});
