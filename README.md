# verus-price-publisher

A small service that runs next to a Verus daemon (`verusd`). Once per new block it reads
the basket (fractional currency) states from the daemon's local RPC, computes a USD price
for each Verus currency, and writes one JSON file: `v1/prices.json`.

Wallets download that one file. The load on the node is constant: it does not grow with
the number of wallets.

- Plain JavaScript (Node.js 20 or newer). **No runtime dependencies**, no build step.
  About 750 lines in `src/`.
- Read-only RPC: an allow-list of five methods. Any other method is refused in code.
- RPC credentials come from the daemon conf file or environment variables. They are
  never logged and never written to the output.
- A thin basket cannot set the price of another currency: a reserve route needs at least
  `minRouteReserve` (default 1,000) native coins in the basket.
- **Frozen baskets look like quiet baskets.** On 2026-11-20 all 27 mainnet basket states
  were unchanged over blocks 4330959 to 4330965, and the 4 known baskets (Bridge.vETH,
  Pure, Kaiju, Switch) were also unchanged since block 4330936. The service cannot tell a
  frozen basket from one that simply had no conversions. It publishes the last on-chain
  price with a fresh block height.

### Basket discovery and its cost (read this first)

By default (`"baskets": "auto"`) the service finds the baskets itself: once per hour it
calls `listcurrencies {"systemtype":"local"}` and keeps every live local basket. Then each
new block costs **1 `getblockheader` + 1 `getcurrency` per live basket**, plus one
`getbestblockhash` every 10 s. On VRSC mainnet (27 live local baskets on 2026-11-20) that
is **28 calls per block, about 2,040 calls per hour**. On VRSCTEST (91 live baskets) it is
about 5,900 calls per hour.

To read only the baskets you choose, set a fixed list in the config file. Then
`listcurrencies` is never called and each block costs 1 + the number of listed baskets:

```json
"baskets": ["i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx", "iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY",
            "i9kVWKU2VwARALpbXn4RS9zvrhvNRaUibb", "i4Xr5TAMrDTD99H69EemhjDxJ4ktNskUtc"]
```

These are Bridge.vETH, Pure, Kaiju and Switch: 5 calls per block, about 660 calls per hour.
The anchor basket is always read, also when it is not in the list. See
[Node load](#node-load-measured) for the measurements.

## How it works

1. Every `pollSeconds` (default 10 s) the service calls `getbestblockhash`.
2. On a new block (and at most once per `minIntervalSeconds`, default 60 s) it runs a cycle:
   `getblockheader` for the height and time, then one `getcurrency` per basket.
3. The basket list comes from `listcurrencies {"systemtype":"local"}`, at most once per
   `basketListSeconds` (default 1 hour), because `listcurrencies` is expensive. It keeps
   fractional currencies that are not pre-launch and not refunding. You can also give a
   fixed list instead (`"baskets": [...]`); then `listcurrencies` is never called.
4. It computes all prices in one pass (see [Price rules](#price-rules)) and writes
   `v1/prices.json` atomically (temporary file, `fsync`, rename).
5. If any RPC call fails (also a single basket read), the cycle stops. No partial file is
   written. The last file stays as it is and its times do not move, so clients see the age
   and can stop showing the price. The next poll tries again. The service logs the first
   failure and the recovery, not every failed poll. An unknown id in a fixed `baskets` list
   therefore stops publishing until you fix the list.
6. After a restart the service serves the saved file (if it has the same schema, chain and
   anchor) and does not rewrite it until a new block arrives, so a restart does not make an
   old block look new.

## Node load (measured)

Measured against a VRSC mainnet daemon and a VRSCTEST daemon (Verus 1.2.18) on
2026-11-20, with the counters the service logs after each cycle (`calls {...}` in the log).

| | RPC calls |
|---|---|
| Start-up, once | 1 `getblockchaininfo` (checks the chain id) |
| Each poll | 1 `getbestblockhash` |
| Each cycle (new block) | 1 `getblockheader` + 1 `getcurrency` per basket |
| Basket list, at most once per hour | 1 `listcurrencies` |

| Chain, basket mode | Baskets | Calls per cycle | Calls per hour (1 block/min) | Cycle time |
|---|---|---|---|---|
| VRSC, `"auto"` | 27 live local | 28 | 360 + 60 × 28 + 1 = **2,041** | 560 to 950 ms |
| VRSC, fixed list of 4 | 4 | 5 | 360 + 60 × 5 = **660** | 190 ms |
| VRSCTEST, `"auto"` | 91 live local | 92 | 360 + 60 × 92 + 1 = **5,881** | 200 to 470 ms |

"Calls per cycle" does not count the poll that found the block. The first cycle after a
basket-list refresh also has the `listcurrencies` call (about 0.1 to 0.3 s more). The load
is the same for 1 wallet or 1 million.

To lower the load: raise `pollSeconds` or `minIntervalSeconds`, or set a fixed `baskets` list.

## Install

### Plain Node.js and systemd

```sh
sudo useradd --system --home /opt/verus-price-publisher verus   # or use the user that runs verusd
sudo git clone https://github.com/Meyse/verus-price-publisher.git /opt/verus-price-publisher
sudo mkdir -p /etc/verus-price-publisher /var/www/verus-prices
sudo cp /opt/verus-price-publisher/config.example.json /etc/verus-price-publisher/config.json
sudo chown verus /var/www/verus-prices
# Edit config.json: chain, rpc.conf, outDir.
sudo cp /opt/verus-price-publisher/deploy/verus-price-publisher.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now verus-price-publisher
journalctl -u verus-price-publisher -f
```

The service user must be able to read the daemon conf file (for the RPC credentials). If you
do not want that, leave out `rpc.conf` and set `VERUS_RPC_URL`, `VERUS_RPC_USER` and
`VERUS_RPC_PASSWORD` in an `EnvironmentFile=` with mode 600.

There is nothing to install with npm or pnpm. To run the tests: `node --test test/*.test.js`
(or `pnpm test`).

One run without the loop, for a check: `node src/main.js --config config.json --once`.

### Docker

```sh
docker build -t verus-price-publisher .
docker run -d --name verus-prices --network host \
  -v /home/verus/.komodo/VRSC/VRSC.conf:/run/VRSC.conf:ro \
  -v /var/www/verus-prices:/data \
  -e VERUS_RPC_CONF=/run/VRSC.conf \
  verus-price-publisher --chain VRSC
```

On Linux, `--network host` lets the container reach the daemon on `127.0.0.1`, and the
read-only conf mount gives it the credentials. The output goes to `/data` (`OUT_DIR`). To
use the built-in HTTP server in the container, add `-e HTTP_PORT=8080 -e HTTP_HOST=0.0.0.0`
and put it behind your reverse proxy. The data folder must be writable by the container's
`node` user (uid 1000).

On Docker Desktop (macOS, Windows), `--network host` does not reach the host's
`127.0.0.1` by default. Use `host.docker.internal` and pass the credentials in an env file
(mode 600), because the service sends conf-file credentials only to a local address:

```sh
# rpc.env holds two lines: VERUS_RPC_USER=... and VERUS_RPC_PASSWORD=...
docker run -d --name verus-prices --env-file rpc.env \
  -e VERUS_RPC_URL=http://host.docker.internal:27486 \
  -v /path/to/out:/data verus-price-publisher --chain VRSC
```

Environment variables are visible to anyone who can run `docker inspect` on the host.
The conf-file mount does not have that exposure.

## Configuration

All keys are optional. Without a config file, use `--chain VRSC` or `--chain VRSCTEST` and
the defaults.

| Key | Default | Meaning |
|---|---|---|
| `chain` | `VRSC` | Preset: `VRSC` or `VRSCTEST`. For another chain, also set `id`, `anchor`, `anchorBasket`. |
| `id` | from preset | i-address of the chain's native currency. |
| `testnet` | from preset | Copied into the file. |
| `anchor` | VRSC: DAI.vETH `iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM`; VRSCTEST: DAI.vETH `iN9vbHXexEh6GTZ45fRoJGKTQThfbgUwMh` | Currency counted as exactly 1 USD. |
| `anchorBasket` | VRSC: Bridge.vETH `i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx`; VRSCTEST: Bridge.vETH `iSojYsotVzXz4wh2eJriASGo6UidJDDhL2` | Basket that sets the native USD price. Always read. |
| `rpc.conf` | the daemon's default conf path (`~/.komodo/VRSC/VRSC.conf`, `~/.komodo/vrsctest/vrsctest.conf`) | Reads `rpcuser`, `rpcpassword`, `rpcport`, `rpchost`. |
| `rpc.url` | `http://<rpchost>:<rpcport>` | RPC URL. Credentials in the URL are refused. |
| `rpc.timeoutSeconds` | 15 | Timeout for one RPC call. |
| `baskets` | `"auto"` | `"auto"` (from `listcurrencies`) or a list of basket ids or names. Ids avoid a double read. |
| `outDir` | `./out` | The file goes to `<outDir>/v1/prices.json`. |
| `pollSeconds` | 10 | How often to check for a new block. |
| `minIntervalSeconds` | 60 | Minimum time between two cycles. |
| `basketListSeconds` | 3600 | How often to refresh the basket list (minimum 60). |
| `maxAgeSeconds` | 900 | Copied into the file as `maxAge`: the age after which clients should not show the prices. |
| `minRouteReserve` | 1000 | Minimum native reserve (in native coins, for example VRSC) of a basket that sets the price of a reserve currency (price rule 4). `0` turns it off. |
| `http` | `null` (off) | `{ "host": "127.0.0.1", "port": 8080 }` to serve the file from the service itself. |
| `pbaas` | `[]` | Extra PBaaS chains: `{ name, id, rpc, baskets }` each, see [PBaaS chains](#pbaas-chains). `rpc` takes `conf`, `url`, `timeoutSeconds` as for the main chain. |

Environment variables: `VERUS_CHAIN`, `VERUS_RPC_CONF`, `VERUS_RPC_URL`, `VERUS_RPC_USER`,
`VERUS_RPC_PASSWORD` (main chain only; the user and password override the conf file),
`OUT_DIR`, `HTTP_PORT`, `HTTP_HOST`.

### PBaaS chains

Add a `pbaas` entry per chain. Give the chain id and the bridge basket as a fixed list.
The ids are the same on every node; check them with `getcurrency vARRR` and
`getcurrency Bridge.vARRR` on your VRSC daemon.

| Chain | `id` | Bridge basket |
|---|---|---|
| vARRR | `iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2` | Bridge.vARRR `iD5WRg7jdQM1uuoVHsBCAEKfJCKGs1U3TB` |
| CHIPS | `iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP` | Bridge.CHIPS `i3nokiCTVevZMLpR3VmZ7YDfCqA5juUqqH` |
| vDEX | `iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N` | Bridge.vDEX `i6j1rzjgrDhSmUYiTtp21J8Msiudv5hgt9` |

**Recommended: your own PBaaS daemon.** Point `rpc.conf` at that chain's daemon conf file
(the credentials go only to a local address, as for the main chain):

```json
"pbaas": [
  { "name": "vARRR", "id": "iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2",
    "rpc": { "conf": "/path/to/the/vARRR/daemon.conf" },
    "baskets": ["iD5WRg7jdQM1uuoVHsBCAEKfJCKGs1U3TB"] }
]
```

With your own daemon you can also use `"baskets": "auto"`, which reads all live baskets of
that chain (one `listcurrencies` per hour there).

**Possible, not recommended: a public API.** The same entry with a public RPC URL and no
credentials:

```json
  { "name": "CHIPS", "id": "iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP",
    "rpc": { "url": "https://api.chips.cash/" },
    "baskets": ["i3nokiCTVevZMLpR3VmZ7YDfCqA5juUqqH"] }
```

This costs the public API **3 calls per VRSC block** (`getbestblockhash`, `getblockheader`,
1 `getcurrency`), about 180 calls per hour, plus 1 `getblockchaininfo` at start. Community
members host these APIs. Do not use `"auto"` there (it would call `listcurrencies`). Also,
the service cannot check data that comes from a server it does not run: a public API sets
those prices. Use your own daemon for a service that wallets rely on.

How the prices combine:

- The native USD price (VRSC) always comes from the main chain's anchor basket. A PBaaS
  basket gets a price only if it holds VRSC or the anchor. The `minRouteReserve` rule
  applies the same way.
- A currency that both chains price keeps the main chain's price. Example (2026-11-20):
  vARRR keeps 0.2301 from SUPER🛒 on VRSC (276,331 VRSC in reserve) instead of 0.2281 from
  Bridge.vARRR on vARRR (91,124 VRSC). CHIPS keeps 0.03370 instead of 0.03362.
- Prices from a PBaaS chain have `route.system` set to that chain's id. The file lists
  each PBaaS chain read in this cycle in `systems`.
- If a PBaaS chain fails, its prices are left out of that cycle, the other chains and the
  main chain still publish, and the service logs the failure once and the recovery once.
  The service checks each chain's `chainid` with `getblockchaininfo` and stops on a mismatch.

## Serving the file

Serve the output folder with your web server. Keep the cache short (blocks come about once
per minute) and allow any origin, because wallets and web pages read the file.

nginx:

```nginx
location = /v1/prices.json {
    root /var/www/verus-prices;
    add_header Cache-Control "public, max-age=30" always;
    add_header Access-Control-Allow-Origin "*" always;
    limit_except GET { deny all; }   # GET also allows HEAD
}
```

Caddy:

```caddy
prices.example.org {
    @file path /v1/prices.json
    handle @file {
        root * /var/www/verus-prices
        header Cache-Control "public, max-age=30"
        header Access-Control-Allow-Origin "*"
        file_server
    }
    handle {
        respond 404
    }
}
```

Or turn on the built-in server (`http` in the config) and proxy to it. It serves only
`/v1/prices.json`, only for GET and HEAD (other methods get 405), with
`Cache-Control: public, max-age=30` and `Access-Control-Allow-Origin: *`. It binds to
`127.0.0.1` by default. It answers 503 until the first file exists.

## Output schema (v1)

```json
{
  "schemaVersion": 1,
  "chain": { "name": "VRSC", "id": "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV", "testnet": false },
  "height": 4330936,
  "blockHash": "…",
  "blockTime": 1795182512,
  "generatedAt": 1795182540,
  "maxAge": 900,
  "quote": "USD",
  "anchor": { "currency": "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM", "basket": "i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx" },
  "prices": {
    "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV": {
      "name": "VRSC", "usd": "0.636937365967",
      "route": { "type": "native", "basket": "i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx", "via": "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM" }
    },
    "iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY": {
      "name": "Pure", "usd": "4.08808074546",
      "route": { "type": "basket", "basket": "iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY", "via": "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV" }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | 1. A breaking change gets a new number and a new path (`v2/`). |
| `chain` | The chain whose daemon produced the file. |
| `height`, `blockHash`, `blockTime` | The block the states were read at. `blockTime` is Unix seconds. |
| `generatedAt` | Unix seconds when the file was written. |
| `maxAge` | Seconds. A client should not show prices when `now - generatedAt > maxAge`. |
| `quote` | Always `USD`. |
| `anchor` | The currency counted as 1 USD and the basket that sets the native price. |
| `prices` | Map of currency i-address to `{ name, usd, route }`. Only currencies with a price are in the map. |
| `usd` | Decimal string, at most 12 significant digits, no exponent. |
| `route.type` | `anchor` (fixed 1), `native` (from the anchor basket), `basket` (the basket's own state), `reserve` (a reserve of `route.basket`). |
| `route.basket` | The basket whose state gave the price. |
| `route.via` | The reference currency: the native coin or the anchor. |
| `route.nativeReserve` | Only for `reserve` routes: the route basket's reserve in native units, a decimal string (12 significant digits). A wallet can apply a stricter limit than `minRouteReserve`. |
| `route.system` | Only for prices from a PBaaS chain: that chain's id. |
| `systems` | Only when PBaaS chains are configured: `{ name, id, height, blockTime }` for each chain read in this cycle. |

## Price rules

Ported from Verus Mobile (`onChainPriceMath.js`). Uses
`bestcurrencystate.reservecurrencies[].priceinreserve`, the price of one basket unit in
that reserve. The math uses decimal fixed-point numbers (BigInt, 24 decimals). The inputs
come from JSON numbers, so they keep about 15 to 16 significant digits (the daemon sends
8 decimals; a value above about 10^7 can lose its last satoshi digit).

1. Native USD = `priceinreserve[anchor] / priceinreserve[native]` in the anchor basket.
2. The anchor = 1 USD.
3. A basket: if it holds the native, USD = `priceinreserve[native] × native USD`; else if
   it holds the anchor, USD = `priceinreserve[anchor]`; else no price.
4. Any other reserve currency C: of the baskets that hold C and the native, take the one
   with the largest native reserve; USD = `priceinreserve[native] / priceinreserve[C] × native USD`.
   If none holds the native, use the basket with the largest anchor reserve the same way.
   The chosen basket must hold at least `minRouteReserve` native units (default 1,000).
   For an anchor route the anchor reserve counts as `anchor reserve / native USD` native
   units. If the largest basket is too thin, C gets no price. This rule does not apply to
   rules 1 to 3. `0` turns it off.
5. Bad data gives no price and no error: zero, negative, missing or non-numeric
   `priceinreserve`, zero supply, pre-launch or refunding baskets.
6. Only baskets whose `systemid` is the chain itself are used. A basket from another
   chain (for example Bridge.vARRR on VRSC) has an imported copy of its state that can be
   older than the state on its own chain.

## Security notes

- The RPC client (`src/rpc.js`) has a fixed allow-list: `getblockchaininfo`,
  `getbestblockhash`, `getblockheader`, `getcurrency`, `listcurrencies`. It refuses every
  other method before any network request. No wallet method is on the list.
- Credentials stay inside the RPC client and go only into the `Authorization` header.
  Error messages hold the method name and the daemon's error text, never the request.
  Credentials in `rpc.url` are refused. Redirects are refused. The conf file's credentials
  are sent only to `127.0.0.1`, `localhost`, `::1` or the conf's own `rpchost`; for another
  host the service stops at start-up unless `VERUS_RPC_USER` and `VERUS_RPC_PASSWORD` are set. `.gitignore` excludes `config.json`, `*.local.json`
  and `*.conf`.
- At start-up the service checks that the daemon's `chainid` is the configured chain and
  stops if it is not. A reply without a `chainid` counts as a failed call.
- The built-in HTTP server serves one in-memory file. It reads no paths from the request.
- The output holds only public chain data.

## Verification status

- Unit and integration tests: `node --test test/*.test.js` (price math against the
  2026-11-01 worked example, bad data, the allow-list, the publish/failure/recovery cycle
  against a fake daemon, the HTTP server).
- Live: VRSCTEST daemon on 2026-11-20, several new blocks. VRSCTEST, DAI.vETH and
  Bridge.vETH prices checked by hand against the raw Bridge.vETH basket state.
- Mainnet, public API: one single run against `https://api.verus.services` with the fixed
  basket list, no `listcurrencies`. All 12 VRSC-chain prices matched the 2026-11-01 worked
  example within 0.1 %.
- Mainnet, local daemon, 2026-11-20: `"auto"` for 4 cycles (heights 4330959 to 4330965;
  27 live local baskets, 50 prices). VRSC, Bridge.vETH, vETH, CHIPS, vUSDC.vETH and SUPER🛒
  checked by hand against raw `getcurrency` output: equal to 12 significant digits. A run
  with the fixed list of 4 gave the same 12 prices as the public API run.
- In "auto" mode some reserve prices come from a different basket than with the fixed list,
  because a basket with a larger VRSC reserve holds them: vETH (NATI🦉, −0.08 %),
  vUSDC.vETH (Floralis, −0.41 %), vUSDT.vETH (Floralis, +0.05 %), EURC.vETH (Floralis, −0.03 %).
- Basket states on 2026-11-20: all 27 mainnet basket states (reserves, prices, supply and
  conversion fields) were identical at blocks 4330959, 4330961, 4330963 and 4330965. The 4
  known baskets were also identical to the public API read at block 4330936. The other 23
  were not read at 4330936. The prices did not move (frozen baskets).
- `minRouteReserve` 1,000 on mainnet (block 4330974 and one new block): 41 prices instead of
  50, no other price changed. The 9 without a price: Bears, Bulls (Traders, 336 VRSC),
  bitcoins (🟠, 100 VRSC), Bridge.CHIPS, Bridge.vARRR, Bridge.vDEX (Ⓐ, 307 VRSC),
  pepecoin.vETH (Kek🐸, 535 VRSC), vLINK.vETH, vwBTC.vETH (motb, 715 VRSC). On VRSCTEST:
  111 prices instead of 137.
- Docker (Docker Desktop 29.9.3 on macOS, 2026-11-20): the image builds (node:22-alpine,
  234 MB, only `src/`, `package.json` and `LICENSE`, runs as uid 1000). A container against a
  VRSCTEST daemon through `host.docker.internal` with an env file published a new block
  (1326866, 111 prices) to `/data/v1/prices.json` and served it (200, CORS,
  `Cache-Control`; POST got 405). On Docker Desktop, `--network host` could not reach the host,
  and the conf-file credentials were refused for `host.docker.internal` as designed. The
  Linux `--network host` command above is not verified.
- PBaaS (2026-11-20): main chain on a local VRSC daemon, vARRR and CHIPS through their
  public APIs with the bridge basket as a fixed list. This added Bridge.vARRR 3.02946362688
  and Bridge.CHIPS 0.172678554268 (both equal to a hand calculation from the raw states;
  the 2026-11-01 table has 3.029 and 0.173). 43 prices instead of 41. Each public API got
  4 calls in the first cycle (3 per block after that). The vDEX API answered HTTP 502 from
  its CDN at the time, so vDEX was left out and the rest published. A test with one PBaaS
  chain on a dead address: the main chain and the other chains published, one warning.
- Not verified: a PBaaS chain on its own local daemon (`rpc.conf`), `"auto"` on a PBaaS
  chain, vDEX, systemd unit.
- Known limit: the header is read before the baskets. If a new block arrives during the
  reads (under a second), some states can be one block newer than `height`. This was seen
  once on mainnet (2 of 27 states one block newer); the states were unchanged.
- Thin baskets: without the minimum, Ⓐ (307 VRSC in reserve) priced Bridge.vARRR at 2.83
  (3.03 on its own chain) and Bridge.vDEX at 3.47 (3.27), and motb (715 VRSC) priced
  vwBTC.vETH at 52,388 (tBTC.vETH: 65,556). With the default of 1,000 VRSC these get no
  price. Bridge.vARRR, Bridge.CHIPS and Bridge.vDEX then need a `pbaas` entry for their
  chain (best with an own daemon, see [PBaaS chains](#pbaas-chains)) for a price. A basket's own price (rule 3) has no minimum, so a thin
  basket still shows a price for its own unit.

## Open questions for the Verus developers

- Is one published price file acceptable? Who hosts it, and on which domain?
- Anchor rule: is DAI.vETH = 1 USD acceptable?
- Frozen baskets: on 2026-11-20 every mainnet basket state was unchanged over the blocks of
  the test (all 27 over blocks 4330959 to 4330965; the 4 known baskets since 4330936). The
  service cannot tell a frozen basket from a quiet one, so it publishes the last on-chain
  price with a fresh block height. Is that acceptable, or must the daemon expose a
  "conversions disabled" state the service can read?
- Which PBaaS chains must it cover at the start? Should a VRSC-only node use the imported
  states of Bridge.vARRR, Bridge.CHIPS and Bridge.vDEX (close to, but behind, the PBaaS
  chain's own state), or must each PBaaS chain have its own daemon?
- Is about 28 `getcurrency` calls per block on mainnet (about 2,040 calls per hour)
  acceptable, or should the default be a fixed basket list?
- Is 1,000 VRSC the right default for `minRouteReserve`? It removes 9 of 50 mainnet prices.
  Should a basket's own price (rule 3) also need a minimum? On mainnet that would remove 11
  more (all baskets under 1,000 VRSC).

## License

MIT, see [LICENSE](LICENSE).
