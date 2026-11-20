// Price history, recorded forward from the prices the service already computes.
// Three files (hour, day, week) under <outDir>/v1/history/. The files are the state:
// on start the service reads them and continues. No RPC calls.

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './files.js';

export const HISTORY_SCHEMA_VERSION = 1;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
// A cycle whose block is further than this from the clock is not recorded:
// the daemon is still syncing, or the clock is wrong.
const MAX_CLOCK_SKEW = 2 * HOUR;
const DIGITS = 6; // significant digits of a history price

// Start of the UTC slot that holds `t` (Unix seconds).
export function slotStart(resolution, t) {
  if (resolution === 'hour') return t - (t % HOUR);
  if (resolution === 'day') return t - (t % DAY);
  // 1970-01-01 was a Thursday; Monday 00:00 UTC is 4 days after a week boundary of the epoch.
  return t - ((t - 4 * DAY) % WEEK + WEEK) % WEEK;
}

export const RESOLUTIONS = ['hour', 'day', 'week'];

const compact = (usd) => {
  const n = Number(usd);
  return Number.isFinite(n) && n > 0 ? Number(n.toPrecision(DIGITS)) : null;
};

function emptyFile(resolution, meta) {
  return {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    resolution,
    ...meta,
    time: [],
    height: [],
    blockTime: [],
    names: {},
    usd: {},
  };
}

// A loaded file is used only if it has the same schema, resolution, chain and anchor,
// and consistent arrays.
function usable(doc, resolution, meta) {
  if (doc?.schemaVersion !== HISTORY_SCHEMA_VERSION || doc.resolution !== resolution) return false;
  if (doc.chain?.id !== meta.chain.id || doc.anchor?.currency !== meta.anchor.currency
    || doc.anchor?.basket !== meta.anchor.basket) return false;
  const n = doc.time?.length;
  if (!Array.isArray(doc.time) || !Array.isArray(doc.height) || !Array.isArray(doc.blockTime)
    || doc.height.length !== n || doc.blockTime.length !== n) return false;
  if (!doc.time.every((t, i) => Number.isInteger(t) && (i === 0 || t > doc.time[i - 1]))) return false;
  if (!doc.usd || typeof doc.usd !== 'object' || !doc.names || typeof doc.names !== 'object') return false;
  return Object.values(doc.usd).every((series) => Array.isArray(series) && series.length === n);
}

export class History {
  /**
   * @param {object} options
   * @param {string} options.outDir
   * @param {{name: string, id: string, testnet: boolean}} options.chain
   * @param {{currency: string, basket: string}} options.anchor
   * @param {{hour: number, day: number, week: number}} options.retentionDays 0 = no limit
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor({ outDir, chain, anchor, retentionDays, log = () => {} }) {
    this.dir = join(outDir, 'v1', 'history');
    this.meta = { chain, anchor, quote: 'USD' };
    this.retentionDays = retentionDays;
    this.log = log;
    this.files = {}; // resolution -> { doc, body }
  }

  path(resolution) {
    return join(this.dir, `${resolution}.json`);
  }

  body(resolution) {
    return this.files[resolution]?.body ?? null;
  }

  // Read the files of an earlier run. A file for another chain or anchor, or a damaged
  // file, is moved aside (never mixed, never deleted), and new files start.
  async load(nowSeconds) {
    const moved = [];
    for (const resolution of RESOLUTIONS) {
      const path = this.path(resolution);
      let body;
      try {
        body = await readFile(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        continue;
      }
      let doc = null;
      try {
        doc = JSON.parse(body.toString('utf8'));
      } catch {
        // Damaged: moved aside below.
      }
      if (usable(doc, resolution, this.meta)) {
        this.files[resolution] = { doc, body };
      } else {
        const aside = `${path}.replaced-${nowSeconds}`;
        await rename(path, aside);
        moved.push(aside);
      }
    }
    if (moved.length) {
      this.log('warn', `history: files for another chain or anchor, or damaged; moved aside: ${moved.join(', ')}`);
    }
  }

  /**
   * Record one sample per resolution when the cycle is the first at or after a slot start.
   * @param {object} doc the published prices document
   * @param {number} nowSeconds cycle time
   * @returns {Promise<string[]>} the resolutions that got a sample
   */
  async record(doc, nowSeconds) {
    if (Math.abs(nowSeconds - doc.blockTime) > MAX_CLOCK_SKEW) return [];
    const recorded = [];
    for (const resolution of RESOLUTIONS) {
      const current = this.files[resolution]?.doc ?? emptyFile(resolution, this.meta);
      const slot = slotStart(resolution, nowSeconds);
      const last = current.time[current.time.length - 1];
      if (last !== undefined && slot <= last) continue; // this slot has its sample (or the clock went back)
      const next = this.append(current, slot, doc, resolution);
      const body = Buffer.from(`${JSON.stringify(next)}\n`);
      await writeFileAtomic(this.path(resolution), body);
      this.files[resolution] = { doc: next, body };
      recorded.push(resolution);
    }
    return recorded;
  }

  // Return a new file document with the sample appended and old samples trimmed.
  append(current, slot, doc, resolution) {
    const n = current.time.length;
    const usd = {};
    const names = {};
    for (const [id, series] of Object.entries(current.usd)) usd[id] = [...series, null];
    for (const [id, price] of Object.entries(doc.prices)) {
      const value = compact(price.usd);
      if (value === null) continue;
      if (!usd[id]) usd[id] = new Array(n + 1).fill(null);
      usd[id][n] = value;
      names[id] = price.name;
    }
    let time = [...current.time, slot];
    let height = [...current.height, doc.height];
    let blockTime = [...current.blockTime, doc.blockTime];

    const days = this.retentionDays[resolution];
    if (days > 0) {
      const keepFrom = time.findIndex((t) => t > slot - days * DAY);
      if (keepFrom > 0) {
        time = time.slice(keepFrom);
        height = height.slice(keepFrom);
        blockTime = blockTime.slice(keepFrom);
        for (const id of Object.keys(usd)) usd[id] = usd[id].slice(keepFrom);
      }
    }
    for (const id of Object.keys(usd)) {
      if (usd[id].every((v) => v === null)) delete usd[id];
      else names[id] ??= current.names[id] ?? id;
    }
    return { ...emptyFile(resolution, this.meta), time, height, blockTime, names, usd };
  }
}
