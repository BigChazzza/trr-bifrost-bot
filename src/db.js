import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  match_epoch INTEGER PRIMARY KEY AUTOINCREMENT,
  map_name TEXT,
  started_at TEXT NOT NULL,
  awards_granted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_match_stats (
  match_epoch INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  baseline_kills INTEGER NOT NULL,
  baseline_deaths INTEGER NOT NULL,
  last_kills INTEGER NOT NULL,
  last_deaths INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  baseline_combat_score INTEGER NOT NULL DEFAULT 0,
  baseline_defense_score INTEGER NOT NULL DEFAULT 0,
  last_combat_score INTEGER NOT NULL DEFAULT 0,
  last_defense_score INTEGER NOT NULL DEFAULT 0,
  notified_kill_milestone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_epoch, player_id)
);

-- Append-only audit log: one row per award EVENT (match win), kept purely
-- for history/debugging. Revocation decisions are driven by vip_status
-- below, not this table - a player can appear here many times. No CHECK
-- constraint on the reason column (deliberately) so new award categories
-- can be added later without a schema migration - validated in JS instead.
CREATE TABLE IF NOT EXISTS vip_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  match_epoch INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  preexisting INTEGER NOT NULL DEFAULT 0
);

-- Single row per player: the source of truth for whether the bot is
-- allowed to auto-revoke this player's VIP. "preexisting" is decided ONCE,
-- the first time this player is ever considered for an award - if they
-- already had VIP at that moment (independent of anything the bot has
-- done), it's permanently preexisting and never auto-revoked. Repeat wins
-- after that just extend expires_at for non-preexisting players.
CREATE TABLE IF NOT EXISTS vip_status (
  player_id TEXT PRIMARY KEY,
  player_name TEXT NOT NULL,
  preexisting INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * Adds a column to an existing table if it doesn't already exist. Safe to
 * call on every startup - SQLite throws "duplicate column name"
 * (ERR_SQLITE_ERROR) if the column is already there, which we swallow.
 * Needed because CREATE TABLE IF NOT EXISTS does nothing for tables that
 * already exist from a prior deploy (e.g. is_vip was added after the bot
 * was already running in production on Render).
 */
function addColumnIfMissing(db, table, columnDefSql, columnName) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefSql}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column name')) {
      throw new Error(`Failed to migrate ${table}.${columnName}: ${err.message}`);
    }
  }
}

/**
 * SQLite can't ALTER TABLE to drop/widen a CHECK constraint - the only way
 * is to recreate the table without it and copy the data across. This is
 * needed because vip_grants.reason originally had
 * `CHECK (reason IN ('most_kills', 'most_deaths'))`, which would reject the
 * new 'most_combat_score'/'most_defense_score' award categories on any
 * database created before this change (e.g. the already-running Render
 * deployment). Safe/idempotent: only runs the recreate if the CHECK is
 * still present in the table's stored SQL.
 */
function dropVipGrantsReasonCheckIfPresent(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='vip_grants'").get();
  if (!row || !row.sql.includes('CHECK')) return; // already migrated, or fresh DB using the CHECK-free SCHEMA above

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE vip_grants_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT NOT NULL,
        player_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        match_epoch INTEGER NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT,
        preexisting INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      INSERT INTO vip_grants_migrated
        (id, player_id, player_name, reason, match_epoch, granted_at, expires_at, preexisting)
      SELECT id, player_id, player_name, reason, match_epoch, granted_at, expires_at, preexisting
      FROM vip_grants
    `);
    db.exec('DROP TABLE vip_grants');
    db.exec('ALTER TABLE vip_grants_migrated RENAME TO vip_grants');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(`Failed to migrate vip_grants (drop reason CHECK): ${err.message}`);
  }
}

/**
 * Opens (creating if needed) the SQLite database at dbPath, applies the
 * schema idempotently, and returns a small repository object with prepared
 * statements. Kept as one module so every consumer shares one connection.
 */
export function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  // node:sqlite has no .pragma() helper - PRAGMAs are just run via .exec().
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  // Migrate columns/constraints added after the bot was first deployed.
  // Safe no-ops if already applied. Order matters: preexisting/expires_at
  // must exist on vip_grants BEFORE dropVipGrantsReasonCheckIfPresent runs,
  // since that migration's INSERT...SELECT copies those columns across -
  // on a truly first-generation database (before ANY of these migrations
  // ever ran) they wouldn't exist yet otherwise.
  addColumnIfMissing(db, 'matches', 'awards_granted INTEGER NOT NULL DEFAULT 0', 'awards_granted');
  addColumnIfMissing(db, 'player_match_stats', 'is_vip INTEGER NOT NULL DEFAULT 0', 'is_vip');
  addColumnIfMissing(db, 'player_match_stats', 'baseline_combat_score INTEGER NOT NULL DEFAULT 0', 'baseline_combat_score');
  addColumnIfMissing(db, 'player_match_stats', 'baseline_defense_score INTEGER NOT NULL DEFAULT 0', 'baseline_defense_score');
  addColumnIfMissing(db, 'player_match_stats', 'last_combat_score INTEGER NOT NULL DEFAULT 0', 'last_combat_score');
  addColumnIfMissing(db, 'player_match_stats', 'last_defense_score INTEGER NOT NULL DEFAULT 0', 'last_defense_score');
  addColumnIfMissing(db, 'player_match_stats', 'notified_kill_milestone INTEGER NOT NULL DEFAULT 0', 'notified_kill_milestone');
  addColumnIfMissing(db, 'vip_grants', 'preexisting INTEGER NOT NULL DEFAULT 0', 'preexisting');
  dropVipGrantsReasonCheckIfPresent(db);

  const stmts = {
    insertMatch: db.prepare(
      'INSERT INTO matches (map_name, started_at) VALUES (?, ?)'
    ),
    getBotState: db.prepare('SELECT value FROM bot_state WHERE key = ?'),
    setBotState: db.prepare(
      'INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
    getPlayerMatchStat: db.prepare(
      'SELECT * FROM player_match_stats WHERE match_epoch = ? AND player_id = ?'
    ),
    insertPlayerMatchStat: db.prepare(`
      INSERT INTO player_match_stats
        (match_epoch, player_id, player_name, baseline_kills, baseline_deaths, last_kills, last_deaths,
         is_vip, baseline_combat_score, baseline_defense_score, last_combat_score, last_defense_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updatePlayerMatchStatLast: db.prepare(`
      UPDATE player_match_stats
      SET last_kills = ?, last_deaths = ?, player_name = ?, is_vip = ?,
          last_combat_score = ?, last_defense_score = ?
      WHERE match_epoch = ? AND player_id = ?
    `),
    getStatsForMatch: db.prepare(
      'SELECT * FROM player_match_stats WHERE match_epoch = ?'
    ),
    insertVipGrant: db.prepare(`
      INSERT INTO vip_grants (player_id, player_name, reason, match_epoch, granted_at, expires_at, preexisting)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    getVipStatus: db.prepare('SELECT * FROM vip_status WHERE player_id = ?'),
    upsertVipStatus: db.prepare(`
      INSERT INTO vip_status (player_id, player_name, preexisting, expires_at, revoked, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET
        player_name = excluded.player_name,
        preexisting = excluded.preexisting,
        expires_at = excluded.expires_at,
        revoked = excluded.revoked,
        updated_at = excluded.updated_at
    `),
    getExpiredManagedVips: db.prepare(
      'SELECT * FROM vip_status WHERE preexisting = 0 AND revoked = 0 AND expires_at IS NOT NULL AND expires_at <= ?'
    ),
    markVipStatusRevoked: db.prepare(
      'UPDATE vip_status SET revoked = 1, updated_at = ? WHERE player_id = ?'
    ),
    getNotifiedMilestone: db.prepare(
      'SELECT notified_kill_milestone FROM player_match_stats WHERE match_epoch = ? AND player_id = ?'
    ),
    setNotifiedMilestone: db.prepare(
      'UPDATE player_match_stats SET notified_kill_milestone = ? WHERE match_epoch = ? AND player_id = ?'
    ),
    getPlayersForMilestoneCheck: db.prepare(
      'SELECT player_id, player_name, notified_kill_milestone, (last_kills - baseline_kills) AS kills FROM player_match_stats WHERE match_epoch = ?'
    ),
    setMatchAwardsGranted: db.prepare(
      'UPDATE matches SET awards_granted = 1 WHERE match_epoch = ?'
    ),
    getMatchAwardsGranted: db.prepare(
      'SELECT awards_granted FROM matches WHERE match_epoch = ?'
    ),
  };

  return {
    raw: db,

    close() {
      db.close();
    },

    /** Persisted "current match epoch" so a restart doesn't lose track of the active match. */
    getCurrentMatchEpoch() {
      const row = stmts.getBotState.get('current_match_epoch');
      return row ? Number(row.value) : null;
    },

    setCurrentMatchEpoch(epoch) {
      stmts.setBotState.run('current_match_epoch', String(epoch));
    },

    getLastKnownMap() {
      const row = stmts.getBotState.get('last_known_map');
      return row ? row.value : null;
    },

    setLastKnownMap(mapName) {
      stmts.setBotState.run('last_known_map', mapName ?? '');
    },

    getLastTimeRemaining() {
      const row = stmts.getBotState.get('last_time_remaining');
      return row ? Number(row.value) : null;
    },

    setLastTimeRemaining(seconds) {
      stmts.setBotState.run('last_time_remaining', String(seconds ?? ''));
    },

    startNewMatch(mapName) {
      const info = stmts.insertMatch.run(mapName ?? null, new Date().toISOString());
      return info.lastInsertRowid;
    },

    /**
     * Ensures a player_match_stats row exists for this match/player, then
     * updates the "last" columns to the latest absolute values reported by
     * the API. If this is the first time we've seen this player in this
     * match, the current absolute values become the baseline (so a
     * mid-match joiner, or a session-cumulative counter, still yields a
     * correct per-match delta of 0 at the moment we first see them). This
     * applies uniformly to kills/deaths/combatScore/defenseScore - we don't
     * know for certain which of these Bifrost resets per-match vs. carries
     * over, so all four use the same safe delta-from-first-seen approach.
     * isVip is always overwritten to the latest known value - it's a live
     * snapshot, not a baseline.
     */
    upsertPlayerPoll(matchEpoch, playerId, playerName, kills, deaths, isVip, combatScore, defenseScore) {
      const isVipInt = isVip ? 1 : 0;
      const existing = stmts.getPlayerMatchStat.get(matchEpoch, playerId);
      if (!existing) {
        stmts.insertPlayerMatchStat.run(
          matchEpoch, playerId, playerName, kills, deaths, kills, deaths,
          isVipInt, combatScore, defenseScore, combatScore, defenseScore
        );
      } else {
        stmts.updatePlayerMatchStatLast.run(
          kills, deaths, playerName, isVipInt, combatScore, defenseScore, matchEpoch, playerId
        );
      }
    },

    /** Returns [{playerId, playerName, kills, deaths, combatScore, defenseScore, isVip}] deltas for a given match. */
    getMatchDeltas(matchEpoch) {
      return stmts.getStatsForMatch.all(matchEpoch).map((row) => ({
        playerId: row.player_id,
        playerName: row.player_name,
        kills: row.last_kills - row.baseline_kills,
        deaths: row.last_deaths - row.baseline_deaths,
        combatScore: row.last_combat_score - row.baseline_combat_score,
        defenseScore: row.last_defense_score - row.baseline_defense_score,
        isVip: row.is_vip === 1,
      }));
    },

    /** Appends one audit-log row for an award event. Does not drive revocation. */
    recordVipGrant(playerId, playerName, reason, matchEpoch, expiresAt, preexisting) {
      stmts.insertVipGrant.run(
        playerId,
        playerName,
        reason,
        matchEpoch,
        new Date().toISOString(),
        expiresAt,
        preexisting ? 1 : 0
      );
    },

    /** Returns the current vip_status row for a player, or undefined if never tracked. */
    getVipStatus(playerId) {
      return stmts.getVipStatus.get(playerId);
    },

    /**
     * Creates or updates the single source-of-truth VIP status row for a
     * player. preexisting=true means the bot must never call removeVip for
     * them; expiresAt is ignored/irrelevant in that case.
     */
    upsertVipStatus(playerId, playerName, { preexisting, expiresAt, revoked }) {
      stmts.upsertVipStatus.run(
        playerId,
        playerName,
        preexisting ? 1 : 0,
        expiresAt ?? null,
        revoked ? 1 : 0,
        new Date().toISOString()
      );
    },

    /** Players the bot itself granted VIP to (non-preexisting) whose 7-day window has passed and haven't been revoked yet. */
    getExpiredManagedVips(nowIso) {
      return stmts.getExpiredManagedVips.all(nowIso);
    },

    markVipStatusRevoked(playerId) {
      stmts.markVipStatusRevoked.run(new Date().toISOString(), playerId);
    },

    /**
     * Returns all players in the current match with their kill delta and
     * the highest kill milestone already notified for them. Used by the
     * kill-milestone check after each poll.
     * Returns [{playerId, playerName, kills, notifiedKillMilestone}]
     */
    getPlayersForMilestoneCheck(matchEpoch) {
      return stmts.getPlayersForMilestoneCheck.all(matchEpoch).map((row) => ({
        playerId: row.player_id,
        playerName: row.player_name,
        kills: row.kills,
        notifiedKillMilestone: row.notified_kill_milestone,
      }));
    },

    /** Updates the highest kill milestone sent for a player in a match. */
    setNotifiedMilestone(matchEpoch, playerId, milestone) {
      stmts.setNotifiedMilestone.run(milestone, matchEpoch, playerId);
    },

    /**
     * Returns the last known pendingNextMap value:
     *   undefined = key never written (first boot, skip detection this poll)
     *   null      = was explicitly null last poll
     *   string    = had a value last poll
     */
    getLastPendingNextMap() {
      const row = stmts.getBotState.get('last_pending_next_map');
      if (!row) return undefined;
      return row.value === '' ? null : row.value;
    },

    setLastPendingNextMap(value) {
      stmts.setBotState.run('last_pending_next_map', value ?? '');
    },

    /** Marks a match as having had its end-of-match VIP awards sent. */
    setMatchAwardsGranted(matchEpoch) {
      stmts.setMatchAwardsGranted.run(matchEpoch);
    },

    /** Returns true if end-of-match VIP awards have already been sent for this epoch. */
    getMatchAwardsGranted(matchEpoch) {
      const row = stmts.getMatchAwardsGranted.get(matchEpoch);
      return row?.awards_granted === 1;
    },
  };
}
