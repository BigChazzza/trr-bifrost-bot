// If the game clock's remaining time increases by more than this many
// seconds between consecutive polls, treat it as a new match starting
// (the timer resets to a full match length) rather than normal countdown
// jitter. Normal countdown only ever decreases by ~30s per poll, so any
// meaningful increase is a strong signal, but we keep a small buffer to
// avoid false positives from a single noisy/late API value.
const TIME_JUMP_THRESHOLD_SECONDS = 60;

/**
 * Tracks match boundaries and per-player kill/death deltas across polls.
 * Persists its cursor (current match epoch, last known map/time-remaining)
 * to the provided db so it survives process restarts mid-match.
 */
export class MatchTracker {
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {Array<{playerId: string, playerName: string, kills: number, deaths: number, isVip?: boolean, combatScore?: number, defenseScore?: number}>} players
   * @param {{data?: {currentMap?: string}, matchTimeRemainingSeconds?: number} | null} gameState
   * @returns {{transitioned: boolean, endedMatchEpoch: number|null, currentMatchEpoch: number, mapName: string|null, matchTimeExpired: boolean}}
   */
  processPoll(players, gameState) {
    const currentMap = gameState?.data?.currentMap ?? null;
    const timeRemaining = typeof gameState?.matchTimeRemainingSeconds === 'number'
      ? gameState.matchTimeRemainingSeconds
      : null;

    let currentMatchEpoch = this.db.getCurrentMatchEpoch();
    const lastMap = this.db.getLastKnownMap();
    const lastTimeRemaining = this.db.getLastTimeRemaining();

    let transitioned = false;
    let endedMatchEpoch = null;

    if (currentMatchEpoch === null) {
      // First poll this process has ever seen for this DB: nothing to end,
      // just open the first match record.
      currentMatchEpoch = this.db.startNewMatch(currentMap);
      this.db.setCurrentMatchEpoch(currentMatchEpoch);
    } else {
      const mapChanged = lastMap && currentMap && lastMap !== currentMap;
      const timeJumpedUp =
        lastTimeRemaining !== null &&
        timeRemaining !== null &&
        timeRemaining > lastTimeRemaining + TIME_JUMP_THRESHOLD_SECONDS;

      if (mapChanged || timeJumpedUp) {
        transitioned = true;
        endedMatchEpoch = currentMatchEpoch;
        currentMatchEpoch = this.db.startNewMatch(currentMap);
        this.db.setCurrentMatchEpoch(currentMatchEpoch);
      }
    }

    // True only on the single poll where the clock transitions from >0 to 0
    // (and no map-change transition happened simultaneously). Used to fire
    // VIP awards at actual match end rather than waiting for the next map.
    const matchTimeExpired =
      !transitioned &&
      lastTimeRemaining !== null &&
      lastTimeRemaining > 0 &&
      timeRemaining === 0;

    this.db.setLastKnownMap(currentMap);
    this.db.setLastTimeRemaining(timeRemaining);

    for (const player of players ?? []) {
      if (!player?.playerId) continue;
      this.db.upsertPlayerPoll(
        currentMatchEpoch,
        player.playerId,
        player.playerName ?? player.playerId,
        player.kills ?? 0,
        player.deaths ?? 0,
        player.isVip ?? false,
        player.combatScore ?? 0,
        player.defenseScore ?? 0
      );
    }

    return { transitioned, endedMatchEpoch, currentMatchEpoch, mapName: currentMap, matchTimeExpired };
  }
}
