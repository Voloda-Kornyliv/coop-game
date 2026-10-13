// Canvas renderer. Pure presentation: it draws an interpolated view of the
// latest snapshots plus client-only particles. Nothing here affects gameplay.
//
// Camera (GAME_DESIGN.txt section 4): follows your player, shows the same
// 720 units of world height on every device (width capped at 2x), looks ahead
// where you aim, clamps at the map edge, and zooms out for ghosts.

import { CAMERA, EMOTES, TEAMS } from './config.js';

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const TAU = Math.PI * 2;

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mask = document.createElement('canvas');
    this.mctx = this.mask.getContext('2d');
    this.minimap = minimap;
    this.mmctx = minimap.getContext('2d');
    this.mmStatic = null;              // pre-rendered walls etc. for the current map
    this.particles = [];
    this.lights = [];
    this.shakeT = 0;
    this.shakeMag = 0;
    this.time = 0;
    this.frame = 0;
    this.lastPos = new Map();
    this.cam = null;                   // { x, y, viewH, mapId }
    this.aborter = new AbortController();
    window.addEventListener('resize', () => this.resize(), { signal: this.aborter.signal });
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cw = window.innerWidth;
    this.ch = window.innerHeight;
    this.canvas.width = this.mask.width = Math.round(this.cw * this.dpr);
    this.canvas.height = this.mask.height = Math.round(this.ch * this.dpr);
    this.canvas.style.width = `${this.cw}px`;
    this.canvas.style.height = `${this.ch}px`;
    const mw = this.minimap.clientWidth || 150, mh = this.minimap.clientHeight || 86;
    this.minimap.width = Math.round(mw * this.dpr);
    this.minimap.height = Math.round(mh * this.dpr);
    this.mmStatic = null;
  }

  // ------------------------------------------------------------ camera

  updateCamera(view, dt) {
    const me = view.me;
    const map = view.map;
    const targetViewH = CAMERA.viewHeight * (me?.ghost ? CAMERA.ghostZoom : 1);
    let tx = map.w / 2, ty = map.h / 2;
    if (me?.hasPos) {
      tx = me.x; ty = me.y;
      if (me.alive) {
        const look = CAMERA.lookAhead * CAMERA.viewHeight;
        tx += Math.cos(me.aim) * look;
        ty += Math.sin(me.aim) * look;
      }
    }
    const cam = this.cam;
    if (!cam || cam.mapId !== map.id || Math.hypot(cam.x - tx, cam.y - ty) > 1500) {
      this.cam = { x: tx, y: ty, viewH: targetViewH, mapId: map.id };
    } else {
      const k = 1 - Math.exp(-CAMERA.follow * dt);
      cam.x += (tx - cam.x) * k;
      cam.y += (ty - cam.y) * k;
      cam.viewH += (targetViewH - cam.viewH) * Math.min(1, dt * 3);
    }
    const c = this.cam;
    this.scale = this.ch / c.viewH;
    this.viewW = Math.min(this.cw / this.scale, c.viewH * CAMERA.maxAspect);
    this.viewH = c.viewH;
    this.ox = (this.cw - this.viewW * this.scale) / 2;
    this.oy = 0;
    // Stop at the map edge instead of showing empty space.
    c.x = map.w <= this.viewW ? map.w / 2 : Math.min(Math.max(c.x, this.viewW / 2), map.w - this.viewW / 2);
    c.y = map.h <= this.viewH ? map.h / 2 : Math.min(Math.max(c.y, this.viewH / 2), map.h - this.viewH / 2);
    this.left = c.x - this.viewW / 2;
    this.top = c.y - this.viewH / 2;
  }

  worldToScreen(x, y, flipped = false) {
    if (!this.cam) return { x: this.cw / 2, y: this.ch / 2 };
    const sy = flipped ? this.viewH - (y - this.top) : y - this.top;
    return { x: this.ox + (x - this.left) * this.scale, y: this.oy + sy * this.scale };
  }

  inView(x, y, r = 0) {
    const m = r + 80;
    return x > this.left - m && x < this.left + this.viewW + m && y > this.top - m && y < this.top + this.viewH + m;
  }

  // ------------------------------------------------------------ effects API

  shake(mag) {
    this.shakeMag = Math.max(this.shakeMag, mag);
    this.shakeT = 0.25;
  }

  burst(x, y, color, count = 10, speed = 200, size = 4) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU, s = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({ type: 'dot', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.5, max: 0.5, color, size });
    }
  }

  confetti(x, y) {
    const colors = ['#ff5a5f', '#ffd23f', '#3ddc84', '#3fa7ff', '#c77dff', '#ffffff'];
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * TAU, s = 120 + Math.random() * 320;
      this.particles.push({ type: 'rect', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.2, max: 1.2, color: colors[i % colors.length], size: 6, spin: Math.random() * 10 });
    }
  }

  ring(x, y, radius, color, life = 0.35) {
    this.particles.push({ type: 'ring', x, y, radius, life, max: life, color });
  }

  text(x, y, str, color = '#fff', size = 18) {
    this.particles.push({ type: 'text', x, y, vx: 0, vy: -50, str, color, size, life: 0.8, max: 0.8 });
  }

  emoji(x, y, str, size = 26, life = 1) {
    this.particles.push({ type: 'emoji', x, y, vx: 0, vy: -30, str, size, life, max: life });
  }

  zap(points) {
    this.particles.push({ type: 'zap', points, life: 0.25, max: 0.25 });
  }

  light(x, y, radius, life = 0.15) {
    this.lights.push({ x, y, radius, life, max: life });
  }

  // ------------------------------------------------------------ frame

  draw(view, dt) {
    const { ctx } = this;
    this.time += dt;
    this.frame++;
    this.updateParticles(dt);

    let sx = 0, sy = 0;
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      sx = (Math.random() - 0.5) * this.shakeMag;
      sy = (Math.random() - 0.5) * this.shakeMag;
      if (this.shakeT <= 0) this.shakeMag = 0;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!view) return;

    this.updateCamera(view, dt);
    const k = this.dpr * this.scale;
    const flip = view.me?.confused;
    const ex = this.dpr * (this.ox + sx) - this.left * k;
    const ey = this.dpr * (this.oy + sy);
    if (flip) ctx.setTransform(k, 0, 0, -k, ex, ey + (this.viewH + this.top) * k);
    else ctx.setTransform(k, 0, 0, k, ex, ey - this.top * k);
    this.worldTransform = ctx.getTransform();

    this.drawFloor(view);
    this.drawPickups(view);
    this.drawOrbs(view);
    this.drawProps(view, true);
    this.drawWallsAndCrates(view);
    this.drawObjects(view);
    for (const p of view.players) if (p.alive && p.seen) this.drawPlayer(p, view);
    this.drawProps(view, false);
    this.drawBushes(view);
    this.drawParticles(false);
    this.drawZone(view);
    if (view.map.dark) this.drawDarkness(view);
    this.drawBullets(view);
    for (const p of view.players) if (p.ghost && p.seen) this.drawGhost(p, view);
    this.drawParticles(true);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawArrows(view);
    // Letterbox bars when the screen is wider than the fair view.
    if (this.ox > 0) {
      ctx.fillStyle = '#0d0f14';
      ctx.fillRect(0, 0, this.ox, this.ch);
      ctx.fillRect(this.cw - this.ox, 0, this.ox, this.ch);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.frame % 2 === 0) this.drawMinimap(view);
  }

  drawFloor(view) {
    const { ctx } = this;
    const map = view.map;
    ctx.fillStyle = map.floor;
    ctx.fillRect(0, 0, map.w, map.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const x0 = Math.max(100, Math.floor(this.left / 100) * 100), x1 = Math.min(map.w, this.left + this.viewW + 100);
    const y0 = Math.max(100, Math.floor(this.top / 100) * 100), y1 = Math.min(map.h, this.top + this.viewH + 100);
    for (let x = x0; x < x1; x += 100) { ctx.moveTo(x, Math.max(0, this.top)); ctx.lineTo(x, Math.min(map.h, y1)); }
    for (let y = y0; y < y1; y += 100) { ctx.moveTo(Math.max(0, this.left), y); ctx.lineTo(Math.min(map.w, x1), y); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 6;
    ctx.strokeRect(0, 0, map.w, map.h);

    if (map.ice) {
      ctx.fillStyle = 'rgba(180,230,255,0.07)';
      for (let i = 0; i < 40; i++) {
        const x = (i * 373) % map.w, y = (i * 211) % map.h;
        if (this.inView(x, y, 200)) ctx.fillRect(x, y, 180, 6);
      }
      for (const g of map.grip) {
        if (!this.inView(g.x + g.w / 2, g.y + g.h / 2, Math.max(g.w, g.h))) continue;
        ctx.fillStyle = '#3b3b45';
        ctx.fillRect(g.x, g.y, g.w, g.h);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 2;
        for (let x = g.x + 10; x < g.x + g.w; x += 16) { ctx.beginPath(); ctx.moveTo(x, g.y + 4); ctx.lineTo(x, g.y + g.h - 4); ctx.stroke(); }
      }
    }

    for (const l of map.lava) {
      if (!this.inView(l.x + l.w / 2, l.y + l.h / 2, Math.max(l.w, l.h))) continue;
      const glow = 0.75 + Math.sin(this.time * 3 + l.x) * 0.15;
      ctx.fillStyle = '#ff4d1a';
      ctx.fillRect(l.x, l.y, l.w, l.h);
      ctx.fillStyle = `rgba(255,200,40,${glow * 0.6})`;
      ctx.fillRect(l.x + 10, l.y + 10, Math.max(0, l.w - 20), Math.max(0, l.h - 20));
      ctx.fillStyle = 'rgba(255,240,150,0.5)';
      for (let i = 0; i < 4; i++) {
        const bx = l.x + ((this.time * 20 + i * 47 + l.y) % l.w);
        const by = l.y + l.h / 2 + Math.sin(this.time * 2 + i) * l.h * 0.3;
        ctx.beginPath(); ctx.arc(bx, by, 5, 0, TAU); ctx.fill();
      }
    }

    const sign = Math.floor(view.roundTime / 8) % 2 === 0 ? 1 : -1;
    for (const c of map.conveyors) {
      if (!this.inView(c.x + c.w / 2, c.y + c.h / 2, Math.max(c.w, c.h))) continue;
      ctx.fillStyle = '#23252b';
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.save();
      ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip();
      ctx.strokeStyle = 'rgba(255,210,63,0.35)';
      ctx.lineWidth = 6;
      const horizontal = c.dx !== 0;
      const dir = Math.sign(horizontal ? c.dx : c.dy) * sign;
      const off = ((view.roundTime * 170 * dir) % 60 + 60) % 60;
      const len = horizontal ? c.w : c.h;
      for (let s = -60 + off; s < len + 60; s += 60) {
        ctx.beginPath();
        if (horizontal) {
          const x = c.x + s;
          ctx.moveTo(x - 12 * dir, c.y + 15); ctx.lineTo(x + 12 * dir, c.y + c.h / 2); ctx.lineTo(x - 12 * dir, c.y + c.h - 15);
        } else {
          const y = c.y + s;
          ctx.moveTo(c.x + 15, y - 12 * dir); ctx.lineTo(c.x + c.w / 2, y + 12 * dir); ctx.lineTo(c.x + c.w - 15, y - 12 * dir);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const b of map.bumpers) {
      if (!this.inView(b.x, b.y, b.r)) continue;
      ctx.fillStyle = '#ff4fa3';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#ffd1ea';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 8, 0, TAU); ctx.stroke();
    }
  }

  drawWallsAndCrates(view) {
    const { ctx } = this;
    for (const w of view.map.walls) {
      if (!this.inView(w.x + w.w / 2, w.y + w.h / 2, Math.max(w.w, w.h))) continue;
      ctx.fillStyle = '#545b6b';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#6c7487';
      ctx.fillRect(w.x, w.y, w.w, Math.min(6, w.h));
    }
    for (const c of view.crates) {
      if (!this.inView(c.x, c.y, 60)) continue;
      ctx.fillStyle = c.hp >= 3 ? '#a8743f' : c.hp === 2 ? '#8f6234' : '#704b27';
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.strokeStyle = '#5a3a1c';
      ctx.lineWidth = 4;
      ctx.strokeRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4);
      ctx.beginPath();
      ctx.moveTo(c.x + 4, c.y + 4); ctx.lineTo(c.x + c.w - 4, c.y + c.h - 4);
      ctx.moveTo(c.x + c.w - 4, c.y + 4); ctx.lineTo(c.x + 4, c.y + c.h - 4);
      ctx.stroke();
    }
  }

  drawObjects(view) {
    const { ctx } = this;
    for (const o of view.objects) {
      if (!this.inView(o.x, o.y, o.r)) continue;
      if (o.kind === 'turret') {
        ctx.fillStyle = '#2b2f3a';
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#8a93a8';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.save();
        ctx.translate(o.x, o.y);
        ctx.rotate(o.aim);
        ctx.fillStyle = '#5b6375';
        ctx.fillRect(4, -6, o.r + 8, 12);
        if (o.charging) {
          const pulse = 0.6 + Math.sin(this.time * 40) * 0.4;
          ctx.fillStyle = `rgba(255,60,60,${pulse})`;
          ctx.beginPath(); ctx.arc(o.r + 12, 0, 9, 0, TAU); ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = o.charging ? '#ff4d4d' : '#c9d1e3';
        ctx.beginPath(); ctx.arc(o.x, o.y, 8, 0, TAU); ctx.fill();
        if (view.map.dark) this.light(o.x + Math.cos(o.aim) * 120, o.y + Math.sin(o.aim) * 120, 110, 0.05);
      } else if (o.kind === 'barrel') {
        ctx.fillStyle = '#c92a2a';
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#7a1010';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.55, 0, TAU); ctx.stroke();
        this.drawEmoji('⚠️', o.x, o.y + 1, 16);
      } else if (o.kind === 'vault') {
        const s = o.r * 1.6;
        ctx.fillStyle = '#b8860b';
        ctx.fillRect(o.x - s / 2, o.y - s / 2, s, s);
        ctx.strokeStyle = '#ffd23f';
        ctx.lineWidth = 5;
        ctx.strokeRect(o.x - s / 2 + 3, o.y - s / 2 + 3, s - 6, s - 6);
        ctx.fillStyle = 'rgba(255,240,150,0.25)';
        ctx.beginPath(); ctx.arc(o.x, o.y, o.r + 10 + Math.sin(this.time * 3) * 4, 0, TAU); ctx.fill();
        this.drawEmoji('💰', o.x, o.y, 34);
      }
      if (o.hpPct < 1) this.hpBar(o.x, o.y - o.r - 12, 50, o.hpPct, '#ff8c42');
    }
  }

  drawPickups(view) {
    const { ctx } = this;
    for (const k of view.pickups) {
      if (!this.inView(k.x, k.y, 30)) continue;
      const pulse = 1 + Math.sin(this.time * 5 + k.id) * 0.08;
      ctx.save();
      ctx.translate(k.x, k.y);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = 'rgba(255,230,120,0.25)';
      ctx.beginPath(); ctx.arc(0, 0, 26, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(-15, -15, 30, 30);
      ctx.fillStyle = '#5a4300';
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (this.worldTransform.d < 0) ctx.scale(1, -1);
      ctx.fillText('?', 0, 2);
      ctx.restore();
    }
  }

  drawOrbs(view) {
    const { ctx } = this;
    for (const o of view.orbs) {
      if (!this.inView(o.x, o.y, 10)) continue;
      const pulse = 1 + Math.sin(this.time * 8 + o.id) * 0.2;
      ctx.fillStyle = 'rgba(120,255,200,0.25)';
      ctx.beginPath(); ctx.arc(o.x, o.y, 12 * pulse, 0, TAU); ctx.fill();
      ctx.fillStyle = '#7dffcf';
      ctx.beginPath(); ctx.arc(o.x, o.y, 5.5, 0, TAU); ctx.fill();
    }
  }

  drawBushes(view) {
    const { ctx } = this;
    const me = view.me;
    for (const b of view.map.bushes) {
      if (!this.inView(b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h))) continue;
      const mine = me?.alive && me.x >= b.x && me.x <= b.x + b.w && me.y >= b.y && me.y <= b.y + b.h;
      ctx.globalAlpha = mine ? 0.45 : 0.9;
      ctx.fillStyle = '#2f6b2a';
      const r = 22;
      for (let x = b.x + r; x <= b.x + b.w - r + 1; x += r * 1.2) {
        for (let y = b.y + r; y <= b.y + b.h - r + 1; y += r * 1.2) {
          ctx.beginPath(); ctx.arc(x, y, r + 4, 0, TAU); ctx.fill();
        }
      }
      ctx.fillStyle = '#3f8a37';
      for (let x = b.x + r; x <= b.x + b.w - r + 1; x += r * 1.2) {
        for (let y = b.y + r; y <= b.y + b.h - r + 1; y += r * 1.2) {
          ctx.beginPath(); ctx.arc(x - 5, y - 5, r * 0.6, 0, TAU); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  drawProps(view, ground) {
    const { ctx } = this;
    for (const o of view.props) {
      const isGround = o.kind !== 'decoy' && o.kind !== 'disco' && o.kind !== 'fart';
      if (isGround !== ground || !this.inView(o.x, o.y, o.r)) continue;
      switch (o.kind) {
        case 'banana': this.drawEmoji('🍌', o.x, o.y, 30); break;
        case 'mine':
          if (o.owner === view.myNum) {
            ctx.fillStyle = Math.floor(this.time * 4) % 2 ? '#ff3b3b' : '#7a1010';
            ctx.beginPath(); ctx.arc(o.x, o.y, 9, 0, TAU); ctx.fill();
            ctx.strokeStyle = 'rgba(255,60,60,0.4)';
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(o.x, o.y, 18, 0, TAU); ctx.stroke();
          }
          break;
        case 'pad': {
          ctx.save();
          ctx.translate(o.x, o.y);
          ctx.rotate(o.angle);
          ctx.fillStyle = '#3ddc84';
          ctx.beginPath(); ctx.arc(0, 0, o.r, 0, TAU); ctx.fill();
          ctx.fillStyle = '#0d3b22';
          ctx.beginPath(); ctx.moveTo(16, 0); ctx.lineTo(-8, -12); ctx.lineTo(-8, 12); ctx.closePath(); ctx.fill();
          ctx.restore();
          break;
        }
        case 'blackhole': {
          ctx.fillStyle = 'rgba(80,0,140,0.25)';
          ctx.beginPath(); ctx.arc(o.x, o.y, 120, 0, TAU); ctx.fill();
          ctx.fillStyle = '#05000a';
          ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill();
          ctx.strokeStyle = '#b07dff';
          ctx.lineWidth = 3;
          for (let i = 0; i < 3; i++) {
            const a = this.time * 6 + (i * TAU) / 3;
            ctx.beginPath(); ctx.arc(o.x, o.y, o.r + 12 + i * 10, a, a + 2); ctx.stroke();
          }
          break;
        }
        case 'fire': {
          const f = 0.7 + Math.random() * 0.3;
          ctx.fillStyle = `rgba(255,${100 + Math.random() * 80},20,${Math.min(1, o.left) * f})`;
          ctx.beginPath(); ctx.arc(o.x, o.y, o.r * f, 0, TAU); ctx.fill();
          break;
        }
        case 'fart': {
          const a = Math.min(1, o.left) * 0.3;
          ctx.fillStyle = `rgba(140,200,40,${a})`;
          for (let i = 0; i < 6; i++) {
            const ang = this.time * 0.8 + i;
            ctx.beginPath();
            ctx.arc(o.x + Math.cos(ang) * o.r * 0.45, o.y + Math.sin(ang * 1.3) * o.r * 0.45, o.r * 0.55, 0, TAU);
            ctx.fill();
          }
          break;
        }
        case 'decoy': {
          const info = view.roster.get(o.owner);
          if (info) this.drawPlayer({ num: o.owner, x: o.x, y: o.y, r: o.r, aim: o.angle, hp: 1, maxHp: 1, alive: true, decoy: true, level: 0, team: info.team }, view, info);
          break;
        }
        case 'disco': {
          const t = 1 - o.left / 1.5;
          ctx.lineWidth = 6;
          for (let i = 0; i < 5; i++) {
            ctx.strokeStyle = `hsla(${(this.time * 400 + i * 70) % 360},90%,60%,${0.5 * (1 - t)})`;
            ctx.beginPath(); ctx.arc(o.x, o.y, o.r * (0.2 + i * 0.2) * (0.5 + t * 0.5), 0, TAU); ctx.stroke();
          }
          this.drawEmoji('🪩', o.x, o.y, 34);
          break;
        }
        default: break;
      }
    }
  }

  drawBullets(view) {
    const { ctx } = this;
    for (const b of view.bullets) {
      if (!this.inView(b.x, b.y, b.r)) continue;
      const color = view.roster.get(b.owner)?.color || '#fff';
      switch (b.kind) {
        case 'bullet':
        case 'pellet':
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.45, 0, TAU); ctx.fill();
          break;
        case 'turretShot':
          ctx.fillStyle = 'rgba(255,60,60,0.35)';
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.9, 0, TAU); ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
          break;
        case 'snowball':
          ctx.fillStyle = '#f4fbff';
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
          ctx.strokeStyle = '#a9c9e0';
          ctx.lineWidth = 3;
          ctx.stroke();
          break;
        case 'hook': {
          const owner = view.byNum.get(b.owner);
          if (owner?.hasPos) {
            ctx.strokeStyle = '#c9ccd3';
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(owner.x, owner.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
          this.drawEmoji('🪝', b.x, b.y, 22);
          break;
        }
        case 'rocket': this.drawEmoji('🚀', b.x, b.y, 28); break;
        case 'boomerang': this.drawEmoji('🪃', b.x, b.y, 30, this.time * 18); break;
        case 'potato': this.drawEmoji('🥔', b.x, b.y, 26, this.time * 10); break;
        case 'bananaThrow': this.drawEmoji('🍌', b.x, b.y, 26, this.time * 14); break;
        default: {
          const orb = { swapOrb: '#ff4fd8', sheepOrb: '#ffffff', shrinkRay: '#4ee6e0', reverseOrb: '#a259ff' }[b.kind] || color;
          ctx.fillStyle = orb;
          ctx.globalAlpha = 0.35;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.7, 0, TAU); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
          if (b.kind === 'sheepOrb') this.drawEmoji('🐑', b.x, b.y, 16);
        }
      }
    }
  }

  drawPlayer(p, view, infoOverride) {
    const { ctx } = this;
    const info = infoOverride || view.roster.get(p.num);
    if (!info || !this.inView(p.x, p.y, p.r + 60)) return;
    const isMe = p.num === view.myNum && !p.decoy;
    const teams = view.mode === 'teams';
    let alpha = p.away ? 0.5 : 1;
    if (p.invis) {
      alpha = isMe ? 0.35 : 0.04;
      if (!isMe) this.footprints(p);
    }
    if (isMe && p.inBush) alpha = Math.min(alpha, 0.7);
    const bodyR = p.r * (p.bighead ? 1.5 : 1);

    ctx.save();
    ctx.globalAlpha = alpha;
    if (teams && info.team >= 0) {
      ctx.strokeStyle = TEAMS.colors[info.team];
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(p.x, p.y, bodyR + 6, 0, TAU); ctx.stroke();
    }
    ctx.translate(p.x, p.y);

    if (p.speed || p.dash) {
      ctx.fillStyle = info.color;
      ctx.globalAlpha = alpha * 0.25;
      ctx.beginPath(); ctx.arc(-Math.cos(p.aim) * 8, -Math.sin(p.aim) * 8, bodyR, 0, TAU); ctx.fill();
      ctx.globalAlpha = alpha;
    }

    const spin = p.dance || p.slip ? this.time * 14 : 0;
    ctx.rotate(spin);

    if (p.sheep) {
      this.drawEmoji('🐑', 0, 0, p.r * 2.4);
    } else {
      ctx.save();
      ctx.rotate(p.aim - spin);
      ctx.fillStyle = '#20232b';
      ctx.fillRect(bodyR * 0.4, -5, bodyR * 0.9, 10);
      ctx.restore();
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.arc(0, 0, bodyR, 0, TAU); ctx.fill();
      ctx.lineWidth = isMe ? 4 : 3;
      ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.45)';
      ctx.stroke();
      const ea = p.aim - spin;
      const ex = Math.cos(ea), ey = Math.sin(ea);
      const px = -ey, py = ex;
      const er = bodyR * 0.28;
      for (const s of [-1, 1]) {
        const cx = ex * bodyR * 0.35 + px * s * bodyR * 0.35;
        const cy = ey * bodyR * 0.35 + py * s * bodyR * 0.35;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx, cy, er, 0, TAU); ctx.fill();
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.arc(cx + ex * er * 0.4, cy + ey * er * 0.4, er * 0.5, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    if (p.shield > 0) {
      ctx.strokeStyle = 'rgba(90,170,255,0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, bodyR + 3, 0, TAU); ctx.stroke();
    }
    if (p.bubble) {
      ctx.strokeStyle = 'rgba(120,220,255,0.9)';
      ctx.fillStyle = 'rgba(120,220,255,0.15)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, bodyR + 9, 0, TAU); ctx.fill(); ctx.stroke();
    }
    if (p.mirror) {
      ctx.strokeStyle = `hsla(${(this.time * 600) % 360},80%,80%,0.9)`;
      ctx.lineWidth = 4;
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.arc(p.x, p.y, bodyR + 7, this.time * 4, this.time * 4 + TAU); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Stack above the head: hp bar, hat/crown, status icons.
    let top = p.y - bodyR - 8;
    if (p.hp < p.maxHp && !p.decoy) {
      this.hpBar(p.x, top - 3, 46, Math.max(0, p.hp / p.maxHp));
      top -= 10;
    }
    const hat = p.crown ? '👑' : info.hat;
    if (hat && !p.sheep) { this.drawEmoji(hat, p.x, top - 8, 24); top -= 22; }
    const icons = [];
    if (p.away) icons.push('📡');
    if (p.potato) icons.push('🥔');
    if (p.reverse) icons.push('🌀');
    if (p.confused) icons.push('🙃');
    if (p.minigun) icons.push('🔥');
    if (icons.length) { this.drawEmoji(icons.join(''), p.x, top - 8, 18); top -= 20; }
    if (p.potato) this.label(`${Math.ceil(p.potato)}`, p.x + 18, top + 18, '#ff8c42', 14);

    if (p.emote >= 0 && p.emoting) {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath(); ctx.arc(p.x + bodyR + 16, p.y - bodyR - 14, 19, 0, TAU); ctx.fill();
      this.drawEmoji(EMOTES[p.emote], p.x + bodyR + 16, p.y - bodyR - 13, 24);
    }

    if (isMe) {
      const bob = Math.sin(this.time * 6) * 3;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(p.x, top - 4 + bob);
      ctx.lineTo(p.x - 8, top - 16 + bob);
      ctx.lineTo(p.x + 8, top - 16 + bob);
      ctx.closePath();
      ctx.fill();
    }
    if (view.nemesis === p.num && !p.decoy) {
      ctx.strokeStyle = 'rgba(255,60,60,0.85)';
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.arc(p.x, p.y, bodyR + 14, -this.time * 2, -this.time * 2 + TAU); ctx.stroke();
      ctx.setLineDash([]);
    }
    this.nameTag(p, info, bodyR, teams, '#fff');
    ctx.restore();
  }

  // Name with a level badge in front (section 7).
  nameTag(p, info, bodyR, teams, color, size = 14, dy = 16) {
    const nameColor = teams && info.team >= 0 ? TEAMS.colors[info.team] : color;
    const y = p.y + bodyR + dy;
    if (p.level > 0) {
      const { ctx } = this;
      ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
      const w = ctx.measureText(info.name).width;
      const bx = p.x - w / 2 - 13;
      ctx.fillStyle = '#ffd23f';
      ctx.beginPath(); ctx.arc(bx, y, 9, 0, TAU); ctx.fill();
      this.label(String(p.level), bx, y + 1, '#2a2000', 11, false);
    }
    this.label(info.name, p.x, y, nameColor, size);
  }

  hpBar(x, y, w, k, color) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - w / 2, y - 3, w, 7);
    ctx.fillStyle = color || (k > 0.5 ? '#3ddc84' : k > 0.25 ? '#ffd23f' : '#ff5a5f');
    ctx.fillRect(x - w / 2 + 1, y - 2, (w - 2) * k, 5);
  }

  drawGhost(p, view) {
    const { ctx } = this;
    const info = view.roster.get(p.num);
    if (!info || !this.inView(p.x, p.y, 40)) return;
    const isMe = p.num === view.myNum;
    const bob = Math.sin(this.time * 3 + p.num) * 4;
    ctx.save();
    ctx.globalAlpha = isMe ? 0.7 : 0.35;
    ctx.translate(p.x, p.y + bob);
    ctx.fillStyle = '#e8ecff';
    ctx.beginPath();
    ctx.arc(0, -4, 18, Math.PI, 0);
    ctx.lineTo(18, 16);
    for (let i = 0; i < 4; i++) ctx.lineTo(18 - (i + 0.5) * 9, i % 2 ? 16 : 10);
    ctx.lineTo(-18, 16);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = view.mode === 'teams' && info.team >= 0 ? TEAMS.colors[info.team] : info.color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(-6, -4, 3.5, 0, TAU); ctx.arc(6, -4, 3.5, 0, TAU); ctx.fill();
    ctx.restore();

    // Team revive progress ring.
    if (p.reviveT > 0) {
      ctx.strokeStyle = '#3ddc84';
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(p.x, p.y + bob, 30, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, p.reviveT / TEAMS.reviveTime)); ctx.stroke();
    }
    ctx.save();
    ctx.globalAlpha = isMe ? 0.9 : 0.5;
    this.label(info.name, p.x, p.y + bob + 32, '#e8ecff', 12);
    if (isMe && p.ghostReady && view.phase === 'playing') this.label('ready to haunt', p.x, p.y + bob - 30, '#b9c4ff', 11);
    if (p.emote >= 0 && p.emoting) this.drawEmoji(EMOTES[p.emote], p.x + 26, p.y - 24, 22);
    ctx.restore();
  }

  drawZone(view) {
    const z = view.zone;
    if (!z || !z.r) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.left - 200, this.top - 200, this.viewW + 400, this.viewH + 400);
    ctx.arc(z.x, z.y, z.r, 0, TAU, true);
    ctx.fillStyle = 'rgba(150,0,30,0.35)';
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,70,90,0.9)';
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, TAU); ctx.stroke();
    ctx.restore();
  }

  // Each device lights only around its own player (plus flashes), so the
  // Dark House really is dark for everyone.
  drawDarkness(view) {
    const m = this.mctx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, this.mask.width, this.mask.height);
    m.setTransform(this.worldTransform);
    m.globalCompositeOperation = 'source-over';
    m.fillStyle = 'rgba(0,0,0,0.94)';
    m.fillRect(this.left - 200, this.top - 200, this.viewW + 400, this.viewH + 400);
    m.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, strength = 1) => {
      const g = m.createRadialGradient(x, y, r * 0.3, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = g;
      m.beginPath(); m.arc(x, y, r, 0, TAU); m.fill();
    };
    const me = view.me;
    if (me?.hasPos) hole(me.x, me.y, me.ghost ? 300 : 220);
    if (!me || view.phase !== 'playing') hole(this.cam.x, this.cam.y, 3000);
    for (const l of this.lights) hole(l.x, l.y, l.radius, Math.min(1, (l.life / l.max) * 1.5));
    m.globalCompositeOperation = 'source-over';
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mask, 0, 0);
    ctx.restore();
  }

  // Off-screen indicators (section 4): teammates, the crown holder and
  // anyone who just hit you.
  drawArrows(view) {
    const { ctx } = this;
    const targets = [];
    const me = view.me;
    for (const p of view.players) {
      if (p.num === view.myNum || !p.alive || !p.hasPos) continue;
      const info = view.roster.get(p.num);
      if (view.mode === 'teams' && me && p.team === me.team) targets.push({ x: p.x, y: p.y, color: TEAMS.colors[p.team] || '#fff', icon: '' });
      else if (p.crown) targets.push({ x: p.x, y: p.y, color: '#ffd23f', icon: '👑' });
      else if (info && view.attackers.has(p.num)) targets.push({ x: p.x, y: p.y, color: '#ff5a5f', icon: '' });
    }
    for (const [num, a] of view.attackers) {
      if (!view.byNum.get(num)?.hasPos) targets.push({ x: a.x, y: a.y, color: '#ff5a5f', icon: '' });
    }
    const pad = 26;
    const x0 = this.ox + pad, x1 = this.ox + this.viewW * this.scale - pad;
    const y0 = 70, y1 = this.ch - pad;
    for (const t of targets) {
      const s = this.worldToScreen(t.x, t.y, me?.confused);
      if (s.x > x0 && s.x < x1 && s.y > y0 && s.y < y1) continue;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const dx = s.x - cx, dy = s.y - cy;
      const k = Math.min((x1 - cx) / Math.abs(dx || 1e-6), (y1 - cy) / Math.abs(dy || 1e-6));
      const ax = cx + dx * k, ay = cy + dy * k;
      const ang = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = t.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-8, 10); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
      if (t.icon) this.drawEmoji(t.icon, ax - Math.cos(ang) * 22, ay - Math.sin(ang) * 22, 16);
    }
  }

  // ------------------------------------------------------------ minimap (section 4)

  buildMinimapStatic(map) {
    const c = document.createElement('canvas');
    c.width = this.minimap.width;
    c.height = this.minimap.height;
    const g = c.getContext('2d');
    const s = c.width / map.w;
    g.scale(s, c.height / map.h);
    g.fillStyle = map.floor;
    g.fillRect(0, 0, map.w, map.h);
    g.fillStyle = '#ff6a2a';
    for (const l of map.lava) g.fillRect(l.x, l.y, l.w, l.h);
    g.fillStyle = '#26402a';
    for (const b of map.bushes) g.fillRect(b.x, b.y, b.w, b.h);
    g.fillStyle = '#45464d';
    for (const cv of map.conveyors) g.fillRect(cv.x, cv.y, cv.w, cv.h);
    g.fillStyle = '#b9c0d0';
    for (const w of map.walls) g.fillRect(w.x, w.y, Math.max(w.w, 14), Math.max(w.h, 14));
    this.mmStatic = { canvas: c, mapId: map.id };
  }

  drawMinimap(view) {
    const g = this.mmctx;
    const mm = this.minimap;
    const map = view.map;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, mm.width, mm.height);
    if (!this.mmStatic || this.mmStatic.mapId !== map.id || this.mmStatic.canvas.width !== mm.width) this.buildMinimapStatic(map);
    g.globalAlpha = 0.85;
    g.drawImage(this.mmStatic.canvas, 0, 0);
    g.globalAlpha = 1;
    const sx = mm.width / map.w, sy = mm.height / map.h;
    g.setTransform(sx, 0, 0, sy, 0, 0);
    const dot = (x, y, r, color, stroke) => {
      g.fillStyle = color;
      g.beginPath(); g.ellipse(x, y, r / sx, r / sy, 0, 0, TAU); g.fill();
      if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5 / sx; g.stroke(); }
    };
    const px = this.dpr;

    if (view.finalZone) {
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 1.5 / sx * px;
      g.setLineDash([6 / sx * px, 5 / sx * px]);
      g.beginPath(); g.arc(view.finalZone.x, view.finalZone.y, view.finalZone.r, 0, TAU); g.stroke();
      g.setLineDash([]);
    }
    if (view.zone?.r) {
      g.strokeStyle = 'rgba(255,70,90,0.95)';
      g.lineWidth = 2 / sx * px;
      g.beginPath(); g.arc(view.zone.x, view.zone.y, view.zone.r, 0, TAU); g.stroke();
    }
    if (this.cam) {
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 1 / sx * px;
      g.strokeRect(this.left, this.top, this.viewW, this.viewH);
    }
    for (const o of view.objects) {
      if (o.kind === 'turret') dot(o.x, o.y, 2.2 * px, '#ff5a5f');
      else if (o.kind === 'vault') { g.fillStyle = '#ffd23f'; g.fillRect(o.x - 3 * px / sx, o.y - 3 * px / sy, 6 * px / sx, 6 * px / sy); }
    }
    for (const b of view.blips) dot(b.x, b.y, 2.5 * px, `rgba(255,90,95,${1 - b.age})`);
    for (const p of view.players) {
      if (!p.alive || !p.hasPos || p.num === view.myNum) continue;
      if (view.mode === 'teams' && view.me && p.team === view.me.team) dot(p.x, p.y, 2.8 * px, TEAMS.colors[p.team], '#000');
      else if (p.crown) dot(p.x, p.y, 3.5 * px, '#ffd23f', '#000');
    }
    if (view.me?.hasPos) dot(view.me.x, view.me.y, 3.2 * px, '#ffffff', '#000');
  }

  // ------------------------------------------------------------ particles

  footprints(p) {
    const last = this.lastPos.get(p.num);
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < 26) return;
    this.lastPos.set(p.num, { x: p.x, y: p.y });
    this.particles.push({ type: 'dot', x: p.x, y: p.y, vx: 0, vy: 0, life: 1.2, max: 1.2, color: 'rgba(255,255,255,0.5)', size: 4 });
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      if (p.vx !== undefined) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.92;
        p.vy *= 0.92;
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
    for (const l of this.lights) l.life -= dt;
    this.lights = this.lights.filter((l) => l.life > 0);
  }

  drawParticles(overlay) {
    const { ctx } = this;
    for (const p of this.particles) {
      const isOverlay = p.type === 'text' || p.type === 'emoji';
      if (isOverlay !== overlay) continue;
      if (p.type !== 'zap' && !this.inView(p.x, p.y, 40)) continue;
      const k = p.life / p.max;
      ctx.globalAlpha = Math.min(1, k * 1.5);
      switch (p.type) {
        case 'dot':
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + k * 0.5), 0, TAU); ctx.fill();
          break;
        case 'rect':
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.spin * (1 - k) * 3);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
          break;
        case 'ring':
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 6 * k;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * (1.1 - k * 0.6), 0, TAU); ctx.stroke();
          break;
        case 'zap':
          ctx.strokeStyle = '#bfe9ff';
          ctx.lineWidth = 4;
          ctx.beginPath();
          for (let i = 0; i + 3 < p.points.length; i += 2) {
            const [x1, y1, x2, y2] = p.points.slice(i, i + 4);
            ctx.moveTo(x1, y1);
            for (let s = 1; s <= 5; s++) {
              const t = s / 5;
              const j = s === 5 ? 0 : 14;
              ctx.lineTo(x1 + (x2 - x1) * t + (Math.random() - 0.5) * j, y1 + (y2 - y1) * t + (Math.random() - 0.5) * j);
            }
          }
          ctx.stroke();
          break;
        case 'text':
          this.label(p.str, p.x, p.y, p.color, p.size);
          break;
        case 'emoji':
          this.drawEmoji(p.str, p.x, p.y, p.size);
          break;
        default: break;
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ text helpers

  // Text stays upright even when Confusion flips the world.
  drawEmoji(str, x, y, size, rotation = 0) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    if (ctx.getTransform().d < 0) ctx.scale(1, -1);
    ctx.font = `${size}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  label(str, x, y, color, size, outline = true) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    if (ctx.getTransform().d < 0) ctx.scale(1, -1);
    ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (outline) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(str, 0, 0);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  destroy() {
    this.aborter.abort();
  }
}
