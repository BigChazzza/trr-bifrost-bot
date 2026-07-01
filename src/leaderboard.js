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

function buildStatLine(label, names, statLabel, value) {
  const verb = names.length > 1 ? 'have' : 'has';
  return `${label} - ${names.join(', ')} ${verb} the ${statLabel} with ${value}`;
}

/**
 * Formats the combined 15-minute leaderboard announcement:
 *   "Murder Machine - Alice has the most kills with 22. Wooden Spoon - Bob has the most deaths with 15"
 * Handles ties on either stat by joining names with commas ("have" instead
 * of "has"). Omits a side entirely if there are no leaders for it yet (e.g.
 * very early in a match). Returns null if there's nothing to announce at all.
 * Truncates name lists (kills side first, since it's the primary stat) if
 * the combined message would exceed maxLength (Bifrost's 200-char cap).
 */
export function formatMurderMachineMessage(killLeaders, deathLeaders, maxLength = 200) {
  const killNames = killLeaders.map((l) => l.playerName);
  const deathNames = deathLeaders.map((l) => l.playerName);
  const killValue = killLeaders[0]?.kills;
  const deathValue = deathLeaders[0]?.deaths;

  if (!killNames.length && !deathNames.length) return null;

  const render = (kNames, dNames) => {
    const parts = [];
    if (kNames.length) parts.push(buildStatLine('Murder Machine', kNames, 'most kills', killValue));
    if (dNames.length) parts.push(buildStatLine('Wooden Spoon', dNames, 'most deaths', deathValue));
    return parts.join('. ');
  };

  let message = render(killNames, deathNames);
  if (message.length <= maxLength) return message;

  // Trim the longer of the two name lists one entry at a time (kills side
  // preferred when tied in length, since it's the primary stat) until it
  // fits, appending "+N more" to whichever list got trimmed.
  let kNames = [...killNames];
  let dNames = [...deathNames];
  while (message.length > maxLength && (kNames.length > 1 || dNames.length > 1)) {
    if (kNames.length >= dNames.length && kNames.length > 1) {
      kNames.pop();
    } else if (dNames.length > 1) {
      dNames.pop();
    } else {
      break;
    }
    const kDisplay = kNames.length < killNames.length ? [...kNames, `+${killNames.length - kNames.length} more`] : kNames;
    const dDisplay = dNames.length < deathNames.length ? [...dNames, `+${deathNames.length - dNames.length} more`] : dNames;
    message = render(kDisplay, dDisplay);
  }

  if (message.length > maxLength) {
    // Pathological edge case (even fully trimmed it doesn't fit): hard truncate.
    message = message.slice(0, maxLength);
  }

  return message;
}
