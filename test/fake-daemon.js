// A fake verusd on the network boundary. It answers from the mainnet fixture.
// Optional: blockTime(height), stateAt(id, height, state) for getcurrencystate, and
// failRange(params) to fail a getcurrencystate call.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

export const VRSC = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/vrsc-mainnet-baskets.json', import.meta.url)));

export async function fakeDaemon() {
  const daemon = {
    requests: [], down: false, failCurrency: null, hash: 'aa', height: 100, blockTime: null, stateAt: null, failRange: null,
  };
  daemon.server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { method, params } = JSON.parse(body);
    daemon.requests.push({ method, params, auth: req.headers.authorization });
    if (daemon.down || (method === 'getcurrency' && params[0] === daemon.failCurrency)
      || (method === 'getcurrencystate' && daemon.failRange?.(params))) {
      res.writeHead(500).end(JSON.stringify({ result: null, error: { code: -28, message: 'Loading' } }));
      return;
    }
    const blockTime = (height) => (daemon.blockTime ? daemon.blockTime(height) : daemon.time ?? 1790000000 + height);
    const byId = (id) => fixture.baskets.find((b) => b.currencyid === id || b.fullyqualifiedname === id);
    const results = {
      getblockchaininfo: () => ({ name: 'VRSC', chainid: VRSC }),
      getbestblockhash: () => daemon.hash,
      getblockheader: () => ({ hash: params[0], height: daemon.height, time: blockTime(daemon.height) }),
      listcurrencies: () => fixture.baskets.map((b) => ({ currencydefinition: b, bestcurrencystate: b.bestcurrencystate })),
      getcurrency: () => {
        const def = byId(params[0]);
        const state = def && daemon.stateAt?.(def.currencyid, daemon.height, def.bestcurrencystate);
        return state ? { ...def, bestcurrencystate: state } : def;
      },
      // Like verusd: heights past the tip are left out, and the end height is always included.
      getcurrencystate: () => {
        const def = byId(params[0]);
        const [start, end, step] = params[1].split(',').map(Number);
        if (!def || start > daemon.height) return undefined;
        const heights = [];
        for (let h = start; h <= Math.min(end, daemon.height); h += Math.max(1, step)) heights.push(h);
        if (end <= daemon.height && heights[heights.length - 1] !== end) heights.push(end);
        return heights.map((height) => ({
          height,
          blocktime: blockTime(height),
          currencystate: daemon.stateAt?.(def.currencyid, height, def.bestcurrencystate) ?? def.bestcurrencystate,
        }));
      },
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
