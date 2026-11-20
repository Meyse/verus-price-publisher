// Optional HTTP server. It serves only /v1/prices.json, only for GET and HEAD.

import { createServer } from 'node:http';

export const PATH = '/v1/prices.json';

/** @param {() => Buffer|null} getBody */
export function createPriceServer(getBody) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const path = (req.url ?? '').split('?')[0];
    if (path !== PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed\n');
      return;
    }
    const body = getBody();
    if (!body) {
      res.writeHead(503, { 'Retry-After': '30', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'public, max-age=30',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}
