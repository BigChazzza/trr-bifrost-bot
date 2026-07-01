import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS matches (
  match_epoch INTEGER PRIMARY KEY AUTOINCREMENT,
  map_name TEXT,
  started_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_match_stats (
  match_epoch INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  baseline_kills INTEGER NOT NULL,
  baseline_deaths INTEGER NOT NULL,
  last_kills INTEGER NOT NULL,
  last_deaths INTEGER NOT NULL,
  PRIMARY KEY (match_epoch, player_id)
);

CREATE TABLE IF NOT EXISTS vip_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('most_kills', 'most_deaths')),
  match_epoch INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

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
        (match_epoch, player_id, player_name, baseline_kills, baseline_deaths, last_kills, last_deaths)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    updatePlayerMatchStatLast: db.prepare(`
      UPDATE player_match_stats
      SET last_kills = ?, last_deaths = ?, player_name = ?
      WHERE match_epoch = ? AND player_id = ?
    `),
    getStatsForMatch: db.prepare(
      'SELECT * FROM player_match_stats WHERE match_epoch = ?'
    ),
    insertVipGrant: db.prepare(`
      INSERT INTO vip_grants (player_id, player_name, reason, match_epoch, granted_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `),
    getExpiredUnrevokedVips: db.prepare(
      'SELECT * FROM vip_grants WHERE revoked = 0 AND expires_at <= ?'
    ),
    markVipRevoked: db.prepare('UPDATE vip_grants SET revoked = 1 WHERE id = ?'),
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
     * updates last_kills/last_deaths to the latest absolute values reported
     * by the API. If this is the first time we've seen this player in this
     * match, the current absolute kills/deaths become the baseline (so a
     * mid-match joiner, or a session-cumulative counter, still yields a
     * correct per-match delta of 0 at the moment we first see them).
     */
    upsertPlayerPoll(matchEpoch, playerId, playerName, kills, deaths) {
      const existing = stmts.getPlayerMatchStat.get(matchEpoch, playerId);
      if (!existing) {
        stmts.insertPlayerMatchStat.run(matchEpoch, playerId, playerName, kills, deaths, kills, deaths);
      } else {
        stmts.updatePlayerMatchStatLast.run(kills, deaths, playerName, matchEpoch, playerId);
      }
    },

    /** Returns [{playerId, playerName, kills, deaths}] deltas for a given match. */
    getMatchDeltas(matchEpoch) {
      return stmts.getStatsForMatch.all(matchEpoch).map((row) => ({
        playerId: row.player_id,
        playerName: row.player_name,
        kills: row.last_kills - row.baseline_kills,
        deaths: row.last_deaths - row.baseline_deaths,
      }));
    },

    recordVipGrant(playerId, playerName, reason, matchEpoch, expiresAt) {
      stmts.insertVipGrant.run(
        playerId,
        playerName,
        reason,
        matchEpoch,
        new Date().toISOString(),
        expiresAt
      );
    },

    getExpiredUnrevokedVips(nowIso) {
      return stmts.getExpiredUnrevokedVips.all(nowIso);
    },

    markVipRevoked(id) {
      stmts.markVipRevoked.run(id);
    },
  };
}
