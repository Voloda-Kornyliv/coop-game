// Client-side prediction of YOUR OWN movement (GAME_DESIGN.txt section 15).
//
// The host is still the authority. Each snapshot tells us our position and
// the last input sequence number the host had applied (`ack`). We start from
// that position and replay the inputs the host hasn't seen yet, using the
// same speed and wall collisions. Then the drawn position glides toward the
// result, so corrections are smooth instead of jumpy.
//
// Prediction is switched off by the host whenever simple movement wouldn't
// match (dashing, slipping, dancing, ice, big knockback, countdown, pause);
// then we just use the newest host position.

import { circleRectPush, clamp } from './geometry.js';

const MAX_HISTORY = 120;
const SNAP_DISTANCE = 250;      // further than this from the drawn spot: jump, don't glide
const GLIDE_RATE = 20;          // correction speed (per second)

export class Predictor {
  constructor() {
    this.history = [];           // { seq, mx, my, t }
    this.drawn = null;
  }

  record(seq, mx, my) {
    this.history.push({ seq, mx, my, t: performance.now() });
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  reset() {
    this.history = [];
    this.drawn = null;
  }

  // base: our player in the newest snapshot. self: { ack, speed, predictable }.
  // world: { map, crates, objects }. Returns the position to draw.
  update(base, self, world, dt) {
    const now = performance.now();
    this.history = this.history.filter((h) => h.seq > self.ack);
    let x = base.x, y = base.y;

    if (self.predictable) {
      const dir = base.reverse ? -1 : 1;
      for (let i = 0; i < this.history.length; i++) {
        const h = this.history[i];
        const end = this.history[i + 1]?.t ?? now;
        const step = Math.min(0.2, Math.max(0, (end - h.t) / 1000));
        let mx = h.mx * dir, my = h.my * dir;
        const m = Math.hypot(mx, my);
        if (m > 1) { mx /= m; my /= m; }
        x += mx * self.speed * step;
        y += my * self.speed * step;
        if (base.ghost) {
          x = clamp(x, 20, world.map.w - 20);
          y = clamp(y, 20, world.map.h - 20);
        } else {
          ({ x, y } = collide(x, y, base.r, world));
        }
      }
    }

    const d = this.drawn;
    if (!d || Math.hypot(d.x - x, d.y - y) > SNAP_DISTANCE) {
      this.drawn = { x, y };
    } else {
      const k = 1 - Math.exp(-GLIDE_RATE * dt);
      d.x += (x - d.x) * k;
      d.y += (y - d.y) * k;
    }
    return this.drawn;
  }
}

// Same solid things the host collides with (minus hazards, which the host
// corrects anyway).
function collide(x, y, r, { map, crates, objects }) {
  const o = { x, y };
  const solve = (rect) => {
    const push = circleRectPush(o.x, o.y, r, rect);
    if (push) { o.x += push.x; o.y += push.y; }
  };
  for (const w of map.walls) solve(w);
  for (const c of crates) solve(c);
  for (const ob of [...objects, ...map.bumpers]) {
    const dx = o.x - ob.x, dy = o.y - ob.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d < ob.r + r) { o.x = ob.x + (dx / d) * (ob.r + r); o.y = ob.y + (dy / d) * (ob.r + r); }
  }
  o.x = clamp(o.x, r, map.w - r);
  o.y = clamp(o.y, r, map.h - r);
  return o;
}
