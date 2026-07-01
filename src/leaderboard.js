/**
 * Given deltas like [{playerId, playerName, kills, deaths}], returns the
 * players tied for the maximum value of the given stat key. Returns an
 * empty array if the max value is 0 or there are no players (no meaningful
 * leader to report/award in that case).
 */
export function findTiedLeaders(deltas, statKey) {
  if (!deltas?.length) return [];

  const max = deltas.reduce((best, d) => Math.max(best, d[statKey] ?? 0), 0);
  if (max <= 0) return [];

  return deltas.filter((d) => (d[statKey] ?? 0) === max);
}

/**
 * Formats a list of tied leaders + a stat label into a single-line message,
 * truncating the player-name list if needed to stay within maxLength
 * (Bifrost's guildSendMessageToAll caps at 200 chars post-trim).
 */
export function formatLeaderMessage(leaders, statLabel, value, maxLength = 200) {
  if (!leaders.length) return null;

  const names = leaders.map((l) => l.playerName);
  let namesPart = names.join(', ');
  const suffix = ` (${value} ${statLabel})`;
  const prefix = leaders.length > 1 ? 'Tied leaders: ' : 'Leader: ';

  let message = `${prefix}${namesPart}${suffix}`;

  if (message.length > maxLength) {
    // Trim names one at a time, appending "+N more" until it fits.
    let kept = [...names];
    while (kept.length > 1) {
      kept.pop();
      const extra = names.length - kept.length;
      namesPart = `${kept.join(', ')} +${extra} more`;
      message = `${prefix}${namesPart}${suffix}`;
      if (message.length <= maxLength) break;
    }
    if (message.length > maxLength) {
      // Even a single name + suffix doesn't fit (pathological edge case) -
      // hard truncate as a last resort.
      message = message.slice(0, maxLength);
    }
  }

  return message;
}
