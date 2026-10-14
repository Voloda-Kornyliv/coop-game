// Destructible arena objects (GAME_DESIGN.txt section 9) as data plus small
// behaviour functions, like abilities.js. Behaviour runs on the host only.
// All objects are solid circles that block movement and bullets.

import { OBJECTS as O, PROGRESSION, BUSH } from './config.js';

export const OBJECT_KINDS = {
  turret: {
    radius: O.turret.radius,
    hp: (round) => O.turret.hp + O.turret.hpPerRound * Math.max(0, round - 1),
    xp: PROGRESSION.xp.turret,
    directXp: PROGRESSION.xp.turretDirect,
    dropChance: O.turret.dropChance,
    init(o) { o.aim = Math.random() * Math.PI * 2; o.cd = 1 + Math.random(); o.charge = 0; },

    update(sim, o, dt) {
      const target = this.findTarget(sim, o);
      o.cd -= dt;
      if (!target) { o.charge = 0; return; }
      const want = Math.atan2(target.y - o.y, target.x - o.x);
      let diff = want - o.aim;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const turn = O.turret.turnRate * dt;
      o.aim += Math.max(-turn, Math.min(turn, diff));

      // Telegraph: the barrel glows for `charge` seconds before every shot.
      if (o.charge > 0) {
        o.charge -= dt;
        if (o.charge <= 0) {
          o.charge = 0;
          o.cd = O.turret.interval;
          sim.spawnTurretShot(o, O.turret.damage + O.turret.damagePerRound * Math.max(0, sim.round - 1));
        }
      } else if (o.cd <= 0) {
        o.charge = O.turret.charge;
      }
    },

    // Nearest living player in range that the turret can actually see.
    findTarget(sim, o) {
      let best = null, bestD = O.turret.range ** 2;
      for (const p of sim.players.values()) {
        if (!p.alive || p.e.invis) continue;
        const d = (p.x - o.x) ** 2 + (p.y - o.y) ** 2;
        if (d >= bestD) continue;
        if (p.inBush && p.revealT <= 0 && d > BUSH.revealDistance ** 2) continue;
        if (!sim.lineOfSight(o.x, o.y, p.x, p.y)) continue;
        best = p;
        bestD = d;
      }
      return best;
    },
  },

  barrel: {
    radius: O.barrel.radius,
    hp: () => O.barrel.hp,
    xp: PROGRESSION.xp.barrel,
    dropChance: 0,
    init(o) { o.vx = 0; o.vy = 0; o.fuse = 0; },

    // Barrels burn down a fuse after the first hit, slide when grappled,
    // and ride conveyor belts (sections 8A, 9, 10).
    update(sim, o, dt) {
      if (o.fuse > 0) {
        o.fuse -= dt;
        if (o.fuse <= 0) { sim.destroyObject(o, o.igniter || null); return; }
      }
      const belt = sim.beltAt(o.x, o.y);
      const vx = o.vx + belt.x, vy = o.vy + belt.y;
      if (vx || vy) {
        if (!sim.moveObject(o, o.x + vx * dt, o.y + vy * dt)) { o.vx = 0; o.vy = 0; }
      }
      const f = Math.exp(-3 * dt);
      o.vx *= f; o.vy *= f;
      if (Math.abs(o.vx) < 5) o.vx = 0;
      if (Math.abs(o.vy) < 5) o.vy = 0;
    },
    onDestroy(sim, o, attacker) {
      sim.explode(o.x, o.y, O.barrel.blastRadius, O.barrel.blastDamage, attacker, 'barrel');
    },
  },

  vault: {
    radius: O.vault.radius,
    hp: () => O.vault.hp,
    xp: PROGRESSION.xp.vault,
    directXp: PROGRESSION.xp.vaultDirect,
    dropChance: O.vault.dropChance,
  },
};

export const OBJECT_IDS = Object.keys(OBJECT_KINDS);
