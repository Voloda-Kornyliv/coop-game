// DOM HUD and overlays. Player names always go through textContent, never
// innerHTML, because they come from other people's devices.

import { ACTIVES, PICKUPS, PASSIVES, describeCard } from './abilities.js';
import { TEAMS, PROGRESSION } from './config.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class GameUI {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.$ = (sel) => root.querySelector(sel);
    this.cache = {};
    this.offer = null;
    this.results = null;
    this.aborter = new AbortController();
    const opts = { signal: this.aborter.signal };

    this.$('#menu-btn').addEventListener('click', () => this.h.onLeave(), opts);
    this.$('#sound-btn').addEventListener('click', () => this.h.onSoundToggle(), opts);
    this.$('#results-again').addEventListener('click', () => this.h.onPlayAgain(), opts);
    this.$('#results-leave').addEventListener('click', () => this.h.onLeave(true), opts);
    this.$('#results-lobby').addEventListener('click', () => this.h.onLobby(), opts);
    this.$('#notice').hidden = true;
    this.$('#killfeed').replaceChildren();
    this.$('#draft').hidden = true;
    this.$('#results').hidden = true;
  }

  // Only touch the DOM when a value actually changed.
  set(key, value, apply) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    apply(value);
  }

  setSound(on) {
    this.$('#sound-btn').textContent = on ? '🔊' : '🔇';
  }

  update(view) {
    const { me, phase } = view;

    // Scoreboard
    const teams = view.mode === 'teams';
    const scoreKey = view.players.map((p) => `${p.num}:${p.score}:${p.crown}:${p.alive}:${p.picked}:${p.away}:${p.team}`).join('|') + phase + view.teamScores.join();
    this.set('scores', scoreKey, () => {
      const box = this.$('#scores');
      const chips = [];
      if (teams) {
        TEAMS.names.forEach((n, t) => {
          const chip = el('div', 'chip team-score', `${n} ${view.teamScores[t]}`);
          chip.style.background = TEAMS.colors[t];
          chips.push(chip);
        });
      }
      chips.push(...view.players.map((p) => {
        const info = view.roster.get(p.num);
        const chip = el('div', `chip${p.alive ? '' : ' out'}${p.num === view.myNum ? ' me' : ''}`);
        if (teams && p.team >= 0) chip.style.boxShadow = `inset 0 0 0 2px ${TEAMS.colors[p.team]}`;
        const dot = el('span', 'dot');
        dot.style.background = info?.color || '#888';
        chip.append(dot, el('span', 'name', info?.name || '?'));
        if (!teams) chip.append(el('b', '', String(p.score)));
        if (p.crown) chip.append(el('span', '', '👑'));
        if (p.away) chip.append(el('span', '', '📡'));
        if (phase === 'draft' && p.picked) chip.append(el('span', '', '✓'));
        return chip;
      }));
      box.replaceChildren(...chips);
    });

    // Round info
    let info = '';
    if (phase === 'playing' || phase === 'roundEnd') {
      info = `Round ${view.round} · ${view.map.name} · ${fmtTime(view.roundTime)}`;
      if (view.zone?.r) info += ' · ⚠️ zone closing';
      else if (view.zone?.startsIn > 0) info += ` · zone in ${Math.ceil(view.zone.startsIn)}s`;
    } else if (phase === 'countdown') info = `Round ${view.round} · ${view.map.name}`;
    else if (phase === 'draft') info = 'Draft';
    this.set('info', info, (v) => { this.$('#round-info').textContent = v; });

    // Own status
    if (me) {
      // Between rounds everyone is technically a ghost; only show ghost UI in a round.
      const inRound = phase === 'playing' || phase === 'roundEnd' || phase === 'countdown';
      const ghost = me.ghost && inRound;
      this.set('hpVisible', inRound, (v) => { this.$('#hp-bar').hidden = !v; });
      const hpText = ghost ? '👻 Ghost' : `${me.hp} / ${me.maxHp}${me.shield > 0 ? ` +${me.shield}🛡` : ''}`;
      this.set('hp', `${me.hp}/${me.maxHp}/${ghost}/${me.shield}`, () => {
        this.$('#hp-fill').style.width = ghost ? '0%' : `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
        this.$('#hp-text').textContent = hpText;
      });
      // XP bar: level, progress and the catch-up multiplier (section 12).
      const mult = me.leader ? PROGRESSION.leaderXp : me.underdog ? PROGRESSION.underdogXp : 1;
      const xpText = `Lv ${me.level}${me.level >= PROGRESSION.maxLevel ? ' MAX' : ''}${mult !== 1 ? ` · XP ×${mult}` : ''}`;
      this.set('xp', `${xpText}|${me.xpProgress}`, () => {
        this.$('#xp-fill').style.width = `${me.xpProgress * 100}%`;
        this.$('#xp-text').textContent = xpText;
      });
      this.set('xpVisible', inRound || phase === 'draft', (v) => { this.$('#xp-bar').hidden = !v; });

      this.set('ghostHint', ghost && phase === 'playing', (v) => {
        this.$('#ghost-hint').hidden = !v;
        document.body.classList.toggle('ghost-mode', v);
      });

      const ability = ACTIVES[me.ability];
      const abilIcon = ghost ? '🍌' : ability?.icon || '·';
      this.set('abil', `${abilIcon}|${ability?.name}`, () => {
        this.$('#btn-ability .icon').textContent = abilIcon;
        this.$('#btn-ability').title = ability ? `${ability.name}: ${ability.desc}` : '';
        this.$('#ability-name').textContent = ghost ? 'Drop banana' : ability?.name || '';
      });
      const abilCd = ghost ? (me.ghostReady ? 0 : 1) : me.abilCd;
      this.set('abilCd', abilCd, (v) => this.$('#btn-ability').style.setProperty('--cd', v));
      this.set('dashCd', ghost ? 0 : me.dashCd, (v) => this.$('#btn-dash').style.setProperty('--cd', v));
      this.set('dashIcon', ghost ? '👻' : '💨', (v) => { this.$('#btn-dash .icon').textContent = v; });

      // Ammo (section 6): tap it (or press R) to reload.
      const ammoText = ghost || !inRound ? '' : me.reload >= 0 ? '🔄 Reloading…' : `🔫 ${me.ammo}/${me.magazine}`;
      this.set('ammo', `${ammoText}|${me.reload >= 0 ? Math.round(me.reload * 20) : -1}`, () => {
        const btn = this.$('#ammo');
        btn.hidden = !ammoText;
        btn.textContent = ammoText;
        btn.classList.toggle('low', me.reload < 0 && me.ammo <= 2);
        btn.style.setProperty('--reload', me.reload >= 0 ? me.reload : 0);
      });

      const item = me.item ? PICKUPS[me.item] : null;
      this.set('item', me.item || '', () => {
        this.$('#btn-item .icon').textContent = item ? item.icon : '';
        this.$('#btn-item').classList.toggle('empty', !item);
        this.$('#item-name').textContent = item ? item.name : '';
      });
    }

    // Phase-driven overlays
    this.set('phase', phase, (ph) => {
      this.$('#draft').hidden = ph !== 'draft';
      this.$('#results').hidden = ph !== 'matchEnd' || !this.results;
      if (ph !== 'draft') this.offer = null;
    });
    if (phase === 'draft') this.updateDraft(view);
    if (phase === 'matchEnd' && this.results) this.$('#results').hidden = false;
    // Playing again alone makes no sense; the lobby is the way forward then.
    this.set('canAgain', this.h.isHost && view.players.length >= 2, (v) => { this.$('#results-again').hidden = !v; });
  }

  // ------------------------------------------------------------ draft

  showOffer(cards, skipped = false) {
    this.offer = cards.length ? cards : null;
    this.skipped = skipped;
    this.cache.draftKey = null;
  }

  updateDraft(view) {
    const me = view.me;
    const waiting = !this.offer || me?.picked;
    const key = `${waiting}|${this.offer?.join(',')}|${this.skipped}`;
    this.set('draftKey', key, () => {
      const box = this.$('#draft-cards');
      this.$('#draft-title').textContent = !waiting ? 'Pick one'
        : this.skipped ? '🏆 You won the round: no upgrade this time' : 'Waiting for others…';
      if (waiting) {
        box.replaceChildren(this.myBuild(view));
        return;
      }
      box.replaceChildren(...this.offer.map((card) => {
        const d = describeCard(card);
        const btn = el('button', `card ${card[0] === 'a' ? 'active' : 'passive'}`);
        btn.append(el('div', 'card-icon', d.icon), el('div', 'card-kind', d.kind), el('div', 'card-name', d.name), el('div', 'card-desc', d.desc));
        btn.addEventListener('click', () => {
          this.h.onPick(card);
          this.offer = null;
        });
        return btn;
      }));
    });
    this.set('draftTime', Math.ceil(view.phaseLeft), (v) => {
      this.$('#draft-timer').textContent = v > 0 ? `${v}s` : '';
    });
  }

  myBuild(view) {
    const wrap = el('div', 'build');
    const info = view.roster.get(view.myNum);
    const me = view.me;
    if (!me || !info) return wrap;
    const ability = ACTIVES[me.ability];
    wrap.append(el('div', 'build-title', 'Your build'));
    if (ability) wrap.append(el('div', 'build-row', `${ability.icon} ${ability.name}`));
    for (const [id, n] of Object.entries(info.passives || {})) {
      const p = PASSIVES[id];
      if (p) wrap.append(el('div', 'build-row', `${p.icon} ${p.name}${n > 1 ? ` ×${n}` : ''}`));
    }
    return wrap;
  }

  // ------------------------------------------------------------ results

  showResults(results, view) {
    this.results = results;
    const name = (num) => view.roster.get(num)?.name || '?';
    const teams = results.mode === 'teams';
    const winner = this.$('#results-winner');
    winner.textContent = teams && results.winnerTeam >= 0
      ? `🏆 ${TEAMS.names[results.winnerTeam]} TEAM wins! (${results.teamScores.join(' : ')})`
      : `🏆 ${name(results.winner)} wins!`;
    winner.style.color = teams && results.winnerTeam >= 0 ? TEAMS.colors[results.winnerTeam] : '';
    this.$('#results-reason').textContent = results.reason || '';
    this.$('#results-reason').hidden = !results.reason;
    this.$('#results-standings').replaceChildren(...results.standings.map((s, i) => {
      const row = el('div', 'standing');
      const who = el('span', 'grow', name(s.num));
      if (teams && s.team >= 0) who.style.color = TEAMS.colors[s.team];
      row.append(el('span', '', `${i + 1}.`), who, el('span', 'muted-level', `Lv ${s.level}`));
      if (!teams) row.append(el('b', '', String(s.score)));
      return row;
    }));
    this.$('#results-awards').replaceChildren(...results.awards.map((a) => {
      const row = el('div', 'award');
      row.append(el('div', 'award-icon', a.icon));
      const text = el('div', 'grow');
      text.append(el('div', 'award-title', `${a.title}: ${name(a.num)}`), el('div', 'award-text', a.text));
      row.append(text);
      return row;
    }));
    this.cache.canAgain = undefined;
    this.$('#results-lobby').hidden = !this.h.isHost;
    this.$('#results-wait').hidden = this.h.isHost;
    this.$('#results').hidden = false;
  }

  // Small, short message at the bottom; never covers the middle of the screen.
  toast(text) {
    const box = this.$('#toast');
    const div = el('div', 'toast', text);
    box.append(div);
    while (box.children.length > 2) box.firstChild.remove();
    setTimeout(() => div.remove(), 2600);
  }

  setPing(ms) {
    const el2 = this.$('#ping');
    el2.hidden = false;
    if (ms === 'host') { el2.textContent = 'HOST'; el2.className = 'hud-ping good'; return; }
    el2.textContent = `${ms} ms`;
    el2.className = `hud-ping ${ms < 80 ? 'good' : ms < 200 ? 'ok' : 'bad'}`;
  }

  setNotice(text) {
    this.set('notice', text, (v) => {
      this.$('#notice').textContent = v;
      this.$('#notice').hidden = !v;
    });
  }

  clearResults() {
    this.results = null;
    this.$('#results').hidden = true;
  }

  // ------------------------------------------------------------ messages

  announce(text, cls = '') {
    const box = this.$('#announce');
    const div = el('div', `announce ${cls}`, text);
    box.replaceChildren(div);
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => div.remove(), 1600);
  }

  // parts: array of strings or { text, color } (names get their colour).
  feed(parts) {
    const row = el('div', 'feed-row');
    for (const part of parts) {
      if (typeof part === 'string') row.append(document.createTextNode(part));
      else {
        const span = el('b', '', part.text);
        span.style.color = part.color;
        row.append(span);
      }
    }
    const box = this.$('#killfeed');
    box.prepend(row);
    while (box.children.length > 5) box.lastChild.remove();
    setTimeout(() => row.remove(), 5000);
  }

  destroy() {
    this.aborter.abort();
    clearTimeout(this.announceTimer);
    this.$('#announce').replaceChildren();
    document.body.classList.remove('ghost-mode');
  }
}
