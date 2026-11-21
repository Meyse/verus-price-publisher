// Price history, recorded forward from the prices the service already computes, and
// filled backward for missing slots (src/fill.js). Three files (hour, day, week) under
// <outDir>/v1/history/. The files are the state: on start the service reads them and
// continues. All writes go through one queue, so a fill and a live sample never write
// the same file at the same time.

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './files.js';

export const HISTORY_SCHEMA_VERSION = 1;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
// A cycle whose block is further than this from the clock is not recorded:
// the daemon is still syncing, or the clock is wrong.
export const MAX_CLOCK_SKEW = 2 * HOUR;
const DIGITS = 6; // significant digits of a history price

// Start of the UTC slot that holds `t` (Unix seconds).
export function slotStart(resolution, t) {
  if (resolution === 'hour') return t - (t % HOUR);
  if (resolution === 'day') return t - (t % DAY);
  // 1970-01-01 was a Thursday; Monday 00:00 UTC is 4 days after a week boundary of the epoch.
  return t - ((t - 4 * DAY) % WEEK + WEEK) % WEEK;
}

export const RESOLUTIONS = ['hour', 'day', 'week'];
export const SLOT_SECONDS = { hour: HOUR, day: DAY, week: WEEK };

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
    names: dict(),
    usd: dict(),
  };
}

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Maps keyed by currency id have no prototype, so an id such as "__proto__" stays a plain key.
const dict = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));

// A loaded file is used only if it has the same schema, resolution, chain and anchor,
// and consistent arrays.
function usable(doc, resolution, meta) {
  if (doc?.schemaVersion !== HISTORY_SCHEMA_VERSION || doc.resolution !== resolution) return false;
  if (doc.chain?.id !== meta.chain.id || doc.anchor?.currency !== meta.anchor.currency
    || doc.anchor?.basket !== meta.anchor.basket) return false;
  const n = doc.time?.length;
  if (!Array.isArray(doc.time) || !Array.isArray(doc.height) || !Array.isArray(doc.blockTime)
    || doc.height.length !== n || doc.blockTime.length !== n) return false;
  if (!doc.time.every((t, i) => Number.isInteger(t) && slotStart(resolution, t) === t
    && (i === 0 || t > doc.time[i - 1]))) return false;
  if (!doc.height.every(Number.isInteger) || !doc.blockTime.every(Number.isInteger)) return false;
  if (!isMap(doc.usd) || !isMap(doc.names)) return false;
  if (!Object.values(doc.names).every((name) => typeof name === 'string')) return false;
  return Object.values(doc.usd).every((series) => Array.isArray(series) && series.length === n
    && series.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0)));
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
    this.queue = Promise.resolve(); // file writes, one at a time
  }

  // Run fn after all earlier writes; a failure does not block later writes.
  serial(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // Slot starts that have a sample.
  slots(resolution) {
    return new Set(this.files[resolution]?.doc.time ?? []);
  }

  // Known (height, block time) pairs of all samples, sorted by height.
  points() {
    const seen = new Map();
    for (const resolution of RESOLUTIONS) {
      const doc = this.files[resolution]?.doc;
      doc?.height.forEach((height, i) => seen.set(height, doc.blockTime[i]));
    }
    return [...seen].map(([height, time]) => ({ height, time })).sort((a, b) => a.height - b.height);
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
    if (!(Math.abs(nowSeconds - doc.blockTime) <= MAX_CLOCK_SKEW)) return []; // also NaN
    // Most cycles add nothing: they do not wait behind a fill write. (A fill only inserts
    // slots before the last one, so this check cannot miss a needed sample.)
    const needed = RESOLUTIONS.some((resolution) => {
      const time = this.files[resolution]?.doc.time;
      return !time?.length || slotStart(resolution, nowSeconds) > time[time.length - 1];
    });
    if (!needed) return [];
    return this.serial(() => this.recordNow(doc, nowSeconds));
  }

  async recordNow(doc, nowSeconds) {
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

  /**
   * Insert samples for past slots that have none (a slot that has a sample keeps it).
   * @param {string} resolution
   * @param {{slot: number, doc: object}[]} samples doc: { height, blockTime, prices }
   * @returns {Promise<number>} the number of samples inserted
   */
  insert(resolution, samples) {
    return this.serial(async () => {
      const current = this.files[resolution]?.doc ?? emptyFile(resolution, this.meta);
      const merged = this.merge(current, samples, resolution);
      if (!merged) return 0;
      const { doc: next, added } = merged;
      const body = Buffer.from(`${JSON.stringify(next)}\n`);
      await writeFileAtomic(this.path(resolution), body);
      this.files[resolution] = { doc: next, body };
      return added;
    });
  }

  // Return { doc, added }: a new file document with the samples inserted in time order and
  // old samples trimmed. Null when there is nothing to insert.
  merge(current, samples, resolution) {
    const have = new Set(current.time);
    const add = new Map();
    for (const sample of samples) {
      if (slotStart(resolution, sample.slot) === sample.slot && !have.has(sample.slot)) add.set(sample.slot, sample.doc);
    }
    if (!add.size) return null;
    const rows = [
      ...current.time.map((slot, i) => ({ slot, i, height: current.height[i], blockTime: current.blockTime[i] })),
      ...[...add].map(([slot, doc]) => ({ slot, doc, height: doc.height, blockTime: doc.blockTime })),
    ].sort((a, b) => a.slot - b.slot);
    const n = rows.length;
    const usd = dict(Object.entries(current.usd).map(([id, series]) => [id, rows.map((r) => (r.doc ? null : series[r.i]))]));
    const names = dict(Object.entries(current.names));
    rows.forEach((row, k) => {
      if (!row.doc) return;
      for (const [id, price] of Object.entries(row.doc.prices)) {
        const value = compact(price?.usd);
        if (value === null) continue;
        if (!Object.hasOwn(usd, id)) usd[id] = new Array(n).fill(null);
        usd[id][k] = value;
        if (!Object.hasOwn(names, id)) names[id] = typeof price.name === 'string' ? price.name : id;
      }
    });
    const days = this.retentionDays[resolution];
    const keepFrom = days > 0 ? rows.findIndex((r) => r.slot > rows[n - 1].slot - days * DAY) : 0;
    const kept = rows.slice(keepFrom);
    for (const id of Object.keys(usd)) {
      usd[id] = usd[id].slice(keepFrom);
      if (usd[id].every((v) => v === null)) delete usd[id];
    }
    for (const id of Object.keys(names)) if (!Object.hasOwn(usd, id)) delete names[id];
    const added = kept.filter((r) => r.doc).length;
    if (!added) return null;
    return {
      added,
      doc: {
        ...emptyFile(resolution, this.meta),
        time: kept.map((r) => r.slot),
        height: kept.map((r) => r.height),
        blockTime: kept.map((r) => r.blockTime),
        names,
        usd,
      },
    };
  }

  // Return a new file document with the sample appended and old samples trimmed.
  append(current, slot, doc, resolution) {
    const n = current.time.length;
    const usd = dict(Object.entries(current.usd).map(([id, series]) => [id, [...series, null]]));
    const names = dict();
    for (const [id, price] of Object.entries(doc.prices)) {
      const value = compact(price?.usd);
      if (value === null) continue;
      if (!Object.hasOwn(usd, id)) usd[id] = new Array(n + 1).fill(null);
      usd[id][n] = value;
      names[id] = typeof price.name === 'string' ? price.name : id;
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
      else if (!Object.hasOwn(names, id)) names[id] = Object.hasOwn(current.names, id) ? current.names[id] : id;
    }
    return { ...emptyFile(resolution, this.meta), time, height, blockTime, names, usd };
  }
}
