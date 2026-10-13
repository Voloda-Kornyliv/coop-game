// Map layouts as plain data (GAME_DESIGN.txt section 10). Maps are shared
// code, so only the map index goes over the network.
//
// Most content is written for the TOP-LEFT QUARTER and mirrored into all four
// quarters, which keeps every map fair. Things on the centre lines are listed
// explicitly. Points are [x, y] centres; rects are { x, y, w, h }.

import { mirror4, mirrorX, mirrorY } from './geometry.js';

const CRATE = 46;

// 8 spawns, point-symmetric: the left half (x < W/2) and right half mirror each
// other, which also gives Team mode its two sides.
function spawnsFor(W, H) {
  const left = [[180, 180], [180, H - 180], [140, H / 2], [Math.round(W * 0.42), 140]];
  return [...left, ...left.map(([x, y]) => [W - x, H - y])].map(([x, y]) => ({ x, y }));
}

function makeMap(def) {
  const W = def.w, H = def.h;
  const q = def.quad || {};
  const rects4 = (list = []) => list.flatMap((r) => mirror4(r, W, H));
  const points4 = (list = []) => list.flatMap(([x, y, ...rest]) => [
    [x, y, ...rest], [W - x, y, ...rest], [x, H - y, ...rest], [W - x, H - y, ...rest],
  ]);
  const toPoint = ([x, y]) => ({ x, y });
  const toCrate = ([x, y]) => ({ x: x - CRATE / 2, y: y - CRATE / 2, w: CRATE, h: CRATE });

  return {
    id: def.id,
    name: def.name,
    w: W,
    h: H,
    floor: def.floor,
    ice: !!def.ice,
    dark: !!def.dark,
    walls: [...rects4(q.walls), ...(def.walls || [])],
    lava: [...rects4(q.lava), ...(def.lava || [])],
    bushes: [...rects4(q.bushes), ...(def.bushes || [])],
    grip: [...rects4(q.grip), ...(def.grip || [])],
    conveyors: def.conveyors || [],
    bumpers: [...points4(q.bumpers), ...(def.bumpers || [])].map(([x, y, r]) => ({ x, y, r })),
    crates: [...points4(q.crates), ...(def.crates || [])].map(toCrate),
    barrels: [...points4(q.barrels), ...(def.barrels || [])].map(toPoint),
    turrets: [...points4(q.turrets), ...(def.turrets || [])].map(toPoint),
    vault: def.vault ? toPoint(def.vault) : { x: W / 2, y: H / 2 },
    spawns: spawnsFor(W, H),
  };
}

// Points mirrored across one centre line.
const pY = (x, y, H) => [[x, y], [x, H - y]];
const pX = (x, y, W) => [[x, y], [W - x, y]];

function ring(cx, cy, radius, count) {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + Math.PI / count;
    return [Math.round(cx + Math.cos(a) * radius), Math.round(cy + Math.sin(a) * radius)];
  });
}

export const MAPS = [
  makeMap({
    id: 'backyard', name: 'Backyard', w: 2800, h: 1600, floor: '#2b3a2e',
    quad: {
      walls: [
        { x: 420, y: 330, w: 220, h: 28 }, { x: 420, y: 330, w: 28, h: 170 },   // garden shed
        { x: 850, y: 560, w: 28, h: 180 },                                         // fence
        { x: 1240, y: 640, w: 110, h: 24 }, { x: 1240, y: 640, w: 24, h: 90 },     // greenhouse
      ],
      bushes: [{ x: 230, y: 560, w: 150, h: 110 }, { x: 880, y: 200, w: 200, h: 90 }, { x: 620, y: 660, w: 160, h: 80 }],
      crates: [[620, 520], [668, 520], [620, 568], [1000, 420], [1048, 420], [300, 420], [760, 240], [1100, 620], [520, 720], [1240, 470]],
      barrels: [[560, 620], [1150, 330]],
    },
    bushes: mirrorY({ x: 1330, y: 250, w: 140, h: 100 }, 1600),
    turrets: [...pX(650, 800, 2800), ...pY(1400, 560, 1600)],
    vault: [1400, 800],
  }),

  makeMap({
    id: 'ice', name: 'Ice Rink', w: 3000, h: 1700, floor: '#27404f', ice: true,
    quad: {
      walls: [{ x: 850, y: 320, w: 220, h: 28 }, { x: 480, y: 600, w: 28, h: 160 }],
      grip: [{ x: 560, y: 380, w: 220, h: 140 }, { x: 1120, y: 600, w: 200, h: 120 }],
      bushes: [{ x: 300, y: 250, w: 160, h: 90 }],
      crates: [[350, 450], [398, 450], [1000, 180], [1048, 180], [700, 700], [1300, 420], [1300, 468]],
      barrels: [[760, 520], [260, 700]],
      turrets: [[1000, 600]],
    },
    crates: ring(1500, 850, 230, 8),
    turrets: pY(1500, 330, 1700),
    vault: [1500, 850],
  }),

  makeMap({
    id: 'lava', name: 'Lava Lab', w: 3000, h: 1700, floor: '#2e2a33',
    quad: {
      lava: [{ x: 950, y: 0, w: 110, h: 300 }, { x: 950, y: 420, w: 110, h: 360 }],   // rivers with bridges
      walls: [{ x: 450, y: 330, w: 28, h: 200 }, { x: 1200, y: 300, w: 200, h: 28 }],
      crates: [[700, 250], [748, 250], [250, 640], [1250, 450], [800, 600]],
      barrels: [[600, 700], [1150, 560], [300, 480], [820, 420]],
      turrets: [[650, 450], [1300, 700]],
    },
    lava: mirrorY({ x: 1350, y: 520, w: 300, h: 80 }, 1700),
    vault: [1500, 850],
  }),

  makeMap({
    id: 'factory', name: 'Factory', w: 3200, h: 1800, floor: '#33302a',
    conveyors: [
      { x: 400, y: 380, w: 2400, h: 90, dx: 170, dy: 0 },
      { x: 400, y: 1330, w: 2400, h: 90, dx: -170, dy: 0 },
      { x: 640, y: 560, w: 90, h: 680, dx: 0, dy: 150 },
      { x: 2470, y: 560, w: 90, h: 680, dx: 0, dy: -150 },
      { x: 900, y: 855, w: 500, h: 90, dx: -170, dy: 0 },
      { x: 1800, y: 855, w: 500, h: 90, dx: 170, dy: 0 },
    ],
    quad: {
      walls: [{ x: 250, y: 620, w: 220, h: 28 }, { x: 1100, y: 130, w: 28, h: 180 }, { x: 1000, y: 600, w: 200, h: 28 }],
      bushes: [{ x: 280, y: 480, w: 140, h: 100 }],
      crates: [[400, 250], [448, 250], [900, 700], [1300, 620], [1300, 668]],
      barrels: [[550, 750], [1450, 560]],
      turrets: [[1150, 720]],
    },
    // Crates riding the belts become moving cover.
    crates: [[800, 425], [1200, 425], [2000, 425], [2400, 425], [800, 1375], [1200, 1375], [2000, 1375], [2400, 1375], [1000, 900], [2200, 900]],
    turrets: pY(1600, 250, 1800),
    vault: [1600, 900],
  }),

  makeMap({
    id: 'pinball', name: 'Pinball', w: 2800, h: 1600, floor: '#2a2740',
    quad: {
      bumpers: [[700, 450, 40], [1100, 330, 34], [1150, 650, 36]],
      walls: [{ x: 300, y: 250, w: 28, h: 140 }, { x: 950, y: 470, w: 120, h: 28 }],
      bushes: [{ x: 150, y: 420, w: 120, h: 90 }],
      crates: [[500, 200], [548, 200], [596, 200], [1300, 520], [1300, 568], [250, 600]],
      barrels: [[600, 700], [1000, 740]],
      turrets: [[800, 620]],
    },
    bumpers: [...pX(450, 800, 2800).map(([x, y]) => [x, y, 45]), ...pY(1400, 350, 1600).map(([x, y]) => [x, y, 40])],
    vault: [1400, 800],
  }),

  makeMap({
    id: 'dark', name: 'Dark House', w: 2800, h: 1600, floor: '#2c2c2c', dark: true,
    quad: {
      walls: [
        { x: 380, y: 480, w: 420, h: 28 }, { x: 900, y: 480, w: 260, h: 28 },   // corridor walls with a door
        { x: 880, y: 120, w: 28, h: 280 },
        { x: 1150, y: 600, w: 110, h: 28 }, { x: 1150, y: 600, w: 28, h: 120 }, // centre room
      ],
      crates: [[500, 650], [548, 650], [1000, 300], [300, 350], [1300, 400]],
      barrels: [[700, 700], [1050, 650]],
      turrets: [[600, 250]],
    },
    vault: [1400, 800],
  }),

  makeMap({
    id: 'jungle', name: 'Jungle Ruins', w: 3200, h: 1800, floor: '#26331f',
    quad: {
      bushes: [
        { x: 300, y: 350, w: 260, h: 160 }, { x: 750, y: 150, w: 220, h: 140 }, { x: 900, y: 550, w: 240, h: 170 },
        { x: 450, y: 700, w: 200, h: 120 }, { x: 1250, y: 300, w: 200, h: 150 },
      ],
      walls: [
        { x: 620, y: 560, w: 28, h: 120 }, { x: 1050, y: 380, w: 150, h: 28 }, { x: 200, y: 600, w: 160, h: 28 },
        { x: 1400, y: 700, w: 120, h: 28 }, { x: 1400, y: 700, w: 28, h: 110 },   // temple
      ],
      crates: [[500, 250], [1100, 720], [1148, 720], [300, 800]],
      barrels: [[600, 450], [1250, 600]],
      turrets: [[700, 420]],
    },
    turrets: pY(1600, 760, 1800),
    vault: [1600, 900],
  }),
];

export const mapIndex = (id) => MAPS.findIndex((m) => m.id === id);
