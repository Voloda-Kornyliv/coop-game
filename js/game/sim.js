// The authoritative game simulation. Runs ONLY on the host, in fixed 60 Hz
// steps. It never touches the DOM or the network: inputs come in through
// setInput()/handlePick(), and everything that happened goes out through
// `events` (drained into snapshots) and `outbox` (per-player messages).
// Section numbers refer to GAME_DESIGN.txt.

import {
  TICK_DT, PLAYER, ROUND, COLORS, PROGRESSION, BUSH, TEAMS, INTEREST, OBJECTS,
  SUDDEN_DEATH, BOSS, GOLDEN, TITLES,
} from './config.js';
import {
  clamp, dist2, rand, pick, shuffle, circleRectPush, circleOverlapsRect, pointInRect,
  segmentHitsRect, rectsOverlap,
} from './geometry.js';
import { MAPS, mapIndex } from './maps.js';
import {
  ACTIVES, PASSIVES, PICKUPS, PROJECTILES, PROPS, ACTIVE_IDS, PASSIVE_IDS, PICKUP_IDS,
  NEGATIVE_EFFECTS, computeStats, defaultHit, activeSynergies, SYNERGY_IDS,
} from './abilities.js';
import { OBJECT_KINDS, OBJECT_IDS } from './objects.js';
import {
  levelForXp, xpMultiplier, isUnderdog, isLeader, cardCount, bountyXp, levelCatchUp,
} from './progression.js';

const EFFECTS = [
  'dash', 'bubble', 'mirror', 'sheep', 'shrink', 'reverse', 'dance', 'slip', 'confused',
  'bighead', 'invis', 'speed', 'minigun', 'giant',
];

const num = (v, lo, hi) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const freshAwards = () => ({ kos: 0, slips: 0, selfKOs: 0, ghost: 0, dealt: 0, taken: 0, wins: 0, objects: 0, turrets: 0, kings: 0 });

export class Simulation {
  constructor({ targetWins = 5, mapId = 'random', mode = 'ffa' } = {}) {
    this.settings = { targetWins, mapId, mode: mode === 'teams' ? 'teams' : 'ffa' };
    this.players = new Map();          // peer id -> player
    this.retired = new Map();          // name -> progress of players who left (for rejoin)
    this.nextNum = 1;
    this.nextId = 1;
    this.tick = 0;
    this.phase = 'lobby';
    this.phaseTime = 0;
    this.round = 0;
    this.setMap(MAPS[0]);
    this.roundTime = 0;
    this.roundStartCount = 0;
    this.roundStartTeams = 0;
    this.slowmo = 0;
    this.bullets = [];
    this.props = [];
    this.pickups = [];
    this.crates = [];
    this.objects = [];
    this.orbs = [];
    this.zone = null;
    this.burnt = new Set();            // indices of bushes burnt this round
    this.suddenDeath = null;
    this.golden = null;
    this.pickupTimer = 0;
    this.teamScores = [0, 0];
    this.lastWinners = new Set();
    this.results = null;
    this.matchStartCount = 0;
    this.matchStartTeams = 0;
    this.events = [];                  // broadcast in the next snapshot
    this.outbox = [];                  // { to: peerId | '*', msg }
    this.rosterDirty = true;
  }

  get isTeams() { return this.settings.mode === 'teams'; }

  allies(a, b) { return this.isTeams && !!a && !!b && a.team === b.team; }

  isEnemy(a, b) { return a !== b && !this.allies(a, b); }

  setMap(map) {
    this.map = map;
    this.W = map.w;
    this.H = map.h;
  }

  // ------------------------------------------------------------------ players

  addPlayer({ id, name, hat, team }) {
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
      team: team === 0 || team === 1 ? team : this.smallerTeam(),
      score: 0,
      streak: 0,
      xp: 0,
      level: 1,
      ability: pick(ACTIVE_IDS),
      passives: {},
      nemesis: null,
      aw: freshAwards(),
      input: { mx: 0, my: 0, ax: 1, ay: 0, fire: false, touch: false },
      counts: null,
      offer: null,
      picked: true,
      away: false,
      emote: -1,
      emoteT: 0,
      ...(saved || {}),
    };
    if (this.isTeams) p.score = this.teamScores[p.team];
    this.resetForRound(p, null);
    p.alive = false;                    // joins as a ghost until the next round
    p.ghost = true;
    this.players.set(id, p);
    if (this.phase === 'draft') this.offerCards(p);
    if (this.results) this.outbox.push({ to: id, msg: this.results });
    this.rosterDirty = true;
  }

  smallerTeam() {
    const counts = [0, 0];
    for (const p of this.players.values()) if (p.team === 0 || p.team === 1) counts[p.team]++;
    return counts[1] < counts[0] ? 1 : 0;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.alive) this.kill(p, null, 'left');
    const { score, passives, ability, aw, nemesis, xp, level, team } = p;
    this.retired.set(p.name, { score, passives, ability, aw, nemesis, xp, level, team });
    this.players.delete(id);
    this.rosterDirty = true;
    this.checkRoundEnd();
  }

  // A player whose connection dropped keeps their slot while they reconnect.
  // Their character freezes and the round pauses (see `paused`).
  setAway(id, away) {
    const p = this.players.get(id);
    if (!p || p.away === away) return;
    p.away = away;
    p.awayTime = 0;
    p.input = { mx: 0, my: 0, ax: Math.cos(p.aim), ay: Math.sin(p.aim), fire: false, touch: p.input.touch };
    p.counts = null;                   // a reloaded client restarts its counters
    p.pending = null;
    p.lastSeq = 0;                     // ...and its input sequence numbers
    this.event(away ? 'away' : 'back', p.num);
  }

  // Re-send everything a (re)connecting client needs beyond snapshots.
  resync(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.rosterDirty = true;
    if (this.phase === 'draft' && p.offer && !p.picked) this.outbox.push({ to: id, msg: { type: 'offer', cards: p.offer, reroll: !!p.canReroll } });
    if (this.results) this.outbox.push({ to: id, msg: this.results });
  }

  // Pause while someone reconnects, but never for longer than maxPause: after
  // that the round goes on with their character frozen (slot still reserved).
  get paused() {
    if (this.phase !== 'countdown' && this.phase !== 'playing' && this.phase !== 'roundEnd') return false;
    for (const p of this.players.values()) if (p.away && p.awayTime < ROUND.maxPause) return true;
    return false;
  }

  resetForRound(p, spawn) {
    p.stats = this.statsFor(p);
    p.r = p.stats.radius;
    p.hp = p.stats.maxHp;
    p.shield = 0;
    p.alive = true;
    p.ghost = false;
    p.x = spawn ? spawn.x : this.W / 2;
    p.y = spawn ? spawn.y : this.H / 2;
    p.vx = 0; p.vy = 0; p.kvx = 0; p.kvy = 0;
    p.aim = Math.atan2(this.H / 2 - p.y, this.W / 2 - p.x);
    p.fireCd = 0; p.dashCd = 0; p.abilCd = 0; p.padCd = 0; p.baaCd = 0; p.ghostCd = 0;
    p.dashDx = 1; p.dashDy = 0; p.slipDx = 1; p.slipDy = 0;
    p.item = null;
    p.potato = null;
    p.lastHit = null;
    p.ammo = p.stats.magazine;
    p.reloadT = 0;
    p.idleT = 0;
    p.trickleT = 0;
    p.slipFireT = 0;
    p.possess = null;
    p.moveSpeed = p.stats.speed;
    p.inBush = false;
    p.revealT = 0;
    p.revived = false;
    p.reviveT = 0;
    p.e = Object.fromEntries(EFFECTS.map((k) => [k, 0]));
  }

  statsFor(p) {
    return computeStats(p.passives, p.level, { teamBuff: !!p.teamBuff });
  }

  // Inputs come straight from the network: validate everything.
  setInput(id, msg) {
    const p = this.players.get(id);
    if (!p || !msg) return;
    // Input travels on an unordered channel: ignore anything older than
    // what we already have (sequence numbers only ever go up).
    const seq = int(msg.s);
    if (seq && seq <= (p.lastSeq || 0)) return;
    p.lastSeq = seq;
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
      p.streak = 0;
      p.xp = 0;
      p.level = 1;
      p.passives = {};
      p.nemesis = null;
      p.aw = freshAwards();
    }
    this.teamScores = [0, 0];
    this.round = 0;
    this.results = null;
    this.lastWinners = new Set();
    this.matchStartCount = this.players.size;
    this.matchStartTeams = this.teamsPresent().size;
    this.rosterDirty = true;
    this.startDraft();
  }

  teamsPresent() {
    return new Set([...this.players.values()].map((p) => p.team));
  }

  setPhase(phase) {
    this.phase = phase;
    this.phaseTime = 0;
  }

  startDraft() {
    this.setPhase('draft');
    for (const p of this.players.values()) this.offerCards(p);
  }

  offerCards(p, isReroll = false) {
    const firstDraft = this.round === 0;
    const count = cardCount(this, p, firstDraft, this.lastWinners);
    if (count === 0) {
      // Round winners skip the draft, but get a silly title (section 8).
      p.offer = null;
      p.picked = true;
      this.outbox.push({ to: p.id, msg: { type: 'offer', cards: [], skipped: true, title: p.title } });
      return;
    }
    const cards = new Set();
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
    // Underdogs get one free reroll per draft (section 12).
    if (!isReroll) p.canReroll = !firstDraft && isUnderdog(this, p);
    this.outbox.push({ to: p.id, msg: { type: 'offer', cards: p.offer, reroll: !!p.canReroll } });
  }

  handleReroll(id) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'draft' || p.picked || !p.canReroll) return;
    p.canReroll = false;
    this.offerCards(p, true);
  }

  handlePick(id, card) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'draft' || p.picked || !p.offer?.includes(card)) return;
    this.applyCard(p, card);
  }

  applyCard(p, card) {
    const [kind, cid] = card.split(':');
    const before = activeSynergies(p.passives);
    if (kind === 'a') p.ability = cid;
    else p.passives[cid] = (p.passives[cid] || 0) + 1;
    for (const id of activeSynergies(p.passives)) {
      if (!before.has(id)) this.event('synergy', p.num, SYNERGY_IDS.indexOf(id));
    }
    p.stats = this.statsFor(p);
    p.picked = true;
    p.offer = null;
    this.rosterDirty = true;
  }

  startRound() {
    this.round++;
    const forced = mapIndex(this.settings.mapId);
    this.setMap(forced >= 0 ? MAPS[forced] : pick(MAPS));
    const map = this.map;
    this.bullets = [];
    this.props = [];
    this.pickups = [];
    this.orbs = [];
    this.crates = map.crates.map((c) => ({ ...c, id: this.nextId++, hp: ROUND.crateHp }));
    this.objects = [
      ...map.turrets.map((t) => this.makeObject('turret', t)),
      ...map.barrels.map((b) => this.makeObject('barrel', b)),
      this.makeObject('vault', map.vault),
    ];
    this.roundTime = 0;
    this.pickupTimer = ROUND.pickupEvery / 2;
    this.slowmo = 0;
    this.burnt = new Set();
    this.firstBlood = false;
    this.suddenDeath = null;
    this.golden = null;
    this.goldenDone = false;

    // The final circle is random but known from the start (section 9).
    const fx = rand(this.W * 0.3, this.W * 0.7), fy = rand(this.H * 0.3, this.H * 0.7);
    this.zone = {
      fx, fy,
      startR: Math.max(...[[0, 0], [this.W, 0], [0, this.H], [this.W, this.H]].map(([x, y]) => Math.hypot(x - fx, y - fy))),
      minR: ROUND.zoneMinRadius,
      startAt: this.players.size <= ROUND.smallGame ? ROUND.zoneStartSmallGame : ROUND.zoneStart,
    };

    for (const p of levelCatchUp(this)) this.event('catchUp', p.num, p.level);

    // Section 2: the smaller team gets the "Underdog Squad" buff.
    const sizes = [0, 0];
    for (const p of this.players.values()) if (p.team === 0 || p.team === 1) sizes[p.team]++;
    const small = sizes[0] === sizes[1] ? -1 : sizes[0] < sizes[1] ? 0 : 1;
    for (const p of this.players.values()) p.teamBuff = this.isTeams && p.team === small;

    // Section 12: match point "boss mode".
    const target = this.settings.targetWins;
    for (const p of this.players.values()) p.boss = target > 1 && p.score === target - 1;
    const bosses = [...this.players.values()].filter((p) => p.boss);
    if (bosses.length) {
      if (this.isTeams) this.event('matchPointTeam', bosses[0].team);
      else for (const p of bosses) this.event('matchPoint', p.num);
    }

    const spawns = this.assignSpawns();
    for (const p of this.players.values()) {
      this.resetForRound(p, spawns.get(p.id));
      if (isUnderdog(this, p)) p.shield = PROGRESSION.underdogShield;
    }
    this.roundStartCount = this.players.size;
    this.roundStartTeams = this.teamsPresent().size;
    this.setPhase('countdown');
    this.event('round', this.round);
  }

  // Free-for-all: shuffled. Teams: each team on its own half (section 2).
  assignSpawns() {
    const out = new Map();
    const all = shuffle([...this.map.spawns]);
    if (!this.isTeams) {
      let i = 0;
      for (const p of this.players.values()) out.set(p.id, all[i++ % all.length]);
      return out;
    }
    const sides = [all.filter((s) => s.x < this.W / 2), all.filter((s) => s.x >= this.W / 2)];
    const idx = [0, 0];
    for (const p of this.players.values()) {
      const side = sides[p.team] || all;
      out.set(p.id, side[idx[p.team]++ % side.length]);
    }
    return out;
  }

  makeObject(kind, at) {
    const def = OBJECT_KINDS[kind];
    const hp = def.hp(this.round);
    const o = { id: this.nextId++, kind, x: at.x, y: at.y, r: def.radius, hp, maxHp: hp, aim: 0, charge: 0 };
    def.init?.(o);
    return o;
  }

  checkRoundEnd() {
    if (this.phase !== 'playing') return;
    const alive = this.living();
    let winners;
    if (this.isTeams) {
      const teams = new Set(alive.map((p) => p.team));
      if (teams.size > (this.roundStartTeams > 1 ? 1 : 0)) return;
      const team = teams.size ? [...teams][0] : -1;
      winners = team >= 0 ? [...this.players.values()].filter((p) => p.team === team) : [];
      if (team >= 0) {
        this.teamScores[team]++;
        for (const p of this.players.values()) p.score = this.teamScores[p.team];
        this.event('teamWin', team);
      } else {
        this.event('draw');
      }
    } else {
      if (alive.length > (this.roundStartCount > 1 ? 1 : 0)) return;
      winners = alive.slice(0, 1);
      if (winners[0]) { winners[0].score++; this.event('roundWin', winners[0].num); }
      else this.event('draw');
    }
    this.lastWinners = new Set(winners.map((p) => p.id));
    for (const p of this.players.values()) {
      const won = this.lastWinners.has(p.id);
      p.streak = won ? p.streak + 1 : 0;
      p.title = won ? pick(TITLES) : null;
      if (won) p.aw.wins++;
    }
    this.slowmo = ROUND.slowmoTime;
    this.rosterDirty = true;
    this.setPhase('roundEnd');
  }

  finishRound() {
    const target = this.settings.targetWins;
    if (this.isTeams) {
      const team = this.teamScores.findIndex((s) => s >= target);
      if (team >= 0) { this.endMatch({ winnerTeam: team }); return; }
    } else {
      const winner = [...this.players.values()].find((p) => this.lastWinners.has(p.id));
      if (winner && winner.score >= target) { this.endMatch({ winnerNum: winner.num }); return; }
    }
    this.startDraft();
  }

  endMatch({ winnerNum = 0, winnerTeam = -1, reason = '' }) {
    const all = [...this.players.values()];
    const best = (fn, minValue = 1, pool = all) => {
      let top = null, topV = -Infinity;
      for (const p of pool) { const v = fn(p); if (v > topV) { top = p; topV = v; } }
      return top && topV >= minValue ? top : null;
    };
    const winningTeam = all.filter((p) => p.team === winnerTeam);
    const awards = [
      ...(this.isTeams
        ? [['⭐', 'Team MVP', best((p) => p.aw.kos * 100 + p.aw.dealt + p.aw.objects * 20, 0, winningTeam), (p) => `${plural(p.aw.kos, 'KO')}, ${Math.round(p.aw.dealt)} damage`]]
        : [['🏆', 'Champion', best((p) => p.score), (p) => plural(p.score, 'round win')]]),
      ['🎯', 'Sharpshooter', best((p) => p.aw.kos), (p) => plural(p.aw.kos, 'KO')],
      ['🗡️', 'Kingslayer', best((p) => p.aw.kings), (p) => plural(p.aw.kings, 'Crown Holder KO')],
      ['🧱', 'Demolition', best((p) => p.aw.objects), (p) => plural(p.aw.objects, 'object') + ' destroyed'],
      ['🔧', 'Turret Tamer', best((p) => p.aw.turrets), (p) => plural(p.aw.turrets, 'turret') + ' destroyed'],
      ['🍌', 'Banana King', best((p) => p.aw.slips), (p) => `${plural(p.aw.slips, 'enemy', 'enemies')} slipped`],
      ['💥', 'Kamikaze', best((p) => p.aw.selfKOs), (p) => plural(p.aw.selfKOs, 'self-KO')],
      ['👻', 'Ghost of the Match', best((p) => p.aw.ghost), (p) => `${plural(p.aw.ghost, 'ghostly annoyance')} & possessions`],
      ['🕊️', 'Pacifist', best((p) => -p.aw.dealt, -Infinity), (p) => `only ${Math.round(p.aw.dealt)} damage dealt`],
      ['🩹', 'Unlucky', best((p) => p.aw.taken), (p) => `took ${Math.round(p.aw.taken)} damage`],
    ].filter(([, , p]) => p).map(([icon, title, p, text]) => ({ icon, title, num: p.num, text: text(p) }));

    this.results = {
      type: 'results',
      mode: this.settings.mode,
      winner: winnerNum,
      winnerTeam,
      teamScores: this.teamScores,
      reason,
      standings: all.sort((a, b) => b.score - a.score || b.level - a.level)
        .map((p) => ({ num: p.num, score: p.score, level: p.level, team: p.team })),
      awards,
    };
    this.outbox.push({ to: '*', msg: this.results });
    this.setPhase('matchEnd');
  }

  // Ends the match when the opponents are gone for good.
  checkAbandoned() {
    if (this.phase === 'matchEnd' || this.phase === 'lobby') return false;
    if (this.isTeams) {
      const teams = this.teamsPresent();
      if (this.matchStartTeams > 1 && teams.size < 2 && this.players.size) {
        this.endMatch({ winnerTeam: [...teams][0], reason: 'The other team left' });
        return true;
      }
    } else if (this.matchStartCount > 1 && this.players.size < 2) {
      const last = [...this.players.values()][0];
      if (last) { this.endMatch({ winnerNum: last.num, reason: 'Everyone else left' }); return true; }
    }
    return false;
  }

  // ------------------------------------------------------------------ main step

  step() {
    this.tick++;
    for (const p of this.players.values()) if (p.away) p.awayTime += TICK_DT;
    if (this.checkAbandoned()) return;

    const emotes = () => {
      for (const p of this.players.values()) {
        p.presses = this.takePresses(p);
        if (p.presses.emote) { p.emote = p.emoteIdx; p.emoteT = 2; this.event('emote', p.num, p.emoteIdx); }
        p.emoteT = Math.max(0, p.emoteT - TICK_DT);
      }
    };

    if (this.paused) { emotes(); return; }

    this.phaseTime += TICK_DT;
    let dt = TICK_DT;
    if (this.slowmo > 0) {
      this.slowmo -= TICK_DT;
      dt *= ROUND.slowmoScale;
    }
    emotes();

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
    this.moveCrates(dt);
    for (const p of this.players.values()) this.updatePlayer(p, dt);
    this.separatePlayers();
    this.updateRevives(dt);
    for (const o of [...this.objects]) {
      if (this.objects.includes(o)) OBJECT_KINDS[o.kind].update?.call(OBJECT_KINDS[o.kind], this, o, dt);
    }
    this.updateSuddenDeath(dt);
    this.updateGolden(dt);
    this.updateProps(dt);
    this.updateBullets(dt);
    this.updatePickups(dt);
    this.updateOrbs(dt);
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
    p.revealT = Math.max(0, p.revealT - dt);
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
      // COMBAT ROLL: dashing with a part-empty magazine loads bullets (section 6).
      if (p.ammo < p.stats.magazine) {
        p.ammo = Math.min(p.stats.magazine, p.ammo + p.stats.dashReload);
        p.reloadT = 0;
        this.event('roll', p.num);
      }
    }
    if (presses.abil && p.abilCd <= 0 && canAct && ACTIVES[p.ability]) {
      ACTIVES[p.ability].cast(this, p);
      p.abilCd = ACTIVES[p.ability].cd * p.stats.cdMult;
      p.revealT = BUSH.revealTime;
      this.event('cast', p.num, ACTIVE_IDS.indexOf(p.ability));
    }
    if (presses.item && p.item && canAct) {
      const item = p.item;
      p.item = null;
      PICKUPS[item].use(this, p);
      this.event('use', p.num, PICKUP_IDS.indexOf(item));
    }

    this.movePlayer(p, dt);
    p.inBush = this.map.bushes.some((b, i) => !this.burnt.has(i) && pointInRect(p.x, p.y, b));
    this.updateReload(p, dt);

    if (inp.fire && p.fireCd <= 0 && !e.dance && !e.dash && !e.slip) {
      if (e.sheep) {
        if (p.baaCd <= 0) { this.event('baa', p.num); p.baaCd = 0.6; }
      } else if (e.minigun > 0 || p.ammo > 0 || this.sdType() === 'hyper') {
        this.fire(p);
      }
    }
    // BANANA: slipping players spray bullets in random directions, for free.
    if (e.slip > 0) {
      p.slipFireT -= dt;
      if (p.slipFireT <= 0) {
        p.slipFireT = 0.15;
        this.spawnProjectile(p, 'bullet', { angle: rand(0, Math.PI * 2), r: p.stats.bulletR, dmg: p.stats.bulletDmg });
        this.event('shot', p.num, Math.round(p.x), Math.round(p.y));
      }
    }

    if (p.stats.fireTrail && e.dash > 0 && this.tick % 2 === 0) this.spawnProp('fire', p.x, p.y, p.id);
    this.updatePotato(p, dt);
    this.applyHazards(p, dt);
  }

  // Auto-reload only (section 6): a full reload when empty, or bullets
  // trickling back one by one after a short pause in shooting.
  updateReload(p, dt) {
    p.idleT += dt;
    const mag = p.stats.magazine;
    if (this.sdType() === 'hyper') { p.ammo = mag; p.reloadT = 0; return; }
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) { p.reloadT = 0; p.ammo = mag; this.event('reloaded', p.num); }
      return;
    }
    if (p.ammo <= 0) {
      p.reloadT = p.stats.reloadTime;
      this.event('reload', p.num);
      return;
    }
    if (p.ammo < mag && p.idleT >= PLAYER.trickleDelay) {
      p.trickleT -= dt;
      if (p.trickleT <= 0) {
        p.ammo++;
        p.trickleT = p.stats.trickleEvery;
        this.event('trickle', p.num, p.ammo, mag);
      }
    } else {
      p.trickleT = 0;
    }
  }

  movePlayer(p, dt) {
    const e = p.e, inp = p.input, map = this.map;
    p.r = p.stats.radius * (e.shrink ? 0.6 : 1) * (e.giant ? 1.9 : 1) * (p.boss ? BOSS.sizeMult : 1);

    let mx = inp.mx, my = inp.my;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    if (e.reverse) { mx = -mx; my = -my; }
    const speed = p.stats.speed * (e.speed ? 1.7 : 1) * (e.shrink ? 1.35 : 1) * (e.giant ? 0.85 : 1) * (e.sheep ? 1.2 : 1)
      * (p.ammo <= 0 && p.reloadT > 0 ? 1 + PLAYER.emptySpeedBonus : 1)   // duck for cover while empty
      * (this.sdType() === 'hyper' ? 1.5 : 1);
    p.moveSpeed = speed;               // sent to the player for movement prediction
    let tvx = mx * speed, tvy = my * speed;
    if (e.dance) { tvx = 0; tvy = 0; }
    if (e.slip) { tvx = p.slipDx * 380; tvy = p.slipDy * 380; }
    if (e.dash) { tvx = p.dashDx * PLAYER.dashSpeed; tvy = p.dashDy * PLAYER.dashSpeed; }

    const onIce = map.ice && !map.grip.some((g) => pointInRect(p.x, p.y, g));
    p.onIce = onIce;
    if (onIce && !e.dash && !e.slip) {
      const k = 1 - Math.exp(-2.5 * dt);
      p.vx += (tvx - p.vx) * k;
      p.vy += (tvy - p.vy) * k;
    } else {
      p.vx = tvx; p.vy = tvy;
    }

    const belt = this.beltAt(p.x, p.y);
    p.x += (p.vx + p.kvx + belt.x) * dt;
    p.y += (p.vy + p.kvy + belt.y) * dt;
    const decay = Math.exp(-(onIce ? 2 : 6) * dt);
    p.kvx *= decay; p.kvy *= decay;

    // JUGGERNAUT and GIANT MODE crush crates just by walking through them.
    if (p.stats.juggernaut || e.giant) {
      for (const c of [...this.crates]) if (circleOverlapsRect(p.x, p.y, p.r + 2, c)) this.damageCrate(c, 99, p);
    }
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

  beltAt(x, y) {
    const sign = this.conveyorSign();
    const out = { x: 0, y: 0 };
    for (const c of this.map.conveyors) {
      if (pointInRect(x, y, c)) { out.x += c.dx * sign; out.y += c.dy * sign; }
    }
    return out;
  }

  // Factory: crates on a belt ride along until something blocks them.
  moveCrates(dt) {
    if (!this.map.conveyors.length) return;
    for (const c of this.crates) {
      const belt = this.beltAt(c.x + c.w / 2, c.y + c.h / 2);
      if (!belt.x && !belt.y) continue;
      const next = { x: c.x + belt.x * dt, y: c.y + belt.y * dt, w: c.w, h: c.h };
      if (next.x < 0 || next.y < 0 || next.x + c.w > this.W || next.y + c.h > this.H) continue;
      if (this.map.walls.some((w) => rectsOverlap(next, w))) continue;
      if (this.crates.some((o) => o !== c && rectsOverlap(next, o))) continue;
      if (this.objects.some((o) => circleOverlapsRect(o.x, o.y, o.r, next))) continue;
      c.x = next.x;
      c.y = next.y;
    }
  }

  // Push a circle out of walls, crates, objects and the map edge. Returns the last normal.
  collideWorld(o, r) {
    let normal = null;
    const solve = (rect) => {
      const push = circleRectPush(o.x, o.y, r, rect);
      if (push) { o.x += push.x; o.y += push.y; normal = push; }
    };
    for (const w of this.map.walls) solve(w);
    for (const c of this.crates) solve(c);
    for (const ob of this.objects) {
      const dx = o.x - ob.x, dy = o.y - ob.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < ob.r + r) {
        o.x = ob.x + (dx / d) * (ob.r + r);
        o.y = ob.y + (dy / d) * (ob.r + r);
        normal = { nx: dx / d, ny: dy / d };
      }
    }
    if (o.x < r) { o.x = r; normal = { nx: 1, ny: 0 }; }
    if (o.x > this.W - r) { o.x = this.W - r; normal = { nx: -1, ny: 0 }; }
    if (o.y < r) { o.y = r; normal = { nx: 0, ny: 1 }; }
    if (o.y > this.H - r) { o.y = this.H - r; normal = { nx: 0, ny: -1 }; }
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
    const free = minigun || this.sdType() === 'hyper';
    p.fireCd = p.stats.fireInterval * (minigun ? 0.3 : 1);
    p.revealT = BUSH.revealTime;
    p.idleT = 0;
    p.trickleT = 0;
    // The last bullet glows (everyone sees the reload coming); with
    // PARTING GIFT it's huge and explodes (sections 8B and 14).
    const last = !free && p.ammo === 1;
    if (!free) p.ammo--;
    let aim = p.aim;
    if (p.input.touch) aim = this.assistAim(p, aim);
    const n = p.stats.shots;
    for (let i = 0; i < n; i++) {
      const angle = aim + (i - (n - 1) / 2) * 0.2 + (minigun ? (Math.random() - 0.5) * 0.15 : 0);
      if (last && p.stats.gift) {
        this.spawnProjectile(p, 'giftShot', { angle, r: p.stats.bulletR * 2, dmg: p.stats.bulletDmg + 15 });
        continue;
      }
      const b = this.spawnProjectile(p, 'bullet', {
        angle,
        r: p.stats.bulletR * (last ? 1.25 : 1),
        dmg: p.stats.bulletDmg,
        bounces: p.stats.bounces,
        pierce: p.stats.pierce,
      });
      b.last = last;
    }
    if (p.stats.spray) this.push(p, -Math.cos(aim), -Math.sin(aim), 90, true);   // SPRAY & PRAY
    this.event('shot', p.num, Math.round(p.x), Math.round(p.y));
  }

  // Bend touch shots slightly toward the nearest enemy inside a narrow cone.
  assistAim(p, aim) {
    const cone = (PLAYER.aimAssistDeg * Math.PI) / 180;
    let best = null, bestDiff = cone;
    for (const o of this.living()) {
      if (!this.isEnemy(p, o) || o.e.invis || !this.canSee(p, o)) continue;
      if (dist2(p.x, p.y, o.x, o.y) > 700 * 700) continue;
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
      if (pointInRect(p.x, p.y, l)) this.damage(p, ROUND.lavaPctPerSec * p.stats.maxHp * dt, null, 'lava', true);
    }
    const zone = this.zoneState();
    if (zone?.active && dist2(p.x, p.y, zone.x, zone.y) > zone.r * zone.r) {
      this.damage(p, ROUND.zonePctPerSec * p.stats.maxHp * dt, null, 'zone', true);
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
        this.event('pickup', p.num, PICKUP_IDS.indexOf(p.item));
      }
    }
  }

  updateGhost(p, dt, presses) {
    if (p.possess) { this.updatePossession(p, dt, presses); return; }
    const inp = p.input;
    p.x = clamp(p.x + inp.mx * 360 * dt, 20, this.W - 20);
    p.y = clamp(p.y + inp.my * 360 * dt, 20, this.H - 20);
    if (this.phase !== 'playing') return;
    // PROP POSSESSION (section 11): ability over a crate or barrel hops inside.
    if (presses.abil || presses.item) {
      const prop = this.propAt(p.x, p.y);
      if (prop) { this.possess(p, prop); return; }
    }
    if (p.ghostCd > 0) return;
    // In a 1v1 finale ghosts wait longer, so the duel stays fair.
    const cd = this.living().length === 2 ? ROUND.ghostCooldownDuel : ROUND.ghostCooldown;
    if (presses.abil || presses.item) {
      this.spawnProp('banana', p.x, p.y, p.id, { life: ROUND.ghostBananaLife });
      p.ghostCd = cd;
      p.aw.ghost++;
      this.event('ghostBanana', p.num);
    } else if (inp.fire || presses.dash) {
      const spooked = this.spook(p.x, p.y, p, 110, 650);
      p.ghostCd = spooked ? cd : 0.5;
      if (spooked) p.aw.ghost++;
      this.event('spook', p.num, Math.round(p.x), Math.round(p.y));
    }
  }

  // "BOO!": push nearby living enemies and XP orbs away. Returns how many players.
  spook(x, y, ghost, radius, force) {
    let spooked = 0;
    for (const o of this.living()) {
      if (this.allies(ghost, o)) continue;
      const dx = o.x - x, dy = o.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < radius) { this.push(o, dx / d, dy / d, force); spooked++; }
    }
    for (const o of this.orbs) {
      const dx = o.x - x, dy = o.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < radius) { o.vx += (dx / d) * 400; o.vy += (dy / d) * 400; }
    }
    return spooked;
  }

  propAt(x, y) {
    const crate = this.crates.find((c) => !c.possessedBy && pointInRect(x, y, c));
    if (crate) return { type: 'crate', ref: crate };
    const barrel = this.objects.find((o) => o.kind === 'barrel' && !o.possessedBy && !o.fuse && dist2(x, y, o.x, o.y) < o.r * o.r);
    return barrel ? { type: 'barrel', ref: barrel } : null;
  }

  possess(p, prop) {
    prop.ref.possessedBy = p.num;
    p.possess = { type: prop.type, id: prop.ref.id };
    p.aw.ghost++;
    this.event('possess', p.num);
  }

  releaseProp(num) {
    for (const p of this.players.values()) {
      if (p.num !== num || !p.possess) continue;
      const ref = p.possess.type === 'crate' ? this.crates.find((c) => c.id === p.possess.id) : this.objects.find((o) => o.id === p.possess.id);
      if (ref) ref.possessedBy = 0;
      p.possess = null;
      this.event('unpossess', p.num);
    }
  }

  updatePossession(p, dt, presses) {
    const pos = p.possess;
    const ref = pos.type === 'crate' ? this.crates.find((c) => c.id === pos.id) : this.objects.find((o) => o.id === pos.id);
    if (!ref || this.phase !== 'playing') { p.possess = null; if (ref) ref.possessedBy = 0; return; }
    if (presses.abil || presses.item || presses.dash) { this.releaseProp(p.num); return; }
    const inp = p.input;
    const step = PLAYER.speed * ROUND.possessSpeed * dt;
    const dx = clamp(inp.mx, -1, 1) * step, dy = clamp(inp.my, -1, 1) * step;
    if (pos.type === 'crate') {
      const next = { x: ref.x + dx, y: ref.y + dy, w: ref.w, h: ref.h };
      const blocked = next.x < 0 || next.y < 0 || next.x + ref.w > this.W || next.y + ref.h > this.H
        || this.map.walls.some((w) => rectsOverlap(next, w))
        || this.crates.some((c) => c !== ref && rectsOverlap(next, c))
        || this.objects.some((o) => circleOverlapsRect(o.x, o.y, o.r, next));
      if (!blocked) { ref.x = next.x; ref.y = next.y; }
      p.x = ref.x + ref.w / 2; p.y = ref.y + ref.h / 2;
    } else {
      this.moveObject(ref, ref.x + dx, ref.y + dy);
      p.x = ref.x; p.y = ref.y;
    }
    // Wobble: a small scare for anyone close.
    if (inp.fire && p.ghostCd <= 0) {
      this.spook(p.x, p.y, p, 100, 300);
      p.ghostCd = 1.5;
      this.event('wobble', p.num, Math.round(p.x), Math.round(p.y));
    }
  }

  // Team mode: stand next to a teammate's ghost to bring them back (section 2).
  updateRevives(dt) {
    if (!this.isTeams || this.phase !== 'playing') return;
    for (const g of this.players.values()) {
      if (!g.ghost || g.revived || g.away) continue;
      const helper = this.living().find((p) => p.team === g.team
        && dist2(p.x, p.y, g.x, g.y) < (TEAMS.reviveRange + p.r) ** 2);
      if (!helper) { g.reviveT = Math.max(0, g.reviveT - dt * 2); continue; }
      g.reviveT += dt;
      if (g.reviveT >= (g.teamBuff ? TEAMS.oddReviveTime : TEAMS.reviveTime)) this.revive(g, helper);
    }
  }

  revive(g, helper) {
    let spot = { x: g.x, y: g.y };
    if (!this.isFree(spot.x, spot.y, g.stats.radius)) {
      spot = { x: helper.x, y: helper.y };
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        const x = helper.x + Math.cos(a) * 60, y = helper.y + Math.sin(a) * 60;
        if (this.isFree(x, y, g.stats.radius)) { spot = { x, y }; break; }
      }
    }
    const level = g.level, stats = g.stats;
    g.x = spot.x; g.y = spot.y;
    g.alive = true;
    g.ghost = false;
    g.revived = true;
    g.reviveT = 0;
    g.hp = Math.round(stats.maxHp * TEAMS.reviveHp);
    g.kvx = 0; g.kvy = 0; g.vx = 0; g.vy = 0;
    g.e = Object.fromEntries(EFFECTS.map((k) => [k, 0]));
    g.level = level;
    this.event('revive', g.num, helper.num);
  }

  // ------------------------------------------------------------------ progression

  gainXp(p, amount) {
    if (!p || amount <= 0) return;
    p.xp += amount * xpMultiplier(this, p);
    const target = levelForXp(p.xp);
    while (p.level < target) this.levelUp(p);
  }

  levelUp(p) {
    const oldMax = p.stats.maxHp;
    p.level++;
    p.stats = this.statsFor(p);
    if (p.alive) {
      p.hp = Math.min(p.stats.maxHp, p.hp + (p.stats.maxHp - oldMax) + PROGRESSION.levelUpHeal);
      // A small knockback wave around you (section 7).
      for (const o of this.living()) {
        if (!this.isEnemy(p, o)) continue;
        const dx = o.x - p.x, dy = o.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < PROGRESSION.levelUpRadius + o.r) this.push(o, dx / d, dy / d, PROGRESSION.levelUpPush);
      }
    }
    this.event('levelUp', p.num, p.level);
  }

  spawnOrbs(x, y, total) {
    const n = clamp(Math.round(total / 10), 1, 12);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rand(80, 240);
      this.orbs.push({ id: this.nextId++, x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, value: total / n, age: 0, dead: false });
    }
  }

  updateOrbs(dt) {
    const living = this.living();
    for (const o of this.orbs) {
      // ORB DECAY (section 7): half value after 10 s, gone after 20 s.
      o.age += dt;
      if (o.age >= ROUND.orbLife) { o.dead = true; continue; }
      const f = Math.exp(-4 * dt);
      o.vx *= f; o.vy *= f;
      let best = null, bestD = Infinity;
      for (const p of living) {
        const reach = PROGRESSION.orbMagnet + PROGRESSION.orbMagnetPerStack * p.stats.magnet + p.r;
        const d = dist2(p.x, p.y, o.x, o.y);
        if (d < reach * reach && d < bestD) { best = p; bestD = d; }
      }
      if (best) {
        const d = Math.sqrt(bestD) || 1;
        o.vx = ((best.x - o.x) / d) * 560;
        o.vy = ((best.y - o.y) / d) * 560;
        if (d < best.r + 10) {
          o.dead = true;
          this.gainXp(best, o.value * (o.age > ROUND.orbDecayAt ? 0.5 : 1));
          this.event('orb', best.num);
          continue;
        }
      }
      o.x = clamp(o.x + o.vx * dt, 10, this.W - 10);
      o.y = clamp(o.y + o.vy * dt, 10, this.H - 10);
    }
    this.orbs = this.orbs.filter((o) => !o.dead);
  }

  // ------------------------------------------------------------------ combat

  damage(target, amount, attacker, source, quiet = false) {
    if (!target.alive || this.phase !== 'playing' || amount <= 0) return;
    if (attacker && attacker !== target && this.allies(attacker, target)) return;   // no friendly fire
    if (target.e.bubble > 0 || target.e.dash > 0) {
      if (!quiet) this.event('block', target.num);
      return;
    }
    if (attacker) amount *= attacker.stats.damageMult;
    if (target.e.giant) amount *= 0.5;
    if (target.e.shrink) amount *= 1.5;
    const shown = amount;
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, amount);
      target.shield -= absorbed;
      amount -= absorbed;
    }
    target.hp -= amount;
    target.aw.taken += amount;
    if (attacker && attacker !== target) {
      attacker.aw.dealt += shown;
      target.lastHit = { by: attacker.id, t: this.roundTime };
      if (attacker.alive && attacker.stats.vampire && !quiet) {
        // 4 HP per hit, 2 per pellet (shotgun / split shot).
        const pellet = source === 'pellet' || (source === 'bullet' && attacker.stats.shots > 1);
        attacker.hp = Math.min(attacker.stats.maxHp, attacker.hp + attacker.stats.vampire * (pellet ? 2 : 4));
      }
    }
    if (!quiet) {
      target.revealT = BUSH.revealTime;
      this.event('hit', target.num, Math.round(shown), attacker ? attacker.num : 0,
        attacker ? Math.round(attacker.x) : 0, attacker ? Math.round(attacker.y) : 0);
    }
    if (target.hp <= 0) this.kill(target, attacker, source);
  }

  kill(victim, attacker, source) {
    victim.alive = false;
    victim.ghost = true;
    victim.hp = 0;
    victim.shield = 0;
    victim.potato = null;
    victim.reviveT = 0;
    victim.kvx = 0; victim.kvy = 0;

    // Environmental deaths credit whoever hit you in the last 4 seconds.
    let killer = attacker;
    if (!killer && victim.lastHit && this.roundTime - victim.lastHit.t < 4) {
      killer = this.players.get(victim.lastHit.by) || null;
    }
    if (killer === victim || (killer && this.allies(killer, victim))) killer = null;

    let verb = source;
    if (victim.e.sheep) verb = 'sheep';
    else if (victim.e.slip) verb = 'slip';

    if (killer) {
      killer.aw.kos++;
      this.gainXp(killer, PROGRESSION.xp.ko);
      if (!this.firstBlood) {
        this.firstBlood = true;
        this.gainXp(killer, PROGRESSION.xp.firstBlood);
        this.event('firstBlood', killer.num);
      }
      if (this.isCrown(victim)) {
        killer.aw.kings++;
        this.gainXp(killer, bountyXp(victim) * (victim.boss ? BOSS.bountyMult : 1));
        if (killer.alive) killer.hp = Math.min(killer.stats.maxHp, killer.hp + ROUND.crownHeal);
        this.spawnPickup(victim.x, victim.y);
        this.event('crown', killer.num);
      }
      if (killer.nemesis === victim.id) {
        killer.nemesis = null;
        this.gainXp(killer, PROGRESSION.xp.revenge);
        this.event('revenge', killer.num);
      }
      victim.nemesis = killer.id;
    } else if (source !== 'left') {
      victim.aw.selfKOs++;
    }

    this.event('ko', victim.num, killer ? killer.num : 0, verb, Math.round(victim.x), Math.round(victim.y));

    // LAST LAUGH: three live grenades roll out.
    if (victim.stats.lastLaugh && source !== 'left') {
      const n = victim.stats.lastLaugh;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + rand(0, 1);
        this.spawnProp('grenade', victim.x, victim.y, victim.id, { vx: Math.cos(a) * 280, vy: Math.sin(a) * 280, dmg: 20 + 10 * n });
      }
    }
    this.checkRoundEnd();
  }

  // CROWN RADAR (section 4): the leader shows for 1.5 s every 4 s.
  crownPulse() {
    return this.roundTime % 4 < 1.5;
  }

  // The crown is free-for-all only (section 2).
  isCrown(p) {
    if (this.isTeams) return false;
    let max = 0, count = 0;
    for (const o of this.players.values()) {
      if (o.score > max) { max = o.score; count = 1; } else if (o.score === max) count++;
    }
    return max > 0 && count === 1 && p.score === max;
  }

  push(target, nx, ny, force, ignoreMass = false) {
    let f = force;
    if (!ignoreMass && target.e.giant) f *= 0.3;
    if (!ignoreMass && target.stats.juggernaut) f *= 0.5;
    if (this.sdType() === 'zerog') f *= 4;
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
    this.burnBushesAt(x, y, radius);
    for (const p of this.living()) {
      if (p === exclude) continue;
      const dx = p.x - x, dy = p.y - y;
      const d = Math.hypot(dx, dy) || 1;
      if (d > radius + p.r) continue;
      this.damage(p, dmg * (1 - (0.5 * d) / (radius + p.r)), attacker, source);
      if (!attacker || !this.allies(attacker, p) || attacker === p) this.push(p, dx / d, dy / d, 550);
    }
    for (const c of [...this.crates]) {
      if (circleOverlapsRect(x, y, radius, c)) this.damageCrate(c, 2, attacker);
    }
    for (const o of [...this.objects]) {
      if (dist2(x, y, o.x, o.y) < (radius + o.r) ** 2) this.damageObject(o, dmg, attacker);
    }
  }

  // ANTI-CAMPING (section 9): explosions and fire burn bushes for the round.
  burnBushesAt(x, y, radius) {
    this.map.bushes.forEach((b, i) => {
      if (!this.burnt.has(i) && circleOverlapsRect(x, y, radius, b)) {
        this.burnt.add(i);
        this.event('burn', i);
      }
    });
  }

  damageCrate(c, amount, attacker = null) {
    if (c.hp <= 0) return;
    if (c.possessedBy) { amount = c.hp; this.releaseProp(c.possessedBy); }   // a shot pops the ghost out
    c.hp -= amount;
    if (c.hp > 0) return;
    this.crates = this.crates.filter((o) => o !== c);
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    this.event('crate', Math.round(cx), Math.round(cy));
    if (attacker) attacker.aw.objects++;
    this.spawnOrbs(cx, cy, PROGRESSION.xp.crate);
    if (Math.random() < ROUND.crateDropChance) this.spawnPickup(cx, cy);
  }

  damageObject(o, amount, attacker = null) {
    if (o.hp <= 0 || amount <= 0) return;
    if (attacker) amount *= attacker.stats.damageMult;
    if (o.possessedBy) this.releaseProp(o.possessedBy);
    o.hp -= amount;
    if (o.kind === 'barrel' && attacker) o.igniter = attacker;
    if (o.hp > 0) {
      // Barrels: the first hit lights a fuse (section 9).
      if (o.kind === 'barrel' && !o.fuse) {
        o.fuse = OBJECTS.barrel.fuse;
        this.event('hiss', Math.round(o.x), Math.round(o.y));
      }
      return;
    }
    this.destroyObject(o, attacker);
  }

  destroyObject(o, attacker = null) {
    if (!this.objects.includes(o)) return;
    this.objects = this.objects.filter((x) => x !== o);
    const def = OBJECT_KINDS[o.kind];
    if (attacker) {
      attacker.aw.objects++;
      if (o.kind === 'turret') attacker.aw.turrets++;
      this.gainXp(attacker, def.directXp || 0);       // split XP: some straight to the breaker
    }
    this.event('objDown', OBJECT_IDS.indexOf(o.kind), Math.round(o.x), Math.round(o.y));
    this.spawnOrbs(o.x, o.y, def.xp);
    if (Math.random() < def.dropChance) this.spawnPickup(o.x + rand(-25, 25), o.y + rand(-25, 25));
    def.onDestroy?.(this, o, attacker);
  }

  // ------------------------------------------------------------------ projectiles

  spawnProjectile(owner, kind, opts = {}) {
    const def = PROJECTILES[kind];
    const angle = opts.angle ?? owner.aim;
    const r = opts.r ?? def.r;
    const off = owner.r + r + 2;
    return this.addProjectile(kind, {
      owner: owner.id,
      ownerNum: owner.num,
      x: owner.x + Math.cos(angle) * off,
      y: owner.y + Math.sin(angle) * off,
      angle,
      speed: opts.speed ?? def.speed,
      r,
      dmg: opts.dmg ?? def.dmg,
      bounces: opts.bounces ?? 0,
      pierce: opts.pierce ?? def.pierce ?? 0,
      rage: kind === 'bullet' ? owner.stats.rage : 0,
      magnet: kind === 'bullet' ? owner.stats.magnet : 0,
    });
  }

  spawnTurretShot(turret, dmg) {
    const off = turret.r + 12;
    this.addProjectile('turretShot', {
      owner: null,
      ownerNum: 0,
      source: turret.id,
      x: turret.x + Math.cos(turret.aim) * off,
      y: turret.y + Math.sin(turret.aim) * off,
      angle: turret.aim,
      dmg,
    });
    this.event('tshot', Math.round(turret.x), Math.round(turret.y));
  }

  addProjectile(kind, f) {
    const def = PROJECTILES[kind];
    const speed = f.speed ?? def.speed;
    const b = {
      id: this.nextId++,
      kind,
      owner: f.owner,
      ownerNum: f.ownerNum,
      source: f.source ?? null,
      x: f.x,
      y: f.y,
      vx: Math.cos(f.angle) * speed,
      vy: Math.sin(f.angle) * speed,
      r: f.r ?? def.r,
      dmg: f.dmg ?? def.dmg,
      knock: def.knock,
      life: def.life,
      age: 0,
      bounces: f.bounces ?? 0,
      pierce: f.pierce ?? def.pierce ?? 0,
      rage: f.rage || 0,
      magnet: f.magnet || 0,
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
    const turn = 1.0 * b.magnet * dt;
    cur += clamp(diff, -turn, turn);
    b.vx = Math.cos(cur) * sp;
    b.vy = Math.sin(cur) * sp;
  }

  // Returns true when the bullet was removed.
  bulletVsWorld(b, def) {
    let hitRect = null, hitObject = null, push = null;
    for (const w of this.map.walls) {
      push = circleRectPush(b.x, b.y, b.r, w);
      if (push) { hitRect = w; break; }
    }
    if (!push) {
      for (const c of this.crates) {
        if (b.pierced === c.id) continue;
        push = circleRectPush(b.x, b.y, b.r, c);
        if (push) { hitRect = c; break; }
      }
    }
    if (!push) {
      for (const o of this.objects) {
        if (b.source === o.id) continue;              // a turret never hits itself
        const dx = b.x - o.x, dy = b.y - o.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < o.r + b.r) {
          hitObject = o;
          push = { x: (dx / d) * (o.r + b.r - d), y: (dy / d) * (o.r + b.r - d), nx: dx / d, ny: dy / d };
          break;
        }
      }
    }
    if (!push) {
      if (b.x < b.r) push = { x: b.r - b.x, y: 0, nx: 1, ny: 0 };
      else if (b.x > this.W - b.r) push = { x: this.W - b.r - b.x, y: 0, nx: -1, ny: 0 };
      else if (b.y < b.r) push = { x: 0, y: b.r - b.y, nx: 0, ny: 1 };
      else if (b.y > this.H - b.r) push = { x: 0, y: this.H - b.r - b.y, nx: 0, ny: -1 };
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

    const owner = b.owner ? this.players.get(b.owner) || null : null;
    // PIERCING goes through the first crate too.
    if (hitRect && hitRect.hp !== undefined && b.pierce > 0 && !def.onWall) {
      b.pierce--;
      b.pierced = hitRect.id;
      this.damageCrate(hitRect, 1, owner);
      return false;
    }
    if (hitRect && hitRect.hp !== undefined) this.damageCrate(hitRect, 1, owner);
    if (hitObject && def.objects !== false) this.damageObject(hitObject, b.dmg, owner);

    const reflect = () => {
      b.x += push.x; b.y += push.y;
      const d = b.vx * push.nx + b.vy * push.ny;
      if (d < 0) { b.vx -= 2 * d * push.nx; b.vy -= 2 * d * push.ny; }
    };

    if (def.onWall) {
      if (def.onWall(this, b, hitObject)) { b.dead = true; return true; }
      reflect();
      return false;
    }
    if (bumper) { reflect(); return false; }
    if (b.bounces > 0) {
      b.bounces--;
      b.bounced = true;
      reflect();
      if (b.rage) {
        b.dmg += 6 * b.rage;
        b.vx *= 1.12; b.vy *= 1.12;
      }
      // PINBALL WIZARD synergy: after a bounce, head for the nearest enemy.
      if (owner?.stats.pinball) {
        const t = this.nearestEnemy(b.x, b.y, owner, 800);
        if (t) {
          const sp = Math.hypot(b.vx, b.vy), a = Math.atan2(t.y - b.y, t.x - b.x);
          b.vx = Math.cos(a) * sp; b.vy = Math.sin(a) * sp;
        }
      }
      return false;
    }
    b.dead = true;
    this.event('spark', Math.round(b.x), Math.round(b.y));
    return true;
  }

  bulletVsPlayers(b, def) {
    const owner = b.owner ? this.players.get(b.owner) || null : null;
    for (const p of this.players.values()) {
      if (!p.alive || b.dead) continue;
      if (p.id === b.owner && !b.bounced) continue;
      if (owner && p !== owner && this.allies(owner, p) && !def.hitsAllies) continue;
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
    const owner = b.owner ? this.players.get(b.owner) : null;
    for (const o of this.props) {
      if (o.kind !== 'decoy' || o.dead || o.owner === b.owner) continue;
      if (owner && this.allies(owner, this.players.get(o.owner))) continue;
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
      if (owner && this.allies(owner, p)) continue;
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
      const def = PROPS[o.kind];
      if (o.age >= o.life) { o.dead = true; def.onExpire?.(this, o); continue; }
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

  // ------------------------------------------------------------------ visibility (section 9 + 15)

  // Can `viewer` see `target`? Bushes hide enemies unless close or revealed.
  canSee(viewer, target) {
    if (target === viewer || this.allies(viewer, target) || !target.alive) return true;
    if (target.inBush && target.revealT <= 0
      && dist2(viewer.x, viewer.y, target.x, target.y) > BUSH.revealDistance ** 2) return false;
    return true;
  }

  // What a player's own device needs to predict its movement (section 15):
  // last input processed, current speed, and whether simple prediction holds.
  predictionInfo(p) {
    const e = p.e;
    const knocked = Math.hypot(p.kvx, p.kvy) > 60;
    const running = (this.phase === 'playing' || this.phase === 'roundEnd') && !this.paused;
    const predictable = running && !p.away
      && (p.ghost || (p.alive && !e.slip && !e.dash && !e.dance && !p.onIce && !knocked));
    return { ack: p.lastSeq || 0, speed: p.ghost ? 360 : p.moveSpeed, predictable };
  }

  // The area the host sends to a player: their view plus a margin.
  interestRect(viewer) {
    const s = viewer.ghost ? INTEREST.ghostScale : 1;
    const hw = INTEREST.halfWidth * s, hh = INTEREST.halfHeight * s;
    return { x: viewer.x - hw, y: viewer.y - hh, w: hw * 2, h: hh * 2 };
  }

  lineOfSight(x1, y1, x2, y2) {
    for (const w of this.map.walls) if (segmentHitsRect(x1, y1, x2, y2, w)) return false;
    return true;
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
    if (x < r || y < r || x > this.W - r || y > this.H - r) return false;
    for (const w of this.map.walls) if (circleOverlapsRect(x, y, r, w)) return false;
    for (const c of this.crates) if (circleOverlapsRect(x, y, r, c)) return false;
    for (const l of this.map.lava) if (circleOverlapsRect(x, y, r, l)) return false;
    for (const b of this.map.bumpers) if (dist2(x, y, b.x, b.y) < (b.r + r) ** 2) return false;
    for (const o of this.objects) if (dist2(x, y, o.x, o.y) < (o.r + r) ** 2) return false;
    return true;
  }

  randomFreeSpot(r, insideZone = false) {
    const zone = insideZone ? this.zoneState() : null;
    for (let i = 0; i < 100; i++) {
      const x = rand(60, this.W - 60), y = rand(60, this.H - 60);
      if (zone?.active && dist2(x, y, zone.x, zone.y) > (zone.r - 40) ** 2) continue;
      if (this.isFree(x, y, r + 8)) return { x, y };
    }
    return { x: this.W / 2, y: this.H / 2 - 200 };
  }

  teleport(p, x, y) {
    p.x = x; p.y = y;
    p.kvx = 0; p.kvy = 0;
  }

  // Current zone circle. `active` once it has started closing.
  zoneState() {
    const z = this.zone;
    if (!z || (this.phase !== 'playing' && this.phase !== 'roundEnd' && this.phase !== 'countdown')) return null;
    const t = this.roundTime - z.startAt;
    const k = clamp(t / ROUND.zoneShrinkTime, 0, 1);
    let r = z.startR + (z.minR - z.startR) * k;
    // After Sudden Death has run its course the circle closes completely.
    const sd = this.suddenDeath;
    if (sd) {
      const c = (this.roundTime - sd.start - SUDDEN_DEATH.duration) / SUDDEN_DEATH.collapse;
      if (c > 0) r = z.minR * Math.max(0, 1 - c);
    }
    return { x: z.fx, y: z.fy, r, active: t > 0, startsIn: Math.max(0, -t) };
  }

  // ------------------------------------------------------------------ sudden death (section 9)

  sdType() {
    return this.suddenDeath?.type || null;
  }

  updateSuddenDeath(dt) {
    if (this.phase !== 'playing' || !this.zone) return;
    if (!this.suddenDeath) {
      const startAt = this.zone.startAt + ROUND.zoneShrinkTime + SUDDEN_DEATH.delay;
      if (this.roundTime < startAt) return;
      const alive = this.living();
      const sides = this.isTeams ? new Set(alive.map((p) => p.team)).size : alive.length;
      if (sides < 2) return;
      const idx = Math.floor(Math.random() * SUDDEN_DEATH.events.length);
      this.suddenDeath = { type: SUDDEN_DEATH.events[idx], idx, start: this.roundTime, timer: 0 };
      this.event('suddenDeath', idx);
      return;
    }
    const sd = this.suddenDeath;
    sd.timer -= dt;
    if (sd.timer > 0) return;
    if (sd.type === 'bananas') {
      sd.timer = 1;
      for (let i = 0; i < 2; i++) {
        const spot = this.randomPointInZone(16);
        if (spot) { this.spawnProp('banana', spot.x, spot.y, null, { life: 10 }); this.event('bananaRain', Math.round(spot.x), Math.round(spot.y)); }
      }
    } else if (sd.type === 'meteors') {
      sd.timer = 1.5;
      const spot = this.randomPointInZone(OBJECTS.barrel.radius + 6);
      if (spot) { this.objects.push(this.makeObject('barrel', spot)); this.event('meteor', Math.round(spot.x), Math.round(spot.y)); }
    } else {
      sd.timer = 1;
    }
  }

  randomPointInZone(r) {
    const z = this.zoneState();
    if (!z) return null;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(0, z.r - r);
      const x = z.x + Math.cos(a) * d, y = z.y + Math.sin(a) * d;
      if (this.isFree(x, y, r)) return { x, y };
    }
    return null;
  }

  // ------------------------------------------------------------------ golden supply drop (section 12)

  updateGolden(dt) {
    if (this.phase !== 'playing' || this.round < GOLDEN.fromRound) return;
    if (!this.golden) {
      if (this.goldenDone || this.roundTime < GOLDEN.at) return;
      const spot = this.randomFreeSpot(GOLDEN.radius, true);
      this.golden = { x: spot.x, y: spot.y, progress: new Map() };
      this.goldenDone = true;
      this.event('golden', Math.round(spot.x), Math.round(spot.y));
      return;
    }
    const g = this.golden;
    for (const p of this.living()) {
      if (dist2(p.x, p.y, g.x, g.y) > (p.r + GOLDEN.radius) ** 2) { g.progress.delete(p.id); continue; }
      const t = (g.progress.get(p.id) || 0) + dt;
      g.progress.set(p.id, t);
      if (t >= this.goldenUnlockTime(p)) { this.openGolden(p); return; }
    }
  }

  // Underdogs open it instantly; the leader has to stand on it.
  goldenUnlockTime(p) {
    if (isUnderdog(this, p)) return GOLDEN.unlock.underdog;
    if (isLeader(this, p)) return GOLDEN.unlock.leader;
    return GOLDEN.unlock.normal;
  }

  openGolden(p) {
    const idx = Math.floor(Math.random() * GOLDEN.kinds.length);
    const kind = GOLDEN.kinds[idx];
    if (kind === 'minigun') p.e.minigun = 10;
    else if (kind === 'giant') p.e.giant = 7;
    else { p.hp = p.stats.maxHp; p.shield = (p.shield || 0) + 50; }
    this.golden = null;
    this.event('goldenOpen', p.num, idx);
  }

  // ------------------------------------------------------------------ movable objects

  shoveObject(o, vx, vy) {
    o.vx = vx;
    o.vy = vy;
  }

  // Move an object if nothing solid is in the way.
  moveObject(o, x, y) {
    if (x < o.r || y < o.r || x > this.W - o.r || y > this.H - o.r) return false;
    if (this.map.walls.some((w) => circleOverlapsRect(x, y, o.r, w))) return false;
    if (this.crates.some((c) => circleOverlapsRect(x, y, o.r, c))) return false;
    if (this.objects.some((q) => q !== o && dist2(x, y, q.x, q.y) < (q.r + o.r) ** 2)) return false;
    o.x = x;
    o.y = y;
    return true;
  }

  // Teleport All: a random free spot inside the zone, away from everyone.
  randomSafeSpot(r) {
    let spot = null;
    for (let i = 0; i < 40; i++) {
      spot = this.randomFreeSpot(r, true);
      if (this.living().every((p) => dist2(p.x, p.y, spot.x, spot.y) > 250 * 250)) return spot;
    }
    return spot;
  }
}
