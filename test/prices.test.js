import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computePrices } from '../src/prices.js';
import { format } from '../src/decimal.js';

const VRSC = 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV';
const DAI = 'iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM';
const BRIDGE_VETH = 'i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx';
const mainnet = JSON.parse(readFileSync(new URL('./fixtures/vrsc-mainnet-baskets.json', import.meta.url)));
const localBaskets = mainnet.baskets.filter((b) => b.systemid === VRSC);

const usdByName = (prices) => Object.fromEntries(
  [...prices.values()].map((p) => [p.name, Number(format(p.usd))]),
);

test('recorded mainnet basket states give the hand-calculated prices (within 0.5 %)', () => {
  const { prices } = computePrices({
    baskets: localBaskets, native: VRSC, anchor: DAI, anchorBasket: BRIDGE_VETH,
  });
  // Expected values were calculated by hand from mainnet basket states.
  const expected = {
    VRSC: 0.6369,
    'DAI.vETH': 1,
    'Bridge.vETH': 11.763,
    Pure: 4.088,
    Switch: 1.836,
    Kaiju: 1.020,
    'tBTC.vETH': 65556,
    vETH: 1929.25,
    'MKR.vETH': 1489.19,
    'vUSDC.vETH': 1.0023,
    'EURC.vETH': 1.1378,
    'vUSDT.vETH': 0.9982,
  };
  const actual = usdByName(prices);
  for (const [name, usd] of Object.entries(expected)) {
    assert.ok(name in actual, `${name} has a price`);
    assert.ok(Math.abs(actual[name] / usd - 1) < 0.005, `${name}: ${actual[name]} vs ${usd}`);
  }
  // Exact hand calculation with bc -l on the fixture values:
  // VRSC = 11.76339915 / 18.46869061; vETH = 11.76339915 / 0.0060974 (Bridge.vETH);
  // tBTC.vETH = 6.41834027 / 0.00006236 * VRSC (Pure, the largest VRSC reserve).
  assert.equal(format(prices.get(VRSC).usd), '0.636937365967');
  assert.equal(actual.vETH, 1929.24839276);
  assert.equal(actual['tBTC.vETH'], 65556.1376757);
  assert.equal(prices.get('iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY').route.type, 'basket');
});

const N = 'iNATIVE';
const A = 'iANCHOR';
const T = 'iTOKEN';
const basket = (id, reserves, state = {}) => ({
  currencyid: id,
  fullyqualifiedname: id,
  bestcurrencystate: { flags: 49, supply: 1000, reservecurrencies: reserves, ...state },
});
const reserve = (currencyid, priceinreserve, reserves = 100) => ({ currencyid, priceinreserve, reserves });
const anchorBasket = basket('iANCHORBASKET', [reserve(N, 0.5), reserve(A, 2)]); // native = 4 USD

test('a reserve currency takes its price from the basket with the largest native reserve', () => {
  const small = basket('iSMALL', [reserve(N, 1, 10), reserve(T, 0.01)]); // T = 100 native
  const large = basket('iLARGE', [reserve(N, 1, 5000), reserve(T, 0.5)]); // T = 2 native
  const { prices } = computePrices({
    baskets: [anchorBasket, small, large], native: N, anchor: A, anchorBasket: 'iANCHORBASKET',
  });
  assert.equal(format(prices.get(T).usd), '8'); // 2 native * 4 USD
  assert.equal(prices.get(T).route.basket, 'iLARGE');
});

test('a thin basket does not set a reserve price; 0 turns the minimum off', () => {
  const thin = basket('iTHIN', [reserve(N, 1, 10), reserve(T, 0.01)]); // T = 100 native = 400 USD
  const thick = basket('iTHICK', [reserve(N, 1, 5000), reserve(T, 0.5)]); // T = 2 native = 8 USD
  const run = (baskets, minRouteReserve) => computePrices({
    baskets: [anchorBasket, ...baskets], native: N, anchor: A, anchorBasket: 'iANCHORBASKET', minRouteReserve,
  }).prices;

  const thinOnly = run([thin], 1000);
  assert.equal(thinOnly.has(T), false);
  assert.equal(format(thinOnly.get('iTHIN').usd), '4'); // the basket's own price stays: 1 native * 4 USD
  assert.equal(format(run([thin], 0).get(T).usd), '400');

  const both = run([thin, thick], 1000).get(T);
  assert.equal(format(both.usd), '8');
  assert.deepEqual(both.route, { type: 'reserve', basket: 'iTHICK', via: N, nativeReserve: '5000' });

  // Anchor route: 8000 anchor units at 4 USD per native = 2000 native; 2000 units = 500 native.
  const anchorRich = basket('iUSD8000', [reserve(A, 1, 8000), reserve(T, 0.25)]); // T = 4 USD
  const anchorThin = basket('iUSD2000', [reserve(A, 1, 2000), reserve(T, 0.25)]);
  assert.equal(format(run([anchorRich], 1000).get(T).usd), '4');
  assert.equal(run([anchorRich], 1000).get(T).route.nativeReserve, '2000');
  assert.equal(run([anchorThin], 1000).has(T), false);
});

test('bad basket data gives no price and does not throw', () => {
  const cases = {
    zeroPrice: basket('iB1', [reserve(N, 1), reserve(T, 0)]),
    missingPrice: basket('iB2', [reserve(N, 1), { currencyid: T, reserves: 5 }]),
    negativePrice: basket('iB3', [reserve(N, 1), reserve(T, -1)]),
    textPrice: basket('iB4', [reserve(N, 1), reserve(T, 'abc')]),
    nanPrice: basket('iB5', [reserve(N, 1), reserve(T, Number.NaN)]),
    zeroSupply: basket('iB6', [reserve(N, 1), reserve(T, 1)], { supply: 0 }),
    prelaunch: basket('iB7', [reserve(N, 1), reserve(T, 1)], { flags: 1 | 2 }),
    refunding: basket('iB8', [reserve(N, 1), reserve(T, 1)], { flags: 1 | 4 }),
    noReserveList: basket('iB9', 'not a list'),
    noState: { currencyid: 'iB10' },
    textFlags: basket('iB11', [reserve(N, 1), reserve(T, 1)], { flags: 'unknown' }),
  };
  const oddName = { ...basket('iODD', [reserve(N, 1)]), fullyqualifiedname: { x: 1 } };
  for (const [name, bad] of Object.entries(cases)) {
    const { prices } = computePrices({
      baskets: [anchorBasket, bad, null, 7, oddName], native: N, anchor: A, anchorBasket: 'iANCHORBASKET',
    });
    assert.equal(prices.get('iODD').name, 'iODD');
    assert.equal(prices.has(T), false, `${name}: token has no price`);
    if (!['zeroPrice', 'missingPrice', 'negativePrice', 'textPrice', 'nanPrice'].includes(name)) {
      assert.equal(prices.has(bad.currencyid), false, `${name}: basket has no price`);
    }
    assert.equal(format(prices.get(N).usd), '4', `${name}: native still priced`);
  }

  const broken = basket('iANCHORBASKET', [reserve(N, 0), reserve(A, 2)]);
  const { prices, nativeUsd } = computePrices({
    baskets: [broken, basket('iB', [reserve(N, 1), reserve(T, 1)])],
    native: N,
    anchor: A,
    anchorBasket: 'iANCHORBASKET',
  });
  assert.equal(nativeUsd, null);
  assert.deepEqual([...prices.keys()], [A]); // only the anchor itself
});

test('the VRSCTEST preset prices through DAI.vETH in Bridge.vETH', async () => {
  const { loadConfig } = await import('../src/config.js');
  const { chain } = loadConfig({ chain: 'VRSCTEST', env: { VERUS_RPC_URL: 'http://127.0.0.1:1' } });
  const testnet = JSON.parse(readFileSync(new URL('./fixtures/vrsctest-bridge-veth.json', import.meta.url)));
  const { prices } = computePrices({
    baskets: testnet.baskets, native: chain.id, anchor: chain.anchor, anchorBasket: chain.anchorBasket,
  });
  // Hand calculation with bc -l: VRSCTEST = 7.09025643 / 13.19790409;
  // vETH = 13.19790409 / 0.00346814 * VRSCTEST.
  assert.equal(format(prices.get(chain.id).usd), '0.537225939941');
  assert.equal(format(prices.get(chain.anchor).usd), '1');
  assert.equal(format(prices.get(chain.anchorBasket).usd), '7.09025643');
  assert.equal(format(prices.get('iCtawpxUiCc2sEupt7Z4u8SDAncGZpgSKm').usd), '2044.39740899');
});

test('a PBaaS chain coin takes its price only from its own bridge basket', () => {
  const C = 'iCHAINCOIN';
  const big = basket('iBIG', [reserve(N, 1, 100000), reserve(C, 0.5)]); // C = 2 native = 8 USD
  const bridge = basket('iBRIDGE', [reserve(N, 1, 5000), reserve(C, 0.25)]); // C = 4 native = 16 USD
  const thinBridge = basket('iBRIDGE', [reserve(N, 1, 10), reserve(C, 0.25)]);
  const bridges = new Map([[C, 'iBRIDGE']]);
  const run = (list, map) => computePrices({
    baskets: [anchorBasket, ...list], native: N, anchor: A, anchorBasket: 'iANCHORBASKET', minRouteReserve: 1000, bridges: map,
  }).prices;

  assert.equal(format(run([big, bridge]).get(C).usd), '8'); // without the rule: largest reserve
  const viaBridge = run([big, bridge], bridges).get(C);
  assert.equal(format(viaBridge.usd), '16');
  assert.equal(viaBridge.route.basket, 'iBRIDGE');
  assert.equal(run([big], bridges).has(C), false); // bridge not read (main chain): no price
  assert.equal(run([big, thinBridge], bridges).has(C), false); // 10 native < 1000
});
