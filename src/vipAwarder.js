import { findTiedLeaders, formatLeaderMessage } from './leaderboard.js';

const VIP_DURATION_DAYS = 7;

/**
 * Awards 7-day VIP to all players tied for most kills, and separately to
 * all players tied for most deaths, for the given (just-ended) match epoch.
 * Skips a category entirely if its max value is 0 (no meaningful winner).
 * Sends one in-game announcement summarizing the awards.
 */
export async function awardMatchEndVIPs({ db, bifrost, endedMatchEpoch }) {
  const deltas = db.getMatchDeltas(endedMatchEpoch);
  if (!deltas.length) {
    console.log(`[vip] match ${endedMatchEpoch} had no tracked players, skipping awards`);
    return;
  }

  const expiresAt = new Date(Date.now() + VIP_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const killLeaders = findTiedLeaders(deltas, 'kills');
  const deathLeaders = findTiedLeaders(deltas, 'deaths');

  const announcements = [];

  for (const leader of killLeaders) {
    const result = await bifrost.addVip(leader.playerId, leader.playerName);
    if (result?.success) {
      db.recordVipGrant(leader.playerId, leader.playerName, 'most_kills', endedMatchEpoch, expiresAt);
      console.log(`[vip] granted 7-day VIP to ${leader.playerName} (most kills: ${leader.kills})`);
    } else {
      console.error(`[vip] failed to grant VIP to ${leader.playerName} for most kills:`, result?.message);
    }
  }

  for (const leader of deathLeaders) {
    const result = await bifrost.addVip(leader.playerId, leader.playerName);
    if (result?.success) {
      db.recordVipGrant(leader.playerId, leader.playerName, 'most_deaths', endedMatchEpoch, expiresAt);
      console.log(`[vip] granted 7-day VIP to ${leader.playerName} (most deaths: ${leader.deaths})`);
    } else {
      console.error(`[vip] failed to grant VIP to ${leader.playerName} for most deaths:`, result?.message);
    }
  }

  if (killLeaders.length) {
    const msg = formatLeaderMessage(killLeaders, 'kills', killLeaders[0].kills);
    if (msg) announcements.push(`Match MVP - ${msg} - 7 days VIP awarded!`);
  }
  if (deathLeaders.length) {
    const msg = formatLeaderMessage(deathLeaders, 'deaths', deathLeaders[0].deaths);
    if (msg) announcements.push(`Most Deaths - ${msg} - 7 days VIP awarded!`);
  }

  for (const announcement of announcements) {
    // 200-char cap is enforced by formatLeaderMessage already; the "Match
    // MVP - "/"Most Deaths - " prefix is short and always leaves headroom
    // since formatLeaderMessage trims to 200 minus nothing - guard anyway.
    const safeMessage = announcement.length > 200 ? announcement.slice(0, 200) : announcement;
    await bifrost.sendMessageToAll(safeMessage);
  }
}

/**
 * Revokes VIP for any grant whose expiry has passed and hasn't been
 * revoked yet. Intended to run on an hourly interval.
 */
export async function sweepExpiredVips({ db, bifrost }) {
  const nowIso = new Date().toISOString();
  const expired = db.getExpiredUnrevokedVips(nowIso);

  for (const grant of expired) {
    const result = await bifrost.removeVip(grant.player_id);
    if (result?.success) {
      db.markVipRevoked(grant.id);
      console.log(`[vip] revoked expired VIP for ${grant.player_name} (reason: ${grant.reason})`);
    } else {
      // Leave it unrevoked so the next hourly sweep retries; log for visibility.
      console.error(`[vip] failed to revoke expired VIP for ${grant.player_name}:`, result?.message);
    }
  }
}
