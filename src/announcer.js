import { findTiedLeaders, formatLeaderMessage } from './leaderboard.js';

/**
 * Announces the current (in-progress) match's kill leader(s) in-game.
 * No-ops quietly if there's no current match or nobody has any kills yet.
 */
export async function announceCurrentLeaders({ db, bifrost }) {
  const currentMatchEpoch = db.getCurrentMatchEpoch();
  if (currentMatchEpoch === null) {
    console.log('[announce] no current match tracked yet, skipping announcement');
    return;
  }

  const deltas = db.getMatchDeltas(currentMatchEpoch);
  const leaders = findTiedLeaders(deltas, 'kills');

  if (!leaders.length) {
    console.log('[announce] no kills recorded yet this match, skipping announcement');
    return;
  }

  const message = formatLeaderMessage(leaders, 'kills', leaders[0].kills);
  if (!message) return;

  const result = await bifrost.sendMessageToAll(message);
  if (result?.success) {
    console.log(`[announce] sent: "${message}" (notified ${result.playersNotified} players)`);
  } else {
    console.error('[announce] failed to send announcement:', result?.message ?? result?.error);
  }
}
