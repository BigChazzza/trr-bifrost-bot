import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BifrostClient } from './bifrostClient.js';
import { openDb } from './db.js';
import { MatchTracker } from './matchTracker.js';
import { awardMatchEndVIPs, sweepExpiredVips } from './vipAwarder.js';
import { announceCurrentLeaders } from './announcer.js';

/**
 * Builds a fake fetch() that simulates the real Bifrost endpoints closely
 * enough to exercise bifrostClient.js's request-building, auth-header, and
 * retry logic end-to-end without hitting the network.
 */
function makeFakeFetch({ initialPlayers } = {}) {
  let tokenIssued = 0;
  const vips = new Set(initialPlayers?.filter((p) => p.isVip).map((p) => p.playerId) ?? []);
  const messages = [];

  const fetchFn = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      tokenIssued += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `fake-token-${tokenIssued}`, token_type: 'Bearer', expires_in: 3600 }),
      };
    }

    if (url.includes('/graphql')) {
      const auth = opts.headers.Authorization;
      if (!auth || !auth.startsWith('Bearer fake-token-')) {
        return { ok: false, status: 401, text: async () => 'unauthorized' };
      }

      const body = JSON.parse(opts.body);
      const query = body.query;

      if (query.includes('guildGetPlayers')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              guildGetPlayers: {
                timestamp: new Date().toISOString(),
                totalCount: initialPlayers?.length ?? 0,
                players: (initialPlayers ?? []).map((p) => ({ ...p, isVip: vips.has(p.playerId) })),
              },
            },
          }),
        };
      }

      if (query.includes('guildGetGameState')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              guildGetGameState: {
                data: { currentMap: 'Carentan' },
                timestamp: new Date().toISOString(),
                matchTimeRemainingSeconds: 1200,
              },
            },
          }),
        };
      }

      if (query.includes('guildAddVip')) {
        // Live schema wraps args in an `input` object and the response type
        // (GuildVipMutationResponse) only has `success` - no `message` field.
        const { playerId } = body.variables.input;
        vips.add(playerId);
        return { ok: true, status: 200, json: async () => ({ data: { guildAddVip: { success: true } } }) };
      }

      if (query.includes('guildRemoveVip')) {
        const { playerId } = body.variables.input;
        vips.delete(playerId);
        return { ok: true, status: 200, json: async () => ({ data: { guildRemoveVip: { success: true } } }) };
      }

      if (query.includes('guildSendMessageToAll')) {
        const { input } = body.variables;
        messages.push(input.message);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              guildSendMessageToAll: { success: true, message: 'Sent', playersNotified: 2, error: null, timestamp: new Date().toISOString() },
            },
          }),
        };
      }

      return { ok: false, status: 400, text: async () => 'unknown query' };
    }

    throw new Error(`Unexpected URL in fake fetch: ${url}`);
  };

  return { fetchFn, vips, messages, getTokenIssuedCount: () => tokenIssued };
}

test('end-to-end: poll -> announce current leader across all four categories', async () => {
  const { fetchFn, messages } = makeFakeFetch({
    initialPlayers: [
      { playerId: 'p1', playerName: 'Alice', kills: 10, deaths: 2, combatScore: 100, defenseScore: 50 },
      { playerId: 'p2', playerName: 'Bob', kills: 3, deaths: 15, combatScore: 80, defenseScore: 300 },
    ],
  });
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  // First poll from the (fake) live API establishes the per-match baseline
  // at each player's current absolute stats, so its own delta is 0 - this
  // matches real bot startup, where "so far this match" must start counting
  // from whatever the API reports the instant we start watching.
  const players = await bifrost.getPlayers();
  const gameState = await bifrost.getGameState();
  assert.ok(players);
  assert.ok(gameState);
  tracker.processPoll(players.players, gameState);

  // A later poll 30s on: stats have climbed further, producing real deltas
  // to announce. Alice leads kills (+12) and combat score (+350). Bob leads
  // deaths (+5) and defense score (+330).
  tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 22, deaths: 2, combatScore: 450, defenseScore: 60 },
      { playerId: 'p2', playerName: 'Bob', kills: 4, deaths: 20, combatScore: 90, defenseScore: 630 },
    ],
    { data: { currentMap: 'Carentan' }, matchTimeRemainingSeconds: 1170 }
  );

  await announceCurrentLeaders({ db, bifrost });

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0],
    'Killing Machine - Alice (12) Kills\n' +
      'Having a day - Bob (5) Deaths\n' +
      'Rambo - Alice (350)\n' +
      'Brick wall - Bob (330)\n' +
      '\n' +
      '-BigChazzza Bot'
  );

  db.close();
});

test('end-to-end: match transition awards VIP across all four categories and announces congratulations', async () => {
  const { fetchFn, vips, messages } = makeFakeFetch({
    initialPlayers: [
      { playerId: 'p1', playerName: 'Alice', kills: 10, deaths: 4, combatScore: 100, defenseScore: 400 },
      { playerId: 'p2', playerName: 'Bob', kills: 5, deaths: 30, combatScore: 300, defenseScore: 100 },
    ],
  });
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  const players1 = await bifrost.getPlayers();
  const gameState1 = await bifrost.getGameState();
  tracker.processPoll(players1.players, gameState1); // baseline poll, delta 0

  // Stats climb within the SAME match: Alice ends up leading kills (+15)
  // and defense (+30). Bob ends up leading deaths (+15) and combat (+200).
  tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 25, deaths: 5, combatScore: 120, defenseScore: 430 },
      { playerId: 'p2', playerName: 'Bob', kills: 6, deaths: 45, combatScore: 500, defenseScore: 110 },
    ],
    { data: { currentMap: 'Carentan' }, matchTimeRemainingSeconds: 900 } // same map, still mid-match
  );

  // Map changes -> transition. The transition poll's own stats become the
  // NEW match's baseline; the just-ended match's deltas are what's above.
  const result = tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 25, deaths: 5, combatScore: 120, defenseScore: 430 },
      { playerId: 'p2', playerName: 'Bob', kills: 6, deaths: 45, combatScore: 500, defenseScore: 110 },
    ],
    { data: { currentMap: 'Hurtgen Forest' }, matchTimeRemainingSeconds: 1800 }
  );

  assert.equal(result.transitioned, true);

  await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch: result.endedMatchEpoch });

  assert.ok(vips.has('p1'), 'Alice (kills + defense leader) should have been granted VIP');
  assert.ok(vips.has('p2'), 'Bob (deaths + combat leader) should have been granted VIP');

  assert.equal(messages.length, 1);
  assert.equal(
    messages[0],
    'Congratulations! You’ve won yourselves 7-day VIP!\n' +
      'Killing Machine - Alice (15) Kills\n' +
      'Having a day - Bob (15) Deaths\n' +
      'Rambo - Bob (200)\n' +
      'Brick wall - Alice (30)\n' +
      '\n' +
      '-BigChazzza Bot'
  );

  // Both players should now be tracked as bot-managed (not preexisting),
  // since neither had VIP before this match's awards.
  assert.equal(db.getVipStatus('p1').preexisting, 0);
  assert.equal(db.getVipStatus('p2').preexisting, 0);

  db.close();
});

test('end-to-end: a player who already had VIP is announced as a winner but never auto-revoked', async () => {
  // Alice already has VIP (e.g. an existing TRR clan member) before the
  // bot ever grants anything.
  const { fetchFn, vips, messages } = makeFakeFetch({
    initialPlayers: [
      { playerId: 'p1', playerName: 'Alice', kills: 0, deaths: 0, isVip: true },
      { playerId: 'p2', playerName: 'Bob', kills: 0, deaths: 0, isVip: false },
    ],
  });
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  const players1 = await bifrost.getPlayers();
  const gameState1 = await bifrost.getGameState();
  tracker.processPoll(players1.players, gameState1);

  tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 20, deaths: 0, isVip: true },
      { playerId: 'p2', playerName: 'Bob', kills: 2, deaths: 0, isVip: false },
    ],
    { data: { currentMap: 'Carentan' }, matchTimeRemainingSeconds: 900 }
  );

  const result = tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 20, deaths: 0, isVip: true },
      { playerId: 'p2', playerName: 'Bob', kills: 2, deaths: 0, isVip: false },
    ],
    { data: { currentMap: 'Hurtgen Forest' }, matchTimeRemainingSeconds: 1800 }
  );
  assert.equal(result.transitioned, true);

  await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch: result.endedMatchEpoch });

  // Alice wins most kills and gets announced/addVip'd like any other winner...
  assert.ok(vips.has('p1'));
  assert.match(messages[0], /Alice/);

  // ...but she's flagged as preexisting, so the hourly sweep must never touch her.
  const aliceStatus = db.getVipStatus('p1');
  assert.equal(aliceStatus.preexisting, 1);
  assert.equal(aliceStatus.expires_at, null);

  await sweepExpiredVips({ db, bifrost });
  assert.ok(vips.has('p1'), 'preexisting VIP must survive the sweep even with no expiry set');

  db.close();
});

test('end-to-end: a bot-granted (non-preexisting) VIP IS revoked once expired, a preexisting one in the same sweep is not', async () => {
  const { fetchFn, vips } = makeFakeFetch({ initialPlayers: [] });
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');

  // Simulate a bot-managed grant that has already expired.
  vips.add('p1');
  db.upsertVipStatus('p1', 'Alice', { preexisting: false, expiresAt: new Date(Date.now() - 1000).toISOString(), revoked: false });

  // Simulate a preexisting grant with no expiry at all.
  vips.add('p2');
  db.upsertVipStatus('p2', 'Bob', { preexisting: true, expiresAt: null, revoked: false });

  await sweepExpiredVips({ db, bifrost });

  assert.ok(!vips.has('p1'), 'expired bot-managed VIP should have been revoked');
  assert.ok(vips.has('p2'), 'preexisting VIP must never be revoked by the sweep');
  assert.equal(db.getVipStatus('p1').revoked, 1);
  assert.equal(db.getVipStatus('p2').revoked, 0);

  db.close();
});

test('end-to-end: a repeat winner (non-preexisting) gets their 7-day clock refreshed, not re-flagged preexisting', async () => {
  const { fetchFn, vips } = makeFakeFetch({
    initialPlayers: [{ playerId: 'p1', playerName: 'Alice', kills: 0, deaths: 0, isVip: false }],
  });
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  // Match 1: Alice wins kills. Before the bot has ever granted anything,
  // every poll correctly reports isVip: false - it only becomes true AFTER
  // awardMatchEndVIPs actually calls addVip below.
  const p1 = await bifrost.getPlayers();
  const g1 = await bifrost.getGameState();
  tracker.processPoll(p1.players, g1);
  tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 10, deaths: 0, isVip: false }],
    { data: { currentMap: 'Carentan' }, matchTimeRemainingSeconds: 900 }
  );
  const end1 = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 10, deaths: 0, isVip: false }],
    { data: { currentMap: 'Hurtgen Forest' }, matchTimeRemainingSeconds: 1800 }
  );
  await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch: end1.endedMatchEpoch });

  const statusAfterFirstWin = db.getVipStatus('p1');
  assert.equal(statusAfterFirstWin.preexisting, 0, 'must NOT be relabeled preexisting just because isVip now reads true');
  const firstExpiry = statusAfterFirstWin.expires_at;
  assert.ok(firstExpiry);

  // Match 2: Alice wins again. Her win should refresh/extend the expiry,
  // still as a non-preexisting (bot-managed, revocable) grant.
  tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 5, deaths: 0, isVip: true }],
    { data: { currentMap: 'Hurtgen Forest' }, matchTimeRemainingSeconds: 300 }
  );
  const end2 = tracker.processPoll(
    [{ playerId: 'p1', playerName: 'Alice', kills: 5, deaths: 0, isVip: true }],
    { data: { currentMap: 'Omaha Beach' }, matchTimeRemainingSeconds: 1800 }
  );
  await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch: end2.endedMatchEpoch });

  const statusAfterSecondWin = db.getVipStatus('p1');
  assert.equal(statusAfterSecondWin.preexisting, 0, 'repeat win must stay non-preexisting/revocable');
  assert.ok(statusAfterSecondWin.expires_at >= firstExpiry, 'expiry should be refreshed/extended, not left stale');

  assert.ok(vips.has('p1'));
  db.close();
});

test('a single 429 response is retried once and succeeds', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    if (url.includes('/oauth/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }) };
    }
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 429, json: async () => ({ retryAfter: 0.01 }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { guildGetPlayers: { timestamp: 't', totalCount: 0, players: [] } } }),
    };
  };

  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const result = await bifrost.getPlayers();
  assert.ok(result);
  assert.equal(calls, 2);
});

test('a 401 forces exactly one token refresh and retries the request', async () => {
  let tokenCalls = 0;
  let graphqlCalls = 0;
  const fetchFn = async (url, opts) => {
    if (url.includes('/oauth/token')) {
      tokenCalls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `tok-${tokenCalls}`, token_type: 'Bearer', expires_in: 3600 }) };
    }
    graphqlCalls += 1;
    if (graphqlCalls === 1) {
      return { ok: false, status: 401, text: async () => 'expired' };
    }
    // Second attempt should be using the freshly refreshed token.
    assert.equal(opts.headers.Authorization, 'Bearer tok-2');
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { guildGetPlayers: { timestamp: 't', totalCount: 0, players: [] } } }),
    };
  };

  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const result = await bifrost.getPlayers();
  assert.ok(result);
  assert.equal(tokenCalls, 2);
  assert.equal(graphqlCalls, 2);
});

test('token is cached across multiple calls and not re-fetched per request', async () => {
  const { fetchFn, getTokenIssuedCount } = makeFakeFetch({ initialPlayers: [] });
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });

  await bifrost.getPlayers();
  await bifrost.getGameState();
  await bifrost.getPlayers();

  assert.equal(getTokenIssuedCount(), 1, 'token should only be fetched once for 3 calls within its validity window');
});
