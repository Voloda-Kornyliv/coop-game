// Peer-to-peer sessions over PeerJS (WebRTC). The host's browser registers on
// the public PeerJS server under an ID derived from the game code; guests
// connect to it directly. Messages are JSON strings: serialized once per
// broadcast, parsed defensively on arrival.

/* global Peer */

import { MAX_PLAYERS } from './game/config.js';

const ID_PREFIX = 'coopgame-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O/1/I confusion
export const CODE_LENGTH = 5;
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 8000;                // silence for this long = disconnected
const MAX_BUFFERED = 256 * 1024;        // skip droppable messages to a backed-up peer

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function parse(data) {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg.type === 'string' ? msg : null;
  } catch {
    return null;
  }
}

class Emitter {
  constructor() { this.handlers = {}; }
  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  emit(type, ...args) { for (const fn of this.handlers[type] || []) fn(...args); }
}

const cleanName = (name) => String(name || 'Player').trim().slice(0, 20) || 'Player';
const cleanHat = (hat) => (typeof hat === 'string' ? hat.slice(0, 8) : '');

// ---------------------------------------------------------------------------

export class HostSession extends Emitter {
  constructor({ name, hat }) {
    super();
    this.name = name;
    this.hat = hat;
    this.players = [];                  // [{ id, name, hat, isHost }]
    this.guests = new Map();            // peer id -> { conn, lastSeen }
    this.closed = false;
  }

  open(attempt = 0) {
    const code = makeCode();
    const peer = new Peer(ID_PREFIX + code);
    this.peer = peer;

    peer.on('open', (id) => {
      this.id = id;
      this.code = code;
      this.players = [{ id, name: this.name, hat: this.hat, isHost: true }];
      this.heartbeat = setInterval(() => this.tickHeartbeat(), HEARTBEAT_MS);
      this.emit('open', code);
      this.emit('players', this.players);
    });

    peer.on('connection', (conn) => {
      conn.on('data', (data) => this.onData(conn, parse(data)));
      conn.on('close', () => this.removeGuest(conn.peer));
      conn.on('error', () => this.removeGuest(conn.peer));
    });

    peer.on('error', (err) => {
      if (peer !== this.peer || this.closed) return;
      if (err.type === 'unavailable-id' && attempt < 5) {
        peer.destroy();
        this.open(attempt + 1);           // code collision: try another
      } else if (!this.id) {
        this.emit('error', `Could not create game (${err.type}).`);
      }
    });

    // Lost the signaling server: running games keep working, but reconnect
    // so new players can still find us.
    peer.on('disconnected', () => {
      setTimeout(() => { if (peer === this.peer && !peer.destroyed && !this.closed) peer.reconnect(); }, 1000);
    });
  }

  onData(conn, msg) {
    if (!msg || this.closed) return;
    const guest = this.guests.get(conn.peer);
    if (guest) guest.lastSeen = Date.now();

    switch (msg.type) {
      case 'join': {
        if (guest) return;
        if (this.players.length >= MAX_PLAYERS) {
          conn.send(JSON.stringify({ type: 'rejected', reason: 'Game is full.' }));
          setTimeout(() => conn.close(), 500);
          return;
        }
        const player = { id: conn.peer, name: cleanName(msg.name), hat: cleanHat(msg.hat), isHost: false };
        this.guests.set(conn.peer, { conn, lastSeen: Date.now() });
        this.players.push(player);
        conn.send(JSON.stringify({ type: 'welcome', code: this.code }));
        this.broadcastPlayers();
        this.emit('join', player);
        break;
      }
      case 'leave':
        this.removeGuest(conn.peer);
        break;
      case 'hat': {
        const p = this.players.find((o) => o.id === conn.peer);
        if (p) { p.hat = cleanHat(msg.hat); this.broadcastPlayers(); }
        break;
      }
      case 'ping':
        break;
      default:
        if (guest) this.emit('message', conn.peer, msg);
    }
  }

  setHat(hat) {
    this.hat = hat;
    if (this.players[0]) this.players[0].hat = hat;
    this.broadcastPlayers();
  }

  removeGuest(id) {
    const guest = this.guests.get(id);
    if (!guest) return;
    this.guests.delete(id);
    guest.conn.close();
    this.players = this.players.filter((p) => p.id !== id);
    this.broadcastPlayers();
    this.emit('leave', id);
  }

  tickHeartbeat() {
    const now = Date.now();
    for (const [id, g] of this.guests) if (now - g.lastSeen > TIMEOUT_MS) this.removeGuest(id);
    this.broadcastPlayers();
  }

  broadcastPlayers() {
    this.broadcast({ type: 'players', players: this.players });
    this.emit('players', this.players);
  }

  sendRaw(id, data, droppable) {
    const g = this.guests.get(id);
    if (!g || !g.conn.open) return;
    if (droppable && g.conn.dataChannel?.bufferedAmount > MAX_BUFFERED) return;
    try { g.conn.send(data); } catch { /* channel closing; heartbeat cleans up */ }
  }

  send(id, msg, { droppable = false } = {}) {
    this.sendRaw(id, JSON.stringify(msg), droppable);
  }

  broadcast(msg, { droppable = false } = {}) {
    if (!this.guests.size) return;
    const data = JSON.stringify(msg);
    for (const id of this.guests.keys()) this.sendRaw(id, data, droppable);
  }

  close() {
    if (this.closed) return;
    this.broadcast({ type: 'ended' });
    this.closed = true;
    clearInterval(this.heartbeat);
    const peer = this.peer;
    setTimeout(() => peer?.destroy(), 200);  // let the goodbye go out first
  }
}

// ---------------------------------------------------------------------------

export class GuestSession extends Emitter {
  constructor({ name, hat, code }) {
    super();
    this.name = name;
    this.hat = hat;
    this.code = code;
    this.players = [];
    this.closed = false;
    this.lastSeen = 0;
  }

  open() {
    const peer = new Peer();
    this.peer = peer;

    peer.on('open', (id) => {
      this.id = id;
      const conn = peer.connect(ID_PREFIX + this.code, { reliable: true, serialization: 'raw' });
      this.conn = conn;
      const timeout = setTimeout(() => this.fail(`Could not reach game ${this.code}.`), 15000);

      conn.on('open', () => {
        clearTimeout(timeout);
        this.send({ type: 'join', name: this.name, hat: this.hat });
      });
      conn.on('data', (data) => this.onData(parse(data)));
      conn.on('close', () => this.fail('Lost connection to the host.'));
    });

    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') this.fail(`No game found with code ${this.code}.`);
      else this.fail(`Connection error (${err.type}).`);
    });
  }

  onData(msg) {
    if (!msg || this.closed) return;
    this.lastSeen = Date.now();
    switch (msg.type) {
      case 'welcome':
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastSeen > TIMEOUT_MS) this.fail('Lost connection to the host.');
          else this.send({ type: 'ping' });
        }, HEARTBEAT_MS);
        this.emit('open', msg.code);
        break;
      case 'players':
        this.players = Array.isArray(msg.players) ? msg.players : [];
        this.emit('players', this.players);
        break;
      case 'rejected':
        this.fail(String(msg.reason || 'Rejected by host.'));
        break;
      case 'ended':
        this.fail('The host ended the game.');
        break;
      default:
        this.emit('message', msg);
    }
  }

  send(msg) {
    if (this.conn?.open) {
      try { this.conn.send(JSON.stringify(msg)); } catch { /* closing */ }
    }
  }

  setHat(hat) {
    this.hat = hat;
    this.send({ type: 'hat', hat });
  }

  fail(reason) {
    if (this.closed) return;
    this.cleanup();
    this.emit('closed', reason);
  }

  close() {
    if (this.closed) return;
    this.send({ type: 'leave' });
    this.cleanup();
  }

  cleanup() {
    this.closed = true;
    clearInterval(this.heartbeat);
    const peer = this.peer;
    setTimeout(() => peer?.destroy(), 200);
  }
}
