import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTiedLeaders, formatStatsMessage } from './leaderboard.js';

test('findTiedLeaders returns single leader when one player has the max', () => {
  const deltas = [
    { playerId: '1', playerName: 'Alice', kills: 10, deaths: 2 },
    { playerId: '2', playerName: 'Bob', kills: 5, deaths: 8 },
  ];
  const leaders = findTiedLeaders(deltas, 'kills');
  assert.equal(leaders.length, 1);
  assert.equal(leaders[0].playerName, 'Alice');
});

test('findTiedLeaders returns all players tied for the max', () => {
  const deltas = [
    { playerId: '1', playerName: 'Alice', kills: 10, deaths: 2 },
    { playerId: '2', playerName: 'Bob', kills: 10, deaths: 8 },
    { playerId: '3', playerName: 'Carl', kills: 3, deaths: 1 },
  ];
  const leaders = findTiedLeaders(deltas, 'kills');
  assert.equal(leaders.length, 2);
  assert.deepEqual(leaders.map((l) => l.playerName).sort(), ['Alice', 'Bob']);
});

test('findTiedLeaders returns empty array when max value is 0', () => {
  const deltas = [
    { playerId: '1', playerName: 'Alice', kills: 0, deaths: 0 },
    { playerId: '2', playerName: 'Bob', kills: 0, deaths: 0 },
  ];
  assert.deepEqual(findTiedLeaders(deltas, 'kills'), []);
});

test('findTiedLeaders returns empty array for empty input', () => {
  assert.deepEqual(findTiedLeaders([], 'kills'), []);
  assert.deepEqual(findTiedLeaders(null, 'kills'), []);
});

test('findTiedLeaders works for combatScore/defenseScore stat keys too', () => {
  const deltas = [
    { playerId: '1', playerName: 'Alice', combatScore: 450, defenseScore: 100 },
    { playerId: '2', playerName: 'Bob', combatScore: 200, defenseScore: 380 },
  ];
  assert.deepEqual(findTiedLeaders(deltas, 'combatScore').map((l) => l.playerName), ['Alice']);
  assert.deepEqual(findTiedLeaders(deltas, 'defenseScore').map((l) => l.playerName), ['Bob']);
});

test('formatStatsMessage renders all four categories in priority order with the signature', () => {
  const msg = formatStatsMessage({
    killLeaders: [{ playerName: 'Alice', kills: 22 }],
    deathLeaders: [{ playerName: 'Bob', deaths: 15 }],
    combatLeaders: [{ playerName: 'Carl', combatScore: 450 }],
    defenseLeaders: [{ playerName: 'Dave', defenseScore: 380 }],
  });
  assert.equal(
    msg,
    'Killing Machine - Alice (22) Kills\n' +
      'Having a day - Bob (15) Deaths\n' +
      'Rambo - Carl (450)\n' +
      'Brick wall - Dave (380)\n' +
      '\n' +
      '-BigChazzza Bot'
  );
});

test('formatStatsMessage joins tied names with commas', () => {
  const msg = formatStatsMessage({
    killLeaders: [{ playerName: 'Alice', kills: 10 }, { playerName: 'Eve', kills: 10 }],
    deathLeaders: [],
    combatLeaders: [],
    defenseLeaders: [],
  });
  assert.equal(msg, 'Killing Machine - Alice, Eve (10) Kills\n\n-BigChazzza Bot');
});

test('formatStatsMessage omits categories with no leaders', () => {
  const msg = formatStatsMessage({
    killLeaders: [{ playerName: 'Alice', kills: 5 }],
    deathLeaders: [],
    combatLeaders: [],
    defenseLeaders: [{ playerName: 'Dave', defenseScore: 100 }],
  });
  assert.equal(msg, 'Killing Machine - Alice (5) Kills\nBrick wall - Dave (100)\n\n-BigChazzza Bot');
});

test('formatStatsMessage returns null when there is nothing to report and no header', () => {
  const msg = formatStatsMessage({ killLeaders: [], deathLeaders: [], combatLeaders: [], defenseLeaders: [] });
  assert.equal(msg, null);
});

test('formatStatsMessage includes a header line when provided, even with no category leaders', () => {
  const msg = formatStatsMessage({
    header: 'Congratulations! You’ve won yourselves 7-day VIP!',
    killLeaders: [],
    deathLeaders: [],
    combatLeaders: [],
    defenseLeaders: [],
  });
  assert.equal(msg, 'Congratulations! You’ve won yourselves 7-day VIP!\n\n-BigChazzza Bot');
});

test('formatStatsMessage puts the header before the stat lines', () => {
  const msg = formatStatsMessage({
    header: 'Congratulations!',
    killLeaders: [{ playerName: 'Alice', kills: 22 }],
    deathLeaders: [],
    combatLeaders: [],
    defenseLeaders: [],
  });
  assert.equal(msg, 'Congratulations!\nKilling Machine - Alice (22) Kills\n\n-BigChazzza Bot');
});

test('formatStatsMessage respects a custom signature', () => {
  const msg = formatStatsMessage(
    { killLeaders: [{ playerName: 'Alice', kills: 5 }], deathLeaders: [], combatLeaders: [], defenseLeaders: [] },
    200,
    '-Custom Sig'
  );
  assert.match(msg, /-Custom Sig$/);
});

test('formatStatsMessage supports omitting the signature entirely', () => {
  const msg = formatStatsMessage(
    { killLeaders: [{ playerName: 'Alice', kills: 5 }], deathLeaders: [], combatLeaders: [], defenseLeaders: [] },
    200,
    ''
  );
  assert.equal(msg, 'Killing Machine - Alice (5) Kills');
});

test('formatStatsMessage trims tied-name lists (longest first) before dropping whole lines', () => {
  const manyKillers = Array.from({ length: 30 }, (_, i) => ({ playerName: `Killer${i}`, kills: 5 }));
  const msg = formatStatsMessage({
    killLeaders: manyKillers,
    deathLeaders: [{ playerName: 'Bob', deaths: 3 }],
    combatLeaders: [{ playerName: 'Carl', combatScore: 450 }],
    defenseLeaders: [{ playerName: 'Dave', defenseScore: 380 }],
  });
  assert.ok(msg.length <= 200, `expected <= 200 chars, got ${msg.length}`);
  assert.match(msg, /\+\d+ more/);
  // Lower-priority lines should survive as long as possible while the long
  // tied-name list gets trimmed first.
  assert.match(msg, /Having a day/);
  assert.match(msg, /Rambo/);
  assert.match(msg, /Brick wall/);
  assert.match(msg, /-BigChazzza Bot/);
});

test('formatStatsMessage drops the lowest-priority line(s) if trimming names alone is not enough', () => {
  // Every category has one very long tied-name list, forcing line-dropping
  // (Brick wall first, since it's lowest priority) once every line is down
  // to a single name each and it's still too long.
  const longNames = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${'X'.repeat(20)}${i}`);
  const mk = (names, key) => names.map((n) => ({ playerName: n, [key]: 1 }));

  const msg = formatStatsMessage(
    {
      killLeaders: mk(longNames('K', 1), 'kills'),
      deathLeaders: mk(longNames('D', 1), 'deaths'),
      combatLeaders: mk(longNames('C', 1), 'combatScore'),
      defenseLeaders: mk(longNames('F', 1), 'defenseScore'),
    },
    90 // tight budget forces line-dropping even at 1 name per line
  );
  assert.ok(msg.length <= 90, `expected <= 90 chars, got ${msg.length}`);
  assert.doesNotMatch(msg, /Brick wall/, 'lowest-priority line should be dropped first');
});

test('formatStatsMessage hard-truncates as a last resort if nothing else fits', () => {
  const msg = formatStatsMessage(
    { killLeaders: [{ playerName: 'Alice', kills: 5 }], deathLeaders: [], combatLeaders: [], defenseLeaders: [] },
    10
  );
  assert.ok(msg.length <= 10, `expected <= 10 chars, got ${msg.length}: "${msg}"`);
});
