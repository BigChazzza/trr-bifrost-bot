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
function makeFakeFetch({ recordCalls } = {}) {
  let tokenIssued = 0;
  const vips = new Set();
  const messages = [];

  const fetchFn = async (url, opts) => {
    recordCalls?.push({ url, opts });

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
                totalCount: 2,
                players: [
                  { playerId: 'p1', playerName: 'Alice', playerClanTag: 'TRR', isVip: false, kills: 10, deaths: 2, teamkills: 0 },
                  { playerId: 'p2', playerName: 'Bob', playerClanTag: 'TRR', isVip: false, kills: 3, deaths: 15, teamkills: 0 },
                ],
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
        const { playerId } = body.variables;
        vips.add(playerId);
        return { ok: true, status: 200, json: async () => ({ data: { guildAddVip: { success: true, message: 'Player added to VIP list' } } }) };
      }

      if (query.includes('guildRemoveVip')) {
        const { playerId } = body.variables;
        vips.delete(playerId);
        return { ok: true, status: 200, json: async () => ({ data: { guildRemoveVip: { success: true, message: 'Player removed from VIP list' } } }) };
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

test('end-to-end: poll -> announce current leader', async () => {
  const { fetchFn, messages } = makeFakeFetch();
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  // First poll from the (fake) live API establishes the per-match baseline
  // at each player's current absolute stats, so its own delta is 0 - this
  // matches real bot startup, where "kills so far this match" must start
  // counting from whatever the API reports the instant we start watching.
  const players = await bifrost.getPlayers();
  const gameState = await bifrost.getGameState();
  assert.ok(players);
  assert.ok(gameState);
  tracker.processPoll(players.players, gameState);

  // A later poll 30s on: kills have climbed further, producing a real delta
  // to announce (this is what the 15-min announcer actually reads).
  tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 22, deaths: 3 },
      { playerId: 'p2', playerName: 'Bob', kills: 4, deaths: 16 },
    ],
    { data: { currentMap: 'Carentan' }, matchTimeRemainingSeconds: 1170 }
  );

  await announceCurrentLeaders({ db, bifrost });

  assert.equal(messages.length, 1);
  assert.match(messages[0], /Alice/);
  assert.match(messages[0], /12 kills/); // 22 - baseline 10

  db.close();
});

test('end-to-end: match transition awards VIP to kill leader and death leader', async () => {
  const { fetchFn, vips, messages } = makeFakeFetch();
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');
  const tracker = new MatchTracker(db);

  // First poll opens the match with baseline = current absolute stats (delta 0).
  const players1 = await bifrost.getPlayers();
  const gameState1 = await bifrost.getGameState();
  tracker.processPoll(players1.players, gameState1);

  // Second poll: same map, stats climb further -> non-zero deltas going into the transition.
  tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 25, deaths: 4 },
      { playerId: 'p2', playerName: 'Bob', kills: 5, deaths: 30 },
    ],
    { data: { currentMap: 'Carentan' }, matchTimeRemainingSeconds: 900 }
  );

  // Third poll: map changes -> transition. Alice (25 kills, +15 from baseline 10) leads kills.
  // Bob (30 deaths, +15 from baseline 15) leads deaths.
  const result = tracker.processPoll(
    [
      { playerId: 'p1', playerName: 'Alice', kills: 25, deaths: 4 },
      { playerId: 'p2', playerName: 'Bob', kills: 5, deaths: 30 },
    ],
    { data: { currentMap: 'Hurtgen Forest' }, matchTimeRemainingSeconds: 1800 }
  );

  assert.equal(result.transitioned, true);

  await awardMatchEndVIPs({ db, bifrost, endedMatchEpoch: result.endedMatchEpoch });

  assert.ok(vips.has('p1'), 'Alice (kill leader) should have been granted VIP');
  assert.ok(vips.has('p2'), 'Bob (death leader) should have been granted VIP');
  assert.equal(messages.length, 2); // one "Match MVP" + one "Most Deaths" announcement
  assert.match(messages.find((m) => m.includes('MVP')), /Alice/);
  assert.match(messages.find((m) => m.includes('Deaths')), /Bob/);

  db.close();
});

test('end-to-end: expired VIP grant gets revoked by the hourly sweep', async () => {
  const { fetchFn, vips } = makeFakeFetch();
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });
  const db = openDb(':memory:');

  await bifrost.addVip('p1', 'Alice');
  vips.add('p1'); // fake fetch already does this, kept explicit for clarity
  const pastExpiry = new Date(Date.now() - 1000).toISOString();
  db.recordVipGrant('p1', 'Alice', 'most_kills', 1, pastExpiry);

  await sweepExpiredVips({ db, bifrost });

  assert.ok(!vips.has('p1'), 'expired VIP should have been revoked');
  const remaining = db.getExpiredUnrevokedVips(new Date().toISOString());
  assert.equal(remaining.length, 0);

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
  const { fetchFn, getTokenIssuedCount } = makeFakeFetch();
  const bifrost = new BifrostClient({ clientId: 'id', clientSecret: 'secret', serverId: 'server-1', fetchFn });

  await bifrost.getPlayers();
  await bifrost.getGameState();
  await bifrost.getPlayers();

  assert.equal(getTokenIssuedCount(), 1, 'token should only be fetched once for 3 calls within its validity window');
});
