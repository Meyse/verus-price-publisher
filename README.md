# verus-price-publisher

A service that publishes USD prices of Verus currencies as static JSON files. It runs as
one process next to a VRSC daemon (`verusd`). At each new block it reads the basket
(fractional currency) states over the daemon's RPC, computes the prices, and writes the
files. Wallets download the files, so the load on the node does not grow with the number
of wallets.

- **What it needs:** one VRSC daemon on the same machine and Node.js 20 or newer. It needs
  no PBaaS node: the coins of vARRR, CHIPS and vDEX come from the public APIs of those
  chains (built in, off by default). No runtime dependencies, no build step.
- **What it costs the node:** read-only RPC (an allow-list of six methods). Each new block
  costs 1 `getblockheader` and 1 `getcurrency` per basket. Each poll costs 1
  `getbestblockhash`, and no poll calls the daemon in the 60 s after a cycle. On VRSC
  mainnet that is about 1,780 calls per hour, or about 400 with a fixed list of 4
  baskets. Missing history slots (after a stop, or at the first start) are filled from
  the chain's past basket states, one call at a time, with the daemon busy at most about
  one third of the time. On VRSC mainnet a first start took 172 calls and 109 s of daemon
  time over 400 s; a one-day gap took 46 calls and 26 s. See
  [Node load](#node-load-measured).
- **How to install:** a git clone and a systemd unit, or a Docker image. See
  [Install](#install). Nothing to change in the daemon's config.
- **What it outputs:** `v1/prices.json` (the current prices, rewritten at each block) and
  `v1/history/hour.json`, `day.json` and `week.json` (the price history). See
  [Output schema](#output-schema-v1) and [Price history](#price-history-v1).

## How it works

1. Every `pollSeconds` (default 30 s) the service checks for a new block with
   `getbestblockhash`. A cycle runs at most once per `minIntervalSeconds` (default 60 s).
   In that time after a cycle the service makes no RPC call at all; the first poll after
   it is the one at the end of the interval. When two blocks come within one poll period,
   only the newer one is published.
2. With [block notification](#block-notification-optional) (ZMQ or a notify file) the
   daemon tells the service about each new block, and the check runs at once. A
   notification inside the minimum interval waits until the interval ends. The regular
   poll becomes a slow safety poll (300 s).
3. On a new block it runs a cycle: `getblockheader` for the height and time, then one
   `getcurrency` per basket.
4. The basket list comes from `listcurrencies {"systemtype":"local"}`, at most once per
   `basketListSeconds` (default 1 hour), because `listcurrencies` is expensive. It keeps
   fractional currencies that are not pre-launch and not refunding. You can also give a
   fixed list instead (`"baskets": [...]`); then `listcurrencies` is never called.
5. It computes all prices in one pass (see [Price rules](#price-rules)) and writes
   `v1/prices.json` atomically (temporary file, `fsync`, rename).
6. If any RPC call fails (also a single basket read), the cycle stops. No partial file is
   written. The last file stays as it is and its times do not move, so clients see the age
   and can stop showing the price. The next poll tries again. The service logs the first
   failure and the recovery, not every failed poll. An unknown id in a fixed `baskets` list
   therefore stops publishing until you fix the list.
7. After a restart the service serves the saved file (if it has the same schema, chain and
   anchor) and does not rewrite it until a new block arrives, so a restart does not make an
   old block look new.
8. Price history (on by default, `"history": false` turns it off). After each successful
   cycle the service checks three UTC slots: the full hour, the day (00:00) and the week
   (Monday 00:00). The first successful cycle in a new slot adds one sample to that
   slot's file: the slot start, the block height, the block time and the price of each
   currency. Other cycles in the same slot add nothing. Nothing is interpolated.
   **Missing slots are filled from the chain:** a slot in which the service did not run,
   or every cycle failed, gets its sample from the chain's past basket states, in the
   background. See [History fill](#history-fill).
   **The history files roll over:** each file keeps a fixed window
   (`historyRetentionDays`: 7 days hourly, 400 days daily, weekly without a limit), and
   the oldest samples drop off when new ones come in.
9. The history files are the state. At start the service reads them and continues; a
   slot that already has a sample does not get a second one. Each write is atomic. A
   file for another chain, another anchor or another schema, or a damaged file, is renamed
   to `<file>.replaced-<unix time>` (never deleted), a new file starts, and the service
   logs this once. If a file cannot be read at all (for example no permission), the
   service logs an error, keeps publishing `prices.json`, and records no history until a
   restart, so it never overwrites that file. `--once` also continues the history files
   (it adds the live sample; it does not fill).
   A failed cycle records nothing. A cycle whose block time is more than
   2 hours from the clock records nothing (the daemon is still syncing, or the clock is
   wrong). If the clock goes back, no sample is added until it passes the last slot.

## Node load (measured)

Measured against a VRSC mainnet daemon and a VRSCTEST daemon (Verus 1.2.18), with the
counters the service logs after each cycle (`calls {...}` in the log) and a counting proxy
for the polls.

| | RPC calls |
|---|---|
| Start-up, once | 1 `getblockchaininfo` (checks the chain id) |
| Each poll | 1 `getbestblockhash`; none in the minimum interval after a cycle |
| Each cycle (new block) | 1 `getblockheader` + 1 `getcurrency` per basket |
| Basket list, at most once per hour | 1 `listcurrencies` (local baskets) + 1 `listcurrencies` (PBaaS chains); with a fixed list: 1 `getcurrency` per `pbaas` entry |

Polls per hour, measured on VRSCTEST (about 1 block per minute):

| Mode | Polls per hour |
|---|---|
| Default: poll every 30 s, no poll in the 60 s after a cycle | about 100 |
| Notify file, safety poll every 300 s | about 35 |
| ZMQ connected, safety poll every 300 s | about 30 |

Total calls per hour at 1 block per minute (60 cycles), with the default polling:

| Chain, basket mode | Baskets | Calls per cycle | Calls per hour | Cycle time |
|---|---|---|---|---|
| VRSC, `"auto"` | 27 live local | 28 | 60 × 28 + 100 + 2 = **1,782** | 560 to 950 ms |
| VRSC, fixed list of 4 | 4 | 5 | 60 × 5 + 100 = **400** | 190 ms |
| VRSCTEST, `"auto"` | 91 live local | 92 | 60 × 92 + 100 + 2 = **5,622** | 200 to 470 ms |

"Calls per cycle" does not count the poll that found the block. The first cycle after a
basket-list refresh also has the `listcurrencies` call (about 0.1 to 0.3 s more). The load
is the same for 1 wallet or 1 million.

Live history samples make **zero extra RPC calls**. They use the prices that the cycle
already computed. Their only cost is one small file write per slot (24 hourly, 1 daily and
at most 1 weekly write per day).

The [history fill](#history-fill) reads missing slots with `getcurrencystate`, one call
at a time. Each call is sized to take the daemon about 1 s, and before each call the fill
waits at least twice as long as the last call took, so it keeps the daemon at most about
one third busy. No fill call starts during a cycle. Measured with the default fill
windows (2 days of hours, 45 days of days, 730 days of weeks), through a counting proxy:

Cost per state read (daemon time per block state, at the proxy). It depends on the
basket: on VRSC, Bridge.vETH is the most costly.

| Chain | Baskets | Per basket: min / median / max | Average in a first start |
|---|---|---|---|
| VRSC | 27 (`"auto"`) | 0.24 / 1.2 / 57 ms | 8.4 ms |
| VRSCTEST | 91 (`"auto"`) | 0.14 / 0.34 / 7.1 ms | 0.75 ms |

Fill runs. "First start" is an empty `outDir` (195 slots: 47 hours, 44 days, 104 weeks).
"One-day gap" is a restart after the 24 hourly samples and the daily sample of
2026-11-20 were deleted from the files (25 slots). "Daemon busy" is daemon time divided by
wall time.

| Run | Calls | States | Daemon time | Wall time | Daemon busy | Longest call | Largest response |
|---|---|---|---|---|---|---|---|
| VRSC first start, `"auto"` (27 baskets) | 172 | 12,967 | 109 s | 400 s | 27 % | 4.1 s | 290 KB |
| VRSC first start, fixed list of 4 baskets | 60 | 2,037 | 58 s | 178 s | 33 % | 3.5 s | 283 KB |
| VRSC one-day gap, `"auto"` | 46 | 2,625 | 26 s | 96 s | 27 % | 2.5 s | 290 KB |
| VRSCTEST first start, `"auto"` (91 baskets) | 356 | 43,444 | 34 s | 394 s | 9 % | 0.9 s | 292 KB |
| VRSCTEST one-day gap, `"auto"` | 96 | 8,923 | 8 s | 104 s | 8 % | 0.7 s | 292 KB |

In every run, no call failed, no call took over 5 s, and every slot in the windows was
filled. The response sizes are on the wire. The calls are sized from the time per state
of the last call, and the baskets have different costs: a size from a cheap basket gives
a longer call on a costly one (on VRSC, 11 of 172 calls took over 2 s). History file
sizes after a first start (hour, day, week): VRSC `"auto"` 21, 20 and 39 KB (gzip 2.6,
2.7 and 13.5 KB); VRSC with 4 baskets 7, 7 and 14 KB; VRSCTEST 64, 61 and 109 KB (gzip
7.5, 7.5 and 25.5 KB).

### Basket list

By default (`"baskets": "auto"`) the service finds the baskets itself: once per hour it
calls `listcurrencies {"systemtype":"local"}` and keeps every live local basket. To read
only the baskets you choose, set a fixed list. Then `listcurrencies` is never called, and
each block costs 1 + the number of listed baskets:

```json
"baskets": ["i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx", "iHax5qYQGbcMGqJKKrPorpzUBX2oFFXGnY",
            "i9kVWKU2VwARALpbXn4RS9zvrhvNRaUibb", "i4Xr5TAMrDTD99H69EemhjDxJ4ktNskUtc"]
```

These are Bridge.vETH, Pure, Kaiju and Switch. The anchor basket is always read, also
when it is not in the list. A currency that is only in baskets outside the list gets no
price.

To lower the load further: turn on [block notification](#block-notification-optional), raise `minIntervalSeconds`, or set
a fixed `baskets` list.

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

## Block notification (optional)

There are three modes. The default needs no change to the daemon.

| Mode | Daemon conf line | Tool config key (env) | Polls per hour (measured) | A new block is seen |
|---|---|---|---|---|
| Poll (default) | none | none | about 100 | at the next poll, at most 30 s later |
| ZMQ | `zmqpubhashblock=tcp://127.0.0.1:28332` | `blockNotifyZmq` (`BLOCK_NOTIFY_ZMQ`) | about 30 | about 1 s after the daemon publishes it |
| Notify file | `blocknotify=touch /var/lib/verus-blocknotify/VRSC` | `blockNotifyFile` (`BLOCK_NOTIFY_FILE`) | about 35 | within 1 s |

Set at most one of the two keys; with both, the service stops at start with a config
error. A new line in the daemon conf takes effect when the daemon restarts. In both
notification modes the notification is only a trigger: the service then asks the daemon
for the best block with `getbestblockhash`, as in the default mode. No check runs inside
`minIntervalSeconds` after a cycle, and notifications start at most one check per second.

### ZMQ

At each new block the daemon publishes a `hashblock` message on a ZMQ socket. The service
connects to that socket with its own small ZMQ subscriber (ZMTP 3.0, NULL mechanism, no
library) and subscribes to `hashblock`. In `VRSC.conf`:

```ini
zmqpubhashblock=tcp://127.0.0.1:28332
```

In the service's `config.json`:

```json
"blockNotifyZmq": "tcp://127.0.0.1:28332"
```

- While ZMQ is connected, only a safety poll runs: every 300 s, or every `pollSeconds` if
  that is longer. While it is not connected (the daemon restarts, the port refuses, the
  link breaks), the service polls every `pollSeconds` (default 30 s) and tries to
  reconnect every 5 s. It logs a lost connection once and a new connection once.
- Only `tcp://host:port` addresses. A frame over 4 KiB, a message with more than 16
  frames, or malformed data drops the connection; the service then reconnects.
- Use the `zmqpubhashblock` address. An address that publishes no `hashblock` messages
  (for example only `zmqpubhashtx`) still connects, and then the service sees new blocks
  only at the safety poll.
- The ZMQ socket has no authentication. Bind it to `127.0.0.1` or to another address that
  is not public.
- Docker: the container must reach the ZMQ port. On Linux with `--network host`,
  `tcp://127.0.0.1:28332` works. Without host networking, the daemon must bind the ZMQ
  socket on an address that the container can reach (`-e BLOCK_NOTIFY_ZMQ=tcp://<that
  address>:28332`), and that address must not be public.

### Notify file

The daemon's `blocknotify` command touches a file at each new block. The service watches
the file's time (one `stat` per second, no RPC call). The file carries no data, and the
service needs only read access to it. The channel is a file and not a signal, because a
signal from the daemon's user to a service that runs as another user needs root, and a
signal into a container needs Docker access.

Make a folder that the daemon's user can write and the service can read:

```sh
sudo mkdir -p /var/lib/verus-blocknotify
sudo chown <daemon user> /var/lib/verus-blocknotify   # mode 755
```

systemd (daemon and service as the same user or as different users). In `VRSC.conf`:

```ini
blocknotify=touch /var/lib/verus-blocknotify/VRSC
```

In the service's `config.json`:

```json
"blockNotifyFile": "/var/lib/verus-blocknotify/VRSC"
```

Docker (daemon on the host): the same `blocknotify=` line in `VRSC.conf` on the host, and
the folder mounted read-only into the container:

```sh
docker run ... \
  -v /var/lib/verus-blocknotify:/run/blocknotify:ro \
  -e BLOCK_NOTIFY_FILE=/run/blocknotify/VRSC \
  verus-price-publisher --chain VRSC
```

With `blockNotifyFile` set, `pollSeconds` defaults to 300. At start the service logs
`block notification: watching <file>`. If the file never changes (for example a wrong
path), the service still publishes at each safety poll.

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
| `pollSeconds` | 30; 300 with `blockNotifyFile` | How often to check for a new block. No check calls the daemon in the minimum interval after a cycle. With `blockNotifyZmq`, this poll runs while ZMQ is not connected. |
| `blockNotifyZmq` | `null` (off) | The daemon's `zmqpubhashblock` address, `tcp://host:port`. See [Block notification](#block-notification-optional). |
| `blockNotifyFile` | `null` (off) | File that the daemon's `blocknotify` command touches. Not together with `blockNotifyZmq`. |
| `minIntervalSeconds` | 60 | Minimum time between two cycles. |
| `basketListSeconds` | 3600 | How often to refresh the basket list (minimum 60). |
| `maxAgeSeconds` | 900 | Copied into the file as `maxAge`: the age after which clients should not show the prices. |
| `minRouteReserve` | 1000 | Minimum native reserve (in native coins, for example VRSC) of a basket that sets the price of a reserve currency (price rule 4). `0` turns it off. |
| `history` | `true` | Keep the price history files under `<outDir>/v1/history/`. `false` turns it off. |
| `historyRetentionDays` | `{ "hour": 7, "day": 400, "week": 0 }` | How many days of samples each history file keeps. Older samples are removed. `0` = no limit. |
| `historyFill` | `true` | Fill missing history slots from the chain's past states (see [History fill](#history-fill)). `false` turns it off. |
| `historyFillDays` | `{ "hour": 2, "day": 45, "week": 730 }` | How many days back the fill goes in each history file. A value over the file's retention is cut to the retention. `0` = no fill for that file. |
| `http` | `null` (off) | `{ "host": "127.0.0.1", "port": 8080 }` to serve the files from the service itself. |
| `pbaas` | `[]` (off) | PBaaS chains. A built-in name (`"vARRR"`, `"CHIPS"`, `"vDEX"`) uses that chain's public API. An object `{ name, id, rpc }` uses another server, for example an own daemon; optional `baskets` (default: only the chain's bridge basket). See [PBaaS chains](#pbaas-chains). `rpc` takes `conf`, `url`, `timeoutSeconds` as for the main chain. |

Environment variables: `VERUS_CHAIN`, `VERUS_RPC_CONF`, `VERUS_RPC_URL`, `VERUS_RPC_USER`,
`VERUS_RPC_PASSWORD` (main chain only; the user and password override the conf file),
`OUT_DIR`, `HTTP_PORT`, `HTTP_HOST`, `BLOCK_NOTIFY_ZMQ`, `BLOCK_NOTIFY_FILE`, `HISTORY_FILL`
(`0` or `1`; overrides `historyFill`), and `VERUS_PBAAS` (built-in PBaaS names,
comma-separated, used when the config file has no `pbaas`).

### PBaaS chains

The coin of a PBaaS chain takes its USD price only from that chain's own bridge basket,
read on that chain. **The service needs no PBaaS node for this.** It reads the bridge
basket through the chain's public API. vARRR, CHIPS and vDEX are built in. Turn them on by
name:

```json
"pbaas": ["vARRR", "CHIPS", "vDEX"]
```

Or, without a config file: `VERUS_PBAAS=vARRR,CHIPS,vDEX`. The built-in entries are for
VRSC mainnet. They are off by default; without an entry, the chain's coin and its bridge
basket have no price.

| Name | Chain `id` | Public API | Bridge basket (found from chain data) |
|---|---|---|---|
| `vARRR` | `iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2` | `https://vapi.piratechain.com/` | Bridge.vARRR `iD5WRg7jdQM1uuoVHsBCAEKfJCKGs1U3TB` |
| `CHIPS` | `iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP` | `https://api.chips.cash/` | Bridge.CHIPS `i3nokiCTVevZMLpR3VmZ7YDfCqA5juUqqH` |
| `vDEX` | `iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N` | `https://api.vdex.to/` | Bridge.vDEX `i6j1rzjgrDhSmUYiTtp21J8Msiudv5hgt9` |

Each chain costs its public API 3 calls per VRSC cycle (`getbestblockhash`,
`getblockheader`, 1 `getcurrency`), about 180 per hour, and 1 `getblockchaininfo` at start;
the service never calls `listcurrencies` there. The prices of that chain then come from a
server that the operator does not run. A chain that does not answer is left out of that
cycle, and the main chain and the other chains still publish.

An own daemon for a chain works the same way. Give the built-in name with an `rpc`; the
conf file's credentials go only to a local address, as for the main chain. With an own
daemon, `"baskets": "auto"` also reads the other live baskets of that chain (one
`listcurrencies` per hour there):

```json
"pbaas": [
  { "name": "vARRR", "rpc": { "conf": "/path/to/the/vARRR/daemon.conf" }, "baskets": "auto" }
]
```

Any other PBaaS chain: `{ "name": "...", "id": "<chain id>", "rpc": { "url": "..." } }`.

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
- The service logs a failing chain once and its recovery once. It checks each chain's
  `chainid` with `getblockchaininfo` and stops on a mismatch.
- The main chain's imported copy of a bridge basket is not used. It carries a height of
  the PBaaS chain (`bestheight`) and no time, so its age is not known.

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
  604,800 seconds). The chain has no usable block for it (see
  [History fill](#history-fill)), or the fill has not run yet. Show a gap, or join the
  points and mark the gap.
- A live sample is taken at the first cycle in its slot, usually the first block after
  the slot start. A filled sample is at most one grid step later (see
  [History fill](#history-fill)). `blockTime` shows when the price was read.
- All prices are in USD (the `anchor` currency counts as 1 USD). There is no other quote
  currency. To show
  another currency, convert on the client.
- Check `chain.id` and `anchor` before you use a file.
- Ask for gzip (`Accept-Encoding: gzip`); most HTTP clients do this by default.

### History fill

When a slot has no sample (the service was stopped, its cycles failed, or it starts with
no history), the service fills the slot from the chain's own past basket states. It uses
`getcurrencystate` with a height range (`"start,end,step"`), which returns the state of
one basket at every step-th block, with the block time.

- **When:** after the first cycle that publishes a block after a start, and after any
  later cycle when slots are missing (for example after the daemon was down while the
  service ran). The fill runs in the background. Not with `--once`.
- **Which slots:** every slot that has ended, inside the fill window of its file
  (`historyFillDays`, default 2 days of hours, 45 days of days and 730 days of weeks; cut
  to the file's retention). A chart of a day uses hourly points, a chart of a month daily
  points, and longer charts weekly points; the windows cover that. The files still grow
  to their full retention (7, 400 days, no limit) from live samples; only a gap inside a
  window is filled. Only when the block of the cycle is less than 2 hours from the clock
  (the daemon is synced).
- **Which block:** the fill reads the states on a grid of heights with a fixed step: a
  quarter of the blocks of an hour (14 blocks at 62 s per block), or half of the blocks of
  a day (696) or a week (4,877). The sample of a slot is the first grid block (by height)
  whose block time is at or after the slot start and before the slot end. It is at most
  one grid step after the first block of the slot. A day or week slot inside a finer grid
  uses that grid (a missing day whose first hour is also missing is filled from the hour
  grid). `height` and `blockTime` are those of the grid block. Measured after a first
  start: hour samples a median of 7 min (VRSCTEST) and 8 min (VRSC) after the slot start,
  at most 30 min; day samples 10 to 12 h after the slot start; week samples a median of
  15 h (VRSCTEST) and 81 h (VRSC) after the slot start, at most 84 h. The grid starts at a
  height estimated from the known blocks around the missing slots. So a later fill of the
  same slot can use a different grid block (seen on VRSC: one block earlier, with the same
  prices).
- **Same prices:** the prices come from the same code as live samples, with the states of
  all baskets at that one height: the same [price rules](#price-rules), `minRouteReserve`,
  and local baskets only. With `"auto"`, a basket that was not live at that height
  (pre-launch, refunding) is left out, as in the live basket list. Filled and live samples
  have the same form in the files.
- **What stays missing:** a slot with no grid block in it (the chain made no block, or the
  slot is before the chain started), and a slot whose block has no native USD price (for
  example before the anchor basket launched). Nothing is interpolated or invented. PBaaS
  coins get `null` in filled samples: the fill reads only the main chain, so PBaaS coins
  have history from live samples only. The baskets are
  those of the current basket list; a basket that closed since then is not in a filled
  sample.
- **Load:** one call at a time. The first call of a run reads 4 states; each next call
  is sized from the time per state of the last call to take about 1 s, and to at most
  about 256 KB (the number of states per call also depends on the number of reserves of
  the basket). Before each call after the first, the fill waits max(1 s, 2 × the last
  call's time). A call over 5 s halves the size of the next call; a one-state call over
  5 s ends the run. After 1,500 calls a run waits 60 minutes (one log line) and then goes
  on by itself. The fill starts no call while a publish cycle runs, and a cycle never
  waits for the fill (a fill call that was sent just before a cycle starts can still be
  in progress at the daemon). A failed call ends the run with one log line. Publishing
  goes on, and the fill is off until the next start, which tries again.
- **Crash safety:** the fill writes its samples after each part of about 240 grid blocks,
  atomically, through the same write queue as the live samples. A crash leaves valid
  files, and the next start fills only what is still missing.
- The log has one line when a run starts (the missing slots per file) and one when it
  ends (filled slots per file, calls, time, largest response, slots that stay missing).
- `"historyFill": false` or `HISTORY_FILL=0` turns it off.

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
   The chosen basket must hold at least `minRouteReserve` native units (default 1,000).
   If no basket holds C and the native, or the largest one is under the minimum, use the
   basket that holds C and the anchor with the largest anchor reserve, the same way. For
   this anchor route the anchor reserve counts as `anchor reserve / native USD` native
   units, and the same minimum applies. If both routes fail, C gets no price. The minimum
   does not apply to rules 1 to 3. `0` turns it off.
5. Bad data gives no price and no error: zero, negative, missing or non-numeric
   `priceinreserve`, zero supply, pre-launch or refunding baskets.
6. Only baskets whose `systemid` is the chain itself are used. A basket from another
   chain (for example Bridge.vARRR on VRSC) has an imported copy of its state that can be
   older than the state on its own chain.
7. The coin of a PBaaS chain uses rule 4 with one basket only: its bridge basket
   (`gatewayconverterid`), read on the PBaaS chain. A larger basket on the main chain does
   not count. Without a working `pbaas` entry the coin has no price. A configured PBaaS
   chain without a bridge basket gives its coin no price. Data from one PBaaS chain cannot
   set the price of another chain's coin.

## Security notes

- The RPC client (`src/rpc.js`) has a fixed allow-list of six methods: `getblockchaininfo`,
  `getbestblockhash`, `getblockheader`, `getcurrency`, `listcurrencies`, and
  `getcurrencystate` only in its range form (a currency id and `"start,end,step"` with
  block heights). It refuses every other method and form before any network request. No
  wallet method is on the list.
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
- The block notification file is only watched with `stat`; its content is never read. A
  process that can touch it can start at most one check per `minIntervalSeconds`.
- The ZMQ subscriber acts only on messages whose first frame is `hashblock`, and it uses
  none of their content. A peer on the ZMQ address can start at most one
  `getbestblockhash` per second, never inside `minIntervalSeconds`. Its input is bounded
  (4 KiB per frame, 16 frames per message).
- A built-in PBaaS entry sends no credentials. `"auto"` is refused for a public API.
- The output holds only public chain data.

## Verification status

Tested on 2026-11-20 and 2026-11-21:

- Unit and integration tests: `node --test test/*.test.js` (price math against values
  calculated by hand from recorded basket states, bad data, the allow-list, the
  publish/failure/recovery cycle against a fake daemon, the HTTP server; history: one
  sample per slot, the hour, 00:00 and Monday 00:00 boundaries, retention, restart without
  a duplicate, `null` for a currency that appears or disappears, a changed anchor, a
  failed cycle, bad saved files; history fill against a fake daemon: a first start and a
  gap with the call count, a slot without a block, a failed call, the fill turned off, no
  fill call during a cycle, grid estimates that miss, a chain that starts in the middle of
  a day, a basket that was not live at a past height, a cycle that does not wait for a
  fill write, the call size from the measured time per state (slow and fast daemon), the
  pause from the last call's time, a slow call that halves the size, the 60-minute wait
  after 1,500 calls, the fill windows per file, and bad fill settings).
- History fill with the default windows, through a counting proxy, with the real clock, on
  a VRSC mainnet daemon (`"auto"`, 27 baskets, and a fixed list of 4) and a VRSCTEST
  daemon (91 baskets). The calls, times and sizes are in [Node load](#node-load-measured).
  From an empty folder, all 195 missing slots were filled (hour, day and week files: 48, 45
  and 105 samples, no gap, no sample outside its slot). After the 24 hourly samples and
  the daily sample of 2026-11-20 were deleted from a copy of the files, a restart filled
  all 25 slots. Hand check, VRSC: nine filled samples (three per file) against a direct
  `getcurrencystate` read of Bridge.vETH at the same height: VRSC, Bridge.vETH, DAI.vETH
  and MKR.vETH were equal to 6 significant digits. On both daemons the basket states did
  not change in the hour and day windows (VRSC after height 4163338, VRSCTEST after
  1194593), so those checks do not tell near heights apart; the week checks do (VRSC was
  4.13862 USD in 2024-11, 1.09211 in 2025-11 and 0.636937 in 2026-11). Overlap, VRSC: the
  live hour sample at height 4331627, rebuilt from `getcurrencystate` at that height for
  all 27 baskets: all 38 prices were equal to the live sample. The earlier VRSCTEST checks
  (another build of the fill, the same price code) were also equal: nine hand-checked
  samples, and 110 of 110 prices in two rebuilt live samples.
- Price history on a live VRSCTEST daemon with a shifted clock: a test runner (not part of
  the service) shifted the clock and the block-header time by the same offset, so that a
  slot boundary came 90 s after the start. Heights, hashes and basket states were live.
  Three runs: across a full hour (hour sample), across 00:00 UTC (hour and day samples)
  and across Monday 00:00 UTC (hour, day and week samples). Each sample had the height,
  block time and all prices of the `prices.json` of the same block (prices to 6
  significant digits). A restart in the same hour added no sample and lost none. The
  built-in server served the history paths with their `Cache-Control` values and 404 for
  a `.replaced-*` path.
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
- Polling on a live VRSCTEST daemon, 12 minutes (7 blocks), three runs side by side
  through a counting proxy: the earlier version (poll every 10 s, poll before the
  interval check) made 73 polls (about 360 per hour), the default mode 20 (about 100 per
  hour), block notification 7 (about 35 per hour). The default mode published one block
  less: two blocks came 14 s apart, and one poll saw only the newer one.
  In notification mode a test harness touched the file at each new block; a touch inside
  the minimum interval waited until the interval ended.
- ZMQ subscriber against real libzmq 4.3.5 (pyzmq 27.3.0, a test harness outside the
  repo), with the real service process and a fake daemon. libzmq received the
  subscription frame `\x01hashblock`. Each `hashblock` message in the daemon's layout
  started one cycle (about 50 ms after the message, outside the minimum interval). A
  10,000-octet `rawblock` message on the same socket was filtered by the publisher. A
  repeated `hashblock` without a new block cost 1 `getbestblockhash` and no cycle. With
  libzmq stopped, the service polled every 30 s, and it reconnected 5 s after libzmq came
  back. With libzmq heartbeats on (100 ms, timeout 400 ms) the connection stayed up.
- ZMQ against a VRSCTEST daemon with `zmqpubhashblock=tcp://127.0.0.1:28332`, 12 minutes
  (6 blocks), side by side with the poll and notify-file modes through counting proxies.
  The daemon's messages had 3 frames: `hashblock` (9 octets), the block hash (32) and a
  little-endian sequence number (4). The handshake with the daemon's libzmq worked. Each
  message started one cycle about 1 s later, or at the end of the minimum interval.
  Polls: poll mode 21, notify file 6, ZMQ 6. First publish after the daemon's message:
  ZMQ about 1 s, notify file 1 to 4 s (touched by a test harness), poll mode 11 to 21 s.
- Built-in PBaaS names (`VERUS_PBAAS=vARRR,CHIPS,vDEX`, `--once`, local VRSC daemon): vARRR
  and CHIPS were priced from their bridge baskets through their public APIs (4 calls each
  in the first cycle). vDEX answered HTTP 502; it was left out with one warning and the
  rest published.
- Not verified: a PBaaS chain on its own local daemon (`rpc.conf`), `"auto"` on a PBaaS
  chain, vDEX prices (its public API did not answer during the tests), the systemd unit, the Linux
  `--network host` Docker command, the nginx and Caddy snippets, a history run over days
  with the real clock, a real `blocknotify=` line in a daemon config (the notification
  was sent by a test harness), ZMQ from a container, ZMQ on a VRSC mainnet daemon, the
  history fill with PBaaS chains, a crash (kill) during a fill write, the 60-minute wait
  after 1,500 calls on a real daemon (no measured run came near 1,500 calls), a fill
  over a period where the basket states change from hour to hour.

Known limits:

- The header is read before the baskets. If a new block arrives during the reads (under a
  second), some states can be one block newer than `height`.
- Thin baskets: a basket with a small reserve can price its reserve currencies far from
  their price in deeper baskets, and such a basket is cheap to create. With the default of
  1,000 native coins it sets no price for its reserves. A basket's own price (rule 3) has
  no minimum, so a thin basket keeps a price for its own unit.

## License

MIT, see [LICENSE](LICENSE).
