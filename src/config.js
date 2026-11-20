// Configuration: network presets, an optional JSON config file and
// environment variables. Credentials are read here and passed only to RpcClient.

import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { RpcClient, readDaemonConf } from './rpc.js';

const dataDir = (name) => (platform() === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'Komodo', name)
  : join(homedir(), '.komodo', name));

export const PRESETS = {
  VRSC: {
    name: 'VRSC',
    id: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
    testnet: false,
    anchor: 'iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM', // DAI.vETH
    anchorBasket: 'i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx', // Bridge.vETH
    rpcPort: 27486,
    conf: () => join(dataDir('VRSC'), 'VRSC.conf'),
  },
  VRSCTEST: {
    name: 'VRSCTEST',
    id: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq',
    testnet: true,
    anchor: 'iN9vbHXexEh6GTZ45fRoJGKTQThfbgUwMh', // DAI.vETH (testnet)
    anchorBasket: 'iSojYsotVzXz4wh2eJriASGo6UidJDDhL2', // Bridge.vETH (testnet)
    rpcPort: 18843,
    conf: () => join(dataDir('vrsctest'), 'vrsctest.conf'),
  },
};

const DEFAULTS = {
  baskets: 'auto',
  outDir: './out',
  pollSeconds: 10,
  minIntervalSeconds: 60,
  basketListSeconds: 3600,
  maxAgeSeconds: 900,
  minRouteReserve: 1000,
  history: true,
  historyRetentionDays: { hour: 7, day: 400, week: 0 },
  http: null,
};

function number(value, name, min) {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < min) throw new Error(`Config "${name}" must be a number >= ${min}`);
  return n;
}

function baskets(value, name) {
  if (value === undefined || value === 'auto') return 'auto';
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' && v)) return value;
  throw new Error(`Config "${name}" must be "auto" or a list of currency ids or names`);
}

// Build an RpcClient. Order: explicit URL, conf file, preset defaults.
// VERUS_RPC_USER / VERUS_RPC_PASSWORD override the conf file for the main chain.
function rpcClient(rpc = {}, { defaultConf, defaultPort, env = {} }) {
  const confPath = rpc.conf ?? env.VERUS_RPC_CONF ?? (rpc.url || env.VERUS_RPC_URL ? null : defaultConf);
  let conf = {};
  if (confPath) {
    try {
      conf = readDaemonConf(confPath);
    } catch (error) {
      throw new Error(`Cannot read daemon conf file ${confPath}: ${error.code ?? error.message}`);
    }
  }
  const host = conf.rpchost || '127.0.0.1';
  const port = conf.rpcport || defaultPort;
  const url = rpc.url ?? env.VERUS_RPC_URL ?? (port ? `http://${host}:${port}` : null);
  if (!url) throw new Error('Set rpc.url, or rpc.conf with an rpcport line');
  // Send the conf file's credentials only to this machine or to the conf's own rpchost.
  const urlHost = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const daemonHosts = ['127.0.0.1', 'localhost', '::1', host];
  const confAuth = (conf.rpcuser && env.VERUS_RPC_USER === undefined)
    || (conf.rpcpassword && env.VERUS_RPC_PASSWORD === undefined);
  if (confAuth && !daemonHosts.includes(urlHost)) {
    throw new Error(`Refusing to send the conf file's RPC credentials to ${urlHost}. `
      + 'Remove rpc.conf, or set VERUS_RPC_USER and VERUS_RPC_PASSWORD for that host.');
  }
  return new RpcClient({
    url,
    user: env.VERUS_RPC_USER ?? conf.rpcuser,
    password: env.VERUS_RPC_PASSWORD ?? conf.rpcpassword,
    timeoutMs: number(rpc.timeoutSeconds ?? 15, 'rpc.timeoutSeconds', 1) * 1000,
  });
}

function historyConfig(merged) {
  if (merged.history === false) return null;
  if (merged.history !== true) throw new Error('Config "history" must be true or false');
  const days = { ...DEFAULTS.historyRetentionDays, ...merged.historyRetentionDays };
  return {
    retentionDays: {
      hour: number(days.hour, 'historyRetentionDays.hour', 0),
      day: number(days.day, 'historyRetentionDays.day', 0),
      week: number(days.week, 'historyRetentionDays.week', 0),
    },
  };
}

/**
 * @param {object} options
 * @param {string} [options.configPath]
 * @param {string} [options.chain]  preset name when there is no config file
 * @param {object} [options.env]
 */
export function loadConfig({ configPath, chain, env = process.env } = {}) {
  const file = configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const chainName = file.chain ?? chain ?? env.VERUS_CHAIN ?? 'VRSC';
  const preset = PRESETS[chainName];
  if (!preset && !(file.id && file.anchor && file.anchorBasket)) {
    throw new Error(`Unknown chain "${chainName}". Use VRSC or VRSCTEST, or set id, anchor and anchorBasket.`);
  }
  const merged = { ...DEFAULTS, ...file };
  const main = {
    name: chainName,
    id: file.id ?? preset.id,
    testnet: Boolean(file.testnet ?? preset?.testnet),
    anchor: file.anchor ?? preset.anchor,
    anchorBasket: file.anchorBasket ?? preset.anchorBasket,
    baskets: baskets(merged.baskets, 'baskets'),
    rpc: rpcClient(file.rpc, {
      defaultConf: preset?.conf(), defaultPort: preset?.rpcPort ?? 27486, env,
    }),
  };
  const pbaas = (file.pbaas ?? []).map((entry, i) => {
    if (!entry?.id || !entry?.name || !entry?.rpc) {
      throw new Error(`Config pbaas[${i}] needs name, id and rpc`);
    }
    return {
      name: entry.name,
      id: entry.id,
      // Default: only the chain's bridge basket (found from chain data), never listcurrencies.
      baskets: entry.baskets === undefined ? [] : baskets(entry.baskets, `pbaas[${i}].baskets`),
      rpc: rpcClient(entry.rpc, { defaultConf: null, defaultPort: null }),
    };
  });
  let http = null;
  if (merged.http || env.HTTP_PORT) {
    http = {
      host: env.HTTP_HOST ?? merged.http?.host ?? '127.0.0.1',
      port: number(env.HTTP_PORT ?? merged.http?.port ?? 8080, 'http.port', 0),
    };
  }
  return {
    chain: main,
    pbaas,
    outDir: resolve(env.OUT_DIR ?? merged.outDir),
    pollMs: number(merged.pollSeconds, 'pollSeconds', 1) * 1000,
    minIntervalMs: number(merged.minIntervalSeconds, 'minIntervalSeconds', 0) * 1000,
    basketListMs: number(merged.basketListSeconds, 'basketListSeconds', 60) * 1000,
    maxAgeSeconds: number(merged.maxAgeSeconds, 'maxAgeSeconds', 60),
    minRouteReserve: String(number(merged.minRouteReserve, 'minRouteReserve', 0)),
    history: historyConfig(merged),
    http,
  };
}
