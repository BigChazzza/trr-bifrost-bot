import 'dotenv/config';
import { BifrostClient } from './bifrostClient.js';
import { openDb } from './db.js';
import { MatchTracker } from './matchTracker.js';
import { awardMatchEndVIPs, sweepExpiredVips } from './vipAwarder.js';
import { announceCurrentLeaders } from './announcer.js';
import { getMilestonesToNotify } from './killMilestones.js';

const POLL_INTERVAL_MS = 30 * 1000;
const ANNOUNCE_INTERVAL_MS = 30 * 60 * 1000;
const VIP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// When the server is empty (0 players), slow the effective poll rate to
// this interval by skipping most 30s ticks. Normal polling and
// announcements resume automatically once player count hits the threshold.
const EMPTY_SERVER_POLL_INTERVAL_MS = 5 * 60 * 1000;
const ANNOUNCE_RESUME_PLAYER_THRESHOLD = 5;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function maskSecret(value) {
  if (!value) return '(missing)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function main() {
  const clientId = requireEnv('BIFROST_CLIENT_ID');
  const clientSecret = requireEnv('BIFROST_CLIENT_SECRET');
  const serverId = requireEnv('BIFROST_SERVER_ID');
  const dbPath = process.env.DB_PATH || './trr-bot.db';

  console.log('TRR Bifrost stats bot starting up');
  console.log(`  client_id: ${maskSecret(clientId)}`);
  console.log(`  server_id: ${serverId}`);
  console.log(`  db_path:   ${dbPath}`);

  const db = openDb(dbPath);
  const bifrost = new BifrostClient({ clientId, clientSecret, serverId });
  const matchTracker = new MatchTracker(db);

  let pollInFlight = false;
  // Tracks the player count from the last successful poll. null = not yet
  // polled. Used to throttle polling when the server is empty and to
  // suppress announcements when below the resume threshold.
  let lastKnownPlayerCount = null;
  let lastActualPollTime = 0; // epoch ms of the last time we made real API calls

  async function poll() {
    if (pollInFlight) {
      // Guard against overlapping runs if a previous poll is still awaiting
      // a 429 backoff sleep when the next tick fires.
      console.warn('[poll] previous poll still in flight, skipping this tick');
      return;
    }

    // When the server is empty, throttle to 5-minute effective intervals
    // by skipping most 30s ticks. We still let the very first poll through
    // (lastKnownPlayerCount === null) and resume normal rate the moment
    // any player joins (lastKnownPlayerCount > 0).
    if (lastKnownPlayerCount === 0 && Date.now() - lastActualPollTime < EMPTY_SERVER_POLL_INTERVAL_MS) {
      return;
    }

    pollInFlight = true;
    try {
      lastActualPollTime = Date.now();

      const [playersResult, gameState] = await Promise.all([
        bifrost.getPlayers(),
        bifrost.getGameState(),
      ]);

      if (!playersResult) {
        console.warn('[poll] getPlayers returned no data this cycle');
        return;
      }

      const playerCount = playersResult.totalCount ?? (playersResult.players ?? []).length;
      const wasEmpty = lastKnownPlayerCount === 0;
      lastKnownPlayerCount = playerCount;

      if (playerCount === 0 && !wasEmpty) {
        console.log('[poll] server is now empty - switching to 5-minute poll interval');
      } else if (playerCount > 0 && wasEmpty) {
        console.log(`[poll] server has players again (${playerCount}) - resuming 30-second poll interval`);
      }

      const { transitioned, endedMatchEpoch, currentMatchEpoch, mapName, matchTimeExpired } =
        matchTracker.processPoll(playersResult.players ?? [], gameState);

      console.log(
        `[poll] ${playerCount} players, map=${mapName ?? 'unknown'}, matchEpoch=${currentMatchEpoch}` +
          (transitioned ? ` (transitioned from match ${endedMatchEpoch})` : '') +
          (matchTimeExpired ? ' (match clock hit 0)' : '')
      );

      if (matchTimeExpired) {
        // Clock hit 0: award VIP now, at actual match end. Mark the epoch so
        // the subsequent map-change transition doesn't double-send awards.
        console.log(`[vip] match ${currentMatchEpoch} clock expired, awarding VIP now`);
        await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch: currentMatchEpoch });
        db.setMatchAwardsGranted(currentMatchEpoch);
      } else if (transitioned && endedMatchEpoch !== null) {
        // Map changed (or clock jumped): fall back to transition-based awards.
        // Skip if time-expiry already fired them (common path after a normal match).
        if (db.getMatchAwardsGranted(endedMatchEpoch)) {
          console.log(`[vip] match ${endedMatchEpoch} awards already sent at time-expiry, skipping`);
        } else {
          await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch });
          db.setMatchAwardsGranted(endedMatchEpoch);
        }
      }

      await checkKillMilestones(currentMatchEpoch);
    } catch (err) {
      console.error('[poll] unexpected error, will retry next tick:', err);
    } finally {
      pollInFlight = false;
    }
  }

  async function announce() {
    // Suppress announcements until the server has enough players to make
    // them meaningful. Also covers the empty-server throttle case.
    if (lastKnownPlayerCount !== null && lastKnownPlayerCount < ANNOUNCE_RESUME_PLAYER_THRESHOLD) {
      return;
    }
    try {
      await announceCurrentLeaders({ db, bifrost });
    } catch (err) {
      console.error('[announce] unexpected error:', err);
    }
  }

  async function checkKillMilestones(matchEpoch) {
    try {
      const players = db.getPlayersForMilestoneCheck(matchEpoch);
      for (const player of players) {
        const milestones = getMilestonesToNotify(player.notifiedKillMilestone, player.kills);
        if (!milestones.length) continue;

        for (const milestone of milestones) {
          const result = await bifrost.messagePlayer(player.playerId, player.playerName, milestone.message);
          if (result?.success) {
            console.log(`[milestones] sent ${milestone.kills}-kill message to ${player.playerName}`);
          } else {
            console.error(`[milestones] failed to message ${player.playerName} for ${milestone.kills} kills:`, JSON.stringify(result));
          }
        }

        const highest = milestones[milestones.length - 1].kills;
        db.setNotifiedMilestone(matchEpoch, player.playerId, highest);
      }
    } catch (err) {
      console.error('[milestones] unexpected error:', err);
    }
  }

  async function sweep() {
    try {
      await sweepExpiredVips({ db, bifrost });
    } catch (err) {
      console.error('[vip-sweep] unexpected error:', err);
    }
  }

  const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  const announceTimer = setInterval(announce, ANNOUNCE_INTERVAL_MS);
  const sweepTimer = setInterval(sweep, VIP_SWEEP_INTERVAL_MS);

  // Kick off an immediate first poll rather than waiting 30s for the first tick.
  await poll();

  function shutdown(signal) {
    console.log(`Received ${signal}, shutting down cleanly`);
    clearInterval(pollTimer);
    clearInterval(announceTimer);
    clearInterval(sweepTimer);
    db.close();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
