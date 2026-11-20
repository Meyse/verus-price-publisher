#!/usr/bin/env node
// Entry point: node src/main.js [--config path] [--chain VRSC|VRSCTEST] [--once]

import { unwatchFile, watchFile } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Loop } from './loop.js';
import { Publisher } from './publisher.js';
import { createPriceServer, publisherRoutes } from './server.js';
import { ZmqSubscriber } from './zmq.js';

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

const loop = new Loop(publisher, {
  pollMs: config.pollMs,
  onFatal: (error) => {
    log('error', error.message);
    process.exit(1);
  },
});

// Block notification: the daemon's blocknotify command touches this file. The service
// only reads the file's time (a stat once per second, no RPC call), and then checks.
const notifyFile = config.blockNotifyFile;
if (notifyFile) {
  watchFile(notifyFile, { interval: 1000 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs) loop.notify();
  });
  log('info', `block notification: watching ${notifyFile}; safety poll every ${config.pollMs / 1000} s`);
}

// Block notification over ZMQ: each "hashblock" message starts a check. While connected
// only the safety poll runs; while not connected, the normal poll.
let zmq = null;
if (config.blockNotifyZmq) {
  zmq = new ZmqSubscriber({
    address: config.blockNotifyZmq,
    log,
    onMessage: () => loop.notify(),
    onConnect: () => loop.setPoll(config.safetyPollMs),
    onDisconnect: () => loop.setPoll(config.pollMs),
  });
  zmq.start();
  log('info', `block notification: ZMQ ${config.blockNotifyZmq}; poll every ${config.pollMs / 1000} s until `
    + `connected, then every ${config.safetyPollMs / 1000} s`);
}

const stop = (signal) => {
  log('info', `${signal}: stopping`);
  loop.stop();
  zmq?.stop();
  if (notifyFile) unwatchFile(notifyFile);
  if (server) server.close();
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

loop.start();
