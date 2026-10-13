// Host-side driver: runs the Simulation at a fixed rate and ships its output.
// The host's own GameClient is fed through exactly the same messages as remote
// players (minus the network), so there is a single code path to debug.

import { TICK_DT, SNAPSHOT_EVERY } from './config.js';
import { Simulation } from './sim.js';
import { encodeSnapshot, encodeRoster } from './protocol.js';

const MAX_CATCHUP = 0.25;   // seconds; after a long stall we drop time instead of fast-forwarding

export class HostGame {
  constructor({ session, settings }) {
    this.session = session;
    this.sim = new Simulation(settings);
    this.local = null;          // the host's own GameClient
  }

  start(localClient) {
    this.local = localClient;
    for (const p of this.session.players) this.sim.addPlayer(p);
    this.sim.startMatch();
    this.last = performance.now();
    this.acc = 0;
    // setInterval (not rAF) so the simulation keeps running even when the
    // host's canvas isn't being drawn.
    this.timer = setInterval(() => this.loop(), 8);
  }

  loop() {
    const now = performance.now();
    this.acc += Math.min(MAX_CATCHUP, (now - this.last) / 1000);
    this.last = now;
    while (this.acc >= TICK_DT) {
      this.acc -= TICK_DT;
      this.sim.step();
      if (this.sim.tick % SNAPSHOT_EVERY === 0) this.flush();
    }
  }

  flush() {
    const sim = this.sim;
    if (sim.rosterDirty) {
      sim.rosterDirty = false;
      this.toAll(encodeRoster(sim));
    }
    for (const { to, msg } of sim.outbox.splice(0)) {
      if (to === '*') this.toAll(msg);
      else if (to === this.session.id) this.local?.handle(msg);
      else this.session.send(to, msg);
    }
    this.toAll(encodeSnapshot(sim, sim.drainEvents()), true);
  }

  toAll(msg, droppable = false) {
    this.session.broadcast(msg, { droppable });
    this.local?.handle(msg);
  }

  // Messages from any player, including the host's own client.
  onMessage(peerId, msg) {
    if (msg.type === 'in') this.sim.setInput(peerId, msg);
    else if (msg.type === 'pick') this.sim.handlePick(peerId, String(msg.card));
  }

  playerJoined(player) {
    this.session.send(player.id, { type: 'game-start' });
    this.sim.addPlayer(player);
  }

  playerLeft(id) {
    this.sim.removePlayer(id);
  }

  restart() {
    this.sim.startMatch();
  }

  stop() {
    clearInterval(this.timer);
  }
}
