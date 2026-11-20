// A fake verusd on the network boundary. It answers from the mainnet fixture.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

export const VRSC = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/vrsc-mainnet-baskets.json', import.meta.url)));

export async function fakeDaemon() {
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
      getblockheader: () => ({ hash: params[0], height: daemon.height, time: daemon.time ?? 1790000000 + daemon.height }),
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
