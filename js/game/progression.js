// XP, levels and the catch-up rules (GAME_DESIGN.txt sections 7 and 12).
// Pure functions of the simulation state, so the rules are easy to read and
// tune in one place.

import { PROGRESSION as P } from './config.js';

// Total XP needed to REACH a level (level 1 = 0 XP).
export function xpToReach(level) {
  let total = 0;
  for (let n = 1; n < level; n++) total += P.xpBase + P.xpPerLevel * n;
  return total;
}

export function levelForXp(xp) {
  let level = 1;
  while (level < P.maxLevel && xp >= xpToReach(level + 1)) level++;
  return level;
}

// 0..1 progress toward the next level.
export function levelProgress(xp, level) {
  if (level >= P.maxLevel) return 1;
  const lo = xpToReach(level), hi = xpToReach(level + 1);
  return Math.min(1, Math.max(0, (xp - lo) / (hi - lo)));
}

// Scores are per player in free-for-all and per team in Team mode (players
// carry their team's score), so the same rules work for both.
function scoreRange(sim) {
  let max = -Infinity, min = Infinity;
  const counts = new Map();
  for (const p of sim.players.values()) {
    max = Math.max(max, p.score);
    min = Math.min(min, p.score);
    const key = sim.isTeams ? `t${p.team}` : p.id;
    counts.set(key, p.score);
  }
  const leaders = [...counts.values()].filter((s) => s === max).length;
  return { max, min, leaders };
}

// The leader: alone at the top with at least one win.
export function isLeader(sim, p) {
  const { max, leaders } = scoreRange(sim);
  return max > 0 && leaders === 1 && p.score === max;
}

// Underdogs: the fewest wins, when not everyone is tied.
export function isUnderdog(sim, p) {
  const { max, min } = scoreRange(sim);
  return min < max && p.score === min;
}

export function xpMultiplier(sim, p) {
  if (isLeader(sim, p)) return P.leaderXp;
  if (isUnderdog(sim, p)) return P.underdogXp;
  return 1;
}

// Draft cards (section 8): round winners skip, the leader gets fewer, the
// underdogs get more.
export function cardCount(sim, p, firstDraft, roundWinners) {
  if (firstDraft) return 3;
  if (roundWinners.has(p.id)) return 0;
  if (isLeader(sim, p)) return 2;
  if (isUnderdog(sim, p)) return 4;
  return 3;
}

// Knocking out the crown holder pays more the longer their streak is.
export function bountyXp(victim) {
  return P.xp.bounty + P.xp.bountyPerStreak * Math.max(0, (victim.streak || 0) - 1);
}

// Nobody falls more than maxLevelGap levels behind the top player.
export function levelCatchUp(sim) {
  let top = 1;
  for (const p of sim.players.values()) top = Math.max(top, p.level);
  const floor = top - P.maxLevelGap;
  const raised = [];
  for (const p of sim.players.values()) {
    if (p.level < floor) {
      p.level = floor;
      p.xp = xpToReach(floor);
      raised.push(p);
    }
  }
  return raised;
}
