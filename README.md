# verus-price-publisher

A small service that runs next to a Verus daemon (`verusd`). Once per new block it reads
the basket (fractional currency) states from the daemon's local RPC, computes a USD price
for each Verus currency, and writes one JSON file: `v1/prices.json`. It also keeps a price
history in three files: `v1/history/hour.json`, `day.json` and `week.json`.

Wallets download these files. The load on the node is constant: it does not grow with
the number of wallets.

- Plain JavaScript (Node.js 20 or newer). **No runtime dependencies**, no build step.
  About 1,050 lines in `src/`.
- Read-only RPC: an allow-list of five methods. Any other method is refused in code.
- RPC credentials come from the daemon conf file or environment variables. They are
  never logged and never written to the output.
- A thin basket cannot set the price of another currency: a reserve route needs at least
  `minRouteReserve` (default 1,000) native coins in the basket.
- PBaaS chain coins (vARRR, CHIPS, vDEX) take their price only from their own bridge
  basket on their own chain. They need a `pbaas` entry; see [PBaaS chains](#pbaas-chains).

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
7. Price history (on by default, `"history": false` turns it off). After each successful
   cycle the service checks three UTC slots: the full hour, the day (00:00) and the week
   (Monday 00:00). The first successful cycle in a new slot adds one sample to that
   slot's file: the slot start, the block height, the block time and the price of each
   currency. Other cycles in the same slot add nothing. Nothing is interpolated: a slot in
   which the service did not run, or every cycle failed, has no sample.
8. The history files are the state. At start the service reads them and continues; a
   slot that already has a sample does not get a second one. Each write is atomic. A
   file for another chain, another anchor or another schema, or a damaged file, is renamed
   to `<file>.replaced-<unix time>` (never deleted), a new file starts, and the service
   logs this once. A failed cycle records nothing. A cycle whose block time is more than
   2 hours from the clock records nothing (the daemon is still syncing, or the clock is
   wrong). If the clock goes back, no sample is added until it passes the last slot.

## Node load (measured)

Measured against a VRSC mainnet daemon and a VRSCTEST daemon (Verus 1.2.18) on
2026-11-20, with the counters the service logs after each cycle (`calls {...}` in the log).

| | RPC calls |
|---|---|
| Start-up, once | 1 `getblockchaininfo` (checks the chain id) |
| Each poll | 1 `getbestblockhash` |
| Each cycle (new block) | 1 `getblockheader` + 1 `getcurrency` per basket |
| Basket list, at most once per hour | 1 `listcurrencies` (local baskets) + 1 `listcurrencies` (PBaaS chains); with a fixed list: 1 `getcurrency` per `pbaas` entry |

| Chain, basket mode | Baskets | Calls per cycle | Calls per hour (1 block/min) | Cycle time |
|---|---|---|---|---|
| VRSC, `"auto"` | 27 live local | 28 | 360 + 60 × 28 + 2 = **2,042** | 560 to 950 ms |
| VRSC, fixed list of 4 | 4 | 5 | 360 + 60 × 5 = **660** | 190 ms |
| VRSCTEST, `"auto"` | 91 live local | 92 | 360 + 60 × 92 + 2 = **5,882** | 200 to 470 ms |

"Calls per cycle" does not count the poll that found the block. The first cycle after a
basket-list refresh also has the `listcurrencies` call (about 0.1 to 0.3 s more). The load
is the same for 1 wallet or 1 million.

The price history makes **zero extra RPC calls**. It uses the prices that the cycle
already computed. Its only cost is one small file write per slot (24 hourly, 1 daily and
at most 1 weekly write per day).

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
| `history` | `true` | Keep the price history files under `<outDir>/v1/history/`. `false` turns it off. |
| `historyRetentionDays` | `{ "hour": 7, "day": 400, "week": 0 }` | How many days of samples each history file keeps. Older samples are removed. `0` = no limit. |
| `http` | `null` (off) | `{ "host": "127.0.0.1", "port": 8080 }` to serve the files from the service itself. |
| `pbaas` | `[]` | Extra PBaaS chains: `{ name, id, rpc }` each, optional `baskets` (default: only the chain's bridge basket). See [PBaaS chains](#pbaas-chains). `rpc` takes `conf`, `url`, `timeoutSeconds` as for the main chain. |

Environment variables: `VERUS_CHAIN`, `VERUS_RPC_CONF`, `VERUS_RPC_URL`, `VERUS_RPC_USER`,
`VERUS_RPC_PASSWORD` (main chain only; the user and password override the conf file),
`OUT_DIR`, `HTTP_PORT`, `HTTP_HOST`.

### PBaaS chains

**The coin of a PBaaS chain (vARRR, CHIPS, vDEX, …) takes its USD price only from that
chain's own bridge basket, read on that chain.** So add a `pbaas` entry per chain. Without
an entry, the chain's coin and its bridge basket have no price. The main chain holds only an
imported copy of each bridge basket, and the service does not use it (see below).

An entry needs `name`, `id` and `rpc`. The service finds the bridge basket from chain data
(`gatewayconverterid` of the chain definition) and reads only that basket on the PBaaS
chain. The ids are the same on every node:

| Chain | `id` | Bridge basket (found automatically) |
|---|---|---|
| vARRR | `iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2` | Bridge.vARRR `iD5WRg7jdQM1uuoVHsBCAEKfJCKGs1U3TB` |
| CHIPS | `iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP` | Bridge.CHIPS `i3nokiCTVevZMLpR3VmZ7YDfCqA5juUqqH` |
| vDEX | `iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N` | Bridge.vDEX `i6j1rzjgrDhSmUYiTtp21J8Msiudv5hgt9` |

**Recommended: your own PBaaS daemon.** Point `rpc.conf` at that chain's daemon conf file
(the credentials go only to a local address, as for the main chain):

```json
"pbaas": [
  { "name": "vARRR", "id": "iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2",
    "rpc": { "conf": "/path/to/the/vARRR/daemon.conf" } }
]
```

With your own daemon you can add `"baskets": "auto"` to also read the other live baskets of
that chain (one `listcurrencies` per hour there). A list of ids works as for the main chain.

**Possible, not recommended: a public API.** The same entry with a public RPC URL and no
credentials:

```json
  { "name": "CHIPS", "id": "iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP",
    "rpc": { "url": "https://api.chips.cash/" } }
```

This costs the public API **3 calls per VRSC block** (`getbestblockhash`, `getblockheader`,
1 `getcurrency`), about 180 calls per hour, plus 1 `getblockchaininfo` at start. Community
members host these APIs. Do not use `"auto"` there (it would call `listcurrencies`). Also,
the service cannot check data that comes from a server it does not run: a public API sets
those prices. Use your own daemon for a service that wallets rely on.

How the prices combine:

- The native USD price (VRSC) always comes from the main chain's anchor basket. A PBaaS
  basket gets a price only if it holds VRSC or the anchor. The `minRouteReserve` rule
  applies the same way, also to the bridge route of the chain's coin.
- The list of PBaaS chains and their bridges comes from the main chain, at most once per
  `basketListSeconds`: with `"baskets": "auto"` from one `listcurrencies
  {"systemtype":"pbaas"}` (all PBaaS chains the main chain knows); with a fixed list from
  one `getcurrency` per configured chain. With a fixed list, the rule covers only the
  configured chains.
- Any other currency that both chains price keeps the main chain's price.
- Prices from a PBaaS chain have `route.system` set to that chain's id. The file lists
  each PBaaS chain read in this cycle in `systems`.
- If a PBaaS chain fails, its prices (also its coin) are left out of that cycle, the other
  chains and the main chain still publish, and the service logs the failure once and the
  recovery once. The service checks each chain's `chainid` with `getblockchaininfo` and
  stops on a mismatch.

Why not the imported copy on the main chain: the main chain's copy of a bridge basket
carries a height of the PBaaS chain (`bestheight`) and no time. The service cannot know the
age of that state, so it does not use it.

## Serving the file

Serve the four files with your web server, and only these four: the history folder can
also hold `.replaced-*` files. Allow any origin, because wallets and web pages read the
files. Cache times:

| Path | Changes | `Cache-Control` |
|---|---|---|
| `/v1/prices.json` | each block (about 1 per minute) | `public, max-age=30` |
| `/v1/history/hour.json` | once per hour | `public, max-age=300` |
| `/v1/history/day.json`, `/v1/history/week.json` | once per day or week | `public, max-age=3600` |

Turn on gzip for JSON: the history files are about 2.5 times smaller with it (see
[Price history](#price-history-v1)).

nginx:

```nginx
gzip on;
gzip_types application/json;

location = /v1/prices.json {
    root /var/www/verus-prices;
    add_header Cache-Control "public, max-age=30" always;
    add_header Access-Control-Allow-Origin "*" always;
    limit_except GET { deny all; }   # GET also allows HEAD
}
location = /v1/history/hour.json {
    root /var/www/verus-prices;
    add_header Cache-Control "public, max-age=300" always;
    add_header Access-Control-Allow-Origin "*" always;
    limit_except GET { deny all; }
}
location ~ ^/v1/history/(day|week)\.json$ {
    root /var/www/verus-prices;
    add_header Cache-Control "public, max-age=3600" always;
    add_header Access-Control-Allow-Origin "*" always;
    limit_except GET { deny all; }
}
```

Caddy:

```caddy
prices.example.org {
    root * /var/www/verus-prices
    encode gzip
    @files path /v1/prices.json /v1/history/hour.json /v1/history/day.json /v1/history/week.json
    handle @files {
        header Access-Control-Allow-Origin "*"
        header /v1/prices.json Cache-Control "public, max-age=30"
        header /v1/history/hour.json Cache-Control "public, max-age=300"
        header /v1/history/day.json Cache-Control "public, max-age=3600"
        header /v1/history/week.json Cache-Control "public, max-age=3600"
        file_server
    }
    handle {
        respond 404
    }
}
```

Or turn on the built-in server (`http` in the config) and proxy to it. It serves only
these four fixed paths, only for GET and HEAD (other methods get 405, other paths 404),
with the `Cache-Control` values above and `Access-Control-Allow-Origin: *`. It serves the
files from memory and does not compress them, so let the proxy add gzip. It binds to
`127.0.0.1` by default. A path answers 503 until its first file exists. With
`"history": false` the history paths answer 404.

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
| `route.system` | Only for prices from a PBaaS chain: that chain's id. A PBaaS coin has type `reserve`, `basket` = its bridge basket, and `system` set. |
| `systems` | Only when PBaaS chains are configured: `{ name, id, height, blockTime }` for each chain read in this cycle. |

## Price history (v1)

Three files, one per resolution. Each file holds every currency, so one download serves
all charts of a wallet.

| File | Slot | Kept (default) | Size at full retention, 50 currencies (plain / gzip) |
|---|---|---|---|
| `v1/history/hour.json` | full UTC hour | 7 days (168 samples) | 86 KB / 34 KB |
| `v1/history/day.json` | UTC day, from 00:00 | 400 days | 198 KB / 75 KB |
| `v1/history/week.json` | UTC week, from Monday 00:00 | no limit | 256 KB / 97 KB after 10 years (520 samples) |

The sizes were measured with the 50 currencies of a VRSC mainnet price file and a random
price walk (a random walk compresses worse than real prices). Each file grows by about
0.5 KB (plain) per sample for 50 currencies.

```json
{
  "schemaVersion": 1,
  "resolution": "hour",
  "chain": { "name": "VRSC", "id": "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV", "testnet": false },
  "anchor": { "currency": "iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM", "basket": "i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx" },
  "quote": "USD",
  "time": [1795183200, 1795186800, 1795194000],
  "height": [4330951, 4331012, 4331130],
  "blockTime": [1795183243, 1795186839, 1795194018],
  "names": { "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV": "VRSC", "iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY": "Pure" },
  "usd": {
    "i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV": [0.636937, 0.641203, 0.63815],
    "iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY": [null, 4.10221, 4.08808]
  }
}
```

(Example values. The real file is written without spaces or line breaks.)

| Field | Meaning |
|---|---|
| `schemaVersion` | 1. A breaking change gets a new number and a new path. |
| `resolution` | `hour`, `day` or `week`. |
| `chain`, `anchor`, `quote` | As in `prices.json`. A change of chain or anchor starts a new file. |
| `time` | The shared time axis: slot starts in Unix seconds (UTC), strictly increasing. |
| `height`, `blockTime` | For each sample: the block the prices come from, and its time. |
| `names` | Currency i-address to name, for each currency in `usd`. |
| `usd` | Currency i-address to an array of the same length as `time`. Each value is the USD price in that sample, a JSON number with 6 significant digits, or `null` when the currency had no price in that sample. A currency with no price in any kept sample is not in the map. |

### Reading the history

For wallet and app developers:

- Pick the file by chart range: `hour.json` for 1 day to 7 days, `day.json` for 1 month
  to 1 year, `week.json` for longer ranges ("all").
- `usd[id][i]` is the price at `time[i]`. Use the same i-address keys as in
  `prices.json`. For the current price, use `prices.json`: it has more digits and changes
  each block.
- `null` means "no price in this sample". The currency did not exist yet, or the price
  rules gave it no price at that time (for example a basket under `minRouteReserve`).
  Draw a gap. Do not draw it as 0.
- A missing slot is a step in `time` that is larger than the resolution (3,600, 86,400 or
  604,800 seconds). The service was not running, or its cycles failed. The file does not
  fill such slots. Show a gap, or join the points and mark the gap.
- A sample is taken at the first cycle in its slot. Usually that is the first block after
  the slot start. After a start or an outage it can be later in the slot. `blockTime`
  shows when the price was read.
- All prices are in USD (the `anchor` currency counts as 1 USD). There is no other quote
  currency. To show
  another currency, convert on the client.
- Check `chain.id` and `anchor` before you use a file.
- Ask for gzip (`Accept-Encoding: gzip`); most HTTP clients do this by default.

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
7. The coin of a PBaaS chain uses rule 4 with one basket only: its bridge basket
   (`gatewayconverterid`), read on the PBaaS chain. A larger basket on the main chain does
   not count. Without a working `pbaas` entry the coin has no price.

## Security notes

- The RPC client (`src/rpc.js`) has a fixed allow-list: `getblockchaininfo`,
  `getbestblockhash`, `getblockheader`, `getcurrency`, `listcurrencies`. It refuses every
  other method before any network request. No wallet method is on the list.
- Credentials stay inside the RPC client and go only into the `Authorization` header.
  Error messages hold the method name and the daemon's error text, never the request.
  Credentials in `rpc.url` are refused. Redirects are refused. The conf file's credentials
  are sent only to `127.0.0.1`, `localhost`, `::1` or the conf's own `rpchost`; for another
  host the service stops at start-up unless `VERUS_RPC_USER` and `VERUS_RPC_PASSWORD` are
  set. `.gitignore` excludes `config.json`, `*.local.json` and `*.conf`.
- At start-up the service checks that the daemon's `chainid` is the configured chain and
  stops if it is not. A reply without a `chainid` counts as a failed call.
- The built-in HTTP server serves four fixed paths from memory. It never maps a request
  path to a file on disk.
- The output holds only public chain data.

## Verification status

Tested on 2026-11-20:

- Unit and integration tests: `node --test test/*.test.js` (price math against values
  calculated by hand from recorded basket states, bad data, the allow-list, the
  publish/failure/recovery cycle against a fake daemon, the HTTP server).
- VRSCTEST daemon, several new blocks: the file changed on each new block. The native,
  anchor and anchor-basket prices were checked by hand against the raw basket state.
- VRSC mainnet daemon, `"auto"` and a fixed basket list, several new blocks: six prices
  were checked by hand against raw `getcurrency` output and were equal to 12 significant
  digits. The call counts are in [Node load](#node-load-measured).
- VRSC mainnet through a public API (`rpc.url`, fixed basket list, no `listcurrencies`,
  one run): the same prices as the local daemon with the same list.
- In `"auto"` mode a reserve price can come from a different basket than with a fixed
  list, because the basket with the largest native reserve sets it. The differences seen
  were under 0.5 %.
- `minRouteReserve`: with the default, baskets under the minimum set no reserve price, and
  no other price changed.
- Docker (Docker Desktop 29.9.3 on macOS): the image builds (node:22-alpine, 234 MB, only
  `src/`, `package.json` and `LICENSE`, runs as uid 1000). A container against a VRSCTEST
  daemon through `host.docker.internal` with an env file published a new block to
  `/data/v1/prices.json` and served it (200, CORS, `Cache-Control`; POST got 405). On Docker
  Desktop, `--network host` could not reach the host, and the conf-file credentials were
  refused for `host.docker.internal` as designed.
- PBaaS: main chain on a local VRSC daemon, vARRR and CHIPS through their public APIs,
  bridge found from chain data. The coin and bridge prices were equal to a hand calculation
  from the raw states. Each public API got 4 calls in the first cycle and 3 per block after
  that. With one PBaaS chain on a dead address, the main chain and the other chains
  published, with one warning.
- Not verified: a PBaaS chain on its own local daemon (`rpc.conf`), `"auto"` on a PBaaS
  chain, vDEX (its public API did not answer during the test), the systemd unit, the Linux
  `--network host` Docker command.

Known limits:

- The header is read before the baskets. If a new block arrives during the reads (under a
  second), some states can be one block newer than `height`.
- Thin baskets: a basket with a small reserve can price its reserve currencies far from
  their price in deeper baskets, and such a basket is cheap to create. With the default of
  1,000 native coins it sets no price for its reserves. A basket's own price (rule 3) has
  no minimum, so a thin basket keeps a price for its own unit.

## Open questions for the Verus developers

- Is one published price file acceptable? Who hosts it, and on which domain?
- Anchor rule: is DAI.vETH = 1 USD acceptable?
- Which PBaaS chains must it cover at the start? A PBaaS coin needs a `pbaas` entry
  (own daemon or public API).
- Is the imported copy of a bridge basket on VRSC acceptable as a fallback for a VRSC-only
  node? The VRSC daemon gives its age only as a height on the other chain, so the service
  does not use it. If the daemon exposed the time of that state, a fallback with an age
  limit would be simple.
- Is about 28 `getcurrency` calls per block on mainnet (about 2,040 calls per hour)
  acceptable, or should the default be a fixed basket list?
- Is 1,000 VRSC the right default for `minRouteReserve`? It removes 9 of 50 mainnet prices.
  Should a basket's own price (rule 3) also need a minimum? On mainnet that would remove 11
  more (all baskets under 1,000 VRSC).

## License

MIT, see [LICENSE](LICENSE).
