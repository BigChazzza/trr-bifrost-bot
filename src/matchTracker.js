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
   * @param {{data?: {currentMap?: string}, matchTimeRemainingSeconds?: number, pendingNextMap?: string|null} | null} gameState
   * @returns {{transitioned: boolean, endedMatchEpoch: number|null, currentMatchEpoch: number, mapName: string|null, matchEndDetected: boolean, matchEndReason: string|null}}
   */
  processPoll(players, gameState) {
    const currentMap = gameState?.data?.currentMap ?? null;
    const timeRemaining = typeof gameState?.matchTimeRemainingSeconds === 'number'
      ? gameState.matchTimeRemainingSeconds
      : null;
    const pendingNextMap = gameState?.pendingNextMap ?? null;

    let currentMatchEpoch = this.db.getCurrentMatchEpoch();
    const lastMap = this.db.getLastKnownMap();
    const lastTimeRemaining = this.db.getLastTimeRemaining();
    const lastPendingNextMap = this.db.getLastPendingNextMap(); // undefined = first boot

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

    // Signal 1: clock hit exactly 0. Narrow window — the 30s poll can miss
    // this if the match ends with < 30s left and the map reloads before the
    // next tick (covered by the transition fallback in that case).
    const matchTimeExpired =
      !transitioned &&
      lastTimeRemaining !== null &&
      lastTimeRemaining > 0 &&
      timeRemaining === 0;

    // Signal 2: pendingNextMap went from null → non-null. This happens when
    // the map vote completes or the next map is queued during the end-of-match
    // results screen — a persistent signal that lasts 20-60s, so the 30s poll
    // won't miss it. lastPendingNextMap === undefined means this is the first
    // boot poll; skip detection to avoid a false positive on startup.
    const pendingNextMapQueued =
      !transitioned &&
      lastPendingNextMap === null &&
      pendingNextMap !== null;

    const matchEndDetected = matchTimeExpired || pendingNextMapQueued;
    const matchEndReason = matchTimeExpired ? 'clock=0' : pendingNextMapQueued ? 'pendingNextMap' : null;

    this.db.setLastKnownMap(currentMap);
    this.db.setLastTimeRemaining(timeRemaining);
    this.db.setLastPendingNextMap(pendingNextMap);

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

    return { transitioned, endedMatchEpoch, currentMatchEpoch, mapName: currentMap, matchEndDetected, matchEndReason };
  }
}
