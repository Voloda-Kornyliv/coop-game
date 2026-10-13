// DOM HUD and overlays. Player names always go through textContent, never
// innerHTML, because they come from other people's devices.

import { ACTIVES, PICKUPS, PASSIVES, describeCard } from './abilities.js';

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
    const scoreKey = view.players.map((p) => `${p.num}:${p.score}:${p.crown}:${p.alive}:${p.picked}`).join('|') + phase;
    this.set('scores', scoreKey, () => {
      const box = this.$('#scores');
      box.replaceChildren(...view.players.map((p) => {
        const info = view.roster.get(p.num);
        const chip = el('div', `chip${p.alive ? '' : ' out'}${p.num === view.myNum ? ' me' : ''}`);
        const dot = el('span', 'dot');
        dot.style.background = info?.color || '#888';
        chip.append(dot, el('span', 'name', info?.name || '?'), el('b', '', String(p.score)));
        if (p.crown) chip.append(el('span', '', '👑'));
        if (phase === 'draft' && p.picked) chip.append(el('span', '', '✓'));
        return chip;
      }));
    });

    // Round info
    let info = '';
    if (phase === 'playing' || phase === 'roundEnd') {
      info = `Round ${view.round} · ${view.map.name} · ${fmtTime(view.roundTime)}`;
      if (view.zone) info += ' · ⚠️ zone closing';
    } else if (phase === 'countdown') info = `Round ${view.round} · ${view.map.name}`;
    else if (phase === 'draft') info = 'Draft';
    this.set('info', info, (v) => { this.$('#round-info').textContent = v; });

    // Own status
    if (me) {
      // Between rounds everyone is technically a ghost; only show ghost UI in a round.
      const inRound = phase === 'playing' || phase === 'roundEnd' || phase === 'countdown';
      const ghost = me.ghost && inRound;
      this.set('hpVisible', inRound, (v) => { this.$('#hp-bar').hidden = !v; });
      const hpText = ghost ? '👻 Ghost' : `${me.hp} / ${me.maxHp}`;
      this.set('hp', `${me.hp}/${me.maxHp}/${ghost}`, () => {
        this.$('#hp-fill').style.width = ghost ? '0%' : `${Math.max(0, (me.hp / me.maxHp) * 100)}%`;
        this.$('#hp-text').textContent = hpText;
      });
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
  }

  // ------------------------------------------------------------ draft

  showOffer(cards) {
    this.offer = cards;
    this.cache.draftKey = null;
  }

  updateDraft(view) {
    const me = view.me;
    const waiting = !this.offer || me?.picked;
    const key = `${waiting}|${this.offer?.join(',')}`;
    this.set('draftKey', key, () => {
      const box = this.$('#draft-cards');
      this.$('#draft-title').textContent = waiting ? 'Waiting for others…' : 'Pick one';
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
    this.$('#results-winner').textContent = `🏆 ${name(results.winner)} wins!`;
    this.$('#results-standings').replaceChildren(...results.standings.map((s, i) => {
      const row = el('div', 'standing');
      row.append(el('span', '', `${i + 1}.`), el('span', 'grow', name(s.num)), el('b', '', String(s.score)));
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
    this.$('#results-again').hidden = !this.h.isHost;
    this.$('#results-wait').hidden = this.h.isHost;
    this.$('#results').hidden = false;
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
