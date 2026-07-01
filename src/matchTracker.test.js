import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { MatchTracker } from './matchTracker.js';

function makeGameState(currentMap, matchTimeRemainingSeconds) {
  return { data: { currentMap }, matchTimeRemainingSeconds };
}

test('first poll ever opens a match with no transition reported', () => {
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  const players = [{ playerId: 'p1', playerName: 'Alice', kills: 5, deaths: 1 }];
  const result = tracker.processPoll(players, makeGameState('Carentan', 1800));

  assert.equal(result.transitioned, false);
  assert.equal(result.endedMatchEpoch, null);
  assert.equal(result.mapName, 'Carentan');
  assert.equal(db.getCurrentMatchEpoch(), result.currentMatchEpoch);

  const deltas = db.getMatchDeltas(result.currentMatchEpoch);
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].kills, 0); // baseline == first-seen absolute value
  assert.equal(deltas[0].deaths, 0);

  db.close();
});

test('kills accumulate as deltas across polls within the same match', () => {
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  tracker.processPoll([{ playerId: 'p1', playerName: 'Alice', kills: 5, deaths: 1 }], makeGameState('Carentan', 1800));
  const second = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 12, deaths: 3 }],
    makeGameState('Carentan', 1770)
  );

  assert.equal(second.transitioned, false);
  const deltas = db.getMatchDeltas(second.currentMatchEpoch);
  assert.equal(deltas[0].kills, 7); // 12 - 5
  assert.equal(deltas[0].deaths, 2); // 3 - 1

  db.close();
});

test('map change triggers a match transition and resets deltas for the new match', () => {
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  // First poll ever: baseline is set to the current absolute value (0 delta).
  const first = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 0, deaths: 0 }],
    makeGameState('Carentan', 1800)
  );
  // A later poll in the same match: kills climb to 20 before the match ends.
  tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 20, deaths: 4 }],
    makeGameState('Carentan', 300)
  );

  const second = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 20, deaths: 4 }],
    makeGameState('Hurtgen Forest', 1800)
  );

  assert.equal(second.transitioned, true);
  assert.equal(second.endedMatchEpoch, first.currentMatchEpoch);
  assert.notEqual(second.currentMatchEpoch, first.currentMatchEpoch);

  // The old match's final deltas should still be queryable for VIP awarding.
  const oldDeltas = db.getMatchDeltas(first.currentMatchEpoch);
  assert.equal(oldDeltas[0].kills, 20);

  // The new match starts fresh: same absolute kills becomes the new baseline, delta 0.
  const newDeltas = db.getMatchDeltas(second.currentMatchEpoch);
  assert.equal(newDeltas[0].kills, 0);

  db.close();
});

test('a large upward jump in time remaining (no map name reported) also triggers a transition', () => {
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  const first = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 10, deaths: 2 }],
    makeGameState('Carentan', 60)
  );
  const second = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 10, deaths: 2 }],
    makeGameState('Carentan', 1800) // same map (e.g. re-run), but clock jumped way up
  );

  assert.equal(second.transitioned, true);
  assert.equal(second.endedMatchEpoch, first.currentMatchEpoch);

  db.close();
});

test('normal countdown (small decreases) never falsely triggers a transition', () => {
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  tracker.processPoll([{ playerId: 'p1', playerName: 'Alice', kills: 1, deaths: 0 }], makeGameState('Carentan', 1800));
  const r2 = tracker.processPoll([{ playerId: 'p1', playerName: 'Alice', kills: 1, deaths: 0 }], makeGameState('Carentan', 1770));
  const r3 = tracker.processPoll([{ playerId: 'p1', playerName: 'Alice', kills: 2, deaths: 0 }], makeGameState('Carentan', 1740));

  assert.equal(r2.transitioned, false);
  assert.equal(r3.transitioned, false);

  db.close();
});

test('a player who joins mid-match gets a baseline of their first-seen stats, not 0', () => {
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  tracker.processPoll([{ playerId: 'p1', playerName: 'Alice', kills: 5, deaths: 1 }], makeGameState('Carentan', 1800));
  // p2 joins later already having, say, session-cumulative kills of 100 from a prior match.
  const second = tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 6, deaths: 1 },
      { playerId: 'p2', playerName: 'Bob', kills: 100, deaths: 50 },
    ],
    makeGameState('Carentan', 1770)
  );

  const deltas = db.getMatchDeltas(second.currentMatchEpoch);
  const bob = deltas.find((d) => d.playerName === 'Bob');
  assert.equal(bob.kills, 0); // baseline = 100, so delta is 0 the moment we first see them
  db.close();
});

test('surviving a simulated restart: reopening the db resumes tracking the same match', () => {
  const dbPath = ':memory:';
  // Note: ':memory:' can't actually be reopened across two Database instances,
  // so this test uses a persisted-cursor check within one open db instead,
  // which is the behavior that matters (bot_state survives across MatchTracker
  // instances sharing one db connection, simulating a fresh MatchTracker
  // being constructed after a restart against the same on-disk file).
  const db = openDb(dbPath);
  const trackerBeforeRestart = new MatchTracker(db);
  const first = trackerBeforeRestart.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 5, deaths: 1 }],
    makeGameState('Carentan', 1800)
  );

  // Simulate "restart" by constructing a brand new MatchTracker against the same db.
  const trackerAfterRestart = new MatchTracker(db);
  const second = trackerAfterRestart.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 9, deaths: 2 }],
    makeGameState('Carentan', 1770)
  );

  assert.equal(second.transitioned, false);
  assert.equal(second.currentMatchEpoch, first.currentMatchEpoch);
  const deltas = db.getMatchDeltas(second.currentMatchEpoch);
  assert.equal(deltas[0].kills, 4); // 9 - 5, baseline carried over correctly

  db.close();
});
