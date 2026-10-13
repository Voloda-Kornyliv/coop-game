// Peer-to-peer lobby using PeerJS (WebRTC). The host's browser registers on the
// public PeerJS server under an ID derived from the game code; guests connect
// directly to it. The host owns the player list and broadcasts it to everyone.

const ID_PREFIX = 'coopgame-v1-';           // keeps our IDs apart from other apps on the shared server
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
const CODE_LENGTH = 5;
const MAX_PLAYERS = 8;
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 8000;                   // no message for this long = player gone

const $ = (id) => document.getElementById(id);

let peer = null;
let isHost = false;
let myId = null;
let gameCode = null;
let players = [];                          // [{ id, name, isHost }]
let heartbeatTimer = null;

// Host only: guest peer id -> { conn, lastSeen }
const guests = new Map();
// Guest only
let hostConn = null;
let hostLastSeen = 0;

// ---------- UI ----------

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function setBusy(busy) {
  $('create-btn').disabled = busy;
  $('join-btn').disabled = busy;
}

function showLobby() {
  $('home').hidden = true;
  $('lobby').hidden = false;
  $('lobby-code').textContent = gameCode;
  setStatus(isHost ? 'Share the code so others can join.' : 'Connected to host.');
  renderPlayers();
}

function showHome() {
  $('lobby').hidden = true;
  $('home').hidden = false;
  setBusy(false);
}

function renderPlayers() {
  const list = $('players');
  list.replaceChildren();
  for (const p of players) {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('you');
    const name = document.createElement('span');
    name.textContent = p.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.isHost && 'host', p.id === myId && 'you'].filter(Boolean).join(' · ');
    li.append(name, tag);
    list.append(li);
  }
  $('player-count').textContent = `(${players.length}/${MAX_PLAYERS})`;
}

function getName() {
  const name = $('name').value.trim();
  if (!name) {
    setStatus('Enter your name first.', true);
    $('name').focus();
    return null;
  }
  try { localStorage.setItem('coopgame-name', name); } catch {}
  return name;
}

function makeCode() {
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
  return code;
}

// ---------- Host ----------

function createGame(name, attempt = 0) {
  setBusy(true);
  setStatus('Creating game…');
  const code = makeCode();
  const p = new Peer(ID_PREFIX + code);
  peer = p;

  peer.on('open', (id) => {
    isHost = true;
    myId = id;
    gameCode = code;
    players = [{ id, name, isHost: true }];
    history.replaceState(null, '', `?code=${code}`);
    showLobby();
    startHeartbeat();
  });

  peer.on('connection', (conn) => {
    conn.on('data', (msg) => onHostMessage(conn, msg));
    conn.on('close', () => removeGuest(conn.peer));
    conn.on('error', () => removeGuest(conn.peer));
  });

  peer.on('error', (err) => {
    if (p !== peer) return;
    if (err.type === 'unavailable-id' && attempt < 5) {
      p.destroy();
      createGame(name, attempt + 1);            // code collision, try another
    } else if (!myId) {
      fail(`Could not create game (${err.type}).`);
    }
  });

  // Lost the signaling server; existing player connections keep working,
  // but reconnect so new players can still find us.
  peer.on('disconnected', () => {
    setTimeout(() => { if (p === peer && !p.destroyed) p.reconnect(); }, 1000);
  });
}

function onHostMessage(conn, msg) {
  const guest = guests.get(conn.peer);
  if (guest) guest.lastSeen = Date.now();

  if (msg.type === 'join') {
    if (players.length >= MAX_PLAYERS) {
      conn.send({ type: 'rejected', reason: 'Game is full.' });
      setTimeout(() => conn.close(), 500);
      return;
    }
    const name = String(msg.name || 'Player').slice(0, 20);
    guests.set(conn.peer, { conn, lastSeen: Date.now() });
    players.push({ id: conn.peer, name, isHost: false });
    conn.send({ type: 'welcome', code: gameCode });
    broadcastPlayers();
  } else if (msg.type === 'leave') {
    removeGuest(conn.peer);
  }
}

function removeGuest(peerId) {
  const guest = guests.get(peerId);
  if (!guest) return;
  guests.delete(peerId);
  guest.conn.close();
  players = players.filter((p) => p.id !== peerId);
  broadcastPlayers();
}

function broadcastPlayers() {
  for (const { conn } of guests.values()) {
    if (conn.open) conn.send({ type: 'players', players });
  }
  renderPlayers();
}

// ---------- Guest ----------

function joinGame(name, code) {
  setBusy(true);
  setStatus('Connecting…');
  peer = new Peer();                         // random id for guests

  peer.on('open', (id) => {
    myId = id;
    hostConn = peer.connect(ID_PREFIX + code, { reliable: true });

    const timeout = setTimeout(() => fail(`Could not reach game ${code}.`), 15000);

    hostConn.on('open', () => {
      clearTimeout(timeout);
      hostConn.send({ type: 'join', name });
    });
    hostConn.on('data', (msg) => {
      hostLastSeen = Date.now();
      if (msg.type === 'welcome') {
        gameCode = msg.code;
        history.replaceState(null, '', `?code=${gameCode}`);
        showLobby();
        startHeartbeat();
      } else if (msg.type === 'players') {
        players = msg.players;
        renderPlayers();
      } else if (msg.type === 'rejected') {
        fail(msg.reason);
      } else if (msg.type === 'ended') {
        fail('The host ended the game.');
      }
    });
    hostConn.on('close', () => { if (peer) fail('Lost connection to the host.'); });
  });

  peer.on('error', (err) => {
    if (!peer) return;
    if (err.type === 'peer-unavailable') fail(`No game found with code ${code}.`);
    else fail(`Connection error (${err.type}).`);
  });
}

// ---------- Shared ----------

// Mobile browsers often drop connections silently (screen lock, tab switch),
// so both sides ping regularly and treat silence as a disconnect.
function startHeartbeat() {
  hostLastSeen = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (isHost) {
      for (const [peerId, g] of guests) {
        if (now - g.lastSeen > TIMEOUT_MS) removeGuest(peerId);
      }
      for (const { conn } of guests.values()) {
        if (conn.open) conn.send({ type: 'players', players });
      }
    } else {
      if (now - hostLastSeen > TIMEOUT_MS) return fail('Lost connection to the host.');
      if (hostConn.open) hostConn.send({ type: 'ping' });
    }
  }, HEARTBEAT_MS);
}

function leave() {
  try {
    if (isHost) {
      for (const { conn } of guests.values()) if (conn.open) conn.send({ type: 'ended' });
    } else if (hostConn?.open) {
      hostConn.send({ type: 'leave' });
    }
  } catch {}
  // Give the goodbye message a moment to go out before tearing down.
  const p = peer;
  setTimeout(() => p?.destroy(), 200);
  reset();
}

function reset() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  peer = null;
  isHost = false;
  myId = null;
  gameCode = null;
  players = [];
  guests.clear();
  hostConn = null;
  history.replaceState(null, '', location.pathname);
}

function fail(message) {
  const p = peer;
  if (!p) return;                            // already torn down
  reset();
  p.destroy();
  showHome();
  setStatus(message, true);
}

// ---------- Wire up ----------

$('create-btn').addEventListener('click', () => {
  const name = getName();
  if (name) createGame(name);
});

$('join-btn').addEventListener('click', () => {
  const name = getName();
  if (!name) return;
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) {
    setStatus(`Game code is ${CODE_LENGTH} characters.`, true);
    return;
  }
  joinGame(name, code);
});

$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-btn').click(); });
$('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($('code').value ? $('join-btn') : $('create-btn')).click();
});

$('leave-btn').addEventListener('click', () => {
  leave();
  showHome();
  setStatus('You left the game.');
});

$('copy-btn').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?code=${gameCode}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus('Invite link copied.');
  } catch {
    setStatus(link);
  }
});

window.addEventListener('beforeunload', () => { if (peer) leave(); });

// Prefill name and code (from an invite link) on load.
try { $('name').value = localStorage.getItem('coopgame-name') || ''; } catch {}
const linkCode = new URLSearchParams(location.search).get('code');
if (linkCode) {
  $('code').value = linkCode.toUpperCase();
  setStatus('Enter your name and press Join.');
}
