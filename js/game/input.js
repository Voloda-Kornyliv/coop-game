// Turns touch, mouse and keyboard into one input state:
//   move (-1..1), aim direction, fire flag, and press COUNTERS for buttons.
// Counters (not booleans) make presses survive batching and network hiccups.

const STICK_RADIUS = 55;
const FIRE_THRESHOLD = 0.35;

const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

export class Input {
  constructor(root, { onTouch } = {}) {
    this.root = root;
    this.onTouch = onTouch;
    this.counts = { dash: 0, abil: 0, item: 0, emote: 0, reload: 0 };
    this.emoteIdx = 0;
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, down: false };
    this.sticks = { move: null, aim: null };
    this.touchMode = matchMedia('(pointer: coarse)').matches;
    this.lastAim = { x: 1, y: 0 };
    this.aborter = new AbortController();

    this.els = {
      move: root.querySelector('#stick-move'),
      aim: root.querySelector('#stick-aim'),
    };
    this.bind();
    this.setTouchMode(this.touchMode);
  }

  bind() {
    const opts = { signal: this.aborter.signal };
    const press = (name) => () => { this.counts[name]++; };

    // Buttons react on pointerdown (no 300 ms click delay on phones).
    const buttons = { '#btn-dash': press('dash'), '#btn-ability': press('abil'), '#btn-item': press('item'), '#ammo': press('reload') };
    for (const [sel, fn] of Object.entries(buttons)) {
      this.root.querySelector(sel).addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      }, opts);
    }
    this.root.querySelectorAll('[data-emote]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.emote(Number(btn.dataset.emote));
      }, opts);
    });

    this.root.addEventListener('pointerdown', (e) => this.onDown(e), opts);
    window.addEventListener('pointermove', (e) => this.onMove(e), opts);
    window.addEventListener('pointerup', (e) => this.onUp(e), opts);
    window.addEventListener('pointercancel', (e) => this.onUp(e), opts);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault(), opts);

    window.addEventListener('keydown', (e) => this.onKey(e, true), opts);
    window.addEventListener('keyup', (e) => this.onKey(e, false), opts);
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.down = false; }, opts);
  }

  emote(i) {
    this.emoteIdx = i;
    this.counts.emote++;
  }

  setTouchMode(on) {
    this.touchMode = on;
    document.body.classList.toggle('touch', on);
  }

  onDown(e) {
    if (e.target.closest('button, .overlay')) return;
    if (e.pointerType === 'mouse') {
      this.setTouchMode(false);
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2) this.counts.abil++;
      return;
    }
    e.preventDefault();
    if (!this.touchMode) this.setTouchMode(true);
    this.onTouch?.();
    const side = e.clientX < window.innerWidth / 2 ? 'move' : 'aim';
    if (this.sticks[side]) return;
    this.sticks[side] = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: 0, y: 0 };
    this.drawStick(side);
  }

  onMove(e) {
    if (e.pointerType === 'mouse') {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      return;
    }
    for (const side of ['move', 'aim']) {
      const s = this.sticks[side];
      if (!s || s.id !== e.pointerId) continue;
      let dx = (e.clientX - s.ox) / STICK_RADIUS;
      let dy = (e.clientY - s.oy) / STICK_RADIUS;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      s.x = dx; s.y = dy;
      this.drawStick(side);
    }
  }

  onUp(e) {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this.mouse.down = false;
      return;
    }
    for (const side of ['move', 'aim']) {
      if (this.sticks[side]?.id === e.pointerId) {
        this.sticks[side] = null;
        this.drawStick(side);
      }
    }
  }

  onKey(e, down) {
    if (e.target.matches?.('input, textarea')) return;
    if (MOVE_KEYS[e.code]) {
      e.preventDefault();
      if (down) this.keys.add(e.code); else this.keys.delete(e.code);
      return;
    }
    if (!down || e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); this.counts.dash++; }
    else if (e.code === 'KeyQ') this.counts.abil++;
    else if (e.code === 'KeyE') this.counts.item++;
    else if (e.code === 'KeyR') this.counts.reload++;
    else if (/^Digit[1-4]$/.test(e.code)) this.emote(Number(e.code.slice(5)) - 1);
  }

  drawStick(side) {
    const el = this.els[side];
    const s = this.sticks[side];
    el.classList.toggle('active', !!s);
    if (s) {
      el.style.left = `${s.ox}px`;
      el.style.top = `${s.oy}px`;
      el.firstElementChild.style.transform = `translate(${s.x * STICK_RADIUS}px, ${s.y * STICK_RADIUS}px)`;
    } else {
      el.style.left = '';
      el.style.top = '';
      el.firstElementChild.style.transform = '';
    }
  }

  // playerScreen: where the local player is on screen (for mouse aiming).
  read(playerScreen) {
    let mx = 0, my = 0;
    for (const k of this.keys) { mx += MOVE_KEYS[k][0]; my += MOVE_KEYS[k][1]; }
    const mv = this.sticks.move;
    if (mv) { mx += mv.x; my += mv.y; }
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }

    let fire = false;
    const aim = this.sticks.aim;
    if (this.touchMode) {
      const am = aim ? Math.hypot(aim.x, aim.y) : 0;
      if (am > 0.2) {
        this.lastAim = { x: aim.x / am, y: aim.y / am };
        fire = am > FIRE_THRESHOLD;
      } else if (!aim && Math.hypot(mx, my) > 0.3) {
        const mm = Math.hypot(mx, my);
        this.lastAim = { x: mx / mm, y: my / mm };
      }
    } else if (playerScreen) {
      const dx = this.mouse.x - playerScreen.x, dy = this.mouse.y - playerScreen.y;
      const d = Math.hypot(dx, dy);
      if (d > 2) this.lastAim = { x: dx / d, y: dy / d };
      fire = this.mouse.down;
    }

    return {
      mx, my,
      ax: this.lastAim.x, ay: this.lastAim.y,
      fire,
      dash: this.counts.dash, abil: this.counts.abil, item: this.counts.item,
      emote: this.counts.emote, emoteIdx: this.emoteIdx, reload: this.counts.reload,
      touch: this.touchMode,
    };
  }

  destroy() {
    this.aborter.abort();
    this.setTouchMode(false);
  }
}
