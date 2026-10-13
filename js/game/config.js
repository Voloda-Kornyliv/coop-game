// Every gameplay tunable lives here so balancing never means hunting through code.

export const WORLD_W = 1600;
export const WORLD_H = 900;

export const TICK_RATE = 60;               // simulation steps per second (host only)
export const TICK_DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2;           // ticks between snapshots -> 30 snapshots/s
export const INPUT_SEND_MS = 33;           // clients send input ~30 times/s
export const INTERP_DELAY_TICKS = 5;       // render other entities ~83 ms in the past

export const MAX_PLAYERS = 8;

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
  zoneStart: 45,                            // seconds before the ring starts closing
  zoneShrinkTime: 40,
  zoneMinRadius: 140,
  zoneDps: 12,
  lavaDps: 35,
  endDelay: 3.5,                            // pause after a round is decided
  draftTime: 15,
  pickupEvery: 10,
  maxPickups: 3,
  crateHp: 3,
  crateDropChance: 0.35,
  ghostCooldown: 6,
  crownHeal: 30,
  slowmoTime: 1.2,
  slowmoScale: 0.3,
};

export const TARGET_WINS_OPTIONS = [3, 5, 7];

export const COLORS = [
  '#ff5a5f', '#3fa7ff', '#ffd23f', '#3ddc84',
  '#c77dff', '#ff8c42', '#4ee6e0', '#ff7eb6',
];

export const HATS = ['🎩', '🧢', '👒', '🎓', '⛑️', '🍄', '🎀', '🚧', '🌵', '🦆', ''];
export const EMOTES = ['😂', '😡', '👋', '💀'];
