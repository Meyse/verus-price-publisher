// Read-only JSON-RPC client for verusd.
// Only the methods in ALLOWED_METHODS can be called. Credentials stay in this
// module: they go into the Authorization header and nowhere else.

import { readFileSync } from 'node:fs';

// Private on purpose: no other module can add a method.
const ALLOWED_METHODS = new Set([
  'getblockchaininfo',
  'getbestblockhash',
  'getblockheader',
  'getcurrency',
  'listcurrencies',
  'getcurrencystate', // only the range form, see call()
]);

// getcurrencystate is allowed only as (currency id, "start,end,step") with block heights.
const RANGE = /^\d{1,10},\d{1,10},\d{1,10}$/;

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
    if (method === 'getcurrencystate'
      && !(params.length === 2 && typeof params[0] === 'string' && RANGE.test(params[1]))) {
      throw new RpcError('getcurrencystate: only the range form (currency id, "start,end,step") is allowed');
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
      throw new RpcError(`${method}: ${error.cause?.code ?? error.cause?.message ?? error.name}`);
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      // The daemon sends an empty or HTML body for 401 and some other errors.
    }
    if (body?.error) {
      throw new RpcError(`${method}: ${String(body.error.message ?? 'error').slice(0, 200)}`);
    }
    if (!response.ok || !body || !('result' in body)) {
      throw new RpcError(`${method}: HTTP ${response.status}`);
    }
    return body.result;
  }
}
