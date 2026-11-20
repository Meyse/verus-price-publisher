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
  const daemon = { requests: [], down: false, hash: 'aa', height: 100, auth: null };
  daemon.server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { method, params } = JSON.parse(body);
    daemon.requests.push({ method, auth: req.headers.authorization });
    if (daemon.down) {
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

  daemon.down = false;
  assert.equal(await publisher.tick(), true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).height, 101);
  assert.deepEqual((await readdir(join(dir, 'v1'))), ['prices.json']); // no temp file left
  assert.ok(!logs.join('\n').includes('s3cret'));
});

test('the HTTP server serves only the price file, only for GET and HEAD', async (t) => {
  const body = Buffer.from('{"schemaVersion":1}\n');
  const server = createPriceServer(() => body).listen(0, '127.0.0.1');
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
  assert.equal((await fetch(`${base}/v1/../config.json`)).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
});
