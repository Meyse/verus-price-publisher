import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Publisher } from '../src/publisher.js';
import { RpcClient } from '../src/rpc.js';
import { createPriceServer } from '../src/server.js';

const VRSC = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/vrsc-mainnet-baskets.json', import.meta.url)));

// A fake verusd on the network boundary. It answers from the mainnet fixture.
async function fakeDaemon() {
  const daemon = { requests: [], down: false, failCurrency: null, hash: 'aa', height: 100 };
  daemon.server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { method, params } = JSON.parse(body);
    daemon.requests.push({ method, auth: req.headers.authorization });
    if (daemon.down || (method === 'getcurrency' && params[0] === daemon.failCurrency)) {
      res.writeHead(500).end(JSON.stringify({ result: null, error: { code: -28, message: 'Loading' } }));
      return;
    }
    const byId = (id) => fixture.baskets.find((b) => b.currencyid === id || b.fullyqualifiedname === id);
    const results = {
      getblockchaininfo: () => ({ name: 'VRSC', chainid: VRSC }),
      getbestblockhash: () => daemon.hash,
      getblockheader: () => ({ hash: params[0], height: daemon.height, time: 1790000000 + daemon.height }),
      listcurrencies: () => fixture.baskets.map((b) => ({ currencydefinition: b, bestcurrencystate: b.bestcurrencystate })),
      getcurrency: () => byId(params[0]),
    };
    const result = results[method]?.();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result === undefined
      ? { result: null, error: { code: -5, message: 'not found' } }
      : { result, error: null }));
  });
  daemon.server.listen(0, '127.0.0.1');
  await once(daemon.server, 'listening');
  daemon.port = daemon.server.address().port;
  return daemon;
}

test('the RPC client refuses methods outside the read-only allow-list', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  const rpc = new RpcClient({ url: `http://127.0.0.1:${daemon.port}` });
  for (const method of ['sendcurrency', 'dumpprivkey', 'z_sendmany', 'getwalletinfo', 'stop', 'signmessage']) {
    await assert.rejects(rpc.call(method), /not on the read-only allow-list/);
  }
  assert.equal(daemon.requests.length, 0);
  assert.throws(() => new RpcClient({ url: 'http://user:pass@127.0.0.1:1' }), /not in the URL/);
});

test('publishes once per block, keeps the last file while the RPC fails, and recovers', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  const dir = await mkdtemp(join(tmpdir(), 'vpp-'));
  const conf = join(dir, 'VRSC.conf');
  await writeFile(conf, `rpcuser=alice\nrpcpassword=s3cret\nrpcport=${daemon.port}\nrpchost=127.0.0.1\n`);
  await writeFile(join(dir, 'config.json'), JSON.stringify({ chain: 'VRSC', rpc: { conf }, outDir: dir, minIntervalSeconds: 0 }));
  const logs = [];
  const config = loadConfig({ configPath: join(dir, 'config.json'), env: {} });
  const publisher = new Publisher(config, { log: (level, message) => logs.push(`${level} ${message}`) });
  const file = join(dir, 'v1', 'prices.json');

  assert.equal(await publisher.tick(), true);
  const first = await readFile(file, 'utf8');
  const doc = JSON.parse(first);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.height, 100);
  assert.equal(doc.prices[VRSC].usd, '0.636937365967');
  // Bridge.vARRR lives on the vARRR chain: its copy on VRSC is not used.
  assert.equal(doc.prices.iD5WRg7jdQM1uuoVHsBCAEKfJCKGs1U3TB, undefined);
  assert.equal(daemon.requests[0].auth, `Basic ${Buffer.from('alice:s3cret').toString('base64')}`);

  // Same block: no new cycle, no basket reads.
  const before = daemon.requests.length;
  assert.equal(await publisher.tick(), false);
  assert.deepEqual(daemon.requests.slice(before).map((r) => r.method), ['getbestblockhash']);

  // RPC down while a new block arrives: the file stays byte for byte.
  daemon.down = true;
  daemon.hash = 'bb';
  daemon.height = 101;
  assert.equal(await publisher.tick(), false);
  assert.equal(await publisher.tick(), false);
  assert.equal(await readFile(file, 'utf8'), first);
  assert.equal(logs.filter((l) => l.startsWith('error')).length, 1); // logged once, not on every poll

  // The daemon answers, but one basket read fails: still no partial file.
  daemon.down = false;
  daemon.failCurrency = 'iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY'; // Pure
  assert.equal(await publisher.tick(), false);
  assert.equal(await readFile(file, 'utf8'), first);

  daemon.failCurrency = null;
  assert.equal(await publisher.tick(), true);
  const second = await readFile(file, 'utf8');
  assert.equal(JSON.parse(second).height, 101);
  assert.deepEqual((await readdir(join(dir, 'v1'))), ['prices.json']); // no temp file left
  assert.ok(!logs.join('\n').includes('s3cret'));

  // A restart on the same block serves the saved file and does not rewrite it.
  const restarted = new Publisher(config);
  await restarted.loadExisting();
  assert.equal(restarted.body.toString('utf8'), second);
  assert.equal(await restarted.tick(), false);
  assert.equal(await readFile(file, 'utf8'), second);
});

test('conf file credentials are not sent to another host', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vpp-'));
  const conf = join(dir, 'VRSC.conf');
  await writeFile(conf, 'rpcuser=alice\nrpcpassword=s3cret\nrpcport=27486\n');
  assert.throws(
    () => loadConfig({ chain: 'VRSC', env: { VERUS_RPC_CONF: conf, VERUS_RPC_URL: 'https://api.example.org' } }),
    /Refusing to send the conf file's RPC credentials to api\.example\.org/,
  );
  assert.doesNotThrow(() => loadConfig({ chain: 'VRSC', env: { VERUS_RPC_CONF: conf } }));
});

test('the HTTP server serves only the price file, only for GET and HEAD', async (t) => {
  const body = Buffer.from('{"schemaVersion":1}\n');
  const routes = new Map([
    ['/v1/prices.json', { body: () => body, maxAge: 30 }],
    ['/v1/history/day.json', { body: () => body, maxAge: 3600 }],
  ]);
  const server = createPriceServer(routes).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await fetch(`${base}/v1/prices.json?x=1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.match(ok.headers.get('cache-control'), /max-age=\d+/);
  assert.equal(await ok.text(), body.toString());
  assert.equal((await fetch(`${base}/v1/prices.json`, { method: 'HEAD' })).status, 200);
  const post = await fetch(`${base}/v1/prices.json`, { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal((await fetch(`${base}/v1/history/day.json`)).headers.get('cache-control'), 'public, max-age=3600');
  assert.equal((await fetch(`${base}/v1/../config.json`)).status, 404);
  assert.equal((await fetch(`${base}/__proto__`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
});

test('a failed cycle adds no history sample; the next good cycle in a new slot does', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  const dir = await mkdtemp(join(tmpdir(), 'vpp-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    chain: 'VRSC', rpc: { url: `http://127.0.0.1:${daemon.port}` }, outDir: dir, minIntervalSeconds: 0,
  }));
  const config = loadConfig({ configPath: join(dir, 'config.json'), env: {} });
  // The fake block time is 1790000000 + height; 1790002800 is a full hour (497223 * 3600).
  let clock = (1790000000 + 100) * 1000;
  const publisher = new Publisher(config, { now: () => clock });
  const hourFile = join(dir, 'v1', 'history', 'hour.json');

  assert.equal(await publisher.tick(), true);
  const first = await readFile(hourFile, 'utf8');
  assert.deepEqual(JSON.parse(first).time, [1789999200]); // slot of 1790000100

  daemon.down = true;
  daemon.hash = 'bb';
  daemon.height = 2900;
  clock = (1790000000 + 2900) * 1000; // past the next full hour
  assert.equal(await publisher.tick(), false);
  assert.equal(await readFile(hourFile, 'utf8'), first);

  daemon.down = false;
  assert.equal(await publisher.tick(), true);
  const hour = JSON.parse(await readFile(hourFile, 'utf8'));
  assert.deepEqual(hour.time, [1789999200, 1790002800]);
  assert.deepEqual(hour.height, [100, 2900]);
});
