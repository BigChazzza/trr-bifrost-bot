import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTiedLeaders, formatLeaderMessage } from './leaderboard.js';

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

test('formatLeaderMessage formats a single leader', () => {
  const msg = formatLeaderMessage([{ playerName: 'Alice' }], 'kills', 42);
  assert.equal(msg, 'Leader: Alice (42 kills)');
  assert.ok(msg.length <= 200);
});

test('formatLeaderMessage formats multiple tied leaders', () => {
  const msg = formatLeaderMessage(
    [{ playerName: 'Alice' }, { playerName: 'Bob' }],
    'kills',
    10
  );
  assert.equal(msg, 'Tied leaders: Alice, Bob (10 kills)');
});

test('formatLeaderMessage returns null for empty leaders list', () => {
  assert.equal(formatLeaderMessage([], 'kills', 0), null);
});

test('formatLeaderMessage truncates a very long tied-name list to fit 200 chars', () => {
  const leaders = Array.from({ length: 60 }, (_, i) => ({
    playerName: `PlayerWithAVeryLongNameNumber${i}`,
  }));
  const msg = formatLeaderMessage(leaders, 'kills', 5);
  assert.ok(msg.length <= 200, `expected <= 200 chars, got ${msg.length}`);
  assert.match(msg, /\+\d+ more/);
});

test('formatLeaderMessage respects a custom maxLength', () => {
  const leaders = [{ playerName: 'Alice' }, { playerName: 'Bob' }, { playerName: 'Carl' }];
  const msg = formatLeaderMessage(leaders, 'kills', 5, 30);
  assert.ok(msg.length <= 30, `expected <= 30 chars, got ${msg.length}: "${msg}"`);
});
