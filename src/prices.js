// Pure price math. Input: basket definitions as `getcurrency` returns them.
// Output: a USD price for every currency that has a usable route.
// Ported from Verus Mobile (onChainPriceMath.js); one pass prices all currencies.

import { ONE, div, format, mul, parse, positive } from './decimal.js';

// CCurrencyState flags: PRELAUNCH = 2, REFUNDING = 4.
const NOT_LIVE = 2 | 4;

// Reserves of a live basket. A pre-launch, refunding or zero-supply basket has none.
function liveReserves(definition) {
  const state = definition?.bestcurrencystate;
  if (!state || typeof state !== 'object') return [];
  if (!Number.isInteger(state.flags) || (state.flags & NOT_LIVE) !== 0) return [];
  if (definition.prelaunch === true) return [];
  if (!positive(state.supply)) return [];
  return Array.isArray(state.reservecurrencies) ? state.reservecurrencies : [];
}

function reserveOf(definition, currencyId) {
  return liveReserves(definition).find((reserve) => reserve?.currencyid === currencyId);
}

function priceIn(definition, currencyId) {
  return positive(reserveOf(definition, currencyId)?.priceinreserve);
}

// USD price of the native coin: priceinreserve[anchor] / priceinreserve[native].
export function nativeUsdPrice(anchorBasket, { native, anchor }) {
  const anchorPrice = priceIn(anchorBasket, anchor);
  const nativePrice = priceIn(anchorBasket, native);
  return anchorPrice && nativePrice ? div(anchorPrice, nativePrice) : null;
}

// A basket prices its own unit from its own state.
function ownStateRoute(basket, native, anchor, nativeUsd) {
  if (reserveOf(basket, native)) {
    const price = priceIn(basket, native);
    return price && nativeUsd ? { usd: mul(price, nativeUsd), via: native } : null;
  }
  const price = priceIn(basket, anchor);
  return price ? { usd: price, via: anchor } : null;
}

// A reserve currency takes its price from the basket with the largest
// reserve of the reference currency (native first, then anchor).
// `toNative` converts that reserve to native units; the route needs at least
// `minReserve` native units (0 = no minimum).
function reserveRoute(currencyId, baskets, referenceId, referenceUsd, toNative, minReserve) {
  if (!referenceUsd) return null;
  let best = null;
  for (const basket of baskets) {
    const currencyPrice = priceIn(basket, currencyId);
    const reference = reserveOf(basket, referenceId);
    const referencePrice = positive(reference?.priceinreserve);
    const amount = positive(reference?.reserves);
    if (!currencyPrice || !referencePrice || !amount) continue;
    if (best && amount <= best.amount) continue;
    best = {
      amount,
      usd: mul(div(referencePrice, currencyPrice), referenceUsd),
      basket: basket.currencyid,
    };
  }
  if (!best) return null;
  const nativeReserve = toNative(best.amount);
  if (nativeReserve === null || nativeReserve < minReserve) return null;
  return { usd: best.usd, basket: best.basket, via: referenceId, nativeReserve };
}

/**
 * @param {object} input
 * @param {object[]} input.baskets  basket definitions with `bestcurrencystate`
 * @param {string} input.native     native coin id (on a PBaaS chain: the main chain's native)
 * @param {string} input.anchor     dollar anchor id (= 1 USD)
 * @param {string} [input.anchorBasket] basket that sets the native USD price
 * @param {bigint} [input.nativeUsd] native USD price when it comes from another chain
 * @param {number|string} [input.minRouteReserve] minimum native reserve of a reserve-route basket
 * @param {Map<string, string>} [input.bridges] PBaaS chain coin id -> its bridge basket id.
 *   Such a coin takes its price only from its bridge basket.
 * @returns {{ nativeUsd: bigint|null, prices: Map<string, {name: string, usd: bigint, route: object}> }}
 */
export function computePrices({
  baskets, native, anchor, anchorBasket, nativeUsd, minRouteReserve = 0, bridges = new Map(),
}) {
  const minReserve = parse(minRouteReserve);
  if (minReserve === null) throw new Error('minRouteReserve must be a non-negative decimal');
  const list = (Array.isArray(baskets) ? baskets : [])
    .filter((b) => b && typeof b === 'object' && typeof b.currencyid === 'string');

  const text = (value) => (typeof value === 'string' && value ? value : null);
  const names = new Map();
  for (const basket of list) {
    names.set(basket.currencyid, text(basket.fullyqualifiedname) ?? text(basket.name) ?? basket.currencyid);
  }
  for (const basket of list) {
    const map = basket.currencynames;
    if (!map || typeof map !== 'object') continue;
    for (const [id, name] of Object.entries(map)) {
      if (!names.has(id) && text(name)) names.set(id, name);
    }
  }
  const nameOf = (id) => names.get(id) ?? id;

  let usdNative = nativeUsd ?? null;
  if (usdNative === null && anchorBasket) {
    const basket = list.find((b) => b.currencyid === anchorBasket);
    usdNative = basket ? nativeUsdPrice(basket, { native, anchor }) : null;
  }

  const prices = new Map();
  const put = (id, usd, route) => {
    if (usd && usd > 0n) prices.set(id, { name: nameOf(id), usd, route });
  };

  put(anchor, ONE, { type: 'anchor' });
  if (anchorBasket && nativeUsd == null) {
    put(native, usdNative, { type: 'native', basket: anchorBasket, via: anchor });
  }

  const basketIds = new Set(list.map((b) => b.currencyid));
  for (const basket of list) {
    const id = basket.currencyid;
    if (id === native || id === anchor) continue;
    const route = ownStateRoute(basket, native, anchor, usdNative);
    if (route) put(id, route.usd, { type: 'basket', basket: id, via: route.via });
  }

  const reserveIds = new Set();
  for (const basket of list) {
    for (const reserve of liveReserves(basket)) {
      if (typeof reserve?.currencyid === 'string') reserveIds.add(reserve.currencyid);
    }
  }
  // An anchor reserve is worth anchor / nativeUsd native units (anchor = 1 USD).
  const anchorToNative = (amount) => (usdNative ? div(amount, usdNative) : null);
  for (const id of reserveIds) {
    if (id === native || id === anchor || basketIds.has(id)) continue;
    const bridge = bridges.get(id);
    const pool = bridge ? list.filter((b) => b.currencyid === bridge) : list;
    const route = reserveRoute(id, pool, native, usdNative, (amount) => amount, minReserve)
      || reserveRoute(id, pool, anchor, ONE, anchorToNative, minReserve);
    if (route) {
      put(id, route.usd, {
        type: 'reserve', basket: route.basket, via: route.via, nativeReserve: format(route.nativeReserve),
      });
    }
  }

  return { nativeUsd: usdNative, prices };
}
