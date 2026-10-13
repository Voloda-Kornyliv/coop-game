// Canvas renderer. Pure presentation: it draws an interpolated view of the
// latest snapshots plus client-only particles. Nothing here affects gameplay.

import { WORLD_W as W, WORLD_H as H, EMOTES } from './config.js';

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const TAU = Math.PI * 2;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mask = document.createElement('canvas');
    this.mctx = this.mask.getContext('2d');
    this.particles = [];
    this.lights = [];
    this.shakeT = 0;
    this.shakeMag = 0;
    this.time = 0;
    this.lastPos = new Map();
    this.aborter = new AbortController();
    window.addEventListener('resize', () => this.resize(), { signal: this.aborter.signal });
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = window.innerWidth, ch = window.innerHeight;
    this.canvas.width = this.mask.width = Math.round(cw * this.dpr);
    this.canvas.height = this.mask.height = Math.round(ch * this.dpr);
    this.canvas.style.width = `${cw}px`;
    this.canvas.style.height = `${ch}px`;
    this.scale = Math.min(cw / W, ch / H);
    this.ox = (cw - W * this.scale) / 2;
    this.oy = (ch - H * this.scale) / 2;
  }

  worldToScreen(x, y, flipped = false) {
    return { x: this.ox + x * this.scale, y: this.oy + (flipped ? H - y : y) * this.scale };
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

  line(x1, y1, x2, y2, color) {
    this.particles.push({ type: 'line', x1, y1, x2, y2, color, life: 0.3, max: 0.3 });
  }

  light(x, y, radius, life = 0.15) {
    this.lights.push({ x, y, radius, life, max: life });
  }

  // ------------------------------------------------------------ frame

  draw(view, dt) {
    const { ctx } = this;
    this.time += dt;
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

    const k = this.dpr * this.scale;
    const flip = view.me?.confused;
    const tx = this.dpr * (this.ox + sx), ty = this.dpr * (this.oy + sy);
    if (flip) ctx.setTransform(k, 0, 0, -k, tx, ty + H * k);
    else ctx.setTransform(k, 0, 0, k, tx, ty);
    this.worldTransform = ctx.getTransform();

    this.drawFloor(view);
    this.drawPickups(view);
    this.drawProps(view, true);
    this.drawWallsAndCrates(view);
    for (const p of view.players) if (p.alive) this.drawPlayer(p, view);
    this.drawProps(view, false);
    this.drawParticles(false);
    this.drawZone(view);
    if (view.map.dark) this.drawDarkness(view);
    this.drawBullets(view);
    for (const p of view.players) if (p.ghost) this.drawGhost(p, view);
    this.drawParticles(true);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawFloor(view) {
    const { ctx } = this;
    const map = view.map;
    ctx.fillStyle = map.floor;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 100; x < W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 100; y < H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    if (map.ice) {
      ctx.fillStyle = 'rgba(180,230,255,0.08)';
      for (let i = 0; i < 12; i++) ctx.fillRect((i * 173) % W, (i * 97) % H, 160, 6);
    }

    for (const l of map.lava) {
      const glow = 0.75 + Math.sin(this.time * 3 + l.x) * 0.15;
      ctx.fillStyle = '#ff4d1a';
      ctx.fillRect(l.x, l.y, l.w, l.h);
      ctx.fillStyle = `rgba(255,200,40,${glow * 0.6})`;
      ctx.fillRect(l.x + 10, l.y + 10, l.w - 20, l.h - 20);
      ctx.fillStyle = 'rgba(255,240,150,0.5)';
      for (let i = 0; i < 4; i++) {
        const bx = l.x + ((this.time * 20 + i * 47 + l.y) % l.w);
        const by = l.y + l.h / 2 + Math.sin(this.time * 2 + i) * l.h * 0.3;
        ctx.beginPath(); ctx.arc(bx, by, 5, 0, TAU); ctx.fill();
      }
    }

    const sign = Math.floor(view.roundTime / 8) % 2 === 0 ? 1 : -1;
    for (const c of map.conveyors) {
      ctx.fillStyle = '#23252b';
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.save();
      ctx.beginPath(); ctx.rect(c.x, c.y, c.w, c.h); ctx.clip();
      ctx.strokeStyle = 'rgba(255,210,63,0.35)';
      ctx.lineWidth = 6;
      const dir = Math.sign(c.dx) * sign;
      const off = ((view.roundTime * 170 * dir) % 60 + 60) % 60;
      for (let x = c.x - 60 + off; x < c.x + c.w + 60; x += 60) {
        ctx.beginPath();
        ctx.moveTo(x - 12 * dir, c.y + 15);
        ctx.lineTo(x + 12 * dir, c.y + c.h / 2);
        ctx.lineTo(x - 12 * dir, c.y + c.h - 15);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const b of map.bumpers) {
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
      ctx.fillStyle = '#545b6b';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#6c7487';
      ctx.fillRect(w.x, w.y, w.w, Math.min(6, w.h));
    }
    for (const c of view.crates) {
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

  drawPickups(view) {
    const { ctx } = this;
    for (const k of view.pickups) {
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
      ctx.fillText('?', 0, 2);
      ctx.restore();
    }
  }

  drawProps(view, ground) {
    const { ctx } = this;
    for (const o of view.props) {
      const isGround = o.kind !== 'decoy' && o.kind !== 'disco' && o.kind !== 'fart';
      if (isGround !== ground) continue;
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
          if (info) this.drawPlayer({ num: o.owner, x: o.x, y: o.y, r: o.r, aim: o.angle, hp: 1, maxHp: 1, alive: true, decoy: true }, view, info);
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
      const color = view.roster.get(b.owner)?.color || '#fff';
      switch (b.kind) {
        case 'bullet':
        case 'pellet':
          ctx.fillStyle = color;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.45, 0, TAU); ctx.fill();
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
          if (owner) {
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
    if (!info) return;
    const isMe = p.num === view.myNum && !p.decoy;
    let alpha = 1;
    if (p.invis) {
      alpha = isMe ? 0.35 : 0.04;
      if (!isMe) this.footprints(p);
    }
    const bodyR = p.r * (p.bighead ? 1.5 : 1);

    ctx.save();
    ctx.globalAlpha = alpha;
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
      // Gun barrel
      ctx.save();
      ctx.rotate(p.aim - spin);
      ctx.fillStyle = '#20232b';
      ctx.fillRect(bodyR * 0.4, -5, bodyR * 0.9, 10);
      ctx.restore();
      // Body
      ctx.fillStyle = info.color;
      ctx.beginPath(); ctx.arc(0, 0, bodyR, 0, TAU); ctx.fill();
      ctx.lineWidth = isMe ? 4 : 3;
      ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.45)';
      ctx.stroke();
      // Eyes look where you aim
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
      const w = 46;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p.x - w / 2, top - 6, w, 7);
      const k = Math.max(0, p.hp / p.maxHp);
      ctx.fillStyle = k > 0.5 ? '#3ddc84' : k > 0.25 ? '#ffd23f' : '#ff5a5f';
      ctx.fillRect(p.x - w / 2 + 1, top - 5, (w - 2) * k, 5);
      top -= 10;
    }
    const hat = p.crown ? '👑' : info.hat;
    if (hat && !p.sheep) { this.drawEmoji(hat, p.x, top - 8, 24); top -= 22; }
    const icons = [];
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
    this.label(info.name, p.x, p.y + bodyR + 16, '#fff', 14);
    ctx.restore();
  }

  drawGhost(p, view) {
    const { ctx } = this;
    const info = view.roster.get(p.num);
    if (!info) return;
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
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(-6, -4, 3.5, 0, TAU); ctx.arc(6, -4, 3.5, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = isMe ? 0.9 : 0.5;
    this.label(info.name, p.x, p.y + bob + 32, '#e8ecff', 12);
    if (isMe && p.ghostReady && view.phase === 'playing') this.label('ready to haunt', p.x, p.y + bob - 30, '#b9c4ff', 11);
    if (p.emote >= 0 && p.emoting) this.drawEmoji(EMOTES[p.emote], p.x + 26, p.y - 24, 22);
    ctx.restore();
  }

  drawZone(view) {
    if (!view.zone) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(W / 2, H / 2, view.zone, 0, TAU, true);
    ctx.fillStyle = 'rgba(150,0,30,0.35)';
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,70,90,0.9)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, view.zone, 0, TAU); ctx.stroke();
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
    m.fillRect(0, 0, W, H);
    m.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, strength = 1) => {
      const g = m.createRadialGradient(x, y, r * 0.3, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = g;
      m.beginPath(); m.arc(x, y, r, 0, TAU); m.fill();
    };
    if (view.me) hole(view.me.x, view.me.y, view.me.ghost ? 260 : 200);
    if (!view.me || view.phase !== 'playing') hole(W / 2, H / 2, 2000);
    for (const l of this.lights) hole(l.x, l.y, l.radius, Math.min(1, (l.life / l.max) * 1.5));
    m.globalCompositeOperation = 'source-over';
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.mask, 0, 0);
    ctx.restore();
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
    for (const l of this.lights) l.life -= dt;
    this.lights = this.lights.filter((l) => l.life > 0);
  }

  drawParticles(overlay) {
    const { ctx } = this;
    for (const p of this.particles) {
      const isOverlay = p.type === 'text' || p.type === 'emoji';
      if (isOverlay !== overlay) continue;
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
        case 'line':
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 8]);
          ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke();
          ctx.setLineDash([]);
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

  drawEmoji(str, x, y, size, rotation = 0) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    if (rotation) ctx.rotate(rotation);
    if (this.worldTransform && this.worldTransform.d < 0) ctx.scale(1, -1);
    ctx.font = `${size}px ${EMOJI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  label(str, x, y, color, size) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(str, 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  destroy() {
    this.aborter.abort();
  }
}

