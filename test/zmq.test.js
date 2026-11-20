import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { Loop } from '../src/loop.js';
import { Publisher } from '../src/publisher.js';
import { ZmqSubscriber } from '../src/zmq.js';
import { fakeDaemon } from './fake-daemon.js';

// Octets written out from the ZMTP 3.0 grammar (rfc.zeromq.org/spec/23). Numbers are
// octets, strings are their ASCII octets.
const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from([p]))));
const zeros = (n) => Buffer.alloc(n);
// signature: %xFF, 8 padding octets, %x7F; version 3.0; "NULL" padded to 20; as-server 0; 31 filler.
const SUB_GREETING = Buffer.concat([bytes(0xff), zeros(8), bytes(0x7f, 3, 0, 'NULL'), zeros(16), bytes(0), zeros(31)]);
// A libzmq 4.3 publisher announces 3.1; padding is not significant.
const PUB_GREETING = Buffer.concat([bytes(0xff), zeros(7), bytes(1, 0x7f, 3, 1, 'NULL'), zeros(16), bytes(0), zeros(31)]);
// READY command: flags %x04, size 25, %d5 "READY", 11 "Socket-Type", value size 3 (4 octets BE), value.
const SUB_READY = bytes(0x04, 25, 5, 'READY', 11, 'Socket-Type', 0, 0, 0, 3, 'SUB');
const PUB_READY = bytes(0x04, 25, 5, 'READY', 11, 'Socket-Type', 0, 0, 0, 3, 'PUB');
// SUBSCRIBE message (ZMTP 3.0): %x00 short-size %d1 subscription.
const SUBSCRIBE = bytes(0x00, 10, 1, 'hashblock');
// The daemon's message: "hashblock", 32-octet hash, 4-octet LE sequence (MORE, MORE, last).
const HASHBLOCK = Buffer.concat([bytes(0x01, 9, 'hashblock', 0x01, 32), Buffer.alloc(32, 0xab), bytes(0x00, 4, 7, 0, 0, 0)]);

const until = async (condition, what) => {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5)); // waits for socket I/O only
  }
  assert.fail(`timed out waiting for ${what}`);
};

// A local TCP peer that plays the publisher side.
async function publisherPeer(t) {
  const peer = { connections: [] };
  peer.server = createServer((socket) => {
    const c = { socket, data: Buffer.alloc(0), closed: false };
    socket.setNoDelay(true);
    socket.on('data', (d) => { c.data = Buffer.concat([c.data, d]); });
    socket.on('close', () => { c.closed = true; });
    socket.on('error', () => {});
    peer.connections.push(c);
  }).listen(0, '127.0.0.1');
  await once(peer.server, 'listening');
  t.after(() => { peer.connections.forEach((c) => c.socket.destroy()); peer.server.close(); });
  peer.address = `tcp://127.0.0.1:${peer.server.address().port}`;
  peer.last = () => peer.connections[peer.connections.length - 1];
  // Accept the next connection and complete the handshake from the publisher side.
  peer.handshake = async () => {
    const count = peer.connections.length;
    await until(() => peer.connections.length > count, 'a connection');
    const c = peer.last();
    c.socket.write(PUB_GREETING);
    c.socket.write(PUB_READY);
    await until(() => c.data.length >= 64 + SUB_READY.length + SUBSCRIBE.length, 'the subscription');
    return c;
  };
  return peer;
}

function subscriber(address, extra = {}) {
  const s = { messages: 0, logs: [], timers: [], events: [] };
  s.sub = new ZmqSubscriber({
    address,
    onMessage: () => { s.messages += 1; extra.onMessage?.(); },
    onConnect: () => { s.events.push('connect'); extra.onConnect?.(); },
    onDisconnect: () => { s.events.push('disconnect'); extra.onDisconnect?.(); },
    log: (level, message) => s.logs.push(`${level} ${message}`),
    setTimer: (fn, ms) => { const timer = { fn, ms }; s.timers.push(timer); return timer; },
    clearTimer: (timer) => { s.timers = s.timers.filter((x) => x !== timer); },
  });
  return s;
}

test('ZMQ: handshake and subscription bytes; a hashblock message, also split across TCP chunks, is a trigger', async (t) => {
  const peer = await publisherPeer(t);
  const s = subscriber(peer.address);
  t.after(() => s.sub.stop());
  s.sub.start();
  const c = await peer.handshake();
  assert.deepEqual(c.data, Buffer.concat([SUB_GREETING, SUB_READY, SUBSCRIBE]));
  assert.deepEqual(s.events, ['connect']);

  c.socket.write(HASHBLOCK);
  await until(() => s.messages === 1, 'one trigger');
  for (const octet of HASHBLOCK) { // one octet per write
    c.socket.write(Buffer.from([octet]));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await until(() => s.messages === 2, 'the split message');
  // Another topic is not a trigger; a hashblock message with fewer frames still is.
  c.socket.write(bytes(0x01, 8, 'rawblock', 0x00, 1, 0));
  c.socket.write(bytes(0x00, 9, 'hashblock'));
  await until(() => s.messages === 3, 'the one-frame message');
  assert.equal(c.closed, false);
  // PING (ZMTP 3.1 heartbeat): %d4 "PING", 2-octet TTL, context "ab" -> PONG with "ab".
  const before = c.data.length;
  c.socket.write(bytes(0x04, 9, 4, 'PING', 0, 10, 'ab'));
  await until(() => c.data.length >= before + 9, 'the PONG');
  assert.deepEqual(c.data.subarray(before), bytes(0x04, 7, 4, 'PONG', 'ab'));

  s.sub.stop(); // clean shutdown: the socket closes, no reconnect, no disconnect log
  await until(() => c.closed, 'the close on stop');
  assert.deepEqual([s.events, s.timers, s.logs.filter((l) => l.startsWith('warn'))], [['connect'], [], []]);
});

test('ZMQ: an oversize or malformed frame drops the connection; a refused connection is logged once', async (t) => {
  const peer = await publisherPeer(t);
  const cases = {
    'frame of 1048576 octets': bytes(0x02, 0, 0, 0, 0, 0, 0x10, 0, 0), // long frame header, 1 MiB
    'reserved frame flag bits': bytes(0x08, 0),
    'command frame with MORE': bytes(0x05, 0),
    // 16 frames, the last one with MORE: a 17th frame would follow.
    'message with too many frames': Buffer.concat(Array.from({ length: 16 }, () => bytes(0x01, 1, 'x'))),
    // ERROR command, reason "bad\nline": the log line keeps no control character.
    'peer sent ERROR: bad?line': bytes(0x04, 15, 5, 'ERROR', 8, 'bad\nline'),
  };
  for (const [reason, frame] of Object.entries(cases)) {
    const s = subscriber(peer.address);
    s.sub.start();
    const c = await peer.handshake();
    c.socket.write(frame);
    await until(() => c.closed, `drop on ${reason}`);
    assert.deepEqual(s.events, ['connect', 'disconnect']);
    assert.ok(s.logs.some((l) => l.includes(reason)), s.logs.join('\n'));
    assert.deepEqual(s.timers.map((x) => x.ms), [5000]); // reconnect after a fixed wait
    s.sub.stop();
  }

  // A message before READY: dropped during the handshake.
  const early = subscriber(peer.address);
  early.sub.start();
  await until(() => peer.connections.length === 6, 'a connection');
  peer.last().socket.write(Buffer.concat([PUB_GREETING, bytes(0x00, 0)]));
  await until(() => peer.last().closed, 'drop on a message before READY');
  assert.deepEqual(early.events, []);
  early.sub.stop();

  const closed = createServer().listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const { port } = closed.address();
  closed.close();
  const refused = subscriber(`tcp://127.0.0.1:${port}`);
  refused.sub.start();
  await until(() => refused.timers.some((x) => x.ms === 5000), 'a reconnect timer');
  refused.timers.find((x) => x.ms === 5000).fn(); // second attempt, also refused
  await until(() => refused.timers.filter((x) => x.ms === 5000).length === 2, 'a second reconnect timer');
  assert.equal(refused.logs.filter((l) => l.includes('cannot connect')).length, 1);
  refused.sub.stop();
});

test('ZMQ with the loop: a message starts one cycle; disconnect falls back to polling, reconnect to the safety poll', async (t) => {
  const daemon = await fakeDaemon();
  t.after(() => daemon.server.close());
  const peer = await publisherPeer(t);
  const dir = await mkdtemp(join(tmpdir(), 'vpp-zmq-'));
  const config = loadConfig({ chain: 'VRSC', env: { VERUS_RPC_URL: `http://127.0.0.1:${daemon.port}`, OUT_DIR: dir, BLOCK_NOTIFY_ZMQ: peer.address } });
  assert.deepEqual([config.pollMs, config.safetyPollMs], [30000, 300000]);

  const T = 1790000100 * 1000;
  let clock = T;
  let timers = [];
  const published = [];
  const publisher = new Publisher(config, {
    now: () => clock,
    log: (level, message) => { if (message.startsWith('published')) published.push([message.split(':')[0], clock - T]); },
  });
  const loop = new Loop(publisher, {
    pollMs: config.pollMs,
    onFatal: (error) => { throw error; },
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timers = timers.filter((x) => x !== timer); },
  });
  const planned = () => timers.map((x) => x.at - T);
  const fire = async () => { const [timer] = timers.splice(0, 1); clock = Math.max(clock, timer.at); await timer.fn(); };

  const s = subscriber(peer.address, {
    onMessage: () => loop.notify(),
    onConnect: () => loop.setPoll(config.safetyPollMs),
    onDisconnect: () => loop.setPoll(config.pollMs),
  });
  t.after(() => s.sub.stop());
  loop.start();
  await fire(); // first cycle at T, before ZMQ is connected
  assert.deepEqual(planned(), [60000]); // normal poll (30 s), not before the 60 s interval
  s.sub.start();
  const c = await peer.handshake();
  await fire(); // 60 s: same block
  assert.deepEqual(planned(), [360000]); // connected: safety poll only

  daemon.hash = 'bb';
  daemon.height = 101;
  c.socket.write(HASHBLOCK);
  await until(() => planned()[0] === 61000, 'a check after the message');
  await fire();
  assert.deepEqual(published, [['published height 100', 0], ['published height 101', 61000]]);

  c.socket.destroy(); // the daemon goes away
  await until(() => s.events.includes('disconnect'), 'the disconnect');
  assert.deepEqual(planned(), [121000]); // normal poll again: 61 s + 60 s interval
  assert.equal(s.logs.filter((l) => l.includes('disconnected')).length, 1);

  s.timers.find((x) => x.ms === 5000).fn(); // reconnect after the fixed wait
  await peer.handshake();
  await fire(); // 121 s
  assert.deepEqual(planned(), [421000]); // connected again: safety poll
  assert.deepEqual(s.events, ['connect', 'disconnect', 'connect']);
});
