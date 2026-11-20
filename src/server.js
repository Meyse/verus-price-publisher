// Optional HTTP server. It serves only a fixed set of paths, only for GET and HEAD.
// Each path has an in-memory body and its own Cache-Control max-age.

import { createServer } from 'node:http';

export const PATH = '/v1/prices.json';

/**
 * @param {Map<string, {body: () => Buffer|null, maxAge: number}>} routes
 */
export function createPriceServer(routes) {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const route = routes.get((req.url ?? '').split('?')[0]);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed\n');
      return;
    }
    const body = route.body();
    if (!body) {
      res.writeHead(503, { 'Retry-After': '30', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': `public, max-age=${route.maxAge}`,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  return server;
}

// The routes of a Publisher: the live file and, when history is on, the three history files.
export function publisherRoutes(publisher) {
  const routes = new Map([[PATH, { body: () => publisher.body, maxAge: 30 }]]);
  if (publisher.history) {
    const maxAge = { hour: 300, day: 3600, week: 3600 };
    for (const resolution of ['hour', 'day', 'week']) {
      routes.set(`/v1/history/${resolution}.json`, {
        body: () => publisher.history.body(resolution), maxAge: maxAge[resolution],
      });
    }
  }
  return routes;
}
