// Runs on every device (the host too). Sends input, buffers snapshots, renders
// an interpolated view slightly in the past, and turns events into juice:
// particles, sounds, vibration, kill feed and announcements.

import { TICK_RATE, INPUT_SEND_MS, INTERP_DELAY_TICKS, TEAMS } from './config.js';
import { clamp, lerp, lerpAngle } from './geometry.js';
import { decodeSnapshot, encodeInput } from './protocol.js';
import { ACTIVES, ACTIVE_IDS, PICKUPS, PICKUP_IDS, VERBS } from './abilities.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { GameUI } from './ui.js';
import { audio } from './audio.js';

const MAX_BUFFER = 90;
const BLIP_TIME = 1000;           // ms an enemy shot shows on the minimap
const ATTACKER_TIME = 2000;      // ms an edge arrow points at whoever hit you
const EFFECT_EMOJI = { sheep: '🐑', shrink: '🔬', reverse: '🌀', dance: '🕺', slip: '🍌', confused: '🙃', bighead: '🎈' };

function vibrate(ms) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

export class GameClient {
  constructor({ root, myId, isHost, send, onLeave, onPlayAgain, onLobby }) {
    this.root = root;
    this.myId = myId;
    this.send = send;
    this.roster = new Map();            // num -> { id, name, color, hat, passives }
    this.myNum = 0;
    this.snaps = [];
    this.renderTick = null;
    this.view = null;
    this.lastPhase = null;
    this.lastCount = 0;
    this.recentKOs = [];
    this.wentFullscreen = false;
    this.connNotice = '';
    this.blips = [];
    this.attackers = new Map();
    this.aborter = new AbortController();

    root.hidden = false;
    this.renderer = new Renderer(root.querySelector('#canvas'), root.querySelector('#minimap'));
    this.input = new Input(root, { onTouch: () => this.enterFullscreen() });
    this.ui = new GameUI(root, {
      isHost,
      onPick: (card) => this.send({ type: 'pick', card }),
      onLeave: (confirmed) => { if (confirmed || window.confirm('Leave the game?')) onLeave(); },
      onPlayAgain,
      onLobby,
      onSoundToggle: () => this.setSound(!audio.enabled),
    });

    let soundPref = null;
    try { soundPref = localStorage.getItem('coopgame-sound'); } catch { /* private mode */ }
    this.setSound(soundPref ? soundPref === 'on' : !this.input.touchMode, false);

    const unlock = () => audio.unlock();
    window.addEventListener('pointerdown', unlock, { signal: this.aborter.signal });
    window.addEventListener('keydown', unlock, { signal: this.aborter.signal });
    document.addEventListener('visibilitychange', () => this.requestWakeLock(), { signal: this.aborter.signal });
    this.requestWakeLock();

    this.inputTimer = setInterval(() => this.sendInput(), INPUT_SEND_MS);
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ messages

  handle(msg) {
    switch (msg.type) {
      case 'snap': {
        const snap = decodeSnapshot(msg);
        const last = this.snaps[this.snaps.length - 1];
        if (last && snap.tick <= last.tick) return;   // stale / duplicate
        this.snaps.push(snap);
        if (this.snaps.length > MAX_BUFFER) this.snaps.splice(0, this.snaps.length - MAX_BUFFER);
        break;
      }
      case 'roster':
        this.roster = new Map(msg.players.map((p) => [p.num, p]));
        this.myNum = msg.players.find((p) => p.id === this.myId)?.num || 0;
        break;
      case 'offer':
        this.ui.showOffer(msg.cards, !!msg.skipped);
        break;
      case 'results':
        this.pendingResults = msg;
        break;
      default:
        break;
    }
  }

  sendInput() {
    const me = this.view?.me;
    const screen = me ? this.renderer.worldToScreen(me.x, me.y, me.confused) : null;
    const state = this.input.read(screen);
    this.lastInput = state;
    this.send(encodeInput(state));
  }

  // ------------------------------------------------------------ frame

  frame(now) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.advanceClock(dt);
    this.view = this.buildView();
    if (this.view) {
      this.processEvents();
      this.phaseTransitions();
      this.ui.update(this.view);
      this.ui.setNotice(this.connNotice || this.pauseNotice());
      if (this.pendingResults) {
        this.ui.showResults(this.pendingResults, this.view);
        this.pendingResults = null;
      }
    }
    this.renderer.draw(this.view, dt);
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // Keep renderTick a fixed delay behind the newest snapshot, advancing with
  // the local clock and gently correcting drift. Big gaps (tab was hidden)
  // snap straight to the present and skip the stale events.
  advanceClock(dt) {
    const latest = this.snaps[this.snaps.length - 1];
    if (!latest) return;
    const target = latest.tick - INTERP_DELAY_TICKS;
    if (this.renderTick === null || Math.abs(target - this.renderTick) > 30) {
      this.renderTick = target;
      for (const s of this.snaps) if (s.tick <= target) s.done = true;
    } else {
      this.renderTick += dt * TICK_RATE;
      this.renderTick += (target - this.renderTick) * Math.min(1, dt * 3);
    }
    this.renderTick = Math.min(this.renderTick, latest.tick);
  }

  setConnectionNotice(text) {
    this.connNotice = text;
    if (!this.view) this.ui.setNotice(text);
  }

  // Read from the newest snapshot (not the delayed view) so the banner is current.
  pauseNotice() {
    const latest = this.snaps[this.snaps.length - 1];
    if (!latest?.paused || !latest.waitingFor.length) return '';
    const names = latest.waitingFor.map((num) => this.roster.get(num)?.name || '?');
    return `⏸ Waiting for ${names.join(', ')} to reconnect…`;
  }

  buildView() {
    const snaps = this.snaps;
    if (!snaps.length || this.renderTick === null) return null;
    let i = snaps.length - 1;
    while (i > 0 && snaps[i].tick > this.renderTick) i--;
    const a = snaps[i];
    const b = snaps[i + 1] || a;
    const t = b.tick > a.tick ? clamp((this.renderTick - a.tick) / (b.tick - a.tick), 0, 1) : 0;

    // Drop snapshots we'll never need again (keep `a`).
    const old = snaps.slice(0, Math.max(0, i - 1));
    if (old.every((s) => s.done)) snaps.splice(0, old.length);

    const lerpMap = (ma, mb, extra) => {
      const out = [];
      for (const eb of mb.values()) {
        const ea = ma.get(eb.id ?? eb.num);
        if (!ea) { out.push(eb); continue; }
        const o = { ...eb, x: lerp(ea.x, eb.x, t), y: lerp(ea.y, eb.y, t) };
        if (extra) extra(o, ea, eb);
        out.push(o);
      }
      return out;
    };

    const players = lerpMap(a.players, b.players, (o, pa, pb) => {
      o.aim = lerpAngle(pa.aim, pb.aim, t);
      // Don't slide from a hidden/unknown position or across a death.
      if (pa.alive !== pb.alive || !pa.hasPos || !pb.hasPos || !pa.seen) { o.x = pb.x; o.y = pb.y; }
    });

    // Own aim is shown instantly from local input: aiming feels lag-free.
    const meIdx = players.findIndex((p) => p.num === this.myNum);
    if (meIdx >= 0 && this.lastInput && players[meIdx].alive) {
      players[meIdx] = { ...players[meIdx], aim: Math.atan2(this.lastInput.ay, this.lastInput.ax) };
    }
    const me = meIdx >= 0 ? players[meIdx] : null;

    const now = performance.now();
    this.blips = this.blips.filter((bl) => now - bl.t < BLIP_TIME);
    for (const [num, at] of this.attackers) if (now - at.t > ATTACKER_TIME) this.attackers.delete(num);
    const zone = b.zone && a.zone && a.zone.r && b.zone.r ? { ...b.zone, r: lerp(a.zone.r, b.zone.r, t) } : b.zone;

    return {
      tick: this.renderTick,
      phase: b.phase,
      phaseLeft: b.phaseLeft,
      paused: b.paused,
      round: b.round,
      map: b.map,
      mode: b.mode,
      teamScores: b.teamScores,
      roundTime: lerp(a.roundTime, b.roundTime, t),
      zone,
      finalZone: b.finalZone,
      players,
      byNum: new Map(players.map((p) => [p.num, p])),
      bullets: lerpMap(a.bullets, b.bullets),
      props: lerpMap(a.props, b.props),
      crates: [...b.crates.values()],
      pickups: lerpMap(a.pickups, b.pickups),
      objects: [...b.objects.values()],
      orbs: lerpMap(a.orbs, b.orbs),
      blips: this.blips.map((bl) => ({ x: bl.x, y: bl.y, age: (now - bl.t) / BLIP_TIME })),
      attackers: this.attackers,
      roster: this.roster,
      myNum: this.myNum,
      me,
      nemesis: me?.nemesis || 0,
    };
  }

  processEvents() {
    for (const s of this.snaps) {
      if (s.done || s.tick > this.renderTick) continue;
      s.done = true;
      for (const ev of s.events) this.onEvent(ev);
    }
  }

  phaseTransitions() {
    const v = this.view;
    if (v.phase !== this.lastPhase) {
      if (v.phase === 'playing' && this.lastPhase === 'countdown') {
        this.ui.announce('GO!', 'go');
        audio.play('go');
      }
      if (v.phase === 'draft' && this.lastPhase === 'matchEnd') this.ui.clearResults();
      this.lastPhase = v.phase;
      this.lastCount = 0;
    }
    if (v.phase === 'countdown') {
      const n = Math.ceil(v.phaseLeft);
      if (n > 0 && n !== this.lastCount) {
        this.lastCount = n;
        this.ui.announce(String(n), 'count');
        audio.play('count');
      }
    }
  }

  // ------------------------------------------------------------ events -> juice

  name(num) {
    const info = this.roster.get(num);
    return { text: info?.name || '?', color: info?.color || '#fff' };
  }

  onEvent([type, ...a]) {
    const v = this.view;
    const R = this.renderer;
    // Only players we can actually see have a usable position.
    const pos = (num) => { const p = v.byNum.get(num); return p?.seen ? p : null; };
    const isMe = (num) => num === this.myNum && num !== 0;
    const isEnemy = (num) => !isMe(num) && !(v.mode === 'teams' && v.me && v.byNum.get(num)?.team === v.me.team);
    // Positional sound: full volume nearby, fading out across the map.
    const near = (x, y) => {
      const c = R.cam;
      if (!c) return 1;
      const d = Math.hypot(x - c.x, y - c.y);
      return Math.max(0, Math.min(1, 1 - (d - 700) / 1100));
    };

    switch (type) {
      case 'shot': {
        const [num, x, y] = a;
        const p = pos(num);
        R.light(x, y, 150, 0.12);
        if (p && (isMe(num) || !p.invis)) R.burst(p.x + Math.cos(p.aim) * p.r, p.y + Math.sin(p.aim) * p.r, '#fff3b0', 2, 80, 3);
        if (isEnemy(num)) this.blips.push({ x, y, t: performance.now() });
        audio.play('shot', isMe(num) ? 0.03 : 0.06, isMe(num) ? 1 : near(x, y));
        break;
      }
      case 'tshot':
        audio.play('tshot', 0.08, near(a[0], a[1]));
        break;
      case 'hit': {
        const [num, amount, by, ax, ay] = a;
        const p = pos(num);
        if (p) {
          R.burst(p.x, p.y, this.roster.get(num)?.color || '#fff', 8, 220);
          R.text(p.x, p.y - p.r - 10, `-${amount}`, isMe(num) ? '#ff5a5f' : '#ffffff', 16);
        }
        if (isMe(num)) {
          R.shake(8); audio.play('hurt'); vibrate(35);
          if (by) this.attackers.set(by, { x: ax, y: ay, t: performance.now() });
        } else if (isMe(by)) audio.play('hit');
        break;
      }
      case 'levelUp': {
        const [num, level] = a;
        const p = pos(num);
        if (p) { R.ring(p.x, p.y, 70, 'rgba(255,210,63,0.9)', 0.5); R.text(p.x, p.y - p.r - 24, 'LEVEL UP!', '#ffd23f', 16); }
        if (isMe(num)) { this.ui.announce(`LEVEL UP! Lv ${level}`, 'good'); vibrate(40); }
        audio.play('levelup', 0.2, isMe(num) ? 1 : 0.5);
        break;
      }
      case 'catchUp':
        if (isMe(a[0])) this.ui.announce(`⬆️ Catch-up boost: Lv ${a[1]}`, 'good');
        break;
      case 'orb':
        if (isMe(a[0])) audio.play('orb', 0.05);
        break;
      case 'objDown': {
        const [kind, x, y] = a;
        if (kind === 2) { R.burst(x, y, '#ffd23f', 40, 420, 7); R.ring(x, y, 120, 'rgba(255,210,63,0.9)', 0.6); R.shake(6); }
        else R.burst(x, y, kind === 0 ? '#8a93a8' : '#c92a2a', 20, 300, 6);
        audio.play('hit', 0.05, near(x, y));
        break;
      }
      case 'teamWin': {
        const mine = v.me && v.me.team === a[0];
        this.ui.announce(mine ? 'YOUR TEAM WINS THE ROUND!' : `${TEAMS.names[a[0]]} TEAM wins the round!`, mine ? 'good' : '');
        audio.play('win');
        break;
      }
      case 'revive':
        this.ui.feed([this.name(a[1]), ' revived ', this.name(a[0])]);
        if (isMe(a[0])) this.ui.announce('REVIVED!', 'good');
        audio.play('levelup', 0.2);
        break;
      case 'ko': {
        const [victim, killer, verb, x, y] = a;
        R.confetti(x, y);
        R.shake(isMe(victim) ? 16 : 6);
        audio.play('ko', 0.03, isMe(victim) || isMe(killer) ? 1 : Math.max(0.3, near(x, y)));
        const [withKiller, alone] = VERBS[verb] || VERBS.bullet;
        if (verb === 'left') this.ui.feed([this.name(victim), ` ${alone}`]);
        else if (killer) this.ui.feed([this.name(killer), ` ${withKiller} `, this.name(victim)]);
        else this.ui.feed([this.name(victim), ` ${alone}`]);
        if (isMe(victim)) { this.ui.announce('KO! 👻 Haunt them!', 'bad'); vibrate(250); }
        else if (isMe(killer)) {
          const now = performance.now();
          this.recentKOs = this.recentKOs.filter((t) => now - t < 2500);
          this.recentKOs.push(now);
          this.ui.announce(this.recentKOs.length >= 3 ? 'TRIPLE KO!' : this.recentKOs.length === 2 ? 'DOUBLE KO!' : 'KO!', 'good');
        }
        break;
      }
      case 'boom': {
        const [x, y, radius] = a;
        if (radius) {
          R.ring(x, y, radius, 'rgba(255,170,60,0.9)', 0.4);
          R.burst(x, y, '#ff9a3c', 22, radius * 3, 6);
          R.light(x, y, radius * 2, 0.3);
          R.shake(near(x, y) > 0.8 ? 10 : 0);
          audio.play('boom', 0.03, near(x, y));
        } else {
          R.burst(x, y, '#fff3b0', 10, 300, 4);
          R.light(x, y, 200, 0.15);
        }
        break;
      }
      case 'dash': {
        const p = pos(a[0]);
        if (p) R.ring(p.x, p.y, p.r + 10, 'rgba(255,255,255,0.6)', 0.2);
        if (isMe(a[0])) audio.play('dash');
        break;
      }
      case 'cast': {
        const p = pos(a[0]);
        const ability = ACTIVES[ACTIVE_IDS[a[1]]];
        if (p && ability) R.emoji(p.x, p.y - p.r - 30, ability.icon, 26, 0.8);
        audio.play('cast');
        if (ability === ACTIVES.fart) audio.play('fart');
        break;
      }
      case 'use': {
        const p = pos(a[0]);
        const item = PICKUPS[PICKUP_IDS[a[1]]];
        if (p && item) R.emoji(p.x, p.y - p.r - 30, item.icon, 28, 1);
        if (item && isMe(a[0])) this.ui.announce(`${item.icon} ${item.name}!`);
        break;
      }
      case 'pickup':
        if (isMe(a[0])) audio.play('pickup');
        break;
      case 'baa': {
        const p = pos(a[0]);
        if (p) R.text(p.x, p.y - p.r - 14, 'baa!', '#ffffff', 18);
        audio.play('baa', 0.2);
        break;
      }
      case 'effect': {
        const [num, effect, by] = a;
        const p = pos(num);
        if (p && EFFECT_EMOJI[effect]) R.emoji(p.x, p.y - p.r - 26, EFFECT_EMOJI[effect], 30, 1);
        if (effect === 'slip') {
          audio.play('slip');
          if (by && by !== num) this.ui.feed([this.name(by), ' bananaed ', this.name(num)]);
        }
        if (effect === 'sheep' && by) this.ui.feed([this.name(by), ' sheeped ', this.name(num)]);
        if (isMe(num)) {
          const msg = { sheep: 'BAA! You are a sheep', reverse: 'Controls reversed!', confused: 'Upside down!', shrink: 'Tiny!', dance: 'Dance!' }[effect];
          if (msg) this.ui.announce(msg, 'bad');
          vibrate(60);
        }
        break;
      }
      case 'swap': {
        const [x, y] = [pos(a[0]), pos(a[1])];
        if (x && y) { R.ring(x.x, x.y, 40, '#ff4fd8'); R.ring(y.x, y.y, 40, '#ff4fd8'); }
        audio.play('swap');
        break;
      }
      case 'blink': {
        R.burst(a[1], a[2], '#c9b8ff', 14, 200);
        audio.play('swap');
        break;
      }
      case 'zap':
        R.zap(a);
        audio.play('zap');
        break;
      case 'spark':
        R.burst(a[0], a[1], '#cfd3dc', 4, 120, 3);
        break;
      case 'crate':
        R.burst(a[0], a[1], '#a8743f', 18, 260, 6);
        audio.play('hit');
        break;
      case 'block': {
        const p = pos(a[0]);
        if (p) R.text(p.x, p.y - p.r - 12, 'BLOCKED', '#8fe3ff', 14);
        audio.play('block', 0.1);
        break;
      }
      case 'reflect': {
        const p = pos(a[0]);
        if (p) R.text(p.x, p.y - p.r - 12, 'REFLECT', '#f0f0ff', 14);
        audio.play('block', 0.1);
        break;
      }
      case 'boing':
      case 'bump':
        audio.play('boing', 0.15);
        break;
      case 'potato':
        if (isMe(a[0])) this.ui.announce('🥔 HOT POTATO! Pass it!', 'bad');
        break;
      case 'potatoPass': {
        const p = pos(a[1]);
        if (p) R.text(p.x, p.y - p.r - 12, 'TAG!', '#ff8c42', 16);
        if (isMe(a[1])) this.ui.announce('🥔 You have the potato!', 'bad');
        break;
      }
      case 'crown': {
        const p = pos(a[0]);
        if (p) R.text(p.x, p.y - p.r - 12, '+30 👑', '#ffd23f', 16);
        break;
      }
      case 'revenge':
        if (isMe(a[0])) this.ui.announce('REVENGE!', 'good');
        else this.ui.feed([this.name(a[0]), ' got REVENGE']);
        break;
      case 'round':
        this.ui.clearResults();
        break;
      case 'roundWin':
        this.ui.announce(isMe(a[0]) ? 'YOU WIN THE ROUND!' : `${this.name(a[0]).text} wins the round!`, isMe(a[0]) ? 'good' : '');
        audio.play('win');
        break;
      case 'draw':
        this.ui.announce('Draw!');
        break;
      case 'emote':
        audio.play('emote', 0.1);
        break;
      case 'spook':
        R.ring(a[1], a[2], 110, 'rgba(220,230,255,0.8)', 0.4);
        R.emoji(a[1], a[2] - 30, '👻', 34, 0.8);
        audio.play('spook');
        break;
      case 'away':
        this.ui.feed([this.name(a[0]), ' lost connection 📡']);
        break;
      case 'back':
        this.ui.feed([this.name(a[0]), ' is back!']);
        break;
      case 'teleportAll':
        this.ui.announce('🌪️ Everyone teleported!');
        audio.play('swap');
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ device niceties

  setSound(on, save = true) {
    audio.setEnabled(on);
    this.ui.setSound(on);
    if (save) {
      try { localStorage.setItem('coopgame-sound', on ? 'on' : 'off'); } catch { /* private mode */ }
    }
  }

  enterFullscreen() {
    if (this.wentFullscreen || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
    this.wentFullscreen = true;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => { /* not allowed here (e.g. iPhone) */ });
  }

  async requestWakeLock() {
    if (document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* denied */ }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.inputTimer);
    this.aborter.abort();
    this.input.destroy();
    this.renderer.destroy();
    this.ui.destroy();
    this.wakeLock?.release?.().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    this.root.hidden = true;
  }
}
