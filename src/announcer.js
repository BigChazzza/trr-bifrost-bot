import { findTiedLeaders, formatMurderMachineMessage } from './leaderboard.js';

/**
 * Announces the current (in-progress) match's kill leader(s) ("Murder
 * Machine") and death leader(s) ("Wooden Spoon") in-game, in one combined
 * message. No-ops quietly if there's no current match or nobody has any
 * kills/deaths recorded yet.
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

  const message = formatMurderMachineMessage(killLeaders, deathLeaders);
  if (!message) {
    console.log('[announce] no kills or deaths recorded yet this match, skipping announcement');
    return;
  }

  const result = await bifrost.sendMessageToAll(message);
  if (result?.success) {
    console.log(`[announce] sent: "${message}" (notified ${result.playersNotified} players)`);
  } else {
    console.error('[announce] failed to send announcement:', JSON.stringify(result));
  }
}
