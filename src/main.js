#!/usr/bin/env node
// Entry point: node src/main.js [--config path] [--chain VRSC|VRSCTEST] [--once]

import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Publisher } from './publisher.js';
import { createPriceServer, publisherRoutes } from './server.js';

const log = (level, message) => {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    chain: { type: 'string' },
    once: { type: 'boolean', default: false },
  },
});

let config;
try {
  config = loadConfig({ configPath: values.config, chain: values.chain });
} catch (error) {
  log('error', error.message);
  process.exit(2);
}

const publisher = new Publisher(config, { log });
log('info', `chain ${config.chain.name}, RPC ${config.chain.rpc.label}, output ${publisher.path}`);

await publisher.loadExisting();

if (values.once) {
  try {
    const ok = await publisher.tick({ force: true });
    process.exit(ok ? 0 : 1);
  } catch (error) {
    log('error', error.message);
    process.exit(1);
  }
}

let server = null;
if (config.http) {
  server = createPriceServer(publisherRoutes(publisher));
  server.on('error', (error) => {
    log('error', `HTTP server: ${error.message}`);
    process.exit(1);
  });
  server.listen(config.http.port, config.http.host, () => {
    log('info', `serving http://${config.http.host}:${server.address().port}/v1/`);
  });
}

let timer = null;
let stopping = false;
const loop = async () => {
  try {
    await publisher.tick();
  } catch (error) {
    log('error', error.message);
    process.exit(1);
  }
  if (!stopping) timer = setTimeout(loop, config.pollMs);
};

const stop = (signal) => {
  log('info', `${signal}: stopping`);
  stopping = true;
  clearTimeout(timer);
  if (server) server.close();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

loop();
