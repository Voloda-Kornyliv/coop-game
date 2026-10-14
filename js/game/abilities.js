// Every ability, upgrade, pickup, projectile and arena prop as data plus small
// behaviour functions. Adding content means adding an entry here, not touching
// the simulation loop. Behaviour runs on the host only; clients use the
// names/icons/descriptions for UI.

import { PLAYER, PROGRESSION, TEAMS } from './config.js';
import { pick } from './geometry.js';

const TAU = Math.PI * 2;
const dirOf = (a) => ({ x: Math.cos(a), y: Math.sin(a) });

// ---------------------------------------------------------------------------
// Kill-feed verbs. [verb when someone gets credit, phrase when nobody does]
// ---------------------------------------------------------------------------

export const VERBS = {
  bullet: ['blasted', 'got blasted'],
  pellet: ['shotgunned', 'got shotgunned'],
  boomerang: ['boomeranged', 'caught their own boomerang'],
  rocket: ['rocketed', 'was rocketed'],
  zap: ['zapped', 'got zapped'],
  snowball: ['snowballed', 'was snowballed'],
  blackhole: ['spaghettified', 'got spaghettified'],
  fart: ['farted on', 'choked on a fart'],
  fire: ['toasted', 'got toasted'],
  mine: ['mined', 'stepped on a mine'],
  potato: ['potatoed', 'held the potato too long'],
  decoy: ['fooled', 'was fooled'],
  lastlaugh: ['took down', 'went out with a bang'],
  lava: ['yeeted into lava', 'melted in lava'],
  gift: ['parting-gifted', 'unwrapped their own gift'],
  turret: ['fed to a turret', 'got turreted'],
  barrel: ['barrel-bombed', 'blew up with a barrel'],
  zone: ['pushed out of the zone', 'got lost in the zone'],
  sheep: ['sheared', 'got sheared'],
  slip: ['caught slipping', 'slipped into oblivion'],
  left: ['', 'left the game'],
};

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

export function defaultHit(sim, b, target) {
  const owner = sim.players.get(b.owner);
  sim.damage(target, b.dmg, owner, b.kind);
  const sp = Math.hypot(b.vx, b.vy) || 1;
  sim.push(target, b.vx / sp, b.vy / sp, b.knock);
  return true;
}

function effectHit(effect, seconds) {
  return (sim, b, target) => {
    sim.applyEffect(target, effect, seconds, sim.players.get(b.owner));
    return true;
  };
}

export const PROJECTILES = {
  bullet: { speed: PLAYER.bulletSpeed, r: PLAYER.bulletRadius, life: PLAYER.bulletLife, dmg: PLAYER.bulletDamage, knock: PLAYER.knockback },
  pellet: { speed: 820, r: 6, life: 0.35, dmg: 12, knock: 330 },

  boomerang: {
    speed: 640, r: 15, life: 1.6, dmg: 25, knock: 300, reflectable: false,
    update(sim, b, dt) {
      const owner = sim.players.get(b.owner);
      if (b.age > 0.55 && owner) {
        if (!b.data.returning) { b.data.returning = true; b.hitIds.clear(); }
        const dx = owner.x - b.x, dy = owner.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < owner.r + b.r) { b.dead = true; return; }
        b.vx = (dx / d) * 720;
        b.vy = (dy / d) * 720;
      }
    },
    onWall(sim, b) { b.data.returning = true; b.age = Math.max(b.age, 0.55); return false; },
    pierce: 99,
  },

  rocket: {
    speed: 330, r: 12, life: 3.5, dmg: 0, knock: 0,
    update(sim, b, dt) {
      const owner = sim.players.get(b.owner);
      const target = sim.nearestEnemy(b.x, b.y, owner, 900);
      if (target) {
        const want = Math.atan2(target.y - b.y, target.x - b.x);
        let cur = Math.atan2(b.vy, b.vx);
        let diff = want - cur;
        while (diff > Math.PI) diff -= TAU;
        while (diff < -Math.PI) diff += TAU;
        cur += Math.max(-2.6 * dt, Math.min(2.6 * dt, diff));
        b.vx = Math.cos(cur) * 330;
        b.vy = Math.sin(cur) * 330;
      }
      // Rockets can be shot down by anyone else's bullets.
      for (const o of sim.bullets) {
        if (o === b || o.dead || o.owner === b.owner) continue;
        if ((o.x - b.x) ** 2 + (o.y - b.y) ** 2 < (o.r + b.r) ** 2) {
          o.dead = true;
          b.dead = true;
          sim.explode(b.x, b.y, 70, 15, owner, 'rocket');
          return;
        }
      }
    },
    onHit(sim, b) { sim.explode(b.x, b.y, 95, 35, sim.players.get(b.owner), 'rocket'); return true; },
    onWall(sim, b) { sim.explode(b.x, b.y, 95, 35, sim.players.get(b.owner), 'rocket'); return true; },
    onExpire(sim, b) { sim.explode(b.x, b.y, 95, 35, sim.players.get(b.owner), 'rocket'); },
  },

  snowball: {
    speed: 380, r: 10, life: 2.4, dmg: 10, knock: 500,
    update(sim, b, dt) {
      b.r = Math.min(42, b.r + 16 * dt);
      b.dmg = 10 + (b.r - 10) * 1.2;
      b.knock = 300 + b.r * 12;
    },
    onWall() { return true; },
  },

  swapOrb: {
    speed: 540, r: 13, life: 1.2, dmg: 0, knock: 0, hitsAllies: true,
    onHit(sim, b, target) {
      const owner = sim.players.get(b.owner);
      if (!owner || !owner.alive) return true;
      const { x, y } = owner;
      sim.teleport(owner, target.x, target.y);
      sim.teleport(target, x, y);
      sim.event('swap', owner.num, target.num);
      return true;
    },
  },

  hook: {
    speed: 1050, r: 9, life: 0.45, dmg: 5, knock: 0, reflectable: false, hitsAllies: true,
    onHit(sim, b, target) {
      const owner = sim.players.get(b.owner);
      sim.damage(target, b.dmg, owner, 'bullet');
      if (owner) {
        const dx = owner.x - target.x, dy = owner.y - target.y;
        const d = Math.hypot(dx, dy) || 1;
        sim.push(target, dx / d, dy / d, Math.min(1300, d * 2.6));
      }
      return true;
    },
    onWall(sim, b, hitObject) {
      const owner = sim.players.get(b.owner);
      if (!owner || !owner.alive) return true;
      // Hooking a barrel yanks the barrel to you (section 8A).
      if (hitObject?.kind === 'barrel') {
        const dx = owner.x - hitObject.x, dy = owner.y - hitObject.y;
        const d = Math.hypot(dx, dy) || 1;
        sim.shoveObject(hitObject, (dx / d) * Math.min(1100, d * 2.4), (dy / d) * Math.min(1100, d * 2.4));
        return true;
      }
      const dx = b.x - owner.x, dy = b.y - owner.y;
      const d = Math.hypot(dx, dy) || 1;
      sim.push(owner, dx / d, dy / d, Math.min(1400, d * 2.8), true);
      return true;
    },
  },

  // PARTING GIFT: the last bullet in the magazine is big and explodes.
  giftShot: {
    speed: PLAYER.bulletSpeed, r: PLAYER.bulletRadius * 2, life: PLAYER.bulletLife, dmg: PLAYER.bulletDamage + 15, knock: PLAYER.knockback,
    onHit(sim, b) { sim.explode(b.x, b.y, 90, b.dmg, sim.players.get(b.owner), 'gift'); return true; },
    onWall(sim, b) { sim.explode(b.x, b.y, 90, b.dmg, sim.players.get(b.owner), 'gift'); return true; },
  },

  sheepOrb: { speed: 600, r: 13, life: 1.2, dmg: 0, knock: 0, onHit: effectHit('sheep', 2) },
  shrinkRay: { speed: 950, r: 9, life: 0.8, dmg: 0, knock: 0, onHit: effectHit('shrink', 4) },
  reverseOrb: { speed: 600, r: 13, life: 1.2, dmg: 0, knock: 0, onHit: effectHit('reverse', 3) },

  // Fired by turrets: no owner, hits everyone, telegraphed and slow.
  turretShot: { speed: 380, r: 9, life: 1.6, dmg: 12, knock: 150, objects: false },

  potato: {
    speed: 540, r: 13, life: 1.0, dmg: 0, knock: 0,
    onHit(sim, b, target) {
      if (target.potato) return true;
      target.potato = { t: 5, owner: b.owner, passCd: 0.6 };
      sim.event('potato', target.num);
      return true;
    },
  },

  bananaThrow: {
    speed: 520, r: 11, life: 0.35, dmg: 0, knock: 0, hitsAllies: true,
    onHit(sim, b, target) {
      sim.slip(target, sim.players.get(b.owner), b.vx, b.vy);
      return true;
    },
    onWall(sim, b) { sim.spawnProp('banana', b.x - b.vx * 0.03, b.y - b.vy * 0.03, b.owner); return true; },
    onExpire(sim, b) { sim.spawnProp('banana', b.x, b.y, b.owner); },
  },
};

// ---------------------------------------------------------------------------
// Props: things that sit in the arena for a while.
// ---------------------------------------------------------------------------

export const PROPS = {
  banana: {
    r: 16, life: 25,
    onTouch(sim, prop, p) {
      if (prop.owner === p.id && prop.age < 0.8) return;
      sim.slip(p, sim.players.get(prop.owner), p.vx + p.kvx, p.vy + p.kvy);
      prop.dead = true;
    },
  },
  mine: {
    r: 16, life: 60,
    onTouch(sim, prop, p) {
      const owner = sim.players.get(prop.owner);
      if (prop.owner === p.id || prop.age < 0.8 || (owner && !sim.isEnemy(owner, p))) return;
      prop.dead = true;
      sim.explode(prop.x, prop.y, 115, 45, owner, 'mine');
    },
  },
  pad: {
    r: 28, life: 12,
    onTouch(sim, prop, p) {
      if (p.padCd > 0) return;
      p.padCd = 0.6;
      const d = dirOf(prop.angle);
      p.kvx = 0; p.kvy = 0;
      sim.push(p, d.x, d.y, 1150, true);
      sim.event('boing', p.num);
    },
  },
  blackhole: {
    r: 34, life: 2.2,
    update(sim, prop, dt) {
      for (const p of sim.living()) {
        if (p.id === prop.owner) continue;
        const dx = prop.x - p.x, dy = prop.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > 400) continue;
        const pull = 1700 * (1 - d / 400) * dt;
        p.kvx += (dx / d) * pull;
        p.kvy += (dy / d) * pull;
        if (d < 45) sim.damage(p, 25 * dt, sim.players.get(prop.owner), 'blackhole', true);
      }
    },
  },
  fart: {
    r: 115, life: 4,
    update(sim, prop, dt) {
      const owner = sim.players.get(prop.owner);
      for (const p of sim.living()) {
        if (p.id === prop.owner || (owner && !sim.isEnemy(owner, p))) continue;
        const dx = p.x - prop.x, dy = p.y - prop.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > prop.r + p.r) continue;
        sim.damage(p, 12 * dt, sim.players.get(prop.owner), 'fart', true);
        p.kvx += (dx / d) * 500 * dt;
        p.kvy += (dy / d) * 500 * dt;
      }
    },
  },
  // LAST LAUGH: live grenades dropped on death.
  grenade: {
    r: 10, life: 1.2,
    update(sim, prop, dt) {
      const f = Math.exp(-3 * dt);
      prop.vx *= f; prop.vy *= f;
      const nx = prop.x + prop.vx * dt, ny = prop.y + prop.vy * dt;
      if (sim.isFree(nx, ny, prop.r)) { prop.x = nx; prop.y = ny; } else { prop.vx = 0; prop.vy = 0; }
    },
    onExpire(sim, prop) {
      sim.explode(prop.x, prop.y, 95, prop.dmg || 25, sim.players.get(prop.owner), 'lastlaugh');
    },
  },
  fire: {
    r: 15, life: 2,
    update(sim, prop, dt) {
      sim.burnBushesAt(prop.x, prop.y, prop.r);
      for (const p of sim.living()) {
        if (p.id === prop.owner) continue;
        if ((p.x - prop.x) ** 2 + (p.y - prop.y) ** 2 < (p.r + prop.r) ** 2) {
          sim.damage(p, 25 * dt, sim.players.get(prop.owner), 'fire', true);
        }
      }
    },
  },
  decoy: {
    r: PLAYER.radius, life: 4,
    update(sim, prop, dt) {
      const nx = prop.x + prop.vx * dt, ny = prop.y + prop.vy * dt;
      if (sim.isFree(nx, ny, prop.r)) { prop.x = nx; prop.y = ny; }
      else { prop.vx = -prop.vx; prop.vy = -prop.vy; }
    },
    onShot(sim, prop) {
      prop.dead = true;
      sim.explode(prop.x, prop.y, 105, 30, sim.players.get(prop.owner), 'decoy');
    },
  },
  disco: { r: 230, life: 1.5 },
};

// ---------------------------------------------------------------------------
// Active abilities (the [ABILITY] button). cast() runs on the host.
// ---------------------------------------------------------------------------

function shoot(kind, extra) {
  return (sim, p) => sim.spawnProjectile(p, kind, { angle: p.aim, ...extra });
}

export const ACTIVES = {
  blink: {
    name: 'Blink', icon: '✨', cd: 5, desc: 'Teleport a short distance where you aim.',
    cast(sim, p) {
      const d = dirOf(p.aim);
      for (let dist = 240; dist > 0; dist -= 15) {
        const x = p.x + d.x * dist, y = p.y + d.y * dist;
        if (sim.isFree(x, y, p.r)) {
          sim.event('blink', p.num, Math.round(p.x), Math.round(p.y));
          sim.teleport(p, x, y);
          return;
        }
      }
    },
  },
  swap: { name: 'Swap', icon: '🔀', cd: 9, desc: 'Fire an orb. Whoever it hits swaps places with you.', cast: shoot('swapOrb') },
  grapple: { name: 'Grapple', icon: '🪝', cd: 7, desc: 'Hook a wall to fly to it, or hook a player to yank them to you.', cast: shoot('hook') },
  pad: {
    name: 'Bounce Pad', icon: '🦘', cd: 10, desc: 'Drop a pad that launches anyone who steps on it.',
    cast(sim, p) {
      const d = dirOf(p.aim);
      sim.spawnProp('pad', p.x + d.x * 55, p.y + d.y * 55, p.id, { angle: p.aim });
    },
  },
  shotgun: {
    name: 'Shotgun', icon: '💥', cd: 6, desc: 'A wide burst of pellets with huge knockback.',
    cast(sim, p) {
      for (let i = 0; i < 7; i++) {
        sim.spawnProjectile(p, 'pellet', { angle: p.aim + (i - 3) * 0.075 + (Math.random() - 0.5) * 0.04 });
      }
      const d = dirOf(p.aim);
      sim.push(p, -d.x, -d.y, 260, true);
      sim.event('boom', Math.round(p.x), Math.round(p.y), 0);
    },
  },
  boomerang: { name: 'Boomerang', icon: '🪃', cd: 5, desc: 'Flies out and comes back, hitting on both passes.', cast: shoot('boomerang') },
  rocket: { name: 'Homing Rocket', icon: '🚀', cd: 9, desc: 'A slow rocket that chases the nearest enemy. Can be shot down.', cast: shoot('rocket') },
  zap: {
    name: 'Chain Zap', icon: '⚡', cd: 8, desc: 'Lightning that jumps between up to 4 nearby players.',
    cast(sim, p) {
      const points = [Math.round(p.x), Math.round(p.y)];
      const hit = new Set([p.id]);
      let from = p;
      let range = 330;
      for (let i = 0; i < 4; i++) {
        let best = null, bestD = range * range;
        for (const o of sim.living()) {
          if (hit.has(o.id) || !sim.isEnemy(p, o)) continue;
          const d = (o.x - from.x) ** 2 + (o.y - from.y) ** 2;
          if (d < bestD) { best = o; bestD = d; }
        }
        if (!best) break;
        hit.add(best.id);
        points.push(Math.round(best.x), Math.round(best.y));
        sim.damage(best, 22, p, 'zap');
        from = best;
        range = 240;
      }
      sim.event('zap', ...points);
    },
  },
  snowball: { name: 'Snowball', icon: '☃️', cd: 7, desc: 'Grows bigger and hits harder the further it rolls.', cast: shoot('snowball') },
  blackhole: {
    name: 'Black Hole', icon: '🌀', cd: 14, desc: 'Sucks every other player and bullet toward one point.',
    cast(sim, p) {
      const d = dirOf(p.aim);
      let x = p.x, y = p.y;
      for (let dist = 0; dist < 280; dist += 20) {
        const nx = p.x + d.x * dist, ny = p.y + d.y * dist;
        if (!sim.isFree(nx, ny, 10)) break;
        x = nx; y = ny;
      }
      sim.spawnProp('blackhole', x, y, p.id);
    },
  },
  bubble: {
    name: 'Bubble', icon: '🫧', cd: 10, desc: 'Block all damage and effects for 1.5 seconds.',
    cast(sim, p) { p.e.bubble = 1.5; },
  },
  mirror: {
    name: 'Mirror', icon: '🪞', cd: 9, desc: 'Reflect bullets back at the shooter for 1 second.',
    cast(sim, p) { p.e.mirror = 1; },
  },
  decoy: {
    name: 'Decoy', icon: '🎭', cd: 10, desc: 'A fake you walks forward (and explodes when shot) while you vanish briefly.',
    cast(sim, p) {
      const d = dirOf(p.aim);
      sim.spawnProp('decoy', p.x, p.y, p.id, { vx: d.x * p.stats.speed, vy: d.y * p.stats.speed, angle: p.aim, r: p.r });
      p.e.invis = Math.max(p.e.invis, 1.2);
    },
  },
  vanish: {
    name: 'Vanish', icon: '👤', cd: 12, desc: 'Turn invisible for 3 seconds. Footprints give you away.',
    cast(sim, p) { p.e.invis = 3; },
  },
  banana: { name: 'Banana', icon: '🍌', cd: 4, desc: 'Throw a banana peel. Anyone who steps on it slides away spinning.', cast: shoot('bananaThrow') },
  sheep: { name: 'Sheepify', icon: '🐑', cd: 10, desc: 'Turn the target into a sheep for 2 seconds. Baa.', cast: shoot('sheepOrb') },
  bighead: {
    name: 'Big Head', icon: '🎈', cd: 12, desc: 'Every enemy gets a huge head (and hitbox) for 4 seconds.',
    cast(sim, p) {
      for (const o of sim.living()) if (sim.isEnemy(p, o)) sim.applyEffect(o, 'bighead', 4, p);
    },
  },
  shrink: { name: 'Shrink Ray', icon: '🔬', cd: 9, desc: 'Target becomes tiny, fast and fragile for 4 seconds.', cast: shoot('shrinkRay') },
  reverse: { name: 'Reverse', icon: '🔄', cd: 9, desc: "Target's movement controls are flipped for 3 seconds.", cast: shoot('reverseOrb') },
  potato: { name: 'Hot Potato', icon: '🥔', cd: 12, desc: 'Stick a bomb on someone. Touch others to pass it. Boom in 5s.', cast: shoot('potato') },
  disco: {
    name: 'Disco Ball', icon: '🪩', cd: 12, desc: 'Everyone near you is forced to dance for 1.5 seconds.',
    cast(sim, p) {
      sim.spawnProp('disco', p.x, p.y, p.id);
      for (const o of sim.living()) {
        if (sim.isEnemy(p, o) && (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < 230 ** 2) sim.applyEffect(o, 'dance', 1.5, p);
      }
    },
  },
  fart: {
    name: 'Fart Cloud', icon: '💨', cd: 10, desc: 'Leave a toxic cloud that hurts and pushes people away.',
    cast(sim, p) { sim.spawnProp('fart', p.x, p.y, p.id); },
  },
};

// ---------------------------------------------------------------------------
// Passive upgrades (stack for the whole match). Stats are recomputed from the
// stack counts by computeStats(), so there's no hidden mutable state.
// ---------------------------------------------------------------------------

export const PASSIVES = {
  bouncy: { name: 'Bouncy Bullets', icon: '🏀', max: 3, desc: 'Bullets bounce off walls (+1 bounce per stack).' },
  split: { name: 'Split Shot', icon: '🔱', max: 3, desc: '+1 bullet per shot, fired in a spread.' },
  big: { name: 'Big Bullets', icon: '🟠', max: 3, desc: 'Bullets are 50% bigger and deal +5 damage.' },
  feet: { name: 'Fast Feet', icon: '👟', max: 3, desc: '+15% movement speed.' },
  trigger: { name: 'Quick Trigger', icon: '🔫', max: 3, desc: '+20% fire rate.' },
  vampire: { name: 'Vampire', icon: '🧛', max: 3, desc: 'Heal 4 HP whenever you hit an enemy (2 per pellet).' },
  thick: { name: 'Thick Skin', icon: '🛡️', max: 3, desc: '+30 max HP, and you look chunkier.' },
  dash: { name: 'Dash Master', icon: '🔥', max: 2, desc: 'Half dash cooldown. Dashing leaves a fire trail and reloads +1 extra bullet.' },
  lastlaugh: { name: 'Last Laugh', icon: '💣', max: 3, desc: 'Drop 3 live grenades when you die.' },
  pierce: { name: 'Piercing', icon: '📌', max: 2, desc: 'Bullets pass through the first player or crate they hit.' },
  magnet: { name: 'Magnet', icon: '🧲', max: 2, desc: 'Pickups and XP orbs fly to you from further away, and bullets curve slightly toward enemies.' },
  clock: { name: 'Cooldown Clock', icon: '⏱️', max: 3, desc: 'Ability cooldown -25%.' },
  tiny: { name: 'Tiny', icon: '🐜', max: 2, desc: '25% smaller and harder to hit, -10 max HP.' },
  rage: { name: 'Ricochet Rage', icon: '😤', max: 3, desc: 'Bullets speed up and deal +6 damage after each wall hit.' },
  mag: { name: 'Extended Mag', icon: '🧰', max: 2, desc: '+4 shots in the magazine.' },
  hands: { name: 'Fast Hands', icon: '🤹', max: 2, desc: 'Auto-reload and trickle-reload are 35% faster.' },
  gift: { name: 'Parting Gift', icon: '🎁', max: 1, desc: 'The last bullet in your magazine is huge and explodes (+15 damage).' },
};

// Stats come from upgrade stacks plus level (section 7), so there's no hidden
// mutable state to keep in sync.
export function computeStats(passives, level = 1, { teamBuff = false } = {}) {
  const n = (id) => passives[id] || 0;
  const lv = Math.max(0, level - 1);
  const syn = activeSynergies(passives);
  // FAST HANDS (35% per stack) and the Underdog Squad buff speed up both reloads.
  const reloadMult = 0.65 ** n('hands') * (teamBuff ? 1 - TEAMS.oddReloadBonus : 1);
  const maxHp = (PLAYER.hp + 30 * n('thick') - 10 * n('tiny') + PROGRESSION.hpPerLevel * lv) * (teamBuff ? 1 + TEAMS.oddHpBonus : 1);
  return {
    damageMult: 1 + PROGRESSION.damagePerLevel * lv,
    speed: PLAYER.speed * (1 + 0.15 * n('feet')) * (syn.has('mosquito') ? 1.1 : 1),
    fireInterval: PLAYER.fireInterval / (1 + 0.2 * n('trigger')),
    magazine: PLAYER.magazine + 4 * n('mag'),
    reloadTime: PLAYER.reloadTime * reloadMult,
    trickleEvery: PLAYER.trickleEvery * reloadMult,
    dashReload: PLAYER.dashReload + (n('dash') > 0 ? 1 : 0),
    shots: 1 + n('split'),
    bulletR: PLAYER.bulletRadius * (1 + 0.5 * n('big')),
    // SPLIT SHOT costs 15% damage per bullet per stack.
    bulletDmg: (PLAYER.bulletDamage + 5 * n('big')) * Math.max(0.55, 1 - 0.15 * n('split')),
    bounces: n('bouncy'),
    pierce: n('pierce'),
    vampire: n('vampire'),
    maxHp: Math.round(maxHp),
    radius: (PLAYER.radius + 3 * n('thick')) * 0.75 ** n('tiny'),
    dashCooldown: PLAYER.dashCooldown * 0.5 ** n('dash'),
    fireTrail: n('dash') > 0,
    lastLaugh: n('lastlaugh'),
    magnet: n('magnet'),
    cdMult: 0.75 ** n('clock'),
    rage: n('rage'),
    gift: n('gift') > 0,
    teamBuff,
    pinball: syn.has('pinball'),
    mosquito: syn.has('mosquito'),
    spray: syn.has('spray'),
    juggernaut: syn.has('juggernaut'),
  };
}

// UPGRADE SYNERGIES (section 8B): owning both upgrades of a pair unlocks a bonus.
export const SYNERGIES = {
  pinball: { name: 'Pinball Wizard', icon: '🎱', needs: ['bouncy', 'rage'], desc: 'Bullets aim at the nearest enemy after bouncing.' },
  mosquito: { name: 'Mosquito', icon: '🦟', needs: ['tiny', 'vampire'], desc: '+10% speed, and you buzz near enemies.' },
  spray: { name: 'Spray & Pray', icon: '🚿', needs: ['split', 'mag'], desc: 'Firing pushes you backwards: jetpack away!' },
  juggernaut: { name: 'Juggernaut', icon: '🦏', needs: ['thick', 'big'], desc: 'Half knockback, and you crush crates by walking.' },
};
export const SYNERGY_IDS = Object.keys(SYNERGIES);

export function activeSynergies(passives) {
  return new Set(SYNERGY_IDS.filter((id) => SYNERGIES[id].needs.every((p) => (passives[p] || 0) > 0)));
}

// ---------------------------------------------------------------------------
// Map pickups (single use, the [PICKUP] button).
// ---------------------------------------------------------------------------

export const PICKUPS = {
  medkit: { name: 'Medkit', icon: '❤️', use(sim, p) { p.hp = Math.min(p.stats.maxHp, p.hp + 40); } },
  minigun: { name: 'Minigun', icon: '🔥', use(sim, p) { p.e.minigun = 5; } },
  mine: { name: 'Landmine', icon: '💣', use(sim, p) { sim.spawnProp('mine', p.x, p.y, p.id); } },
  boots: { name: 'Speed Boots', icon: '👢', use(sim, p) { p.e.speed = 4; } },
  giant: { name: 'Giant Mode', icon: '🦖', use(sim, p) { p.e.giant = 4; } },
  confusion: {
    name: 'Confusion', icon: '🙃',
    use(sim, p) { for (const o of sim.living()) if (sim.isEnemy(p, o)) sim.applyEffect(o, 'confused', 3, p); },
  },
  teleport: {
    name: 'Teleport All', icon: '🌪️',
    use(sim) {
      for (const o of sim.living()) {
        const spot = sim.randomSafeSpot(o.r);
        sim.teleport(o, spot.x, spot.y);
      }
      sim.event('teleportAll');
    },
  },
  random: {
    name: 'Mystery', icon: '🎲',
    // Two random abilities at once (section 8C).
    use(sim, p) {
      const a = pick(ACTIVE_IDS);
      let b = pick(ACTIVE_IDS);
      while (b === a) b = pick(ACTIVE_IDS);
      ACTIVES[a].cast(sim, p);
      ACTIVES[b].cast(sim, p);
    },
  },
};

// Stable index orders for the wire format.
export const ACTIVE_IDS = Object.keys(ACTIVES);
export const PASSIVE_IDS = Object.keys(PASSIVES);
export const PICKUP_IDS = Object.keys(PICKUPS);
export const PROJECTILE_IDS = Object.keys(PROJECTILES);
export const PROP_IDS = Object.keys(PROPS);

// Effects a bubble or dash shrugs off.
export const NEGATIVE_EFFECTS = new Set(['sheep', 'shrink', 'reverse', 'dance', 'slip', 'confused', 'bighead']);

export function describeCard(card) {
  const [kind, id] = card.split(':');
  const def = kind === 'a' ? ACTIVES[id] : PASSIVES[id];
  return def && { kind: kind === 'a' ? 'Ability' : 'Upgrade', ...def };
}
