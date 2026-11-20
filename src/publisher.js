// One publish cycle per new block: read basket states, compute prices,
// write v1/prices.json atomically. On a failure the last file stays as it is.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './files.js';
import { History } from './history.js';
import { computePrices } from './prices.js';
import { format } from './decimal.js';

export const SCHEMA_VERSION = 1;
const FRACTIONAL = 1; // currency definition option
const NOT_LIVE = 2 | 4; // currency state flags: PRELAUNCH | REFUNDING

export { writeFileAtomic };

// A PBaaS chain's data may set the price of a PBaaS chain coin only for its own coin,
// and only through its bridge basket. Another chain cannot set it (bad or hostile data).
export function pbaasMaySet(id, price, systemId, bridges) {
  if (!bridges.has(id)) return true;
  return id === systemId && price.route?.type === 'reserve' && price.route.basket === bridges.get(id);
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
    this.bridgeList = null; // { map: PBaaS chain id -> bridge basket id, at }
    this.verified = new Set(); // chain ids whose RPC was checked
    this.failing = false;
    this.failingPbaas = new Set(); // PBaaS chain ids whose last read failed
    this.history = config.history ? new History({
      outDir: config.outDir,
      chain: { name: config.chain.name, id: config.chain.id, testnet: config.chain.testnet },
      anchor: { currency: config.chain.anchor, basket: config.chain.anchorBasket },
      retentionDays: config.history.retentionDays,
      log,
    }) : null;
    this.historyFailing = false;
  }

  // Serve the file of an earlier run (same schema and chain) and do not
  // republish its block: a restart must not make an old block look new.
  async loadExisting() {
    if (this.history) {
      try {
        await this.history.load(Math.floor(this.now() / 1000));
      } catch (error) {
        // Never overwrite a file that could not be read: history stays off for this run.
        this.log('error', `history: cannot read the files, history is off until a restart: ${error.message}`);
        this.history = null;
      }
    }
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

  // True when the minimum interval since the last cycle has passed. A negative
  // time means the clock went back: do not wait for it to catch up.
  cycleAllowed() {
    const elapsed = this.now() - this.lastCycleAt;
    return elapsed < 0 || elapsed >= this.config.minIntervalMs;
  }

  // The earliest time (ms) at which a check can run a cycle.
  nextCycleAt() {
    return this.cycleAllowed() ? this.now() : this.lastCycleAt + this.config.minIntervalMs;
  }

  // Check once. While the minimum interval runs, return at once without an RPC call.
  // Then poll, and run a cycle when the best block changed. Never throws (except for a
  // wrong chain); a failure keeps the last file.
  async tick({ force = false } = {}) {
    const { rpc } = this.config.chain;
    if (!force && !this.cycleAllowed()) return false;
    try {
      await this.verifyChain(this.config.chain);
      const hash = await rpc.call('getbestblockhash');
      if (!force && hash === this.lastHash) return false;
      const started = this.now();
      const clients = [rpc, ...this.config.pbaas.map((c) => c.rpc)];
      clients.forEach((client) => client.resetCounts());
      const doc = await this.cycle(hash);
      const body = Buffer.from(`${JSON.stringify(doc, null, 1)}\n`);
      await writeFileAtomic(this.path, body);
      this.body = body;
      this.lastHash = hash;
      this.lastCycleAt = started;
      await this.recordHistory(doc);
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

  // Add a history sample when this cycle is the first of a new slot. A history write
  // error is logged once and retried on the next cycle; prices.json is not affected.
  async recordHistory(doc) {
    if (!this.history) return;
    try {
      const recorded = await this.history.record(doc, doc.generatedAt);
      if (recorded.length) this.log('info', `history: sample at height ${doc.height} for ${recorded.join(', ')}`);
      if (this.historyFailing) this.log('info', 'history: writing again');
      this.historyFailing = false;
    } catch (error) {
      if (!this.historyFailing) this.log('error', `history: cannot write: ${error.message}`);
      this.historyFailing = true;
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

  // PBaaS chains and their bridge baskets, from the main chain, at most once per
  // basketListSeconds. "auto": all PBaaS chains the main chain knows (one listcurrencies).
  // Fixed list: only the configured pbaas chains (one getcurrency each).
  async bridges() {
    const { chain, pbaas } = this.config;
    if (this.bridgeList && this.now() - this.bridgeList.at < this.config.basketListMs) {
      return this.bridgeList.map;
    }
    const map = new Map();
    const add = (def) => {
      if (typeof def?.currencyid === 'string' && def.currencyid !== chain.id
        && typeof def.gatewayconverterid === 'string') map.set(def.currencyid, def.gatewayconverterid);
    };
    if (chain.baskets === 'auto') {
      const list = await chain.rpc.call('listcurrencies', [{ systemtype: 'pbaas' }]);
      if (!Array.isArray(list)) throw new Error('listcurrencies: unexpected result');
      list.forEach((entry) => add(entry?.currencydefinition));
    }
    for (const entry of pbaas) {
      if (!map.has(entry.id)) add(await chain.rpc.call('getcurrency', [entry.id]));
      if (!map.has(entry.id)) map.set(entry.id, null); // no bridge basket: the coin gets no price
    }
    this.bridgeList = { map, at: this.now() };
    return map;
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
    // A PBaaS chain's coin is priced only by its own bridge basket on its own chain.
    // On the main chain that basket is an imported copy and is not read, so the main
    // chain gives these coins no price.
    const bridges = await this.bridges();
    const { nativeUsd, prices } = computePrices({
      baskets: main.baskets,
      native: chain.id,
      anchor: chain.anchor,
      anchorBasket: chain.anchorBasket,
      minRouteReserve: this.config.minRouteReserve,
      bridges,
    });
    if (!nativeUsd) this.log('warn', `${chain.name}: no native USD price from the anchor basket`);

    const systems = [];
    for (const pbaas of this.config.pbaas) {
      try {
        const bridge = bridges.get(pbaas.id);
        const read = await this.readChain(pbaas, null, bridge ? [bridge] : []);
        const result = computePrices({
          baskets: read.baskets,
          native: chain.id,
          anchor: chain.anchor,
          nativeUsd: nativeUsd ?? 0n,
          minRouteReserve: this.config.minRouteReserve,
          bridges,
        });
        for (const [id, price] of result.prices) {
          if (prices.has(id) || !pbaasMaySet(id, price, pbaas.id, bridges)) continue;
          prices.set(id, { ...price, route: { ...price.route, system: pbaas.id } });
        }
        systems.push({
          name: pbaas.name, id: pbaas.id, height: read.header.height, blockTime: read.header.time,
        });
        if (this.failingPbaas.delete(pbaas.id)) this.log('info', `${pbaas.name}: prices are back`);
      } catch (error) {
        if (error.fatal) throw error;
        // Log the first failure and the recovery, not every block.
        if (!this.failingPbaas.has(pbaas.id)) {
          this.log('warn', `${pbaas.name}: no prices until it answers again: ${error.message}`);
        }
        this.failingPbaas.add(pbaas.id);
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
