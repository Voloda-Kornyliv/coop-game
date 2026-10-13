// App shell: home screen, lobby, and starting/stopping the game. All game
// logic lives under js/game/; networking lives in js/net.js.

import { HostSession, GuestSession, CODE_LENGTH } from './net.js';
import { HostGame } from './game/host.js';
import { GameClient } from './game/client.js';
import { HATS, TARGET_WINS_OPTIONS, MAX_PLAYERS, TEAMS } from './game/config.js';
import { MAPS } from './game/maps.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

let session = null;
let isHost = false;
let hostGame = null;
let client = null;
let myHat = store.get('coopgame-hat') ?? HATS[0];

// ---------------------------------------------------------------- UI helpers

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function setBusy(busy) {
  $('create-btn').disabled = busy;
  $('join-btn').disabled = busy;
}

function showHome() {
  document.body.classList.remove('in-game');
  $('lobby').hidden = true;
  $('home').hidden = false;
  setBusy(false);
}

function showLobby(code) {
  $('home').hidden = true;
  $('lobby').hidden = false;
  $('lobby-code').textContent = code;
  $('host-settings').hidden = !isHost;
  $('wait-host').hidden = isHost;
  history.replaceState(null, '', `?code=${code}`);
  setStatus(isHost ? 'Share the code so others can join.' : 'Connected to host.');
  renderHats();
}

function renderPlayers(players, mode = session?.mode) {
  const teams = mode === 'teams';
  const list = $('players');
  list.replaceChildren(...players.map((p) => {
    const li = document.createElement('li');
    const mine = p.id === session?.id;
    if (mine) li.classList.add('you');
    const name = document.createElement('span');
    name.textContent = `${p.hat ? `${p.hat} ` : ''}${p.name}`;
    if (teams) {
      // Team badge: tap your own to switch sides (section 2).
      const badge = document.createElement('button');
      badge.className = 'team-badge';
      badge.textContent = TEAMS.names[p.team] ?? '?';
      badge.style.background = TEAMS.colors[p.team] ?? '#888';
      badge.disabled = !mine;
      badge.title = mine ? 'Switch team' : '';
      badge.addEventListener('click', () => session?.setTeam(session.id, p.team === 0 ? 1 : 0));
      name.prepend(badge);
    }
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.isHost && 'host', p.id === session?.id && 'you', p.away && '📡 reconnecting…'].filter(Boolean).join(' · ');
    li.append(name, tag);
    return li;
  }));
  $('player-count').textContent = `(${players.length}/${MAX_PLAYERS})`;
  $('mode-info').textContent = teams ? 'Mode: Team vs Team' : 'Mode: Free-for-all';
  $('shuffle-btn').hidden = !(isHost && teams);
}

function renderHats() {
  $('hats').replaceChildren(...HATS.map((hat) => {
    const btn = document.createElement('button');
    btn.textContent = hat || '∅';
    btn.title = hat ? 'Hat' : 'No hat';
    btn.classList.toggle('selected', hat === myHat);
    btn.addEventListener('click', () => {
      myHat = hat;
      store.set('coopgame-hat', hat);
      session?.setHat(hat);
      renderHats();
    });
    return btn;
  }));
}

function fillSettings() {
  $('target-wins').replaceChildren(...TARGET_WINS_OPTIONS.map((n) => new Option(`${n} wins`, n, n === 5, n === 5)));
  $('mode').replaceChildren(new Option('Free-for-all', 'ffa', true, true), new Option('Teams', 'teams'));
  $('map-choice').replaceChildren(
    new Option('Random', 'random', true, true),
    ...MAPS.map((m) => new Option(m.name, m.id)),
  );
}

function getName() {
  const name = $('name').value.trim();
  if (!name) {
    setStatus('Enter your name first.', true);
    $('name').focus();
    return null;
  }
  store.set('coopgame-name', name);
  return name;
}

// ---------------------------------------------------------------- sessions

function createGame(name) {
  setBusy(true);
  setStatus('Creating game…');
  isHost = true;
  session = new HostSession({ name, hat: myHat });
  session
    .on('open', (code) => showLobby(code))
    .on('players', renderPlayers)
    .on('error', (msg) => fail(msg))
    .on('join', (p) => hostGame?.playerJoined(p))
    .on('leave', (id) => hostGame?.playerLeft(id))
    .on('away', (id) => hostGame?.playerAway(id))
    .on('back', (id) => hostGame?.playerBack(id))
    .on('reconnect', (p) => hostGame?.playerReconnected(p))
    .on('message', (id, msg) => hostGame?.onMessage(id, msg));
  session.open();
}

function joinGame(name, code) {
  setBusy(true);
  setStatus('Connecting…');
  isHost = false;
  session = new GuestSession({ name, hat: myHat, code });
  session
    .on('open', (c) => showLobby(c))
    .on('players', renderPlayers)
    .on('closed', (reason) => fail(reason))
    .on('ping', (ms) => client?.setPing(ms))
    .on('reconnecting', () => {
      client?.setConnectionNotice('📡 Connection lost. Reconnecting…');
      setStatus('Connection lost. Reconnecting…', true);
    })
    .on('reconnected', () => {
      if (client) client.myId = session.id;   // only changes if our slot expired
      client?.setConnectionNotice('');
      setStatus('Reconnected.');
    })
    .on('message', (msg) => {
      if (msg.type === 'game-start') startClient();
      else if (msg.type === 'lobby') returnToLobby();
      else client?.handle(msg);
    });
  session.open();
}

function startClient() {
  if (client) return;
  document.body.classList.add('in-game');
  client = new GameClient({
    root: $('game'),
    myId: session.id,
    isHost,
    // Input goes on the fast channel; picks etc. on the reliable one.
    send: isHost ? (msg) => hostGame.onMessage(session.id, msg)
      : (msg) => (msg.type === 'in' ? session.sendFast(msg) : session.send(msg)),
    onLeave: () => leave('You left the game.'),
    onPlayAgain: () => hostGame?.restart(),
    onLobby: () => hostBackToLobby(),
  });
  if (isHost) client.setPing('host');
}

function startHostGame() {
  if (!isHost || hostGame) return;
  const mode = $('mode').value;
  if (mode === 'teams') session.rebalanceTeams();
  hostGame = new HostGame({
    session,
    settings: { targetWins: Number($('target-wins').value), mapId: $('map-choice').value, mode },
  });
  session.inGame = true;
  session.broadcast({ type: 'game-start' });
  startClient();
  hostGame.start(client);
}

// Host: end the match and take everyone back to the lobby (session stays open).
function hostBackToLobby() {
  if (!isHost) return;
  session.broadcast({ type: 'lobby' });
  returnToLobby();
}

function returnToLobby() {
  client?.destroy();
  client = null;
  hostGame?.stop();
  hostGame = null;
  if (isHost) session.inGame = false;
  document.body.classList.remove('in-game');
  showLobby(session.code);
  renderPlayers(session.players);
}

function teardown() {
  client?.destroy();
  client = null;
  hostGame?.stop();
  hostGame = null;
  session?.close();
  session = null;
  history.replaceState(null, '', location.pathname);
}

function leave(message) {
  teardown();
  showHome();
  setStatus(message);
}

function fail(message) {
  teardown();
  showHome();
  setStatus(message, true);
}

// ---------------------------------------------------------------- wiring

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

$('start-btn').addEventListener('click', startHostGame);
$('mode').addEventListener('change', () => session?.setMode?.($('mode').value));
$('shuffle-btn').addEventListener('click', () => session?.shuffleTeams?.());
$('leave-btn').addEventListener('click', () => leave('You left the game.'));

$('copy-btn').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?code=${$('lobby-code').textContent}`;
  try {
    await navigator.clipboard.writeText(link);
    setStatus('Invite link copied.');
  } catch {
    setStatus(link);
  }
});

// Closing/reloading the tab is treated as a dropped connection (not a leave),
// so a guest can come back as the same player. Only the host ends the game.
window.addEventListener('beforeunload', () => { if (isHost) session?.close(); });

// Test/debug hook: open with ?debug to inspect state from the console.
if (new URLSearchParams(location.search).has('debug')) {
  window.coopDebug = { session: () => session, client: () => client, hostGame: () => hostGame };
}

fillSettings();
$('name').value = store.get('coopgame-name') || '';
const linkCode = new URLSearchParams(location.search).get('code');
if (linkCode) {
  $('code').value = linkCode.toUpperCase();
  setStatus('Enter your name and press Join.');
}
