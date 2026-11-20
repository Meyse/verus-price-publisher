import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Loop } from '../src/loop.js';
import { Publisher } from '../src/publisher.js';
import { fakeDaemon } from './fake-daemon.js';

const T = 1790000100 * 1000; // near the fake daemon's block times (1790000000 + height)

// A service on a fake daemon, with an injected clock and fake timers.
async function setup(t, env = {}) {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  const dir = await mkdtemp(join(tmpdir(), 'vpp-loop-'));
  const config = loadConfig({ chain: 'VRSC', env: { VERUS_RPC_URL: `http://127.0.0.1:${daemon.port}`, OUT_DIR: dir, ...env } });
  const s = { daemon, config, clock: T, timers: [], published: [] };
  s.publisher = new Publisher(config, {
    now: () => s.clock,
    log: (level, message) => { if (message.startsWith('published')) s.published.push([message.split(':')[0], s.clock - T]); },
  });
  s.loop = new Loop(s.publisher, {
    pollMs: config.pollMs,
    onFatal: (error) => { throw error; },
    setTimer: (fn, ms) => { const timer = { fn, at: s.clock + ms }; s.timers.push(timer); return timer; },
    clearTimer: (timer) => { s.timers = s.timers.filter((x) => x !== timer); },
  });
  // The planned check, in ms after T.
  s.planned = () => s.timers.map((x) => x.at - T);
  // Advance the clock to the planned check and run it.
  s.fire = async () => {
    const [timer] = s.timers.splice(0, 1);
    s.clock = Math.max(s.clock, timer.at);
    await timer.fn();
  };
  s.calls = () => s.daemon.requests.length;
  s.newBlock = (hash, height) => { s.daemon.hash = hash; s.daemon.height = height; };
  return s;
}

test('polling: no daemon call while the minimum interval runs', async (t) => {
  const s = await setup(t);
  assert.equal(s.config.pollMs, 30000); // default pollSeconds
  s.loop.start();
  await s.fire(); // first cycle at T
  assert.deepEqual(s.published, [['published height 100', 0]]);
  // Poll every 30 s, minimum interval 60 s: the next check is at 60 s, not at 30 s.
  assert.deepEqual(s.planned(), [60000]);

  const before = s.calls();
  s.clock = T + 30000;
  assert.equal(await s.publisher.tick(), false);
  assert.equal(s.calls(), before); // no RPC call at all

  await s.fire(); // 60 s: same block, one poll
  assert.deepEqual(s.daemon.requests.slice(before).map((r) => r.method), ['getbestblockhash']);
  assert.deepEqual(s.planned(), [90000]);
  s.newBlock('bb', 101);
  await s.fire();
  assert.deepEqual(s.published[1], ['published height 101', 90000]);
});

test('block notification: a check at once, but never inside the minimum interval', async (t) => {
  const s = await setup(t, { BLOCK_NOTIFY_FILE: '/tmp/block' });
  assert.equal(s.config.pollMs, 300000); // safety poll
  s.loop.start();
  await s.fire(); // first cycle at T
  assert.deepEqual(s.planned(), [300000]);

  // A block 10 s later: the notification waits for the end of the minimum interval (60 s).
  s.clock = T + 10000;
  s.newBlock('bb', 101);
  const before = s.calls();
  s.loop.notify();
  s.loop.notify();
  assert.deepEqual(s.planned(), [60000]); // one check, at 60 s
  assert.equal(s.calls(), before); // a notification itself calls nothing
  await s.fire();
  assert.deepEqual(s.published[1], ['published height 101', 60000]);
  assert.deepEqual(s.planned(), [360000]);

  // A block after the interval: checked at once.
  s.clock = T + 200000;
  s.newBlock('cc', 102);
  s.loop.notify();
  assert.deepEqual(s.planned(), [200000]);
  await s.fire();
  assert.deepEqual(s.published[2], ['published height 102', 200000]);
});

test('block notification on, but no notification: the safety poll still finds the block', async (t) => {
  const s = await setup(t, { BLOCK_NOTIFY_FILE: '/tmp/block' });
  s.loop.start();
  await s.fire();
  s.newBlock('bb', 101);
  await s.fire();
  assert.deepEqual(s.published, [['published height 100', 0], ['published height 101', 300000]]);
});

test('a failed cycle also waits for the minimum interval', async (t) => {
  const s = await setup(t, { BLOCK_NOTIFY_FILE: '/tmp/block' });
  s.loop.start();
  await s.fire(); // T: good cycle
  s.clock = T + 60000;
  s.newBlock('bb', 101);
  s.daemon.failCurrency = 'iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY'; // Pure: one basket read fails
  s.loop.notify();
  await s.fire(); // 60 s: the cycle fails
  assert.equal(s.published.length, 1);

  s.clock = T + 61000;
  s.daemon.failCurrency = null;
  const before = s.calls();
  s.loop.notify(); // touches right after a failed cycle: no retry before 120 s
  s.loop.notify();
  assert.deepEqual(s.planned(), [120000]);
  assert.equal(s.calls(), before);
  await s.fire();
  assert.deepEqual(s.published[1], ['published height 101', 120000]);
});

test('a built-in PBaaS name gives its id and public API address', async () => {
  const env = { VERUS_RPC_URL: 'http://127.0.0.1:1' };
  const config = loadConfig({ chain: 'VRSC', env: { ...env, VERUS_PBAAS: 'vARRR, chips' } });
  assert.deepEqual(config.pbaas.map((p) => [p.name, p.id, p.rpc.label, p.baskets]), [
    ['vARRR', 'iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2', 'https://vapi.piratechain.com', []],
    ['CHIPS', 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP', 'https://api.chips.cash', []],
  ]);
  assert.throws(() => loadConfig({ chain: 'VRSCTEST', env: { ...env, VERUS_PBAAS: 'vDEX' } }), /for VRSC mainnet/);
  assert.throws(() => loadConfig({ chain: 'VRSC', env: { ...env, VERUS_PBAAS: 'vXYZ' } }), /not a built-in name/);

  const dir = await mkdtemp(join(tmpdir(), 'vpp-loop-'));
  const file = async (pbaas) => {
    await writeFile(join(dir, 'c.json'), JSON.stringify({ chain: 'VRSC', rpc: { url: 'http://127.0.0.1:1' }, pbaas }));
    return () => loadConfig({ configPath: join(dir, 'c.json'), env: {} });
  };
  assert.throws(await file([{ name: 'vDEX', baskets: 'auto' }]), /not allowed on a public API/);
  const own = (await file([{ name: 'vDEX', rpc: { url: 'http://127.0.0.1:2' }, baskets: 'auto' }]))().pbaas[0];
  assert.deepEqual([own.id, own.rpc.label, own.baskets], ['iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N', 'http://127.0.0.1:2', 'auto']);
  assert.throws(await file([{ name: 'vDEX', rpc: { url: 'https://api.vdex.to/' }, baskets: 'auto' }]), /not allowed on a public API/);
  assert.throws(() => loadConfig({ chain: 'VRSC', env: { ...env, VERUS_PBAAS: 'chips, CHIPS' } }), /listed twice/);

  await writeFile(join(dir, 't.json'), JSON.stringify({ chain: 'VRSCTEST', rpc: { url: 'http://127.0.0.1:1' }, pbaas: [{ name: 'vDEX', id: null, rpc: null }] }));
  assert.throws(() => loadConfig({ configPath: join(dir, 't.json'), env: {} }), /for VRSC mainnet/);
  for (const pollSeconds of [null, 1e308]) {
    await writeFile(join(dir, 'p.json'), JSON.stringify({ chain: 'VRSC', rpc: { url: 'http://127.0.0.1:1' }, pollSeconds }));
    assert.throws(() => loadConfig({ configPath: join(dir, 'p.json'), env: {} }), /pollSeconds/);
  }
});
