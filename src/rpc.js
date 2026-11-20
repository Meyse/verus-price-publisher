// Read-only JSON-RPC client for verusd.
// Only the methods in ALLOWED_METHODS can be called. Credentials stay in this
// module: they go into the Authorization header and nowhere else.

import { readFileSync } from 'node:fs';

export const ALLOWED_METHODS = Object.freeze(new Set([
  'getblockchaininfo',
  'getbestblockhash',
  'getblockheader',
  'getcurrency',
  'listcurrencies',
]));

export class RpcError extends Error {}

// Read rpcuser, rpcpassword, rpcport and rpchost from a daemon conf file.
export function readDaemonConf(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(rpcuser|rpcpassword|rpcport|rpchost)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export class RpcClient {
  #url;
  #auth;
  #timeoutMs;

  /**
   * @param {object} options
   * @param {string} options.url       http(s) URL of the RPC server, without credentials
   * @param {string} [options.user]
   * @param {string} [options.password]
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, user, password, timeoutMs = 15000 }) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new RpcError('Put RPC credentials in the conf file or environment, not in the URL');
    }
    this.#url = parsed.href;
    this.#auth = user || password
      ? `Basic ${Buffer.from(`${user ?? ''}:${password ?? ''}`).toString('base64')}`
      : null;
    this.#timeoutMs = timeoutMs;
    this.label = `${parsed.protocol}//${parsed.host}`;
    /** Number of calls per method since the last resetCounts(). */
    this.counts = {};
  }

  resetCounts() {
    const counts = this.counts;
    this.counts = {};
    return counts;
  }

  async call(method, params = []) {
    if (!ALLOWED_METHODS.has(method)) {
      throw new RpcError(`RPC method "${method}" is not on the read-only allow-list`);
    }
    this.counts[method] = (this.counts[method] ?? 0) + 1;
    const headers = { 'content-type': 'application/json' };
    if (this.#auth) headers.authorization = this.#auth;
    let response;
    try {
      response = await fetch(this.#url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '1.0', id: method, method, params }),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new RpcError(`${method}: ${error.cause?.code ?? error.name}`);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // The daemon sends an empty or HTML body for 401 and some other errors.
    }
    if (body?.error) {
      const error = new RpcError(`${method}: ${String(body.error.message ?? 'error').slice(0, 200)}`);
      error.fromDaemon = true; // The daemon answered; the connection works.
      throw error;
    }
    if (!response.ok || !body || !('result' in body)) {
      throw new RpcError(`${method}: HTTP ${response.status}`);
    }
    return body.result;
  }
}
