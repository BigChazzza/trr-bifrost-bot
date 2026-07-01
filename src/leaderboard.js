/**
 * Given deltas like [{playerId, playerName, kills, deaths, combatScore, defenseScore}],
 * returns the players tied for the maximum value of the given stat key.
 * Returns an empty array if the max value is 0 or there are no players (no
 * meaningful leader to report/award in that case).
 */
export function findTiedLeaders(deltas, statKey) {
  if (!deltas?.length) return [];

  const max = deltas.reduce((best, d) => Math.max(best, d[statKey] ?? 0), 0);
  if (max <= 0) return [];

  return deltas.filter((d) => (d[statKey] ?? 0) === max);
}

/**
 * Builds a line "spec" (label, tied player names, value, optional trailing
 * word) for one stat category. Returns null if there are no leaders for
 * this category yet (so the caller can omit the line entirely).
 */
function buildStatLineSpec(label, leaders, valueKey, suffix = '') {
  if (!leaders?.length) return null;
  return {
    label,
    names: leaders.map((l) => l.playerName),
    value: leaders[0][valueKey],
    suffix,
  };
}

/** Renders one line spec to text, showing only the first `keepCount` names (+ "+N more" if trimmed). */
function renderLine(spec, keepCount) {
  const total = spec.names.length;
  const shown = keepCount ?? total;
  let names = spec.names.slice(0, shown);
  if (shown < total) names = [...names, `+${total - shown} more`];
  const suffixPart = spec.suffix ? ` ${spec.suffix}` : '';
  return `${spec.label} - ${names.join(', ')} (${spec.value})${suffixPart}`;
}

/**
 * Assembles the four stat-line specs (Killing Machine / Having a day /
 * Rambo / Brick wall, in that priority order) plus an optional header line
 * and trailing signature into one message, e.g.:
 *
 *   Killing Machine - Alice (22) Kills
 *   Having a day - Bob (15) Deaths
 *   Rambo - Carl (450)
 *   Brick wall - Dave (380)
 *
 *   -BigChazzza Bot
 *
 * Categories with no leaders yet are omitted entirely. Returns null if
 * there's nothing to report in any category (and no header was given).
 *
 * Truncation strategy to respect maxLength (Bifrost's 200-char cap): first
 * trim tied-name lists one name at a time (always trimming whichever line
 * currently has the most names), then - if still too long - drop whole
 * lines starting from the lowest-priority end (Brick wall, then Rambo)
 * before ever touching the header or signature.
 */
export function formatStatsMessage(
  { header, killLeaders, deathLeaders, combatLeaders, defenseLeaders },
  maxLength = 200,
  signature = '-BigChazzza Bot'
) {
  const specs = [
    buildStatLineSpec('Killing Machine', killLeaders, 'kills', 'Kills'),
    buildStatLineSpec('Having a day', deathLeaders, 'deaths', 'Deaths'),
    buildStatLineSpec('Rambo', combatLeaders, 'combatScore'),
    buildStatLineSpec('Brick wall', defenseLeaders, 'defenseScore'),
  ].filter(Boolean);

  if (!specs.length && !header) return null;

  function render(activeSpecs, keepCounts) {
    const lines = activeSpecs.map((spec, i) => renderLine(spec, keepCounts[i]));
    const bodyParts = header ? [header, ...lines] : lines;
    let message = bodyParts.join('\n');
    if (signature) message += `\n\n${signature}`;
    return message;
  }

  let activeSpecs = specs;
  let keepCounts = activeSpecs.map((s) => s.names.length);
  let message = render(activeSpecs, keepCounts);

  // Phase 1: trim tied-name lists, one name at a time from whichever line
  // currently shows the most names, until it fits or every line is down to 1.
  while (message.length > maxLength) {
    let idx = -1;
    let maxNames = 1;
    keepCounts.forEach((count, i) => {
      if (count > maxNames) {
        maxNames = count;
        idx = i;
      }
    });
    if (idx === -1) break;
    keepCounts[idx] -= 1;
    message = render(activeSpecs, keepCounts);
  }

  // Phase 2: still too long even at 1 name per line - drop whole lines from
  // the bottom (lowest priority) up, never touching header/signature.
  while (message.length > maxLength && activeSpecs.length > 0) {
    activeSpecs = activeSpecs.slice(0, -1);
    keepCounts = keepCounts.slice(0, -1);
    message = render(activeSpecs, keepCounts);
  }

  if (message.length > maxLength) {
    // Pathological: even header+signature alone don't fit. Hard truncate.
    message = message.slice(0, maxLength);
  }

  return message;
}
