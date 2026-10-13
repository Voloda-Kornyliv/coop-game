// Peer-to-peer sessions over PeerJS (WebRTC). The host's browser registers on
// the public PeerJS server under an ID derived from the game code; guests
// connect to it directly. Messages are JSON strings: serialized once per
// broadcast, parsed defensively on arrival.
//
// Connections drop (Wi-Fi blips, locked phones), so a dropped guest is never
// kicked straight away: the host keeps their slot for RECONNECT_WINDOW_MS and
// the guest keeps retrying. Guests are identified by a random token (kept in
// sessionStorage), not by their peer id, so even a page reload can rejoin as
// the same player.

/* global Peer */

import { MAX_PLAYERS } from './game/config.js';

const ID_PREFIX = 'coopgame-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O/1/I confusion
export const CODE_LENGTH = 5;
export const RECONNECT_WINDOW_MS = 60000;   // slot kept this long during a game
const LOBBY_WINDOW_MS = 15000;              // ...and this long in the lobby
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 8000;                // silence for this long = connection lost
const FIRST_ATTEMPT_TIMEOUT_MS = 15000;
const ATTEMPT_TIMEOUT_MS = 8000;        // one reconnection attempt
const MAX_BUFFERED = 256 * 1024;        // skip droppable messages to a backed-up peer

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
// Host
//
// Events: open(code), players(list), error(msg), join(player), leave(id),
//         away(id), back(id), reconnect(player), message(id, msg)

export class HostSession extends Emitter {
  constructor({ name, hat }) {
    super();
    this.name = name;
    this.hat = hat;
    this.players = [];                  // [{ id, name, hat, isHost, away }]
    this.guests = new Map();            // player id -> { conn, lastSeen, token, away, awaySince }
    this.connToPlayer = new Map();      // connection peer id -> player id
    this.closed = false;
    this.inGame = false;                // longer reconnect window while a game runs
    this.mode = 'ffa';
  }

  // ---- teams (section 2): fill alternately, players may switch, host shuffles.

  smallerTeam() {
    const counts = [0, 0];
    for (const p of this.players) counts[p.team]++;
    return counts[1] < counts[0] ? 1 : 0;
  }

  setMode(mode) {
    this.mode = mode === 'teams' ? 'teams' : 'ffa';
    this.broadcastPlayers();
  }

  setTeam(id, team) {
    const p = this.players.find((o) => o.id === id);
    if (!p || (team !== 0 && team !== 1)) return;
    p.team = team;
    this.broadcastPlayers();
  }

  shuffleTeams() {
    const order = [...this.players].sort(() => Math.random() - 0.5);
    order.forEach((p, i) => { p.team = i % 2; });
    this.broadcastPlayers();
  }

  // Team sizes may differ by at most 1 when the game starts.
  rebalanceTeams() {
    for (;;) {
      const a = this.players.filter((p) => p.team === 0), b = this.players.filter((p) => p.team === 1);
      if (Math.abs(a.length - b.length) <= 1) break;
      const big = a.length > b.length ? a : b;
      big[Math.floor(Math.random() * big.length)].team = a.length > b.length ? 1 : 0;
    }
    this.broadcastPlayers();
  }

  open(attempt = 0) {
    const code = makeCode();
    const peer = new Peer(ID_PREFIX + code);
    this.peer = peer;

    peer.on('open', (id) => {
      if (this.id) return;              // signaling reconnect, not a new game
      this.id = id;
      this.code = code;
      this.players = [{ id, name: this.name, hat: this.hat, isHost: true, away: false, team: 0 }];
      this.heartbeat = setInterval(() => this.tickHeartbeat(), HEARTBEAT_MS);
      this.emit('open', code);
      this.emit('players', this.players);
    });

    peer.on('connection', (conn) => {
      conn.on('data', (data) => this.onData(conn, parse(data)));
      conn.on('close', () => this.onConnLost(conn));
      conn.on('error', () => this.onConnLost(conn));
    });

    peer.on('error', (err) => {
      if (peer !== this.peer || this.closed) return;
      if (err.type === 'unavailable-id' && attempt < 5 && !this.id) {
        peer.destroy();
        this.open(attempt + 1);           // code collision: try another
      } else if (!this.id) {
        this.emit('error', `Could not create game (${err.type}).`);
      }
      // After the game exists, errors are about the signaling server only;
      // player connections are direct and keep working.
    });

    // Lost the signaling server: keep reconnecting so new/rejoining players
    // can still find us.
    peer.on('disconnected', () => {
      setTimeout(() => { if (peer === this.peer && !peer.destroyed && !this.closed) peer.reconnect(); }, 1000);
    });
  }

  playerIdFor(conn) {
    const id = this.connToPlayer.get(conn.peer);
    const guest = id && this.guests.get(id);
    return guest && guest.conn === conn ? id : null;
  }

  onData(conn, msg) {
    if (!msg || this.closed) return;
    const id = this.playerIdFor(conn);
    const guest = id && this.guests.get(id);
    if (guest) {
      guest.lastSeen = Date.now();
      if (guest.away) this.markBack(id);
    }

    switch (msg.type) {
      case 'join':
        if (!guest) this.onJoin(conn, msg);
        break;
      case 'leave':
        if (id) this.removeGuest(id);
        break;
      case 'hat': {
        const p = this.players.find((o) => o.id === id);
        if (p) { p.hat = cleanHat(msg.hat); this.broadcastPlayers(); }
        break;
      }
      case 'team':
        if (id && !this.inGame) this.setTeam(id, msg.team);
        break;
      case 'ping':
        break;
      default:
        if (id) this.emit('message', id, msg);
    }
  }

  onJoin(conn, msg) {
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';

    // Same token = the same player coming back: rebind their slot.
    for (const [id, g] of this.guests) {
      if (!token || g.token !== token) continue;
      if (g.conn !== conn) { try { g.conn.close(); } catch { /* already closed */ } }
      g.conn = conn;
      g.lastSeen = Date.now();
      this.connToPlayer.set(conn.peer, id);
      conn.send(JSON.stringify({ type: 'welcome', code: this.code, playerId: id }));
      const player = this.players.find((p) => p.id === id);
      if (g.away) this.markBack(id);
      else this.broadcastPlayers();
      this.emit('reconnect', player);
      return;
    }

    if (this.players.length >= MAX_PLAYERS) {
      conn.send(JSON.stringify({ type: 'rejected', reason: 'Game is full.' }));
      setTimeout(() => conn.close(), 500);
      return;
    }
    const player = { id: conn.peer, name: cleanName(msg.name), hat: cleanHat(msg.hat), isHost: false, away: false, team: this.smallerTeam() };
    this.guests.set(player.id, { conn, lastSeen: Date.now(), token, away: false, awaySince: 0 });
    this.connToPlayer.set(conn.peer, player.id);
    this.players.push(player);
    conn.send(JSON.stringify({ type: 'welcome', code: this.code, playerId: player.id }));
    this.broadcastPlayers();
    this.emit('join', player);
  }

  onConnLost(conn) {
    const id = this.playerIdFor(conn);
    if (id) this.markAway(id);
  }

  markAway(id) {
    const g = this.guests.get(id);
    if (!g || g.away || this.closed) return;
    g.away = true;
    g.awaySince = Date.now();
    const p = this.players.find((o) => o.id === id);
    if (p) p.away = true;
    this.broadcastPlayers();
    this.emit('away', id);
  }

  markBack(id) {
    const g = this.guests.get(id);
    if (!g || !g.away) return;
    g.away = false;
    const p = this.players.find((o) => o.id === id);
    if (p) p.away = false;
    this.broadcastPlayers();
    this.emit('back', id);
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
    try { guest.conn.close(); } catch { /* already closed */ }
    this.players = this.players.filter((p) => p.id !== id);
    this.broadcastPlayers();
    this.emit('leave', id);
  }

  tickHeartbeat() {
    const now = Date.now();
    for (const [id, g] of this.guests) {
      if (!g.away && now - g.lastSeen > TIMEOUT_MS) this.markAway(id);
      else if (g.away && now - g.awaySince > (this.inGame ? RECONNECT_WINDOW_MS : LOBBY_WINDOW_MS)) this.removeGuest(id);
    }
    this.broadcastPlayers();
  }

  broadcastPlayers() {
    this.broadcast({ type: 'players', players: this.players, mode: this.mode });
    this.emit('players', this.players, this.mode);
  }

  sendRaw(id, data, droppable) {
    const g = this.guests.get(id);
    if (!g || !g.conn.open) return;
    if (droppable && g.conn.dataChannel?.bufferedAmount > MAX_BUFFERED) return;
    try { g.conn.send(data); } catch { /* channel closing; heartbeat notices */ }
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
// Guest
//
// Events: open(code), players(list), message(msg), reconnecting(), reconnected(),
//         closed(reason)

export class GuestSession extends Emitter {
  constructor({ name, hat, code }) {
    super();
    this.name = name;
    this.hat = hat;
    this.code = code;
    this.players = [];
    this.closed = false;
    this.joined = false;          // got a welcome at least once
    this.reconnecting = false;
    this.lastSeen = 0;
    this.attempt = 0;

    const key = `coopgame-token-${code}`;
    try { this.token = sessionStorage.getItem(key); } catch { /* private mode */ }
    if (!this.token) {
      this.token = makeToken();
      try { sessionStorage.setItem(key, this.token); } catch { /* private mode */ }
    }
  }

  open() {
    this.connect();
  }

  // One connection attempt. Every handler checks it still belongs to the
  // current attempt, so late events from a dead attempt are ignored.
  connect() {
    if (this.closed) return;
    const attempt = ++this.attempt;
    const current = () => attempt === this.attempt && !this.closed;
    this.destroyPeer();

    const peer = new Peer();
    this.peer = peer;
    clearTimeout(this.attemptTimer);
    this.attemptTimer = setTimeout(() => {
      if (current()) this.connectionLost(`Could not reach game ${this.code}.`);
    }, this.joined ? ATTEMPT_TIMEOUT_MS : FIRST_ATTEMPT_TIMEOUT_MS);

    peer.on('open', () => {
      if (!current()) return;
      const conn = peer.connect(ID_PREFIX + this.code, { reliable: true, serialization: 'raw' });
      this.conn = conn;
      conn.on('open', () => {
        if (current()) this.send({ type: 'join', name: this.name, hat: this.hat, token: this.token });
      });
      conn.on('data', (data) => { if (current()) this.onData(parse(data)); });
      conn.on('close', () => { if (current()) this.connectionLost('Lost connection to the host.'); });
      conn.on('error', () => { if (current()) this.connectionLost('Lost connection to the host.'); });
    });

    peer.on('error', (err) => {
      if (!current()) return;
      if (this.joined) {
        // Signaling-server trouble doesn't affect an open data connection.
        if (!this.conn?.open) this.connectionLost('Lost connection to the host.');
        return;
      }
      if (err.type === 'peer-unavailable') this.fail(`No game found with code ${this.code}.`);
      else this.fail(`Connection error (${err.type}).`);
    });
  }

  onData(msg) {
    if (!msg || this.closed) return;
    this.lastSeen = Date.now();
    switch (msg.type) {
      case 'welcome': {
        clearTimeout(this.attemptTimer);
        if (typeof msg.playerId === 'string') this.id = msg.playerId;
        clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => this.tickHeartbeat(), HEARTBEAT_MS);
        const wasReconnecting = this.reconnecting;
        this.reconnecting = false;
        if (!this.joined) {
          this.joined = true;
          this.emit('open', msg.code);
        } else if (wasReconnecting) {
          this.emit('reconnected');
        }
        break;
      }
      case 'players':
        this.players = Array.isArray(msg.players) ? msg.players : [];
        this.mode = msg.mode === 'teams' ? 'teams' : 'ffa';
        this.emit('players', this.players, this.mode);
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

  tickHeartbeat() {
    if (this.reconnecting) return;
    const silent = Date.now() - this.lastSeen;
    // A phone waking up may have queued data; give an open channel extra time.
    if (silent > (this.conn?.open ? TIMEOUT_MS * 1.5 : TIMEOUT_MS)) this.connectionLost('Lost connection to the host.');
    else this.send({ type: 'ping' });
  }

  connectionLost(reason) {
    if (this.closed) return;
    if (!this.joined) { this.fail(reason); return; }
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.reconnectDeadline = Date.now() + RECONNECT_WINDOW_MS;
      clearInterval(this.heartbeat);
      this.emit('reconnecting');
    }
    if (Date.now() > this.reconnectDeadline) {
      this.fail(reason);
      return;
    }
    // Retry shortly; each attempt has its own timeout that calls back here.
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), 1000);
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

  setTeam(id, team) {
    this.send({ type: 'team', team });
  }

  fail(reason) {
    if (this.closed) return;
    this.cleanup();
    this.emit('closed', reason);
  }

  close() {
    if (this.closed) return;
    this.send({ type: 'leave' });
    try { sessionStorage.removeItem(`coopgame-token-${this.code}`); } catch { /* private mode */ }
    this.cleanup();
  }

  destroyPeer() {
    const peer = this.peer;
    this.peer = null;
    this.conn = null;
    if (peer) setTimeout(() => peer.destroy(), 200);
  }

  cleanup() {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.attemptTimer);
    clearTimeout(this.retryTimer);
    this.destroyPeer();
  }
}
