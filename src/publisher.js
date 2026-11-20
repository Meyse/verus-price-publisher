// One publish cycle per new block: read basket states, compute prices,
// write v1/prices.json atomically. On a failure the last file stays as it is.

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { computePrices } from './prices.js';
import { format } from './decimal.js';

export const SCHEMA_VERSION = 1;
const FRACTIONAL = 1; // currency definition option
const NOT_LIVE = 2 | 4; // currency state flags: PRELAUNCH | REFUNDING

export async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export class Publisher {
  /**
   * @param {ReturnType<import('./config.js').loadConfig>} config
   * @param {object} [options]
   * @param {(level: string, message: string) => void} [options.log]
   * @param {() => number} [options.now] milliseconds
   */
  constructor(config, { log = () => {}, now = Date.now } = {}) {
    this.config = config;
    this.log = log;
    this.now = now;
    this.path = join(config.outDir, 'v1', 'prices.json');
    this.body = null; // last published file content, served by the HTTP server
    this.lastHash = null;
    this.lastCycleAt = -Infinity;
    this.basketLists = new Map(); // chain id -> { ids, at }
    this.verified = new Set(); // chain ids whose RPC was checked
    this.failing = false;
  }

  // Serve the file of an earlier run (same schema and chain) and do not
  // republish its block: a restart must not make an old block look new.
  async loadExisting() {
    try {
      const body = await readFile(this.path);
      const doc = JSON.parse(body.toString('utf8'));
      const { chain } = this.config;
      if (doc?.schemaVersion !== SCHEMA_VERSION || doc.chain?.id !== chain.id
        || doc.anchor?.currency !== chain.anchor || doc.anchor?.basket !== chain.anchorBasket) return;
      this.body = body;
      if (typeof doc.blockHash === 'string') this.lastHash = doc.blockHash;
    } catch {
      // No usable earlier file.
    }
  }

  // Poll once. Run a cycle when the best block changed and the minimum
  // interval has passed. Never throws; a failure keeps the last file.
  async tick({ force = false } = {}) {
    const { rpc } = this.config.chain;
    try {
      await this.verifyChain(this.config.chain);
      const hash = await rpc.call('getbestblockhash');
      if (!force && hash === this.lastHash) return false;
      if (!force && this.now() - this.lastCycleAt < this.config.minIntervalMs) return false;
      const started = this.now();
      const clients = [rpc, ...this.config.pbaas.map((c) => c.rpc)];
      clients.forEach((client) => client.resetCounts());
      const doc = await this.cycle(hash);
      const body = Buffer.from(`${JSON.stringify(doc, null, 1)}\n`);
      await writeFileAtomic(this.path, body);
      this.body = body;
      this.lastHash = hash;
      this.lastCycleAt = started;
      // Calls of this cycle per RPC server (the poll that found the block is not included).
      const calls = Object.fromEntries(clients.map((client) => [client.label, client.resetCounts()]));
      if (this.failing) this.log('info', 'RPC is back; publishing again');
      this.failing = false;
      this.log('info', `published height ${doc.height}: ${Object.keys(doc.prices).length} prices, `
        + `${this.now() - started} ms, calls ${JSON.stringify(calls)}`);
      return true;
    } catch (error) {
      if (error.fatal) throw error;
      if (!this.failing) this.log('error', `cycle failed, keeping the last file: ${error.message}`);
      this.failing = true;
      return false;
    }
  }

  async verifyChain(chain) {
    if (this.verified.has(chain.id)) return;
    const info = await chain.rpc.call('getblockchaininfo');
    if (typeof info?.chainid !== 'string') throw new Error('getblockchaininfo: no chainid');
    if (info.chainid !== chain.id) {
      const error = new Error(`RPC at ${chain.rpc.label} serves chain ${info.chainid}, `
        + `not ${chain.name} ${chain.id}`);
      error.fatal = true;
      throw error;
    }
    this.verified.add(chain.id);
  }

  async basketIds(chain, extra = []) {
    if (chain.baskets !== 'auto') return [...new Set([...extra, ...chain.baskets])];
    const cached = this.basketLists.get(chain.id);
    if (cached && this.now() - cached.at < this.config.basketListMs) {
      return [...new Set([...extra, ...cached.ids])];
    }
    const list = await chain.rpc.call('listcurrencies', [{ systemtype: 'local' }]);
    if (!Array.isArray(list)) throw new Error('listcurrencies: unexpected result');
    const ids = list
      .filter((entry) => {
        const def = entry?.currencydefinition;
        const flags = entry?.bestcurrencystate?.flags;
        return def && (def.options & FRACTIONAL) && Number.isInteger(flags) && !(flags & NOT_LIVE)
          && typeof def.currencyid === 'string';
      })
      .map((entry) => entry.currencydefinition.currencyid);
    this.basketLists.set(chain.id, { ids, at: this.now() });
    this.log('info', `${chain.name}: ${ids.length} live baskets`);
    return [...new Set([...extra, ...ids])];
  }

  // Read each basket once. Any failed read fails the cycle, so a partial
  // file is never published (an unknown id in a fixed list fails every cycle).
  async readBaskets(chain, ids) {
    const baskets = [];
    for (const id of ids) {
      const def = await chain.rpc.call('getcurrency', [id]);
      if (def?.systemid !== chain.id) continue; // imported states can be stale
      if (Array.isArray(def?.bestcurrencystate?.reservecurrencies)) baskets.push(def);
    }
    return baskets;
  }

  async readChain(chain, hash, extra) {
    await this.verifyChain(chain); // no-op for the main chain after tick() checked it
    const blockHash = hash ?? await chain.rpc.call('getbestblockhash');
    const header = await chain.rpc.call('getblockheader', [blockHash]);
    if (!Number.isInteger(header?.height)) throw new Error('getblockheader: unexpected result');
    const baskets = await this.readBaskets(chain, await this.basketIds(chain, extra));
    return { header, baskets };
  }

  async cycle(hash) {
    const { chain } = this.config;
    const main = await this.readChain(chain, hash, [chain.anchorBasket]);
    const { nativeUsd, prices } = computePrices({
      baskets: main.baskets,
      native: chain.id,
      anchor: chain.anchor,
      anchorBasket: chain.anchorBasket,
      minRouteReserve: this.config.minRouteReserve,
    });
    if (!nativeUsd) this.log('warn', `${chain.name}: no native USD price from the anchor basket`);

    const systems = [];
    for (const pbaas of this.config.pbaas) {
      try {
        const read = await this.readChain(pbaas, null, []);
        const result = computePrices({
          baskets: read.baskets,
          native: chain.id,
          anchor: chain.anchor,
          nativeUsd: nativeUsd ?? 0n,
          minRouteReserve: this.config.minRouteReserve,
        });
        for (const [id, price] of result.prices) {
          if (!prices.has(id)) prices.set(id, { ...price, route: { ...price.route, system: pbaas.id } });
        }
        systems.push({
          name: pbaas.name, id: pbaas.id, height: read.header.height, blockTime: read.header.time,
        });
      } catch (error) {
        if (error.fatal) throw error;
        this.log('warn', `${pbaas.name}: no prices this cycle: ${error.message}`);
      }
    }

    const sorted = [...prices.entries()].sort(([a, x], [b, y]) => (
      x.name.localeCompare(y.name) || (a < b ? -1 : 1)));
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      chain: { name: chain.name, id: chain.id, testnet: chain.testnet },
      height: main.header.height,
      blockHash: hash,
      blockTime: main.header.time,
      generatedAt: Math.floor(this.now() / 1000),
      maxAge: this.config.maxAgeSeconds,
      quote: 'USD',
      anchor: { currency: chain.anchor, basket: chain.anchorBasket },
      prices: Object.fromEntries(sorted.map(([id, p]) => [id, { name: p.name, usd: format(p.usd), route: p.route }])),
    };
    if (this.config.pbaas.length) doc.systems = systems;
    return doc;
  }
}
