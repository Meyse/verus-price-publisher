# verus-price-publisher

A small service that runs next to a Verus daemon (`verusd`). Once per new block it reads
the basket (fractional currency) states from the daemon's local RPC, computes a USD price
for each Verus currency, and writes one JSON file: `v1/prices.json`.

Wallets download that one file. The load on the node is constant: it does not grow with
the number of wallets.

- Plain JavaScript (Node.js 20 or newer). **No runtime dependencies**, no build step.
  About 700 lines in `src/`.
- Read-only RPC: an allow-list of five methods. Any other method is refused in code.
- RPC credentials come from the daemon conf file or environment variables. They are
  never logged and never written to the output.

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
5. If an RPC call fails, the cycle stops. The last file stays as it is and its times do
   not move, so clients see the age and can stop showing the price. The next poll tries
   again. The service logs the first failure and the recovery, not every failed poll.

## Node load (measured)

Measured on the local VRSCTEST daemon (Verus 1.2.18) on 2026-11-20, with the counters the
service logs after each cycle (`calls {...}` in the log).

| | RPC calls |
|---|---|
| Start-up, once | 1 `getblockchaininfo` (checks the chain id) |
| Each poll | 1 `getbestblockhash` |
| Each cycle (new block) | 1 `getblockheader` + 1 `getcurrency` per basket |
| Basket list, at most once per hour | 1 `listcurrencies` |

VRSCTEST has 91 live baskets: **92 calls per cycle** (plus the poll that found the block).
With the defaults and one block per minute that is about
360 polls + 60 × 92 + 1 = **5,881 calls per hour**, the same for 1 wallet or 1 million.
A cycle took 390 to 470 ms on the test machine (about 600 ms when it also refreshed the basket list).

VRSC mainnet with the four known VRSC baskets as a fixed list (Bridge.vETH, Pure, Kaiju,
Switch): 5 calls per cycle, about 660 calls per hour. The mainnet count with
`"baskets": "auto"` is not measured (the public API test did not call `listcurrencies`);
it is 2 + the number of live local baskets per cycle.

To lower the load: raise `pollSeconds` or `minIntervalSeconds`, or set a fixed `baskets` list.

## Install

### Plain Node.js and systemd

```sh
sudo useradd --system --home /opt/verus-price-publisher verus   # or use the user that runs verusd
sudo git clone <repo-url> /opt/verus-price-publisher
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

`--network host` lets the container reach the daemon on `127.0.0.1`. The output goes to
`/data` (`OUT_DIR`). To use the built-in HTTP server in the container, add
`-e HTTP_PORT=8080 -e HTTP_HOST=0.0.0.0` and put it behind your reverse proxy. The data
folder must be writable by the container's `node` user (uid 1000).

## Configuration

All keys are optional. Without a config file, use `--chain VRSC` or `--chain VRSCTEST` and
the defaults.

| Key | Default | Meaning |
|---|---|---|
| `chain` | `VRSC` | Preset: `VRSC` or `VRSCTEST`. For another chain, also set `id`, `anchor`, `anchorBasket`. |
| `id` | from preset | i-address of the chain's native currency. |
| `testnet` | from preset | Copied into the file. |
| `anchor` | VRSC: DAI.vETH `iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM`; VRSCTEST: USD `iFawzbS99RqGs7J2TNxME1TmmayBGuRkA2` | Currency counted as exactly 1 USD. |
| `anchorBasket` | VRSC: Bridge.vETH `i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx`; VRSCTEST: VRSC-USD `i4QdaEnkSxkAK4FRhRJcq7V7WgRN2XhzMD` | Basket that sets the native USD price. Always read. |
| `rpc.conf` | the daemon's default conf path (`~/.komodo/VRSC/VRSC.conf`, `~/.komodo/vrsctest/vrsctest.conf`) | Reads `rpcuser`, `rpcpassword`, `rpcport`, `rpchost`. |
| `rpc.url` | `http://<rpchost>:<rpcport>` | RPC URL. Credentials in the URL are refused. |
| `rpc.timeoutSeconds` | 15 | Timeout for one RPC call. |
| `baskets` | `"auto"` | `"auto"` (from `listcurrencies`) or a list of basket ids or names. Ids avoid a double read. |
| `outDir` | `./out` | The file goes to `<outDir>/v1/prices.json`. |
| `pollSeconds` | 10 | How often to check for a new block. |
| `minIntervalSeconds` | 60 | Minimum time between two cycles. |
| `basketListSeconds` | 3600 | How often to refresh the basket list (minimum 60). |
| `maxAgeSeconds` | 900 | Copied into the file as `maxAge`: the age after which clients should not show the prices. |
| `http` | `null` (off) | `{ "host": "127.0.0.1", "port": 8080 }` to serve the file from the service itself. |
| `pbaas` | `[]` | Extra PBaaS chains, see below. **Not verified** (no PBaaS daemon was available). |

Environment variables: `VERUS_CHAIN`, `VERUS_RPC_CONF`, `VERUS_RPC_URL`, `VERUS_RPC_USER`,
`VERUS_RPC_PASSWORD` (main chain only; the user and password override the conf file),
`OUT_DIR`, `HTTP_PORT`, `HTTP_HOST`.

### PBaaS chains (not verified)

```json
"pbaas": [
  { "name": "vARRR", "id": "iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2",
    "rpc": { "conf": "/home/verus/.komodo/vARRR/vARRR.conf" }, "baskets": "auto" }
]
```

Each PBaaS chain needs its own daemon. The service reads that chain's local baskets the same
way. The native USD price (VRSC) always comes from the main chain's anchor basket, so a PBaaS
basket gets a price only if it holds VRSC or the anchor. A currency that both chains price
keeps the main chain's price. If a PBaaS chain fails, its prices are left out of that cycle
and the main chain still publishes. This path has no test against a real daemon.

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
| `route.system` | Only for prices from a PBaaS chain: that chain's id. |
| `systems` | Only when PBaaS chains are configured: `{ name, id, height, blockTime }` for each chain read in this cycle. |

## Price rules

Ported from Verus Mobile (`onChainPriceMath.js`). Uses
`bestcurrencystate.reservecurrencies[].priceinreserve`, the price of one basket unit in
that reserve. The math uses exact decimal fixed-point numbers (BigInt, 24 decimals).

1. Native USD = `priceinreserve[anchor] / priceinreserve[native]` in the anchor basket.
2. The anchor = 1 USD.
3. A basket: if it holds the native, USD = `priceinreserve[native] × native USD`; else if
   it holds the anchor, USD = `priceinreserve[anchor]`; else no price.
4. Any other reserve currency C: of the baskets that hold C and the native, take the one
   with the largest native reserve; USD = `priceinreserve[native] / priceinreserve[C] × native USD`.
   If none holds the native, use the basket with the largest anchor reserve the same way.
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
  Credentials in `rpc.url` are refused. `.gitignore` excludes `config.json`, `*.local.json`
  and `*.conf`.
- At start-up the service checks that the daemon's `chainid` is the configured chain and
  stops if it is not.
- The built-in HTTP server serves one in-memory file. It reads no paths from the request.
- The output holds only public chain data.

## Verification status

- Unit and integration tests: `node --test test/*.test.js` (price math against the
  2026-11-01 worked example, bad data, the allow-list, the publish/failure/recovery cycle
  against a fake daemon, the HTTP server).
- Live: VRSCTEST daemon on 2026-11-20, several new blocks; VRSCTEST price checked by hand
  against the raw VRSC-USD basket state.
- Mainnet: one single run against `https://api.verus.services` with the fixed basket list,
  no `listcurrencies`. All 12 VRSC-chain prices matched the 2026-11-01 worked example within 0.1 %.
- Not verified: PBaaS chains, mainnet `"baskets": "auto"`, Docker image, systemd unit.

## Open questions for the Verus developers

- Is one published price file acceptable? Who hosts it, and on which domain?
- Anchor rule: is DAI.vETH = 1 USD acceptable? What must the service publish while
  baskets are frozen (today it publishes the frozen prices with fresh times)?
- Which PBaaS chains must it cover at the start? Should a VRSC-only node use the imported
  states of Bridge.vARRR, Bridge.CHIPS and Bridge.vDEX (close to, but behind, the PBaaS
  chain's own state), or must each PBaaS chain have its own daemon?
- VRSCTEST preset: the anchor is USD in VRSC-USD. Is that the right testnet anchor?
- Is about 92 `getcurrency` calls per block on testnet acceptable, or should the default
  be a fixed basket list?

## License

MIT, see [LICENSE](LICENSE).
