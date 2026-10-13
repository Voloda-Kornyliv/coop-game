// Arena layouts as plain data. Maps are shared code, so only the map index goes
// over the network. Layouts are mirrored so every spawn point is equally fair.

import { WORLD_W as W, WORLD_H as H } from './config.js';
import { mirror4, mirrorX, mirrorY } from './geometry.js';

const crate = (x, y) => ({ x, y, w: 46, h: 46 });

const SPAWNS = [
  { x: 110, y: 110 }, { x: 800, y: 80 }, { x: 1490, y: 110 }, { x: 1520, y: 450 },
  { x: 1490, y: 790 }, { x: 800, y: 820 }, { x: 110, y: 790 }, { x: 80, y: 450 },
];

function map(def) {
  return {
    walls: [], crates: [], lava: [], conveyors: [], bumpers: [],
    ice: false, dark: false, spawns: SPAWNS,
    ...def,
  };
}

function ring(cx, cy, radius, count) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    return crate(cx + Math.cos(a) * radius - 23, cy + Math.sin(a) * radius - 23);
  });
}

export const MAPS = [
  map({
    id: 'backyard',
    name: 'Backyard',
    floor: '#2b3a2e',
    walls: [
      ...mirror4({ x: 280, y: 190, w: 180, h: 28 }, W, H),
      ...mirror4({ x: 280, y: 190, w: 28, h: 150 }, W, H),
      { x: 770, y: 400, w: 60, h: 100 },
    ],
    crates: [
      ...mirror4(crate(520, 300), W, H),
      ...mirrorY(crate(777, 220), H),
      ...mirrorX(crate(430, 427), W),
      ...mirror4(crate(180, 300), W, H),
    ],
  }),
  map({
    id: 'ice',
    name: 'Ice Rink',
    floor: '#27404f',
    ice: true,
    walls: mirror4({ x: 350, y: 250, w: 120, h: 28 }, W, H),
    crates: ring(W / 2, H / 2, 170, 6),
  }),
  map({
    id: 'lava',
    name: 'Lava Lab',
    floor: '#2e2a33',
    lava: [
      { x: 690, y: 375, w: 220, h: 150 },
      ...mirror4({ x: 330, y: 230, w: 130, h: 100 }, W, H),
    ],
    walls: mirror4({ x: 560, y: 120, w: 28, h: 170 }, W, H),
    crates: mirrorY(crate(777, 200), H),
  }),
  map({
    id: 'conveyor',
    name: 'Conveyor',
    floor: '#33302a',
    conveyors: [
      { x: 200, y: 290, w: 1200, h: 80, dx: -170, dy: 0 },
      { x: 200, y: 530, w: 1200, h: 80, dx: 170, dy: 0 },
    ],
    walls: mirror4({ x: 420, y: 140, w: 28, h: 110 }, W, H),
    crates: [
      ...mirrorX(crate(320, 427), W),
      ...mirrorX(crate(560, 427), W),
      crate(777, 427),
    ],
  }),
  map({
    id: 'pinball',
    name: 'Pinball',
    floor: '#2a2740',
    bumpers: [
      { x: 800, y: 450, r: 55 },
      { x: 480, y: 260, r: 38 }, { x: 1120, y: 260, r: 38 },
      { x: 480, y: 640, r: 38 }, { x: 1120, y: 640, r: 38 },
      { x: 800, y: 190, r: 30 }, { x: 800, y: 710, r: 30 },
      { x: 300, y: 450, r: 32 }, { x: 1300, y: 450, r: 32 },
    ],
    walls: mirror4({ x: 220, y: 200, w: 28, h: 90 }, W, H),
    crates: mirrorX(crate(620, 427), W),
  }),
  map({
    id: 'dark',
    name: 'Dark House',
    floor: '#2c2c2c',
    dark: true,
    walls: [
      ...mirror4({ x: 250, y: 240, w: 220, h: 28 }, W, H),
      ...mirror4({ x: 600, y: 120, w: 28, h: 200 }, W, H),
      ...mirrorX({ x: 420, y: 436, w: 200, h: 28 }, W),
      { x: 786, y: 330, w: 28, h: 240 },
    ],
    crates: [
      ...mirror4(crate(470, 330), W, H),
      ...mirror4(crate(900, 170), W, H),
    ],
  }),
];

export const mapIndex = (id) => MAPS.findIndex((m) => m.id === id);
