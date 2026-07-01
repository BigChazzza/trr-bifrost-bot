import 'dotenv/config';
import { BifrostClient } from './bifrostClient.js';
import { openDb } from './db.js';
import { MatchTracker } from './matchTracker.js';
import { awardMatchEndVIPs, sweepExpiredVips } from './vipAwarder.js';
import { announceCurrentLeaders } from './announcer.js';

const POLL_INTERVAL_MS = 30 * 1000;
const ANNOUNCE_INTERVAL_MS = 15 * 60 * 1000;
const VIP_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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

  async function poll() {
    if (pollInFlight) {
      // Guard against overlapping runs if a previous poll is still awaiting
      // a 429 backoff sleep when the next tick fires.
      console.warn('[poll] previous poll still in flight, skipping this tick');
      return;
    }
    pollInFlight = true;
    try {
      const [playersResult, gameState] = await Promise.all([
        bifrost.getPlayers(),
        bifrost.getGameState(),
      ]);

      if (!playersResult) {
        console.warn('[poll] getPlayers returned no data this cycle');
        return;
      }

      const { transitioned, endedMatchEpoch, currentMatchEpoch, mapName } =
        matchTracker.processPoll(playersResult.players ?? [], gameState);

      console.log(
        `[poll] ${playersResult.totalCount ?? (playersResult.players ?? []).length} players, ` +
          `map=${mapName ?? 'unknown'}, matchEpoch=${currentMatchEpoch}` +
          (transitioned ? ` (transitioned from match ${endedMatchEpoch})` : '')
      );

      if (transitioned && endedMatchEpoch !== null) {
        await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch });
      }
    } catch (err) {
      console.error('[poll] unexpected error, will retry next tick:', err);
    } finally {
      pollInFlight = false;
    }
  }

  async function announce() {
    try {
      await announceCurrentLeaders({ db, bifrost });
    } catch (err) {
      console.error('[announce] unexpected error:', err);
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
