# Blast Party: rules for Claude

Blast Party is a browser party shooter on GitHub Pages: plain ES modules, no build step, peer-to-peer through PeerJS.

## The design doc is the source of truth

[GAME_DESIGN.txt](GAME_DESIGN.txt) describes how the game should work.

1. **Update the design before the code.** For any change to gameplay, rules, balance, maps, UI, controls or networking, first edit GAME_DESIGN.txt to describe the new behaviour. Only then implement it. If the user asks for a change that the design doesn't cover, or that contradicts it, update the design first and tell the user what you changed there.
2. **Read the relevant sections before implementing,** and follow them, including the exact numbers. If something in the design turns out to be wrong or impossible while you build it, fix the design to match what you actually did and say so. Never let the code and the design quietly drift apart.
3. **Keep the status current.** When a feature is done, tick it off in section 16 ("Implementation status and build plan") and move it from NEXT to BUILT.
4. **Record decisions.** When the user answers an open question, move it to DECIDED in section 17.
5. **Bump the design version** (the "v0.N" line in the header) and add a short "Changes in v0.N" list when the design changes meaningfully.

If the user says "only change the design file", change nothing else.

## Versioning

Every commit must increase the version in the home screen title in `index.html` (`<h1>Blast Party v0.N</h1>`) by one: v0.2, v0.3, v0.4, and so on. This lets players check that their device loaded the latest deploy.

That title is the only place the version is written. The loader script at the bottom of `index.html` reads it, loads every module with `?v0.N` attached (cache-busting), and exposes it as `VERSION` for the join handshake. **When you add a new `.js` file, add it to `MODULES` in that loader.**

## Architecture rules (see GAME_DESIGN.txt section 15)

- **The host runs the game.** `js/game/sim.js` runs only on the host, never touches the DOM or the network, and checks every input it receives. Clients only send input and draw snapshots.
- **One wire format.** All network message shapes live in `js/game/protocol.js`.
- **Numbers live in config.** Gameplay numbers go in `js/game/config.js`, never inline.
- **Content is data.** Abilities, upgrades, pickups, maps and arena objects are data tables plus small behaviour functions. Add content there, not in the main loop.
- **Player names are untrusted.** Show them with `textContent`, never `innerHTML`.
- **Wrap browser storage.** Wrap `localStorage` and `sessionStorage` access in try/catch.

## Testing before you say it's done

- **Syntax check** every module with JavaScriptCore (`node` isn't installed here):
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -e "checkModuleSyntax('js/game/sim.js')"`
- **Headless simulation run** with bots (`jsc -m <script>.mjs` that imports `js/game/sim.js`) for gameplay logic: no exceptions, no NaN positions, snapshots encode and decode.
- **Real-browser test** for UI or networking changes: headless Chrome with two iframes connected through PeerJS. Look at the screenshots.
- **Report results honestly,** including anything that wasn't tested on real phones.

## Git

- The remote is `Voloda-Kornyliv/coop-game` (GitHub Pages deploys from `main`). The active `gh` account must be Voloda-Kornyliv.
- Commit or push only when the user asks.
