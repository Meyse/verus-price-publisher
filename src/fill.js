// History fill: samples for history slots that have none, read from the chain's own past
// basket states. It uses one more read-only method: getcurrencystate in its range form
// (currency id, "start,end,step"), which returns the state at every step-th height with the
// block time. Prices come from computePrices, the same code as live samples, with the
// states of all baskets at one height.
//
// Slot to block: the sample of a slot is the first block of a regular height grid whose
// block time is at or after the slot start. It must be before the slot end, and the anchor
// basket must give the native coin a price there; else the slot stays missing. The grid
// step is a fixed number of blocks: a quarter of the blocks of an hour, or half of those of
// a day or a week (from the known block times).
//
// Load: one call at a time, and no call starts while a publish cycle runs. Each call is
// sized from the measured time per state of the last call on the same basket (the baskets
// cost very different times per state), to about TARGET_MS, and to at most about
// RESPONSE_BYTES; the first call on each basket in a run reads FIRST_STATES states. Before each
// call after the first, a pause of max(PAUSE_MS, 2 x the last call's time): the fill keeps
// the daemon at most about one third busy. After MAX_CALLS calls the run waits CAP_WAIT_MS
// and goes on. A call over SLOW_MS halves the size; a one-state call over SLOW_MS, or a
// failed call, ends the run, and the fill is then off until a restart.

import { format } from './decimal.js';
import { RESOLUTIONS, SLOT_SECONDS, slotStart } from './history.js';
import { computePrices, nativeUsdPrice } from './prices.js';

const DAY = 86400;
const POINTS_PER_SLOT = { hour: 4, day: 2, week: 2 };
const SEGMENT_SLOTS = { hour: 60, day: 120, week: 120 }; // about 240 grid blocks per segment
const RESPONSE_BYTES = 256 * 1024;
// Before the oldest known sample, one call maps time to height with this many blocks.
const MAP_POINTS = 100;
// For that call only: blocks are assumed to be at most this fast (the target is 60 s), so
// the call surely reaches back far enough.
const FASTEST_BLOCK_SECONDS = 30;
export const MAX_CALLS = 1500;
export const PAUSE_MS = 1000;
const CAP_WAIT_MS = 60 * 60 * 1000;
const TARGET_MS = 1000;
const SLOW_MS = 5000;
const FIRST_STATES = 4;

// Bytes of one state in a response, from the number of reserves (measured on VRSCTEST:
// 615 to 3052 bytes for 1 to 8 reserves).
const entryBytes = (def) => 400 + 330 * Math.max(1, def.bestcurrencystate?.reservecurrencies?.length ?? 1);
const NOT_LIVE = 2 | 4; // currency state flags: PRELAUNCH | REFUNDING, as in publisher.js
const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const STOP = Symbol('stop');

// The known points around time t: lo = last point (by height) before t, hi = the next
// point at or after t.
function bracket(points, t) {
  let i = -1;
  points.forEach((p, k) => { if (p.time < t) i = k; });
  const lo = i >= 0 ? points[i] : null;
  const hi = points.slice(i + 1).find((p) => p.time >= t) ?? null;
  return { lo, hi };
}

const estimate = ({ lo, hi }, t) => (lo && hi && hi.time > lo.time
  ? lo.height + ((t - lo.time) * (hi.height - lo.height)) / (hi.time - lo.time)
  : (hi ?? lo).height);

// Segments: runs of missing slots with their own grid. A slot of a coarser resolution is
// added to a finer segment that holds its first sub-slot (its sample comes from the finer grid).
export function plan(missing) {
  const segments = [];
  for (const resolution of RESOLUTIONS) {
    const len = SLOT_SECONDS[resolution];
    const own = [];
    const slots = missing.filter((m) => m.resolution === resolution).map((m) => m.slot).sort((a, b) => a - b);
    for (const slot of slots) {
      const finer = segments.find((s) => s.from <= slot && slot + SLOT_SECONDS[s.resolution] <= s.to);
      if (finer) finer.slots.push({ resolution, slot });
      else own.push(slot);
    }
    const runs = []; // newest first, each run newest first
    for (const slot of own.reverse()) {
      const run = runs[runs.length - 1];
      if (run && slot === run[run.length - 1] - len && run.length < SEGMENT_SLOTS[resolution]) run.push(slot);
      else runs.push([slot]);
    }
    for (const run of runs) {
      segments.push({
        resolution, from: run[run.length - 1], to: run[0] + len, slots: run.map((slot) => ({ resolution, slot })),
      });
    }
  }
  return segments;
}

export class HistoryFill {
  /**
   * @param {object} options
   * @param {import('./history.js').History} options.history
   * @param {import('./rpc.js').RpcClient} options.rpc
   * @param {{id: string, anchor: string, anchorBasket: string}} options.chain
   * @param {string} options.minRouteReserve
   * @param {{hour: number, day: number, week: number}} options.windowDays
   * @param {(level: string, message: string) => void} options.log
   * @param {() => number} options.now milliseconds
   * @param {(ms: number) => Promise<void>} options.sleep
   * @param {() => Promise<void>} options.idle resolves when no publish cycle runs
   */
  constructor({
    history, rpc, chain, minRouteReserve, windowDays, log, now, sleep, idle, maxCalls = MAX_CALLS,
  }) {
    Object.assign(this, { history, rpc, chain, minRouteReserve, windowDays, log, now, sleep, idle, maxCalls });
    this.tried = new Set(); // "resolution:slot" looked at in this process
    this.running = null;
    this.off = false; // after a failed call: off until a restart
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  // Missing slots: before the current slot, inside the fill window, the chain past the
  // slot end, not looked at before in this process.
  missing(nowSeconds, tipTime) {
    const out = [];
    for (const resolution of RESOLUTIONS) {
      const len = SLOT_SECONDS[resolution];
      const have = this.history.slots(resolution);
      const current = slotStart(resolution, nowSeconds);
      const from = current - this.windowDays[resolution] * DAY;
      for (let slot = current - len; slot > from; slot -= len) {
        if (slot + len <= tipTime && !have.has(slot) && !this.tried.has(`${resolution}:${slot}`)) {
          out.push({ resolution, slot });
        }
      }
    }
    return out;
  }

  /**
   * Start a fill run in the background when slots are missing. Never throws.
   * @param {object} input
   * @param {object[]} input.defs basket definitions of the last cycle (local baskets)
   * @param {Map<string, string|null>} input.bridges
   * @param {{height: number, time: number}} input.tip the block of the last cycle
   * @returns {Promise<void>|null} the run, or null when nothing starts
   */
  start({ defs, bridges, tip }) {
    if (this.off || this.stopped || this.running) return null;
    const missing = this.missing(Math.floor(this.now() / 1000), tip.time);
    if (!missing.length) return null;
    this.running = this.run(missing, { defs, bridges, tip }).finally(() => { this.running = null; });
    return this.running;
  }

  async run(missing, { defs, bridges, tip }) {
    const started = this.now();
    const stats = {
      calls: 0, states: 0, daemonMs: 0, longestMs: 0, maxBytes: 0, filled: { hour: 0, day: 0, week: 0 },
    };
    this.stats = stats;
    this.batch = 0; // calls since the last cap wait
    this.sizes = new Map(); // basket id -> states for its next call (first call: FIRST_STATES)
    this.lastMs = 0;
    const count = (list) => RESOLUTIONS.map((r) => `${r} ${list.filter((m) => m.resolution === r).length}`).join(', ');
    this.log('info', `history fill: ${missing.length} slots missing (${count(missing)}); reading past basket states`);
    const summary = () => {
      const filled = RESOLUTIONS.map((r) => `${r} ${stats.filled[r]}`).join(', ');
      return `filled ${filled}; ${stats.calls} calls, ${stats.states} states, daemon time `
        + `${Math.round(stats.daemonMs / 1000)} s, in ${Math.round((this.now() - started) / 1000)} s; longest call `
        + `${stats.longestMs} ms, largest response ${Math.ceil(stats.maxBytes / 1024)} KB`;
    };
    try {
      const anchorDef = defs.find((d) => d.currencyid === this.chain.anchorBasket);
      if (!anchorDef) throw new Error('the anchor basket is not in the basket list');
      const points = [...this.history.points(), tip].map(({ height, time }) => ({ height, time }))
        .sort((a, b) => a.height - b.height);
      let segments = plan(missing);
      const oldest = Math.min(...segments.map((s) => s.from));
      if (oldest < points[0].time) await this.map(anchorDef, points, oldest);
      // Two passes: a coarser slot that a finer segment could not decide gets its own grid.
      for (let pass = 0; pass < 2 && segments.length; pass += 1) {
        const open = [];
        for (const segment of segments) {
          const decided = new Set(await this.segment(segment, { defs, anchorDef, bridges, points, tip }));
          for (const item of segment.slots) {
            if (decided.has(item)) this.tried.add(`${item.resolution}:${item.slot}`);
            else open.push(item);
          }
        }
        segments = plan(open);
      }
      // Slots still without a sample and still inside the window (a slot can also leave
      // the window while the run goes on).
      const nowSeconds = Math.floor(this.now() / 1000);
      const left = missing.filter(({ resolution, slot }) => !this.history.slots(resolution).has(slot)
        && slot > slotStart(resolution, nowSeconds) - this.windowDays[resolution] * DAY).length;
      this.log('info', `history fill: ${summary()}; ${left} slots stay missing (no block in the slot, `
        + 'or no anchor price at its block)');
    } catch (error) {
      if (error === STOP) return;
      this.off = true;
      this.log('error', `history fill stopped: ${error.message}; ${summary()}; the next start tries again`);
    }
  }

  // One getcurrencystate call of `states` states: a pause before it (not before the first),
  // and never while a publish cycle runs. Then the size of the next call on the same basket.
  async call(id, range, states) {
    if (this.stopped) throw STOP;
    if (this.batch >= this.maxCalls) {
      this.log('info', `history fill: ${this.maxCalls} calls; waiting 60 min, then the fill goes on`);
      await this.sleep(CAP_WAIT_MS);
      this.batch = 0;
    } else if (this.stats.calls > 0) {
      await this.sleep(Math.max(PAUSE_MS, 2 * this.lastMs));
    }
    await this.idle();
    if (this.stopped) throw STOP;
    this.stats.calls += 1;
    this.batch += 1;
    const started = this.now();
    const result = await this.rpc.call('getcurrencystate', [id, range]);
    const ms = Math.max(0, this.now() - started);
    Object.assign(this.stats, {
      states: this.stats.states + states,
      daemonMs: this.stats.daemonMs + ms,
      longestMs: Math.max(this.stats.longestMs, ms),
      maxBytes: Math.max(this.stats.maxBytes, JSON.stringify(result)?.length ?? 0),
    });
    this.lastMs = ms;
    if (ms > SLOW_MS) {
      if (states <= 1) throw new Error(`one state took ${ms} ms`);
      this.sizes.set(id, Math.max(1, Math.floor(states / 2)));
    } else {
      this.sizes.set(id, ms > 0 ? Math.max(1, Math.floor((TARGET_MS * states) / ms)) : Infinity);
    }
    return result;
  }

  // States of one basket on the grid start, start + step, ..., end, in calls sized by
  // call(). Returns height -> { time, state } for the heights in `keep` (all if null).
  async read(def, start, end, step, keep = null) {
    const limit = Math.max(1, Math.floor(RESPONSE_BYTES / entryBytes(def)));
    const out = new Map();
    for (let from = start, per; from <= end; from += per * step) {
      per = Math.min(limit, this.sizes.get(def.currencyid) ?? FIRST_STATES);
      const to = Math.min(end, from + (per - 1) * step);
      const result = await this.call(def.currencyid, `${from},${to},${step}`, Math.floor((to - from) / step) + 1);
      const expected = Math.floor((to - from) / step) + 1;
      if (!Array.isArray(result) || result.length !== expected) {
        throw new Error(`getcurrencystate ${def.currencyid}: unexpected result`);
      }
      result.forEach((entry, i) => {
        if (entry?.height !== from + i * step || !Number.isInteger(entry.blocktime)
          || !isMap(entry.currencystate) || entry.currencystate.currencyid !== def.currencyid) {
          throw new Error(`getcurrencystate ${def.currencyid}: unexpected entry`);
        }
        if (!keep || keep.has(entry.height)) out.set(entry.height, { time: entry.blocktime, state: entry.currencystate });
      });
    }
    return out;
  }

  // One call on the anchor basket that adds known points back to `oldest`.
  async map(anchorDef, points, oldest) {
    const first = points[0];
    const start = Math.max(1, first.height - Math.ceil((first.time - oldest) / FASTEST_BLOCK_SECONDS));
    if (start >= first.height) return;
    const step = Math.max(1, Math.ceil((first.height - start) / MAP_POINTS));
    const end = start + Math.floor((first.height - start) / step) * step;
    const read = await this.read(anchorDef, start, end, step);
    for (const [height, { time }] of read) points.push({ height, time });
    points.sort((a, b) => a.height - b.height);
  }

  // Fill one segment. Returns the slots it decided (filled, or known to have no usable
  // block). A coarser slot that reaches past the segment end and got no block here is not
  // decided: the next run reads it on its own grid.
  async segment(segment, { defs, anchorDef, bridges, points, tip }) {
    const { chain } = this;
    const len = SLOT_SECONDS[segment.resolution];
    const decided = segment.slots.filter(({ resolution, slot }) => resolution === segment.resolution
      || slot + SLOT_SECONDS[resolution] <= segment.to);
    const low = bracket(points, segment.from);
    // A segment that starts before the oldest known block starts at that block (the chain
    // or the mapping call has nothing older); one that also ends before it has no block.
    if (!low.lo && points[0].time >= segment.to) return decided;
    const a = low.lo ?? points[0];
    const b = low.hi && low.hi.height > a.height ? low.hi : points[points.length - 1];
    const spacing = b.height > a.height && b.time > a.time ? (b.time - a.time) / (b.height - a.height) : 60; // s per block
    const step = Math.max(1, Math.floor(len / POINTS_PER_SLOT[segment.resolution] / spacing));
    const margin = (x) => Math.max(step, x.lo && x.hi ? Math.ceil(0.02 * (x.hi.height - x.lo.height)) : 0);
    const start = low.lo
      ? Math.max(1, low.lo.height, Math.floor(estimate(low, segment.from)) - margin(low))
      : points[0].height;
    const high = bracket(points, segment.to);
    const top = Math.min(tip.height, high.hi?.height ?? tip.height); // a known block at or after the end
    let end = Math.min(top, Math.ceil(estimate(high, segment.to)) + margin(high));
    if (end < start) return decided;
    end = start + Math.floor((end - start) / step) * step;

    // The anchor basket first: its block times give the block of each slot. The grid ends
    // come from an estimate; when the times show that they miss the segment, the grid is
    // extended once to the known block before the start or after the end.
    const anchorStates = await this.read(anchorDef, start, end, step);
    let times = [...anchorStates.values()].map((e) => e.time);
    if (low.lo && start > low.lo.height && Math.min(...times) >= segment.from) {
      const from = start - Math.ceil((start - low.lo.height) / step) * step;
      for (const [h, e] of await this.read(anchorDef, Math.max(1, from), start - step, step)) anchorStates.set(h, e);
    }
    times = [...anchorStates.values()].map((e) => e.time);
    if (end + step <= top && Math.max(...times) < segment.to) {
      for (const [h, e] of await this.read(anchorDef, end + step, end + Math.floor((top - end) / step) * step, step)) anchorStates.set(h, e);
    }
    const timeline = [...anchorStates].map(([height, entry]) => ({ height, ...entry })).sort((a, b) => a.height - b.height);
    timeline.forEach(({ height, time }) => points.push({ height, time }));
    points.sort((a, b) => a.height - b.height);
    const picks = [];
    for (const { resolution, slot } of segment.slots) {
      // The first grid block (by height) whose time is in the slot.
      const entry = timeline.find((e) => e.time >= slot && e.time < slot + SLOT_SECONDS[resolution]);
      if (!entry) continue; // no block in the slot
      const anchorBasket = { ...anchorDef, bestcurrencystate: entry.state };
      if (!nativeUsdPrice(anchorBasket, { native: chain.id, anchor: chain.anchor })) continue;
      picks.push({ resolution, slot, height: entry.height, time: entry.time });
    }
    const out = [...new Set([...decided, ...picks.map(({ resolution, slot }) => segment.slots
      .find((x) => x.resolution === resolution && x.slot === slot))])];
    if (!picks.length) return out;

    // The other baskets, only from the first to the last picked height.
    const heights = new Set(picks.map((p) => p.height));
    const first = Math.min(...heights);
    const last = Math.max(...heights);
    const states = new Map([[anchorDef.currencyid, anchorStates]]);
    for (const def of defs) {
      if (def.currencyid === anchorDef.currencyid) continue;
      states.set(def.currencyid, await this.read(def, first, last, step, heights));
    }

    const docs = new Map();
    for (const height of heights) {
      const baskets = [];
      for (const def of defs) {
        const state = states.get(def.currencyid)?.get(height)?.state;
        // As the live basket list: with "auto", a basket that was not live at that height
        // (pre-launch, refunding) is left out; the anchor basket is always read.
        if (chain.baskets === 'auto' && def.currencyid !== chain.anchorBasket
          && !(Number.isInteger(state?.flags) && !(state.flags & NOT_LIVE))) continue;
        if (Array.isArray(state?.reservecurrencies)) baskets.push({ ...def, bestcurrencystate: state });
      }
      const { prices } = computePrices({
        baskets,
        native: chain.id,
        anchor: chain.anchor,
        anchorBasket: chain.anchorBasket,
        minRouteReserve: this.minRouteReserve,
        bridges,
      });
      docs.set(height, {
        height,
        blockTime: anchorStates.get(height).time,
        prices: Object.fromEntries([...prices].map(([id, p]) => [id, { name: p.name, usd: format(p.usd) }])),
      });
    }
    for (const resolution of RESOLUTIONS) {
      const samples = picks.filter((p) => p.resolution === resolution).map((p) => ({ slot: p.slot, doc: docs.get(p.height) }));
      if (samples.length) this.stats.filled[resolution] += await this.history.insert(resolution, samples);
    }
    return out;
  }
}
