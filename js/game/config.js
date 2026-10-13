// Every gameplay tunable lives here so balancing never means hunting through
// code. Section numbers refer to GAME_DESIGN.txt.

// Set by the loader in index.html from the <h1> title ('dev' in tests).
export const VERSION = globalThis.GAME_VERSION || 'dev';

export const TICK_RATE = 60;               // simulation steps per second (host only)
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2;           // ticks between snapshots -> 30 snapshots/s
export const INPUT_SEND_MS = 33;           // clients send input ~30 times/s
export const INTERP_DELAY_TICKS = 5;       // render other entities ~83 ms in the past

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
  speed: 270,
  fireInterval: 0.25,
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
  zoneShrinkTime: 50,
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
  crownHeal: 30,
  slowmoTime: 1.2,
  slowmoScale: 0.3,
  maxPause: 20,                             // seconds a dropped player can pause the round
};

// Section 7 and 12.
export const PROGRESSION = {
  maxLevel: 10,
  xpBase: 60,                               // level N -> N+1 costs xpBase + xpPerLevel * N
  xpPerLevel: 40,
  hpPerLevel: 12,
  damagePerLevel: 0.06,
  levelUpHeal: 25,
  xp: { crate: 10, barrel: 15, turret: 40, vault: 120, ko: 60, bounty: 40, bountyPerStreak: 20 },
  orbMagnet: 80,
  orbMagnetPerStack: 100,
  leaderXp: 0.6,
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
  barrel: { radius: 20, hp: 40, blastRadius: 140, blastDamage: 40 },
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
};

export const MODES = ['ffa', 'teams'];
export const TARGET_WINS_OPTIONS = [3, 5, 7];

export const COLORS = [
  '#ff5a5f', '#3fa7ff', '#ffd23f', '#3ddc84',
  '#c77dff', '#ff8c42', '#4ee6e0', '#ff7eb6',
];

export const HATS = ['🎩', '🧢', '👒', '🎓', '⛑️', '🍄', '🎀', '🚧', '🌵', '🦆', ''];
export const EMOTES = ['😂', '😡', '👋', '💀'];
