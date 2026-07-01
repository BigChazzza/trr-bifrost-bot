import { findTiedLeaders, formatStatsMessage } from './leaderboard.js';

const VIP_DURATION_DAYS = 7;

const CATEGORIES = [
  { statKey: 'kills', reason: 'most_kills' },
  { statKey: 'deaths', reason: 'most_deaths' },
  { statKey: 'combatScore', reason: 'most_combat_score' },
  { statKey: 'defenseScore', reason: 'most_defense_score' },
];

/**
 * Decides whether a VIP grant should be treated as "preexisting" (bot must
 * never auto-revoke) and returns the resulting {preexisting, expiresAt} to
 * persist. The decision is made ONCE per player, the first time they're
 * ever considered for an award:
 *   - No prior vip_status row + isVip already true at award time -> this
 *     player had VIP before the bot ever touched them (e.g. an existing
 *     clan member). Mark preexisting=true permanently; no expiry tracked.
 *   - No prior vip_status row + isVip false -> bot-granted, 7-day expiry.
 * On any LATER win, the existing vip_status row's `preexisting` value is
 * trusted as-is rather than re-derived from the live isVip flag - by then
 * isVip will read true simply because the bot granted it earlier, and
 * re-deriving from that would incorrectly relabel a bot-managed grant as
 * preexisting (permanently protecting VIP that should still expire), or
 * conversely reset a genuinely-preexisting player's status. Repeat wins
 * for a non-preexisting player simply refresh/extend their expiry.
 */
function resolveVipStatusForAward(db, leader) {
  const existing = db.getVipStatus(leader.playerId);
  const nowExpiresAt = new Date(Date.now() + VIP_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  if (!existing) {
    if (leader.isVip) {
      return { preexisting: true, expiresAt: null, isNewPreexisting: true };
    }
    return { preexisting: false, expiresAt: nowExpiresAt, isNewPreexisting: false };
  }

  if (existing.preexisting === 1) {
    // Always was, always will be someone else's VIP to manage.
    return { preexisting: true, expiresAt: null, isNewPreexisting: false };
  }

  // Bot-managed player winning again: refresh the 7-day clock, un-revoke if
  // it had already been swept (a fresh win re-earns VIP).
  return { preexisting: false, expiresAt: nowExpiresAt, isNewPreexisting: false };
}

/**
 * Awards 7-day VIP to every player tied for the top spot in each of the
 * four tracked categories (kills, deaths, combat score, defense score) for
 * the given (just-ended) match epoch. Skips a category entirely if its max
 * value is 0 (no meaningful winner). Players who already had VIP before
 * the bot's involvement are still announced as winners (and addVip is
 * still called, harmlessly), but are flagged so the hourly sweep never
 * revokes VIP the bot didn't grant. Sends one "Congratulations!" in-game
 * announcement summarizing the awards in the same 4-line format used by
 * the 15-minute leaderboard announcement.
 */
export async function awardMatchEndVIPs({ db, bifrost, endedMatchEpoch }) {
  const deltas = db.getMatchDeltas(endedMatchEpoch);
  if (!deltas.length) {
    console.log(`[vip] match ${endedMatchEpoch} had no tracked players, skipping awards`);
    return;
  }

  const leadersByCategory = {};
  for (const { statKey, reason } of CATEGORIES) {
    leadersByCategory[reason] = findTiedLeaders(deltas, statKey);
  }

  async function grant(leader, reason) {
    const { preexisting, expiresAt, isNewPreexisting } = resolveVipStatusForAward(db, leader);

    const result = await bifrost.addVip(leader.playerId, leader.playerName);
    if (!result?.success) {
      console.error(`[vip] failed to grant VIP to ${leader.playerName} for ${reason}:`, JSON.stringify(result));
      return;
    }

    db.upsertVipStatus(leader.playerId, leader.playerName, { preexisting, expiresAt, revoked: false });
    db.recordVipGrant(leader.playerId, leader.playerName, reason, endedMatchEpoch, expiresAt, preexisting);

    if (isNewPreexisting) {
      console.log(`[vip] ${leader.playerName} already had VIP (${reason}) - will NOT be auto-revoked`);
    } else if (preexisting) {
      console.log(`[vip] ${leader.playerName} won again (${reason}) - still protected as preexisting VIP`);
    } else {
      console.log(`[vip] granted/renewed 7-day VIP to ${leader.playerName} (${reason})`);
    }
  }

  for (const { reason } of CATEGORIES) {
    for (const leader of leadersByCategory[reason]) {
      await grant(leader, reason);
    }
  }

  const hasAnyWinner = CATEGORIES.some(({ reason }) => leadersByCategory[reason].length > 0);
  if (!hasAnyWinner) {
    // Nothing to congratulate anyone for (e.g. a match that ended almost
    // immediately after the bot started tracking it, before anyone racked
    // up a single kill/death/combat/defense point). Without this guard,
    // formatStatsMessage would still render the header alone - a hollow
    // "Congratulations! You've won yourselves 7-day VIP!" with no names -
    // which is exactly the "VIP info shown with no actual winners" bug
    // this check exists to prevent. Never send VIP-related text unless
    // there's a real winner to announce.
    console.log(`[vip] match ${endedMatchEpoch} had no winners in any category, skipping VIP announcement`);
    return;
  }

  const message = formatStatsMessage({
    header: 'Congratulations! You’ve won yourselves 7-day VIP!',
    killLeaders: leadersByCategory.most_kills,
    deathLeaders: leadersByCategory.most_deaths,
    combatLeaders: leadersByCategory.most_combat_score,
    defenseLeaders: leadersByCategory.most_defense_score,
  });

  if (message) {
    await bifrost.sendMessageToAll(message);
  }
}

/**
 * Revokes VIP for any BOT-MANAGED (non-preexisting) grant whose expiry has
 * passed and hasn't been revoked yet. Players who already had VIP before
 * the bot ever granted it are never touched here, by construction -
 * getExpiredManagedVips() only returns preexisting=0 rows. Intended to run
 * on an hourly interval.
 */
export async function sweepExpiredVips({ db, bifrost }) {
  const nowIso = new Date().toISOString();
  const expired = db.getExpiredManagedVips(nowIso);

  for (const status of expired) {
    const result = await bifrost.removeVip(status.player_id);
    if (result?.success) {
      db.markVipStatusRevoked(status.player_id);
      console.log(`[vip] revoked expired bot-granted VIP for ${status.player_name}`);
    } else {
      // Leave it unrevoked so the next hourly sweep retries; log for visibility.
      console.error(`[vip] failed to revoke expired VIP for ${status.player_name}:`, JSON.stringify(result));
    }
  }
}
