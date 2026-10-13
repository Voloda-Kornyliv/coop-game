// Small, allocation-light math helpers shared by simulation and rendering.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function circleOverlapsRect(cx, cy, cr, r) {
  const nx = clamp(cx, r.x, r.x + r.w);
  const ny = clamp(cy, r.y, r.y + r.h);
  return dist2(cx, cy, nx, ny) < cr * cr;
}

// Returns how to push a circle out of a rect: { x, y } offset plus unit normal,
// or null when they don't overlap.
export function circleRectPush(cx, cy, cr, r) {
  const nx = clamp(cx, r.x, r.x + r.w);
  const ny = clamp(cy, r.y, r.y + r.h);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= cr * cr) return null;
  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return { x: (dx / d) * (cr - d), y: (dy / d) * (cr - d), nx: dx / d, ny: dy / d };
  }
  // Center is inside the rect: leave through the nearest side.
  const left = cx - r.x, right = r.x + r.w - cx, top = cy - r.y, bottom = r.y + r.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: -(left + cr), y: 0, nx: -1, ny: 0 };
  if (m === right) return { x: right + cr, y: 0, nx: 1, ny: 0 };
  if (m === top) return { x: 0, y: -(top + cr), nx: 0, ny: -1 };
  return { x: 0, y: bottom + cr, nx: 0, ny: 1 };
}

// Mirror a rect into all four quadrants for symmetric (fair) maps.
export function mirror4(r, W, H) {
  return [
    r,
    { ...r, x: W - r.x - r.w },
    { ...r, y: H - r.y - r.h },
    { ...r, x: W - r.x - r.w, y: H - r.y - r.h },
  ];
}

export function mirrorX(r, W) {
  return [r, { ...r, x: W - r.x - r.w }];
}

export function mirrorY(r, H) {
  return [r, { ...r, y: H - r.y - r.h }];
}
