// The authoritative game simulation. Runs ONLY on the host, in fixed 60 Hz
// steps. It never touches the DOM or the network: inputs come in through
// setInput()/handlePick(), and everything that happened goes out through
// `events` (drained into snapshots) and `outbox` (per-player messages).

import {
  WORLD_W, WORLD_H, TICK_DT, PLAYER, ROUND, COLORS,
} from './config.js';
import {
  clamp, dist2, rand, pick, shuffle, circleRectPush, circleOverlapsRect, pointInRect,
} from './geometry.js';
import { MAPS, mapIndex } from './maps.js';
import {
  ACTIVES, PASSIVES, PICKUPS, PROJECTILES, PROPS, ACTIVE_IDS, PASSIVE_IDS, PICKUP_IDS,
  NEGATIVE_EFFECTS, computeStats, defaultHit,
} from './abilities.js';

const EFFECTS = [
  'dash', 'bubble', 'mirror', 'sheep', 'shrink', 'reverse', 'dance', 'slip', 'confused',
  'bighead', 'invis', 'speed', 'minigun', 'giant',
];

const num = (v, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class Simulation {
  constructor({ targetWins = 5, mapId = 'random' } = {}) {
    this.settings = { targetWins, mapId };
    this.players = new Map();          // peer id -> player
    this.retired = new Map();          // name -> progress of players who left (for rejoin)
    this.nextNum = 1;
    this.nextId = 1;
    this.tick = 0;
    this.phase = 'lobby';
    this.phaseTime = 0;
    this.round = 0;
    this.map = MAPS[0];
    this.roundTime = 0;
    this.roundStartCount = 0;
    this.slowmo = 0;
    this.bullets = [];
    this.props = [];
    this.pickups = [];
    this.crates = [];
    this.pickupTimer = 0;
    this.results = null;
    this.events = [];                  // broadcast in the next snapshot
    this.outbox = [];                  // { to: peerId | '*', msg }
    this.rosterDirty = true;
  }

  // ------------------------------------------------------------------ players

  addPlayer({ id, name, hat }) {
    if (this.players.has(id)) return;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const saved = this.retired.get(name);
    this.retired.delete(name);
    const p = {
      id,
      num: this.nextNum++,
      name: String(name).slice(0, 20),
      hat: typeof hat === 'string' ? hat.slice(0, 8) : '',
      color: COLORS.find((c) => !used.has(c)) || pick(COLORS),
      score: 0,
      ability: pick(ACTIVE_IDS),
      passives: {},
      nemesis: null,
      aw: { kos: 0, slips: 0, selfKOs: 0, ghost: 0, dealt: 0, taken: 0, wins: 0 },
      input: { mx: 0, my: 0, ax: 1, ay: 0, fire: false, touch: false },
      counts: null,
      offer: null,
      picked: true,
      emote: -1,
      emoteT: 0,
      ...(saved || {}),
    };
    p.stats = computeStats(p.passives);
    this.resetForRound(p, null);
    p.alive = false;                    // joins as a ghost until the next round
    p.ghost = true;
    this.players.set(id, p);
    if (this.phase === 'draft') this.offerCards(p);
    if (this.results) this.outbox.push({ to: id, msg: this.results });
    this.rosterDirty = true;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive) this.kill(p, null, 'left');
    const { score, passives, ability, aw, nemesis } = p;
    this.retired.set(p.name, { score, passives, ability, aw, nemesis });
    this.players.delete(id);
    this.rosterDirty = true;
    this.checkRoundEnd();
  }

  resetForRound(p, spawn) {
    p.stats = computeStats(p.passives);
    p.r = p.stats.radius;
    p.hp = p.stats.maxHp;
    p.alive = true;
    p.ghost = false;
    p.x = spawn ? spawn.x : WORLD_W / 2;
    p.y = spawn ? spawn.y : WORLD_H / 2;
    p.vx = 0; p.vy = 0; p.kvx = 0; p.kvy = 0;
    p.aim = Math.atan2(WORLD_H / 2 - p.y, WORLD_W / 2 - p.x);
    p.fireCd = 0; p.dashCd = 0; p.abilCd = 0; p.padCd = 0; p.baaCd = 0; p.ghostCd = 0;
    p.dashDx = 1; p.dashDy = 0; p.slipDx = 1; p.slipDy = 0;
    p.item = null;
    p.potato = null;
    p.lastHit = null;
    p.e = Object.fromEntries(EFFECTS.map((k) => [k, 0]));
  }

  // Inputs come straight from the network: validate everything.
  setInput(id, msg) {
    const p = this.players.get(id);
    if (!p || !msg) return;
    const counts = { d: int(msg.d), a: int(msg.a), i: int(msg.i), e: int(msg.e) };
    if (!p.counts) p.counts = counts;   // first input: don't replay old presses
    p.pending = counts;
    p.input = {
      mx: num(msg.mx, -1, 1), my: num(msg.my, -1, 1),
      ax: num(msg.ax, -1, 1), ay: num(msg.ay, -1, 1),
      fire: !!msg.f, touch: !!msg.tc,
    };
    p.emoteIdx = int(msg.ei) % 4;
  }

  // Button presses are monotonically increasing counters, so a press is never
  // lost or duplicated no matter how input messages are batched.
  takePresses(p) {
    const now = p.pending, last = p.counts;
    if (!now || !last) return { dash: false, abil: false, item: false, emote: false };
    const out = { dash: now.d > last.d, abil: now.a > last.a, item: now.i > last.i, emote: now.e > last.e };
    p.counts = now;
    return out;
  }

  // ------------------------------------------------------------------ match flow

  startMatch() {
    for (const p of this.players.values()) {
      p.score = 0;
      p.passives = {};
      p.nemesis = null;
      p.aw = { kos: 0, slips: 0, selfKOs: 0, ghost: 0, dealt: 0, taken: 0, wins: 0 };
    }
    this.round = 0;
    this.results = null;
    this.rosterDirty = true;
    this.startDraft();
  }

  setPhase(phase) {
    this.phase = phase;
    this.phaseTime = 0;
  }

  startDraft() {
    this.setPhase('draft');
    for (const p of this.players.values()) this.offerCards(p);
  }

  offerCards(p) {
    const scores = [...this.players.values()].map((o) => o.score);
    const max = Math.max(...scores), min = Math.min(...scores);
    const leaders = scores.filter((s) => s === max).length;
    let count = 3;
    if (max > min && p.score === min) count = 4;
    else if (max > 0 && p.score === max && leaders === 1) count = 2;

    const cards = new Set();
    const firstDraft = this.round === 0;
    let guard = 0;
    while (cards.size < count && guard++ < 200) {
      if (firstDraft || Math.random() < 0.25) {
        const id = pick(ACTIVE_IDS);
        if (id !== p.ability || firstDraft) cards.add(`a:${id}`);
      } else {
        const id = pick(PASSIVE_IDS);
        if ((p.passives[id] || 0) < PASSIVES[id].max) cards.add(`p:${id}`);
      }
    }
    p.offer = [...cards];
    p.picked = false;
    this.outbox.push({ to: p.id, msg: { type: 'offer', cards: p.offer } });
  }

  handlePick(id, card) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'draft' || p.picked || !p.offer?.includes(card)) return;
    this.applyCard(p, card);
  }

  applyCard(p, card) {
    const [kind, cid] = card.split(':');
    if (kind === 'a') p.ability = cid;
    else p.passives[cid] = (p.passives[cid] || 0) + 1;
    p.stats = computeStats(p.passives);
    p.picked = true;
    p.offer = null;
    this.rosterDirty = true;
  }

  startRound() {
    this.round++;
    const forced = mapIndex(this.settings.mapId);
    this.map = forced >= 0 ? MAPS[forced] : pick(MAPS);
    this.bullets = [];
    this.props = [];
    this.pickups = [];
    this.crates = this.map.crates.map((c) => ({ ...c, id: this.nextId++, hp: ROUND.crateHp }));
    this.roundTime = 0;
    this.pickupTimer = ROUND.pickupEvery / 2;
    this.slowmo = 0;
    const spawns = shuffle([...this.map.spawns]);
    let i = 0;
    for (const p of this.players.values()) this.resetForRound(p, spawns[i++ % spawns.length]);
    this.roundStartCount = this.players.size;
    this.setPhase('countdown');
    this.event('round', this.round);
  }

  checkRoundEnd() {
    if (this.phase !== 'playing') return;
    const alive = this.living();
    const needed = this.roundStartCount > 1 ? 1 : 0;
    if (alive.length > needed) return;
    const winner = alive[0] || null;
    if (winner) {
      winner.score++;
      winner.aw.wins++;
      this.event('roundWin', winner.num);
    } else {
      this.event('draw');
    }
    this.slowmo = ROUND.slowmoTime;
    this.roundWinner = winner;
    this.rosterDirty = true;
    this.setPhase('roundEnd');
  }

  finishRound() {
    const w = this.roundWinner;
    if (w && this.players.has(w.id) && w.score >= this.settings.targetWins) this.endMatch(w);
    else this.startDraft();
  }

  endMatch(winner) {
    const all = [...this.players.values()];
    const best = (fn, minValue = 1) => {
      let top = null, topV = -Infinity;
      for (const p of all) { const v = fn(p); if (v > topV) { top = p; topV = v; } }
      return top && topV >= minValue ? top : null;
    };
    const awards = [
      ['🏆', 'Champion', best((p) => p.score), (p) => plural(p.score, 'round win')],
      ['🎯', 'Sharpshooter', best((p) => p.aw.kos), (p) => plural(p.aw.kos, 'KO')],
      ['🍌', 'Banana King', best((p) => p.aw.slips), (p) => `${plural(p.aw.slips, 'enemy', 'enemies')} slipped`],
      ['💥', 'Kamikaze', best((p) => p.aw.selfKOs), (p) => plural(p.aw.selfKOs, 'self-KO')],
      ['👻', 'Ghost of the Match', best((p) => p.aw.ghost), (p) => plural(p.aw.ghost, 'ghostly annoyance')],
      ['🕊️', 'Pacifist', best((p) => -p.aw.dealt, -Infinity), (p) => `only ${Math.round(p.aw.dealt)} damage dealt`],
      ['🩹', 'Unlucky', best((p) => p.aw.taken), (p) => `took ${Math.round(p.aw.taken)} damage`],
    ].filter(([, , p]) => p).map(([icon, title, p, text]) => ({ icon, title, num: p.num, text: text(p) }));

    this.results = {
      type: 'results',
      winner: winner.num,
      standings: all.sort((a, b) => b.score - a.score).map((p) => ({ num: p.num, score: p.score })),
      awards,
    };
    this.outbox.push({ to: '*', msg: this.results });
    this.setPhase('matchEnd');
  }

  // ------------------------------------------------------------------ main step

  step() {
    this.tick++;
    this.phaseTime += TICK_DT;
    let dt = TICK_DT;
    if (this.slowmo > 0) {
      this.slowmo -= TICK_DT;
      dt *= ROUND.slowmoScale;
    }

    for (const p of this.players.values()) {
      const presses = this.takePresses(p);
      if (presses.emote) { p.emote = p.emoteIdx; p.emoteT = 2; this.event('emote', p.num, p.emoteIdx); }
      p.emoteT = Math.max(0, p.emoteT - TICK_DT);
      p.presses = presses;
    }

    switch (this.phase) {
      case 'countdown':
        for (const p of this.players.values()) this.updateAim(p);
        if (this.phaseTime >= ROUND.countdown) this.setPhase('playing');
        break;
      case 'playing':
        this.updateWorld(dt);
        this.checkRoundEnd();
        break;
      case 'roundEnd':
        this.updateWorld(dt);
        if (this.phaseTime >= ROUND.endDelay) this.finishRound();
        break;
      case 'draft': {
        const all = [...this.players.values()];
        if (this.phaseTime >= ROUND.draftTime) {
          for (const p of all) if (!p.picked && p.offer) this.applyCard(p, pick(p.offer));
        }
        if (all.every((p) => p.picked)) this.startRound();
        break;
      }
      default:
        break;
    }
  }

  updateWorld(dt) {
    this.roundTime += dt;
    for (const p of this.players.values()) this.updatePlayer(p, dt);
    this.separatePlayers();
    this.updateProps(dt);
    this.updateBullets(dt);
    this.updatePickups(dt);
    this.bullets = this.bullets.filter((b) => !b.dead);
    this.props = this.props.filter((o) => !o.dead);
  }

  // ------------------------------------------------------------------ players

  updateAim(p) {
    const { ax, ay } = p.input;
    if (ax * ax + ay * ay > 0.01) p.aim = Math.atan2(ay, ax);
  }

  updatePlayer(p, dt) {
    for (const k of EFFECTS) if (p.e[k] > 0) p.e[k] = Math.max(0, p.e[k] - dt);
    p.fireCd -= dt; p.dashCd -= dt; p.abilCd -= dt; p.padCd -= dt; p.baaCd -= dt; p.ghostCd -= dt;
    const presses = p.presses;
    this.updateAim(p);

    if (p.ghost) { this.updateGhost(p, dt, presses); return; }
    if (!p.alive) return;

    const e = p.e;
    const canAct = !e.sheep && !e.dance;
    const inp = p.input;

    if (presses.dash && p.dashCd <= 0 && !e.dance) {
      let dx = inp.mx, dy = inp.my;
      const m = Math.hypot(dx, dy);
      if (m < 0.2) { dx = Math.cos(p.aim); dy = Math.sin(p.aim); } else { dx /= m; dy /= m; }
      p.dashDx = dx; p.dashDy = dy;
      e.dash = PLAYER.dashTime;
      p.dashCd = p.stats.dashCooldown;
      e.slip = 0;
      this.event('dash', p.num);
    }
    if (presses.abil && p.abilCd <= 0 && canAct && ACTIVES[p.ability]) {
      ACTIVES[p.ability].cast(this, p);
      p.abilCd = ACTIVES[p.ability].cd * p.stats.cdMult;
      this.event('cast', p.num, ACTIVE_IDS.indexOf(p.ability));
    }
    if (presses.item && p.item && canAct) {
      const item = p.item;
      p.item = null;
      PICKUPS[item].use(this, p);
      this.event('use', p.num, PICKUP_IDS.indexOf(item));
    }

    this.movePlayer(p, dt);

    if (inp.fire && p.fireCd <= 0 && !e.dance && !e.dash) {
      if (e.sheep) {
        if (p.baaCd <= 0) { this.event('baa', p.num); p.baaCd = 0.6; }
      } else {
        this.fire(p);
      }
    }

    if (p.stats.fireTrail && e.dash > 0 && this.tick % 2 === 0) this.spawnProp('fire', p.x, p.y, p.id);
    this.updatePotato(p, dt);
    this.applyHazards(p, dt);
  }

  movePlayer(p, dt) {
    const e = p.e, inp = p.input, map = this.map;
    p.r = p.stats.radius * (e.shrink ? 0.6 : 1) * (e.giant ? 1.9 : 1);

    let mx = inp.mx, my = inp.my;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    if (e.reverse) { mx = -mx; my = -my; }
    const speed = p.stats.speed * (e.speed ? 1.7 : 1) * (e.shrink ? 1.35 : 1) * (e.giant ? 0.85 : 1) * (e.sheep ? 0.8 : 1);
    let tvx = mx * speed, tvy = my * speed;
    if (e.dance) { tvx = 0; tvy = 0; }
    if (e.slip) { tvx = p.slipDx * 380; tvy = p.slipDy * 380; }
    if (e.dash) { tvx = p.dashDx * PLAYER.dashSpeed; tvy = p.dashDy * PLAYER.dashSpeed; }

    if (map.ice && !e.dash && !e.slip) {
      const k = 1 - Math.exp(-2.5 * dt);
      p.vx += (tvx - p.vx) * k;
      p.vy += (tvy - p.vy) * k;
    } else {
      p.vx = tvx; p.vy = tvy;
    }

    let bx = 0, by = 0;
    const sign = this.conveyorSign();
    for (const c of map.conveyors) {
      if (pointInRect(p.x, p.y, c)) { bx += c.dx * sign; by += c.dy * sign; }
    }

    p.x += (p.vx + p.kvx + bx) * dt;
    p.y += (p.vy + p.kvy + by) * dt;
    const decay = Math.exp(-(map.ice ? 2 : 6) * dt);
    p.kvx *= decay; p.kvy *= decay;

    const n = this.collideWorld(p, p.r);
    if (n && e.slip) {
      const d = p.slipDx * n.nx + p.slipDy * n.ny;
      if (d < 0) { p.slipDx -= 2 * d * n.nx; p.slipDy -= 2 * d * n.ny; }
    }

    for (const b of map.bumpers) {
      const dx = p.x - b.x, dy = p.y - b.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < b.r + p.r) {
        p.x = b.x + (dx / d) * (b.r + p.r);
        p.y = b.y + (dy / d) * (b.r + p.r);
        this.push(p, dx / d, dy / d, 650, true);
        this.event('bump', b.x, b.y);
      }
    }
  }

  conveyorSign() {
    return Math.floor(this.roundTime / 8) % 2 === 0 ? 1 : -1;
  }

  // Push a circle out of walls, crates and the arena edge. Returns the last normal.
  collideWorld(o, r) {
    let normal = null;
    const solve = (rect) => {
      const push = circleRectPush(o.x, o.y, r, rect);
      if (push) { o.x += push.x; o.y += push.y; normal = push; }
    };
    for (const w of this.map.walls) solve(w);
    for (const c of this.crates) solve(c);
    if (o.x < r) { o.x = r; normal = { nx: 1, ny: 0 }; }
    if (o.x > WORLD_W - r) { o.x = WORLD_W - r; normal = { nx: -1, ny: 0 }; }
    if (o.y < r) { o.y = r; normal = { nx: 0, ny: 1 }; }
    if (o.y > WORLD_H - r) { o.y = WORLD_H - r; normal = { nx: 0, ny: -1 }; }
    return normal;
  }

  separatePlayers() {
    const alive = this.living();
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const min = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 1;
        const overlap = min - d;
        const nx = dx / d, ny = dy / d;
        const wa = a.e.giant && !b.e.giant ? 0.1 : b.e.giant && !a.e.giant ? 0.9 : 0.5;
        a.x -= nx * overlap * wa; a.y -= ny * overlap * wa;
        b.x += nx * overlap * (1 - wa); b.y += ny * overlap * (1 - wa);
        if (a.e.giant && !b.e.giant) this.push(b, nx, ny, 500);
        if (b.e.giant && !a.e.giant) this.push(a, -nx, -ny, 500);
        this.passPotato(a, b);
        this.passPotato(b, a);
      }
    }
  }

  fire(p) {
    const minigun = p.e.minigun > 0;
    p.fireCd = p.stats.fireInterval * (minigun ? 0.3 : 1);
    let aim = p.aim;
    if (p.input.touch) aim = this.assistAim(p, aim);
    const n = p.stats.shots;
    for (let i = 0; i < n; i++) {
      const spread = (i - (n - 1) / 2) * 0.2 + (minigun ? (Math.random() - 0.5) * 0.15 : 0);
      this.spawnProjectile(p, 'bullet', {
        angle: aim + spread,
        r: p.stats.bulletR,
        dmg: p.stats.bulletDmg,
        bounces: p.stats.bounces,
        pierce: p.stats.pierce,
      });
    }
    this.event('shot', p.num);
  }

  // Bend touch shots slightly toward the nearest enemy inside a narrow cone.
  assistAim(p, aim) {
    const cone = (PLAYER.aimAssistDeg * Math.PI) / 180;
    let best = null, bestDiff = cone;
    for (const o of this.living()) {
      if (o === p || o.e.invis) continue;
      let diff = Math.atan2(o.y - p.y, o.x - p.x) - aim;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      if (Math.abs(diff) < Math.abs(bestDiff)) { best = diff; bestDiff = diff; }
    }
    return best === null ? aim : aim + best * 0.7;
  }

  updatePotato(p, dt) {
    if (!p.potato) return;
    p.potato.t -= dt;
    p.potato.passCd -= dt;
    if (p.potato.t <= 0) {
      const owner = this.players.get(p.potato.owner);
      p.potato = null;
      this.explode(p.x, p.y, 130, 25, owner, 'potato', p);
      this.damage(p, 60, owner, 'potato');
    }
  }

  passPotato(from, to) {
    if (!from.potato || to.potato || from.potato.passCd > 0) return;
    to.potato = { ...from.potato, passCd: 0.6 };
    from.potato = null;
    this.event('potatoPass', from.num, to.num);
  }

  applyHazards(p, dt) {
    for (const l of this.map.lava) {
      if (pointInRect(p.x, p.y, l)) this.damage(p, ROUND.lavaDps * dt, null, 'lava', true);
    }
    const zr = this.zoneRadius();
    if (zr && dist2(p.x, p.y, WORLD_W / 2, WORLD_H / 2) > zr * zr) {
      this.damage(p, ROUND.zoneDps * dt, null, 'zone', true);
    }
    if (!p.alive) return;
    for (const k of this.pickups) {
      if (k.dead) continue;
      const pullR = p.stats.magnet ? 220 : 0;
      const d2 = dist2(p.x, p.y, k.x, k.y);
      if (pullR && d2 < pullR * pullR) {
        const d = Math.sqrt(d2) || 1;
        k.x += ((p.x - k.x) / d) * 300 * dt;
        k.y += ((p.y - k.y) / d) * 300 * dt;
      }
      if (!p.item && d2 < (p.r + 16) ** 2) {
        k.dead = true;
        p.item = pick(PICKUP_IDS);
        this.event('pickup', p.num);
      }
    }
  }

  updateGhost(p, dt, presses) {
    const inp = p.input;
    p.x = clamp(p.x + inp.mx * 330 * dt, 20, WORLD_W - 20);
    p.y = clamp(p.y + inp.my * 330 * dt, 20, WORLD_H - 20);
    if (this.phase !== 'playing' || p.ghostCd > 0) return;
    if (presses.abil || presses.item) {
      this.spawnProp('banana', p.x, p.y, p.id);
      p.ghostCd = ROUND.ghostCooldown;
      p.aw.ghost++;
      this.event('ghostBanana', p.num);
    } else if (inp.fire || presses.dash) {
      let spooked = 0;
      for (const o of this.living()) {
        const dx = o.x - p.x, dy = o.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 110) { this.push(o, dx / d, dy / d, 650); spooked++; }
      }
      p.ghostCd = spooked ? ROUND.ghostCooldown : 0.5;
      if (spooked) p.aw.ghost++;
      this.event('spook', p.num, Math.round(p.x), Math.round(p.y));
    }
  }

  // ------------------------------------------------------------------ combat

  damage(target, amount, attacker, source, quiet = false) {
    if (!target.alive || this.phase !== 'playing' || amount <= 0) return;
    if (target.e.bubble > 0 || target.e.dash > 0) {
      if (!quiet) this.event('block', target.num);
      return;
    }
    if (target.e.giant) amount *= 0.5;
    if (target.e.shrink) amount *= 1.5;
    target.hp -= amount;
    target.aw.taken += amount;
    if (attacker && attacker !== target) {
      attacker.aw.dealt += amount;
      target.lastHit = { by: attacker.id, t: this.roundTime };
      if (attacker.alive && attacker.stats.vampire && !quiet) {
        attacker.hp = Math.min(attacker.stats.maxHp, attacker.hp + attacker.stats.vampire);
      }
    }
    if (!quiet) this.event('hit', target.num, Math.round(amount), attacker ? attacker.num : 0);
    if (target.hp <= 0) this.kill(target, attacker, source);
  }

  kill(victim, attacker, source) {
    victim.alive = false;
    victim.ghost = true;
    victim.hp = 0;
    victim.potato = null;
    victim.kvx = 0; victim.kvy = 0;

    // Environmental deaths credit whoever hit you in the last 4 seconds.
    let killer = attacker;
    if (!killer && victim.lastHit && this.roundTime - victim.lastHit.t < 4) {
      killer = this.players.get(victim.lastHit.by) || null;
    }
    if (killer === victim) killer = null;

    let verb = source;
    if (victim.e.sheep) verb = 'sheep';
    else if (victim.e.slip) verb = 'slip';

    if (killer) {
      killer.aw.kos++;
      if (this.isCrown(victim) && killer.alive) {
        killer.hp = Math.min(killer.stats.maxHp, killer.hp + ROUND.crownHeal);
        this.event('crown', killer.num);
      }
      if (killer.nemesis === victim.id) {
        killer.nemesis = null;
        this.event('revenge', killer.num);
      }
      victim.nemesis = killer.id;
    } else if (source !== 'left') {
      victim.aw.selfKOs++;
    }

    this.event('ko', victim.num, killer ? killer.num : 0, verb, Math.round(victim.x), Math.round(victim.y));

    if (victim.stats.lastLaugh && source !== 'left') {
      const n = victim.stats.lastLaugh;
      this.explode(victim.x, victim.y, 100 + 25 * n, 25 + 10 * n, victim, 'lastlaugh', victim);
    }
    this.checkRoundEnd();
  }

  isCrown(p) {
    let max = 0, count = 0;
    for (const o of this.players.values()) {
      if (o.score > max) { max = o.score; count = 1; } else if (o.score === max) count++;
    }
    return max > 0 && count === 1 && p.score === max;
  }

  push(target, nx, ny, force, ignoreMass = false) {
    const f = !ignoreMass && target.e.giant ? force * 0.3 : force;
    target.kvx += nx * f;
    target.kvy += ny * f;
  }

  applyEffect(target, name, seconds, by) {
    if (!target.alive) return false;
    if (NEGATIVE_EFFECTS.has(name) && (target.e.bubble > 0 || target.e.dash > 0)) {
      this.event('block', target.num);
      return false;
    }
    target.e[name] = Math.max(target.e[name], seconds);
    this.event('effect', target.num, name, by ? by.num : 0);
    return true;
  }

  slip(target, owner, vx, vy) {
    if (!this.applyEffect(target, 'slip', 1.2, owner)) return;
    let d = Math.hypot(vx, vy);
    if (d < 1) { const a = rand(0, Math.PI * 2); vx = Math.cos(a); vy = Math.sin(a); d = 1; }
    target.slipDx = vx / d;
    target.slipDy = vy / d;
    if (owner && owner !== target) owner.aw.slips++;
  }

  explode(x, y, radius, dmg, attacker, source, exclude = null) {
    this.event('boom', Math.round(x), Math.round(y), radius);
    for (const p of this.living()) {
      if (p === exclude) continue;
      const dx = p.x - x, dy = p.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > radius + p.r) continue;
      this.damage(p, dmg * (1 - (0.5 * d) / (radius + p.r)), attacker, source);
      this.push(p, dx / d, dy / d, 550);
    }
    for (const c of this.crates) {
      if (circleOverlapsRect(x, y, radius, c)) this.damageCrate(c, 2);
    }
  }

  damageCrate(c, amount) {
    if (c.hp <= 0) return;
    c.hp -= amount;
    if (c.hp > 0) return;
    this.crates = this.crates.filter((o) => o !== c);
    this.event('crate', Math.round(c.x + c.w / 2), Math.round(c.y + c.h / 2));
    if (Math.random() < ROUND.crateDropChance) this.spawnPickup(c.x + c.w / 2, c.y + c.h / 2);
  }

  // ------------------------------------------------------------------ projectiles

  spawnProjectile(owner, kind, opts = {}) {
    const def = PROJECTILES[kind];
    const angle = opts.angle ?? owner.aim;
    const speed = opts.speed ?? def.speed;
    const r = opts.r ?? def.r;
    const off = owner.r + r + 2;
    const b = {
      id: this.nextId++,
      kind,
      owner: owner.id,
      ownerNum: owner.num,
      x: owner.x + Math.cos(angle) * off,
      y: owner.y + Math.sin(angle) * off,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r,
      dmg: opts.dmg ?? def.dmg,
      knock: def.knock,
      life: def.life,
      age: 0,
      bounces: opts.bounces ?? 0,
      pierce: opts.pierce ?? def.pierce ?? 0,
      rage: kind === 'bullet' ? owner.stats.rage : 0,
      magnet: kind === 'bullet' ? owner.stats.magnet : 0,
      bounced: false,
      hitIds: new Set(),
      data: {},
      dead: false,
    };
    this.bullets.push(b);
    return b;
  }

  updateBullets(dt) {
    const blackholes = this.props.filter((o) => o.kind === 'blackhole');
    for (const b of this.bullets) {
      if (b.dead) continue;
      const def = PROJECTILES[b.kind];
      def.update?.(this, b, dt);
      if (b.dead) continue;

      for (const h of blackholes) {
        const dx = h.x - b.x, dy = h.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 400) { b.vx += (dx / d) * 1400 * dt; b.vy += (dy / d) * 1400 * dt; }
      }
      if (b.magnet) this.steerBullet(b, dt);

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.age += dt;
      if (b.age >= b.life) {
        b.dead = true;
        def.onExpire?.(this, b);
        continue;
      }
      if (this.bulletVsWorld(b, def)) continue;
      this.bulletVsPlayers(b, def);
      if (!b.dead) this.bulletVsDecoys(b);
    }
  }

  steerBullet(b, dt) {
    const owner = this.players.get(b.owner);
    const t = this.nearestEnemy(b.x, b.y, owner, 260);
    if (!t) return;
    const sp = Math.hypot(b.vx, b.vy);
    const want = Math.atan2(t.y - b.y, t.x - b.x);
    let cur = Math.atan2(b.vy, b.vx);
    let diff = want - cur;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = 1.6 * b.magnet * dt;
    cur += clamp(diff, -turn, turn);
    b.vx = Math.cos(cur) * sp;
    b.vy = Math.sin(cur) * sp;
  }

  // Returns true when the bullet was removed.
  bulletVsWorld(b, def) {
    let hitRect = null, push = null;
    for (const w of this.map.walls) {
      push = circleRectPush(b.x, b.y, b.r, w);
      if (push) { hitRect = w; break; }
    }
    if (!push) {
      for (const c of this.crates) {
        push = circleRectPush(b.x, b.y, b.r, c);
        if (push) { hitRect = c; break; }
      }
    }
    if (!push) {
      if (b.x < b.r) push = { x: b.r - b.x, y: 0, nx: 1, ny: 0 };
      else if (b.x > WORLD_W - b.r) push = { x: WORLD_W - b.r - b.x, y: 0, nx: -1, ny: 0 };
      else if (b.y < b.r) push = { x: 0, y: b.r - b.y, nx: 0, ny: 1 };
      else if (b.y > WORLD_H - b.r) push = { x: 0, y: WORLD_H - b.r - b.y, nx: 0, ny: -1 };
    }

    let bumper = null;
    if (!push) {
      for (const m of this.map.bumpers) {
        const dx = b.x - m.x, dy = b.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < m.r + b.r) { bumper = m; push = { x: (dx / d) * (m.r + b.r - d), y: (dy / d) * (m.r + b.r - d), nx: dx / d, ny: dy / d }; break; }
      }
    }
    if (!push) return false;

    if (hitRect && hitRect.hp !== undefined) this.damageCrate(hitRect, 1);

    const reflect = () => {
      b.x += push.x; b.y += push.y;
      const d = b.vx * push.nx + b.vy * push.ny;
      if (d < 0) { b.vx -= 2 * d * push.nx; b.vy -= 2 * d * push.ny; }
    };

    if (def.onWall) {
      if (def.onWall(this, b)) { b.dead = true; return true; }
      reflect();
      return false;
    }
    if (bumper) { reflect(); return false; }
    if (b.bounces > 0) {
      b.bounces--;
      b.bounced = true;
      reflect();
      if (b.rage) {
        b.dmg += 5 * b.rage;
        b.vx *= 1.12; b.vy *= 1.12;
      }
      return false;
    }
    b.dead = true;
    this.event('spark', Math.round(b.x), Math.round(b.y));
    return true;
  }

  bulletVsPlayers(b, def) {
    for (const p of this.players.values()) {
      if (!p.alive || b.dead) continue;
      if (p.id === b.owner && !b.bounced) continue;
      if (b.hitIds.has(p.id)) continue;
      const hitR = p.r * (p.e.bighead ? 1.5 : 1);
      if (dist2(b.x, b.y, p.x, p.y) >= (hitR + b.r) ** 2) continue;

      if (p.e.mirror > 0 && def.reflectable !== false && p.id !== b.owner) {
        b.owner = p.id;
        b.ownerNum = p.num;
        b.bounced = false;
        b.vx = -b.vx; b.vy = -b.vy;
        this.event('reflect', p.num);
        continue;
      }
      const consumed = (def.onHit || defaultHit)(this, b, p);
      b.hitIds.add(p.id);
      if (consumed) {
        if (b.pierce > 0) b.pierce--;
        else b.dead = true;
      }
    }
  }

  bulletVsDecoys(b) {
    for (const o of this.props) {
      if (o.kind !== 'decoy' || o.dead || o.owner === b.owner) continue;
      if (dist2(b.x, b.y, o.x, o.y) < (o.r + b.r) ** 2) {
        b.dead = true;
        PROPS.decoy.onShot(this, o);
        return;
      }
    }
  }

  nearestEnemy(x, y, owner, maxDist) {
    let best = null, bestD = maxDist * maxDist;
    for (const p of this.players.values()) {
      if (!p.alive || p === owner || p.e.invis) continue;
      const d = dist2(x, y, p.x, p.y);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  // ------------------------------------------------------------------ props & pickups

  spawnProp(kind, x, y, ownerId, extra = {}) {
    const def = PROPS[kind];
    const owner = this.players.get(ownerId);
    const prop = {
      id: this.nextId++,
      kind,
      x, y,
      r: def.r,
      owner: ownerId,
      ownerNum: owner ? owner.num : 0,
      angle: 0,
      age: 0,
      life: def.life,
      vx: 0, vy: 0,
      dead: false,
      ...extra,
    };
    this.props.push(prop);
    return prop;
  }

  updateProps(dt) {
    for (const o of this.props) {
      if (o.dead) continue;
      o.age += dt;
      if (o.age >= o.life) { o.dead = true; continue; }
      const def = PROPS[o.kind];
      def.update?.(this, o, dt);
      if (!def.onTouch) continue;
      for (const p of this.living()) {
        if (o.dead) break;
        if (dist2(p.x, p.y, o.x, o.y) < (p.r + o.r) ** 2) def.onTouch(this, o, p);
      }
    }
  }

  spawnPickup(x, y) {
    this.pickups.push({ id: this.nextId++, x, y, dead: false });
  }

  updatePickups(dt) {
    this.pickups = this.pickups.filter((k) => !k.dead);
    if (this.phase !== 'playing') return;
    this.pickupTimer -= dt;
    if (this.pickupTimer <= 0) {
      this.pickupTimer = ROUND.pickupEvery;
      if (this.pickups.length < ROUND.maxPickups) {
        const spot = this.randomFreeSpot(20, true);
        this.spawnPickup(spot.x, spot.y);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  event(...args) {
    this.events.push(args);
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  living() {
    const out = [];
    for (const p of this.players.values()) if (p.alive) out.push(p);
    return out;
  }

  isFree(x, y, r) {
    if (x < r || y < r || x > WORLD_W - r || y > WORLD_H - r) return false;
    for (const w of this.map.walls) if (circleOverlapsRect(x, y, r, w)) return false;
    for (const c of this.crates) if (circleOverlapsRect(x, y, r, c)) return false;
    for (const l of this.map.lava) if (circleOverlapsRect(x, y, r, l)) return false;
    for (const b of this.map.bumpers) if (dist2(x, y, b.x, b.y) < (b.r + r) ** 2) return false;
    return true;
  }

  randomFreeSpot(r, insideZone = false) {
    const zr = insideZone ? this.zoneRadius() : 0;
    for (let i = 0; i < 100; i++) {
      const x = rand(60, WORLD_W - 60), y = rand(60, WORLD_H - 60);
      if (zr && dist2(x, y, WORLD_W / 2, WORLD_H / 2) > (zr - 40) ** 2) continue;
      if (this.isFree(x, y, r + 8)) return { x, y };
    }
    return { x: WORLD_W / 2, y: WORLD_H / 2 - 200 };
  }

  teleport(p, x, y) {
    p.x = x; p.y = y;
    p.kvx = 0; p.kvy = 0;
  }

  zoneRadius() {
    const t = this.roundTime - ROUND.zoneStart;
    if (t <= 0 || (this.phase !== 'playing' && this.phase !== 'roundEnd')) return 0;
    const max = Math.hypot(WORLD_W, WORLD_H) / 2;
    const k = Math.min(1, t / ROUND.zoneShrinkTime);
    return max + (ROUND.zoneMinRadius - max) * k;
  }
}

