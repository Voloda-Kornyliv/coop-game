# Blast Party

A top-down party shooter where every player is against everyone else, for 2–8 friends in the same room. Everyone plays in the browser on their own phone or laptop. One device creates a game and gets a code. Others join with the code. The last player standing wins the round, and between rounds everyone drafts upgrades that stack.

It runs entirely on GitHub Pages and needs no backend: players connect browser-to-browser through [PeerJS](https://peerjs.com/) (WebRTC). See [GAME_DESIGN.txt](GAME_DESIGN.txt) for the full design.

## Run locally

ES modules need an HTTP server (opening the file directly won't work):

```sh
python3 -m http.server 8000
# open http://localhost:8000 in two tabs or on two devices on the same network
```

## How it works

- **The host's device runs the game.** It runs the only real simulation, at a fixed 60 steps per second. The other devices only send their controls and draw what the host sends back, and the host checks every incoming message before using it.
- **Snapshots:** the host sends a compact snapshot of the game 30 times per second. Each device draws the world about 80 ms in the past, smoothly in between snapshots, so movement looks smooth even on an uneven connection. Your own aim is drawn from your local input straight away.
- **Button presses are counters,** not on/off flags, so a press is never lost or counted twice.
- **The host's own client** receives exactly the same messages as remote players, so there is only one code path to debug.

```
index.html, style.css
js/main.js            menu, lobby, starting and stopping the game
js/net.js             PeerJS host/guest sessions, heartbeats, JSON messages
js/game/config.js     every gameplay tunable
js/game/abilities.js  abilities, upgrades, pickups, projectiles and props, as data
js/game/maps.js       arena layouts, as data
js/game/sim.js        the authoritative simulation (host only, no DOM)
js/game/protocol.js   the wire format: snapshot encode/decode, input messages
js/game/host.js       fixed-step loop on the host; sends out snapshots
js/game/client.js     runs on every device: input, smoothing, events to effects
js/game/render.js     canvas drawing and particles
js/game/input.js      touch joysticks, keyboard and mouse
js/game/ui.js         HUD, draft cards, results screen
js/game/audio.js      sound effects synthesized with Web Audio
```

To add an ability, add an entry to `ACTIVES` in `abilities.js`, and a projectile or prop next to it if it needs one. Nothing else has to change.
