import { findTiedLeaders, formatStatsMessage } from './leaderboard.js';

/**
 * Announces the current (in-progress) match's leaders across all four
 * tracked categories - Killing Machine (kills), Having a day (deaths),
 * Rambo (combat score), Brick wall (defense score) - in one combined
 * message, signed "-BigChazzza Bot". No-ops quietly if there's no current
 * match or nobody has any stats recorded yet.
 */
export async function announceCurrentLeaders({ db, bifrost }) {
  const currentMatchEpoch = db.getCurrentMatchEpoch();
  if (currentMatchEpoch === null) {
    console.log('[announce] no current match tracked yet, skipping announcement');
    return;
  }

  const deltas = db.getMatchDeltas(currentMatchEpoch);
  const killLeaders = findTiedLeaders(deltas, 'kills');
  const deathLeaders = findTiedLeaders(deltas, 'deaths');
  const combatLeaders = findTiedLeaders(deltas, 'combatScore');
  const defenseLeaders = findTiedLeaders(deltas, 'defenseScore');

  const message = formatStatsMessage({ killLeaders, deathLeaders, combatLeaders, defenseLeaders });
  if (!message) {
    console.log('[announce] no stats recorded yet this match, skipping announcement');
    return;
  }

  const result = await bifrost.sendMessageToAll(message);
  if (result?.success) {
    console.log(`[announce] sent: "${message}" (notified ${result.playersNotified} players)`);
  } else {
    console.error('[announce] failed to send announcement:', JSON.stringify(result));
  }
}
