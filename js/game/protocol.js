// The wire format, in one place. Snapshots are compact arrays sent ~30x/s.
// Each player gets their OWN snapshot (section 15): only what's near them,
// and enemies hidden in bushes are left out entirely, so nobody can find them
// by reading network data. encode* runs on the host, decode* on every client.

import { ROUND, MODES } from './config.js';
import { MAPS } from './maps.js';
import { ACTIVES, ACTIVE_IDS, PICKUP_IDS, PROJECTILE_IDS, PROP_IDS } from './abilities.js';
import { OBJECT_IDS } from './objects.js';
import { levelProgress, isLeader, isUnderdog } from './progression.js';
import { pointInRect, circleOverlapsRect, rectsOverlap } from './geometry.js';

export const PHASES = ['lobby', 'countdown', 'playing', 'roundEnd', 'draft', 'matchEnd'];

const FLAGS = [
  'alive', 'ghost', 'bubble', 'mirror', 'sheep', 'invis', 'dance', 'slip', 'bighead',
  'reverse', 'confused', 'crown', 'dash', 'speed', 'minigun', 'picked', 'giant', 'shrink',
  'ghostReady', 'emoting', 'away', 'seen', 'hasPos', 'inBush', 'leader', 'underdog',
];

const r1 = (v) => Math.round(v);
const r10 = (v) => Math.round(v * 10);

function phaseTimeLeft(sim) {
  switch (sim.phase) {
    case 'countdown': return ROUND.countdown - sim.phaseTime;
    case 'draft': return ROUND.draftTime - sim.phaseTime;
    case 'roundEnd': return ROUND.endDelay - sim.phaseTime;
    default: return sim.roundTime;
  }
}

// Facts that are the same for every viewer: computed once per snapshot tick.
export function sharedState(sim) {
  let crownNum = 0;
  for (const p of sim.players.values()) if (sim.isCrown(p)) crownNum = p.num;
  const all = [...sim.players.values()];
  return {
    crownNum,
    zone: sim.zoneState(),
    leaders: new Set(all.filter((p) => isLeader(sim, p)).map((p) => p.num)),
    underdogs: new Set(all.filter((p) => isUnderdog(sim, p)).map((p) => p.num)),
  };
}

function encodePlayer(sim, p, viewer, rect, shared) {
  const e = p.e;
  const seen = sim.canSee(viewer, p) && pointInRect(p.x, p.y, rect);
  // Teammates and the crown holder are always located (minimap + arrows).
  const hasPos = seen || sim.allies(viewer, p) || p.num === shared.crownNum;
  const on = {
    alive: p.alive, ghost: p.ghost, bubble: e.bubble > 0, mirror: e.mirror > 0, sheep: e.sheep > 0,
    invis: e.invis > 0, dance: e.dance > 0, slip: e.slip > 0, bighead: e.bighead > 0,
    reverse: e.reverse > 0, confused: e.confused > 0, crown: p.num === shared.crownNum, dash: e.dash > 0,
    speed: e.speed > 0, minigun: e.minigun > 0, picked: p.picked, giant: e.giant > 0,
    shrink: e.shrink > 0, ghostReady: p.ghost && p.ghostCd <= 0, emoting: p.emoteT > 0, away: p.away,
    seen, hasPos, inBush: p.inBush, leader: shared.leaders.has(p.num), underdog: shared.underdogs.has(p.num),
  };
  let bits = 0;
  FLAGS.forEach((f, i) => { if (on[f]) bits += 2 ** i; });   // > 31 flags: no bitwise ops

  const abil = ACTIVES[p.ability];
  const abilMax = abil ? abil.cd * p.stats.cdMult : 1;
  const nem = p.nemesis && sim.players.get(p.nemesis);
  return [
    p.num, hasPos ? r1(p.x) : 0, hasPos ? r1(p.y) : 0, Math.round(p.aim * 100),
    Math.ceil(p.hp), p.stats.maxHp, r1(p.r), bits, p.score,
    ACTIVE_IDS.indexOf(p.ability), Math.round(Math.max(0, p.abilCd) / abilMax * 100),
    Math.round(Math.max(0, p.dashCd) / p.stats.dashCooldown * 100),
    p.item ? PICKUP_IDS.indexOf(p.item) : -1,
    p.potato ? r10(p.potato.t) : 0,
    nem ? nem.num : 0,
    p.emoteT > 0 ? p.emote : -1,
    p.level, Math.round(levelProgress(p.xp, p.level) * 100), Math.ceil(p.shield || 0),
    p.team, r10(p.reviveT || 0),
    p.ammo ?? 0, p.stats.magazine, p.reloadT > 0 ? Math.round((1 - p.reloadT / p.stats.reloadTime) * 100) : -1,
  ];
}

export function encodeSnapshot(sim, events, viewer, shared = sharedState(sim)) {
  const rect = sim.interestRect(viewer);
  const near = (x, y) => pointInRect(x, y, rect);
  const zone = shared.zone;
  const z = sim.zone;

  return {
    type: 'snap',
    k: sim.tick,
    ph: PHASES.indexOf(sim.phase),
    pt: r10(phaseTimeLeft(sim)),
    r: sim.round,
    m: MAPS.indexOf(sim.map),
    md: MODES.indexOf(sim.settings.mode),
    ts: sim.teamScores,
    rt: r10(sim.roundTime),
    z: zone ? [r1(zone.x), r1(zone.y), zone.active ? r1(zone.r) : 0, r10(zone.startsIn)] : 0,
    zf: z ? [r1(z.fx), r1(z.fy), z.minR] : 0,
    pa: sim.paused ? 1 : 0,
    aw: [...sim.players.values()].filter((p) => p.away && sim.paused).map((p) => p.num),
    p: [...sim.players.values()].map((p) => encodePlayer(sim, p, viewer, rect, shared)),
    b: sim.bullets.filter((b) => near(b.x, b.y))
      .map((b) => [b.id, r1(b.x), r1(b.y), PROJECTILE_IDS.indexOf(b.kind), b.ownerNum, r1(b.r)]),
    o: sim.props.filter((o) => circleOverlapsRect(o.x, o.y, o.r, rect))
      .map((o) => [o.id, PROP_IDS.indexOf(o.kind), r1(o.x), r1(o.y), r1(o.r), o.ownerNum, Math.round(o.angle * 100), r10(o.life - o.age)]),
    c: sim.crates.filter((c) => rectsOverlap(c, rect)).map((c) => [c.id, r1(c.x), r1(c.y), c.w, c.h, c.hp]),
    u: sim.pickups.filter((k) => near(k.x, k.y)).map((k) => [k.id, r1(k.x), r1(k.y)]),
    // Objects are few and the minimap needs turrets + the vault, so send them all.
    x: sim.objects.map((o) => [o.id, OBJECT_IDS.indexOf(o.kind), r1(o.x), r1(o.y), o.r,
      Math.round((o.hp / o.maxHp) * 100), Math.round(o.aim * 100), o.charge > 0 ? 1 : 0]),
    q: sim.orbs.filter((o) => near(o.x, o.y)).map((o) => [o.id, r1(o.x), r1(o.y)]),
    // Only for the receiving player: drives local movement prediction.
    me: (({ ack, speed, predictable }) => [ack, r1(speed), predictable ? 1 : 0])(sim.predictionInfo(viewer)),
    e: events,
  };
}

export function decodeSnapshot(s) {
  const players = new Map();
  for (const a of s.p) {
    const flags = {};
    FLAGS.forEach((f, i) => { flags[f] = Math.floor(a[7] / 2 ** i) % 2 === 1; });
    players.set(a[0], {
      num: a[0], x: a[1], y: a[2], aim: a[3] / 100, hp: a[4], maxHp: a[5], r: a[6],
      ...flags,
      score: a[8],
      ability: ACTIVE_IDS[a[9]] || null,
      abilCd: a[10] / 100,
      dashCd: a[11] / 100,
      item: a[12] >= 0 ? PICKUP_IDS[a[12]] : null,
      potato: a[13] / 10,
      nemesis: a[14],
      emote: a[15],
      level: a[16],
      xpProgress: a[17] / 100,
      shield: a[18],
      team: a[19],
      reviveT: a[20] / 10,
      ammo: a[21],
      magazine: a[22],
      reload: a[23] >= 0 ? a[23] / 100 : -1,
    });
  }
  const byId = (list, fn) => new Map(list.map((a) => [a[0], fn(a)]));
  return {
    tick: s.k,
    phase: PHASES[s.ph],
    phaseLeft: s.pt / 10,
    round: s.r,
    map: MAPS[s.m] || MAPS[0],
    mode: MODES[s.md] || 'ffa',
    teamScores: s.ts || [0, 0],
    roundTime: s.rt / 10,
    zone: s.z ? { x: s.z[0], y: s.z[1], r: s.z[2], startsIn: s.z[3] / 10 } : null,
    finalZone: s.zf ? { x: s.zf[0], y: s.zf[1], r: s.zf[2] } : null,
    paused: !!s.pa,
    waitingFor: s.aw || [],
    players,
    bullets: byId(s.b, (a) => ({ id: a[0], x: a[1], y: a[2], kind: PROJECTILE_IDS[a[3]], owner: a[4], r: a[5] })),
    props: byId(s.o, (a) => ({ id: a[0], kind: PROP_IDS[a[1]], x: a[2], y: a[3], r: a[4], owner: a[5], angle: a[6] / 100, left: a[7] / 10 })),
    crates: byId(s.c, (a) => ({ id: a[0], x: a[1], y: a[2], w: a[3], h: a[4], hp: a[5] })),
    pickups: byId(s.u, (a) => ({ id: a[0], x: a[1], y: a[2] })),
    objects: byId(s.x, (a) => ({ id: a[0], kind: OBJECT_IDS[a[1]], x: a[2], y: a[3], r: a[4], hpPct: a[5] / 100, aim: a[6] / 100, charging: !!a[7] })),
    orbs: byId(s.q, (a) => ({ id: a[0], x: a[1], y: a[2] })),
    self: s.me ? { ack: s.me[0], speed: s.me[1], predictable: !!s.me[2] } : null,
    events: s.e,
  };
}

export function encodeRoster(sim) {
  return {
    type: 'roster',
    mode: sim.settings.mode,
    players: [...sim.players.values()].map((p) => ({
      num: p.num, id: p.id, name: p.name, color: p.color, hat: p.hat, team: p.team, passives: p.passives,
    })),
  };
}

// Client -> host input message. Buttons are counters (see Simulation.takePresses).
export function encodeInput(s) {
  const q = (v) => Math.round(v * 100) / 100;
  return {
    type: 'in',
    mx: q(s.mx), my: q(s.my), ax: q(s.ax), ay: q(s.ay),
    f: s.fire ? 1 : 0, d: s.dash, a: s.abil, i: s.item, e: s.emote, ei: s.emoteIdx, r: s.reload,
    tc: s.touch ? 1 : 0,
    s: s.seq,
  };
}
