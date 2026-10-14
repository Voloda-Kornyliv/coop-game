// Every gameplay tunable lives here so balancing never means hunting through
// code. Section numbers refer to GAME_DESIGN.txt.

// Set by the loader in index.html from the <h1> title ('dev' in tests).
export const VERSION = globalThis.GAME_VERSION || 'dev';

export const TICK_RATE = 60;               // simulation steps per second (host only)
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2;           // ticks between snapshots -> 30 snapshots/s
export const INPUT_SEND_MS = 33;           // clients send input ~30 times/s
// Section 15: interpolation delay adapts to the connection (in ticks).
export const NET = {
  minDelayTicks: 4,                         // ~67 ms on good Wi-Fi
  maxDelayTicks: 12,                        // ~200 ms on a bad connection
  maxExtrapolateTicks: 4,                   // keep things moving briefly when snapshots stall
  pingEveryMs: 1000,
};

export const MAX_PLAYERS = 8;

// Section 4: everyone sees the same amount of world.
export const CAMERA = {
  viewHeight: 720,
  maxAspect: 2,                             // view width capped at 2 x 720 = 1440
  ghostZoom: 1.5,
  lookAhead: 0.15,                          // fraction of view height
  follow: 8,                                // camera smoothing (higher = snappier)
};

// What the host sends each player: their view plus a margin (section 15).
export const INTEREST = {
  halfWidth: 1150,
  halfHeight: 760,
  ghostScale: 1.5,
};

export const PLAYER = {
  radius: 22,
  hp: 100,
  speed: 243,                               // v0.3: 10% slower
  fireInterval: 0.3,                        // ~3 shots per second
  // Section 6: auto-reload only (no reload button).
  magazine: 8,
  reloadTime: 1.3,                          // full reload when empty
  emptySpeedBonus: 0.1,                     // move faster while completely empty
  trickleDelay: 0.8,                        // stop shooting this long...
  trickleEvery: 0.2,                        // ...then one bullet pops back in this often
  dashReload: 2,                            // "combat roll" bullets
  bulletSpeed: 620,
  bulletRadius: 8,
  bulletDamage: 20,
  bulletLife: 1.5,
  knockback: 230,
  dashSpeed: 1300,
  dashTime: 0.15,
  dashCooldown: 2,
  aimAssistDeg: 12,                         // touch players get a little help
};

export const ROUND = {
  countdown: 3,
  zoneStart: 40,                            // seconds before the ring starts closing
  zoneStartSmallGame: 25,                   // ...with this many players or fewer:
  smallGame: 3,
  zoneShrinkTime: 45,
  zoneMinRadius: 220,
  zonePctPerSec: 0.08,                      // of max HP
  lavaPctPerSec: 0.25,
  endDelay: 3.5,
  draftTime: 15,
  pickupEvery: 8,
  maxPickups: 5,
  crateHp: 3,
  crateDropChance: 0.3,
  ghostCooldown: 6,
  ghostCooldownDuel: 10,                    // when only 2 players are left alive
  ghostBananaLife: 8,
  possessSpeed: 0.3,                        // possessed props move at 30% of player speed
  orbLife: 20,
  orbDecayAt: 10,                           // after this, orbs blink and are worth half
  crownHeal: 30,
  slowmoTime: 1.2,
  slowmoScale: 0.3,
  maxPause: 10,                             // seconds a dropped player can pause the round
};

// Section 9: once the final circle has held for a moment, chaos.
export const SUDDEN_DEATH = {
  delay: 5,
  duration: 15,
  collapse: 8,                              // then the circle shrinks to nothing over this long
  events: ['bananas', 'zerog', 'meteors', 'hyper'],
  names: ['🍌 Banana Storm', '🪐 Zero Gravity', '☄️ Meteor Shower', '⚡ Hyper Speed'],
};

// Section 12: match point and the golden supply drop.
export const BOSS = { sizeMult: 1.15, bountyMult: 2 };
export const GOLDEN = {
  fromRound: 3, at: 20, radius: 26,
  unlock: { underdog: 0, normal: 1, leader: 2.5 },
  kinds: ['minigun', 'giant', 'heal'],
  names: ['🔥 Dual Miniguns', '🦖 Mega Giant Mode', '💖 Full Heal + Shield'],
};

// Silly titles for round winners (section 8).
export const TITLES = [
  'The Untouchable', 'Banana Baron', 'Supreme Blob', 'Professional Dodger', 'Chaos Gremlin',
  'Last Blob Standing', 'Certified Menace', 'Duke of Dodge', 'Crate Whisperer', 'Lord of Lava',
];

// Section 7 and 12.
export const PROGRESSION = {
  maxLevel: 10,
  xpBase: 60,                               // level N -> N+1 costs xpBase + xpPerLevel * N
  xpPerLevel: 40,
  hpPerLevel: 12,
  damagePerLevel: 0.06,
  levelUpHeal: 25,
  // Turret/Vault XP is split: part straight to whoever breaks it, part as orbs.
  xp: {
    crate: 10, barrel: 15, turret: 20, turretDirect: 20, vault: 80, vaultDirect: 40,
    ko: 60, bounty: 40, bountyPerStreak: 20, firstBlood: 25, revenge: 15,
  },
  orbMagnet: 80,
  orbMagnetPerStack: 100,
  leaderXp: 0.7,
  levelUpPush: 450,
  levelUpRadius: 140,
  underdogXp: 1.5,
  maxLevelGap: 2,
  underdogShield: 25,
};

// Section 9.
export const OBJECTS = {
  turret: {
    radius: 24, hp: 120, hpPerRound: 30, damage: 12, damagePerRound: 3,
    range: 450, interval: 1.2, charge: 0.4, bulletSpeed: 380, turnRate: 4, dropChance: 0.3,
  },
  barrel: { radius: 20, hp: 40, blastRadius: 140, blastDamage: 40, fuse: 1.5 },
  vault: { radius: 42, hp: 400, dropChance: 1 },
};

export const BUSH = { revealDistance: 120, revealTime: 1 };

// Section 2.
export const TEAMS = {
  names: ['RED', 'BLUE'],
  colors: ['#ff4d5e', '#4d8dff'],
  reviveRange: 60,
  reviveTime: 3,
  reviveHp: 0.4,
  // "Underdog Squad": the smaller team when sizes differ (section 2).
  oddHpBonus: 0.25,
  oddReloadBonus: 0.15,
  oddReviveTime: 1.5,
};

export const MODES = ['ffa', 'teams'];
export const TARGET_WINS_OPTIONS = [3, 5, 7];

export const COLORS = [
  '#ff5a5f', '#3fa7ff', '#ffd23f', '#3ddc84',
  '#c77dff', '#ff8c42', '#4ee6e0', '#ff7eb6',
];

export const HATS = ['🎩', '🧢', '👒', '🎓', '⛑️', '🍄', '🎀', '🚧', '🌵', '🦆', ''];
export const EMOTES = ['😂', '😡', '👋', '💀'];
