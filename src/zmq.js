// A minimal ZMQ subscriber on node:net: ZMTP 3.0 (rfc.zeromq.org/spec/23), NULL mechanism,
// socket type SUB, one subscription. Each complete message whose first frame is the topic
// calls onMessage(). The message content is not used: it is only a trigger to check the
// daemon. Input is bounded: a frame over MAX_FRAME, a message over MAX_FRAMES frames, or
// anything malformed drops the connection.

import { connect as netConnect } from 'node:net';

const GREETING_SIZE = 64;
const MAX_FRAME = 4096; // body bytes; hashblock frames are 9, 32 and 4 bytes
const MAX_FRAMES = 16; // frames per message
const HANDSHAKE_MS = 10000;
const RECONNECT_MS = 5000;

const FLAG_MORE = 0x01;
const FLAG_LONG = 0x02;
const FLAG_COMMAND = 0x04;

// Greeting: signature (FF, 8 padding, 7F), version 3.0, mechanism "NULL" padded to 20
// octets, as-server 0, 31 octets of filler.
function greeting() {
  const out = Buffer.alloc(GREETING_SIZE);
  out[0] = 0xff;
  out[9] = 0x7f;
  out[10] = 3;
  out[11] = 0;
  out.write('NULL', 12, 'latin1');
  return out;
}

// A short frame (body up to 255 octets).
function shortFrame(flags, body) {
  return Buffer.concat([Buffer.from([flags, body.length]), body]);
}

// READY command with the Socket-Type property.
function ready(socketType) {
  const name = Buffer.from('Socket-Type', 'latin1');
  const value = Buffer.from(socketType, 'latin1');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(value.length);
  return shortFrame(FLAG_COMMAND, Buffer.concat([
    Buffer.from([5]), Buffer.from('READY', 'latin1'), Buffer.from([name.length]), name, size, value,
  ]));
}

// ZMTP 3.0 subscription: a one-frame message, %x01 followed by the topic.
function subscribe(topic) {
  return shortFrame(0, Buffer.concat([Buffer.from([1]), topic]));
}

// Peer text for a log line: printable ASCII only, at most 100 characters.
const printable = (octets) => octets.toString('latin1').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);

// Parse READY metadata into a map of lower-case names to values. Throws on bad input.
function metadata(data) {
  const props = new Map();
  let at = 0;
  while (at < data.length) {
    const nameLength = data[at];
    if (nameLength === 0 || at + 1 + nameLength + 4 > data.length) throw new Error('bad READY metadata');
    const name = data.toString('latin1', at + 1, at + 1 + nameLength).toLowerCase();
    at += 1 + nameLength;
    const valueLength = data.readUInt32BE(at);
    at += 4;
    if (valueLength > data.length - at) throw new Error('bad READY metadata');
    props.set(name, data.subarray(at, at + valueLength));
    at += valueLength;
  }
  return props;
}

/** Parse and check a `tcp://host:port` address. Returns { host, port } or throws. */
export function parseZmqAddress(address) {
  if (typeof address !== 'string' || !address.startsWith('tcp://')) {
    throw new Error('must be tcp://host:port');
  }
  let url;
  try {
    url = new URL(address);
  } catch {
    throw new Error('must be tcp://host:port');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (!host || host === '*' || !Number.isInteger(port) || port < 1 || port > 65535
    || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('must be tcp://host:port');
  }
  return { host, port };
}

export class ZmqSubscriber {
  /**
   * @param {object} options
   * @param {string} options.address tcp://host:port
   * @param {string} [options.topic]
   * @param {() => void} options.onMessage
   * @param {() => void} [options.onConnect] after the handshake and the subscription
   * @param {() => void} [options.onDisconnect] when a connected link is lost
   * @param {(level: string, message: string) => void} [options.log]
   * @param {Function} [options.connect] net.connect
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   */
  constructor({
    address, topic = 'hashblock', onMessage, onConnect = () => {}, onDisconnect = () => {}, log = () => {},
    connect = netConnect, setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    this.address = address;
    this.target = parseZmqAddress(address);
    this.topic = Buffer.from(topic, 'latin1');
    this.onMessage = onMessage;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.log = log;
    this.netConnect = connect;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.socket = null;
    this.connected = false; // handshake done and subscribed
    this.downLogged = false; // "not connected" was logged since the last connect
    this.stopped = true;
    this.handshakeTimer = null;
    this.reconnectTimer = null;
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer);
    if (this.handshakeTimer) this.clearTimer(this.handshakeTimer);
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.socket?.destroy();
  }

  open() {
    this.reconnectTimer = null;
    if (this.stopped) return;
    this.buffer = Buffer.alloc(0);
    this.state = 'greeting'; // greeting -> handshake -> ready
    this.frames = [];
    this.reason = 'closed';
    const socket = this.netConnect({ host: this.target.host, port: this.target.port });
    this.socket = socket;
    this.handshakeTimer = this.setTimer(() => this.drop('no handshake within 10 s'), HANDSHAKE_MS);
    socket.on('connect', () => {
      socket.setKeepAlive(true, 60000);
      socket.write(greeting());
    });
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (error) => { this.reason = error.code ?? error.message; });
    socket.on('close', () => this.closed(socket));
  }

  drop(reason) {
    this.reason = reason;
    this.socket?.destroy();
  }

  closed(socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    if (this.handshakeTimer) this.clearTimer(this.handshakeTimer);
    this.handshakeTimer = null;
    const was = this.connected;
    this.connected = false;
    if (this.stopped) return; // a stop is not a lost connection
    if (was) {
      this.log('warn', `ZMQ ${this.address}: disconnected (${this.reason}); polling until it is back`);
      this.downLogged = true;
      this.onDisconnect();
    } else if (!this.downLogged) {
      this.log('warn', `ZMQ ${this.address}: cannot connect (${this.reason}); polling until it connects`);
      this.downLogged = true;
    }
    this.reconnectTimer = this.setTimer(() => this.open(), RECONNECT_MS);
  }

  receive(chunk) {
    if (this.socket === null) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (this.socket !== null && this.step());
    } catch (error) {
      this.drop(error.message);
    }
  }

  // Consume one greeting or one frame from the buffer. Returns false when more data is needed.
  // The buffer never holds more than one frame header and MAX_FRAME body octets unparsed.
  step() {
    const buf = this.buffer;
    if (this.state === 'greeting') {
      if (buf.length < GREETING_SIZE) return false;
      if (buf[0] !== 0xff || (buf[9] & 0x01) !== 1) throw new Error('not a ZMTP peer');
      if (buf[10] < 3) throw new Error(`ZMTP ${buf[10]} peer, need 3.0 or later`);
      const mechanism = buf.subarray(12, 32);
      if (!mechanism.equals(greeting().subarray(12, 32))) throw new Error('mechanism is not NULL');
      this.buffer = buf.subarray(GREETING_SIZE);
      this.state = 'handshake';
      this.socket.write(ready('SUB'));
      return true;
    }
    if (buf.length < 2) return false;
    const flags = buf[0];
    if (flags & 0xf8) throw new Error('reserved frame flag bits set');
    const long = (flags & FLAG_LONG) !== 0;
    const header = long ? 9 : 2;
    if (buf.length < header) return false;
    const size = long ? buf.readBigUInt64BE(1) : BigInt(buf[1]);
    if (size > BigInt(MAX_FRAME)) throw new Error(`frame of ${size} octets is over the limit`);
    const end = header + Number(size);
    if (buf.length < end) return false;
    const body = buf.subarray(header, end);
    this.buffer = buf.subarray(end);
    if (flags & FLAG_COMMAND) {
      if (flags & FLAG_MORE) throw new Error('command frame with MORE flag');
      if (this.frames.length) throw new Error('command inside a message');
      this.command(body);
      return true;
    }
    if (this.state !== 'ready') throw new Error('message before READY');
    this.frames.push(body);
    if (this.frames.length > MAX_FRAMES || (this.frames.length === MAX_FRAMES && (flags & FLAG_MORE))) {
      throw new Error('message with too many frames');
    }
    if (!(flags & FLAG_MORE)) {
      const [first] = this.frames;
      this.frames = [];
      if (first.equals(this.topic)) this.onMessage();
    }
    return true;
  }

  command(body) {
    const nameLength = body[0];
    if (!nameLength || 1 + nameLength > body.length) throw new Error('bad command');
    const name = body.toString('latin1', 1, 1 + nameLength);
    const data = body.subarray(1 + nameLength);
    if (name === 'ERROR') throw new Error(`peer sent ERROR: ${printable(data.subarray(1, 1 + (data[0] ?? 0)))}`);
    if (name === 'PING' && this.state === 'ready') {
      // Heartbeat (ZMTP 3.1, sent by libzmq publishers with heartbeats on): answer PONG with
      // the ping's context (the octets after the 2-octet TTL).
      this.socket.write(shortFrame(FLAG_COMMAND, Buffer.concat([Buffer.from([4]), Buffer.from('PONG', 'latin1'), data.subarray(2, 18)])));
      return;
    }
    if (name !== 'READY') {
      if (this.state !== 'ready') throw new Error(`unexpected ${printable(Buffer.from(name, 'latin1'))} command`);
      return; // other commands after the handshake are ignored
    }
    if (this.state !== 'handshake') throw new Error('second READY');
    const type = metadata(data).get('socket-type')?.toString('latin1');
    if (type !== 'PUB' && type !== 'XPUB') throw new Error(`peer socket type ${type ?? 'missing'}, need PUB or XPUB`);
    this.state = 'ready';
    if (this.handshakeTimer) this.clearTimer(this.handshakeTimer);
    this.handshakeTimer = null;
    this.socket.write(subscribe(this.topic));
    this.connected = true;
    this.downLogged = false;
    this.log('info', `ZMQ ${this.address}: connected, subscribed to "${this.topic.toString('latin1')}"`);
    this.onConnect();
  }
}
