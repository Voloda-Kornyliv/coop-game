// The wire format, in one place. Snapshots are compact arrays (sent ~30x/s to
// every player); everything else is small JSON objects. encode* runs on the
// host, decode* on every client.

import { ROUND } from './config.js';
import { MAPS } from './maps.js';
import { ACTIVES, ACTIVE_IDS, PICKUP_IDS, PROJECTILE_IDS, PROP_IDS } from './abilities.js';

export const PHASES = ['lobby', 'countdown', 'playing', 'roundEnd', 'draft', 'matchEnd'];

const FLAGS = [
  'alive', 'ghost', 'bubble', 'mirror', 'sheep', 'invis', 'dance', 'slip', 'bighead',
  'reverse', 'confused', 'crown', 'dash', 'speed', 'minigun', 'picked', 'giant', 'shrink',
  'ghostReady', 'emoting', 'away',
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

function playerFlags(sim, p, crownNum) {
  const e = p.e;
  const on = {
    alive: p.alive, ghost: p.ghost, bubble: e.bubble > 0, mirror: e.mirror > 0, sheep: e.sheep > 0,
    invis: e.invis > 0, dance: e.dance > 0, slip: e.slip > 0, bighead: e.bighead > 0,
    reverse: e.reverse > 0, confused: e.confused > 0, crown: p.num === crownNum, dash: e.dash > 0,
    speed: e.speed > 0, minigun: e.minigun > 0, picked: p.picked, giant: e.giant > 0,
    shrink: e.shrink > 0, ghostReady: p.ghost && p.ghostCd <= 0, emoting: p.emoteT > 0, away: p.away,
  };
  let bits = 0;
  FLAGS.forEach((f, i) => { if (on[f]) bits |= 1 << i; });
  return bits;
}

export function encodeSnapshot(sim, events) {
  let crownNum = 0;
  for (const p of sim.players.values()) if (sim.isCrown(p)) crownNum = p.num;

  const players = [];
  for (const p of sim.players.values()) {
    const abil = ACTIVES[p.ability];
    const abilMax = abil ? abil.cd * p.stats.cdMult : 1;
    const nem = p.nemesis && sim.players.get(p.nemesis);
    players.push([
      p.num, r1(p.x), r1(p.y), Math.round(p.aim * 100), Math.ceil(p.hp), p.stats.maxHp, r1(p.r),
      playerFlags(sim, p, crownNum), p.score,
      ACTIVE_IDS.indexOf(p.ability), Math.round(Math.max(0, p.abilCd) / abilMax * 100),
      Math.round(Math.max(0, p.dashCd) / p.stats.dashCooldown * 100),
      p.item ? PICKUP_IDS.indexOf(p.item) : -1,
      p.potato ? r10(p.potato.t) : 0,
      nem ? nem.num : 0,
      p.emoteT > 0 ? p.emote : -1,
    ]);
  }

  return {
    type: 'snap',
    k: sim.tick,
    ph: PHASES.indexOf(sim.phase),
    pt: r10(phaseTimeLeft(sim)),
    r: sim.round,
    m: MAPS.indexOf(sim.map),
    rt: r10(sim.roundTime),
    z: r1(sim.zoneRadius()),
    pa: sim.paused ? 1 : 0,
    aw: [...sim.players.values()].filter((p) => p.away && sim.paused).map((p) => p.num),
    p: players,
    b: sim.bullets.map((b) => [b.id, r1(b.x), r1(b.y), PROJECTILE_IDS.indexOf(b.kind), b.ownerNum, r1(b.r)]),
    o: sim.props.map((o) => [o.id, PROP_IDS.indexOf(o.kind), r1(o.x), r1(o.y), r1(o.r), o.ownerNum, Math.round(o.angle * 100), r10(o.life - o.age)]),
    c: sim.crates.map((c) => [c.id, c.x, c.y, c.w, c.h, c.hp]),
    u: sim.pickups.map((k) => [k.id, r1(k.x), r1(k.y)]),
    e: events,
  };
}

export function decodeSnapshot(s) {
  const players = new Map();
  for (const a of s.p) {
    const flags = {};
    FLAGS.forEach((f, i) => { flags[f] = (a[7] & (1 << i)) !== 0; });
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
    });
  }
  const byId = (list, fn) => new Map(list.map((a) => [a[0], fn(a)]));
  return {
    tick: s.k,
    phase: PHASES[s.ph],
    phaseLeft: s.pt / 10,
    round: s.r,
    map: MAPS[s.m] || MAPS[0],
    roundTime: s.rt / 10,
    zone: s.z,
    paused: !!s.pa,
    waitingFor: s.aw || [],
    players,
    bullets: byId(s.b, (a) => ({ id: a[0], x: a[1], y: a[2], kind: PROJECTILE_IDS[a[3]], owner: a[4], r: a[5] })),
    props: byId(s.o, (a) => ({ id: a[0], kind: PROP_IDS[a[1]], x: a[2], y: a[3], r: a[4], owner: a[5], angle: a[6] / 100, left: a[7] / 10 })),
    crates: s.c.map((a) => ({ id: a[0], x: a[1], y: a[2], w: a[3], h: a[4], hp: a[5] })),
    pickups: byId(s.u, (a) => ({ id: a[0], x: a[1], y: a[2] })),
    events: s.e,
  };
}

export function encodeRoster(sim) {
  return {
    type: 'roster',
    players: [...sim.players.values()].map((p) => ({
      num: p.num, id: p.id, name: p.name, color: p.color, hat: p.hat, passives: p.passives,
    })),
  };
}

// Client -> host input message. Buttons are counters (see Simulation.takePresses).
export function encodeInput(s) {
  const q = (v) => Math.round(v * 100) / 100;
  return {
    type: 'in',
    mx: q(s.mx), my: q(s.my), ax: q(s.ax), ay: q(s.ay),
    f: s.fire ? 1 : 0, d: s.dash, a: s.abil, i: s.item, e: s.emote, ei: s.emoteIdx,
    tc: s.touch ? 1 : 0,
  };
}
