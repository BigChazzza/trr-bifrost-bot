const OAUTH_URL = 'https://api.dev.bifrostgaming.com/v1/oauth/token';
const GRAPHQL_URL = 'https://api.dev.bifrostgaming.com/v1/graphql';

// Refresh the token this many ms before it actually expires, so we never
// race a 401 mid-request. Well within the 30-min token-endpoint rate limit
// since a 1hr token only gets refreshed roughly once an hour.
const TOKEN_REFRESH_SLACK_MS = 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BifrostClient {
  constructor({ clientId, clientSecret, serverId, gameType = 'HLL', fetchFn = fetch }) {
    if (!clientId || !clientSecret || !serverId) {
      throw new Error('BifrostClient requires clientId, clientSecret, and serverId');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.serverId = serverId;
    this.gameType = gameType;
    this.fetchFn = fetchFn;

    this._accessToken = null;
    this._tokenExpiresAt = 0; // epoch ms
  }

  async _getAccessToken() {
    if (this._accessToken && Date.now() < this._tokenExpiresAt - TOKEN_REFRESH_SLACK_MS) {
      return this._accessToken;
    }
    return this._refreshToken();
  }

  async _refreshToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await this.fetchFn(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bifrost OAuth token request failed: ${res.status} ${text}`);
    }

    const json = await res.json();
    this._accessToken = json.access_token;
    // expires_in is seconds (documented as always 3600)
    this._tokenExpiresAt = Date.now() + json.expires_in * 1000;
    return this._accessToken;
  }

  /**
   * Low-level GraphQL request with 401 (one forced token refresh + retry)
   * and 429 (honor retryAfter, retry once) handling. Never throws for a
   * second consecutive 429 — callers should treat a null return as
   * "skip this cycle" rather than crash the whole process.
   */
  async _graphqlRequest(query, variables = undefined, { _retried401 = false, _retried429 = false } = {}) {
    const token = await this._getAccessToken();

    const res = await this.fetchFn(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });

    if (res.status === 401 && !_retried401) {
      // Force refresh (ignore cache) and retry exactly once.
      await this._refreshToken();
      return this._graphqlRequest(query, variables, { _retried401: true, _retried429 });
    }

    if (res.status === 429) {
      const payload = await res.json().catch(() => ({}));
      const retryAfterSeconds = payload?.retryAfter ?? payload?.retry_after ?? 5;
      if (_retried429) {
        console.warn(`[bifrost] rate limited twice in a row, giving up this cycle (retryAfter=${retryAfterSeconds}s)`);
        return null;
      }
      console.warn(`[bifrost] rate limited, waiting ${retryAfterSeconds}s before one retry`);
      await sleep(retryAfterSeconds * 1000);
      return this._graphqlRequest(query, variables, { _retried401, _retried429: true });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[bifrost] GraphQL request failed: ${res.status} ${text}`);
      return null;
    }

    const json = await res.json();
    if (json.errors?.length) {
      console.error('[bifrost] GraphQL errors:', JSON.stringify(json.errors));
      return null;
    }
    return json.data;
  }

  /** guildGetPlayers — rate limit 1 req / 30s per server */
  async getPlayers() {
    const query = `
      query GetPlayers($serverId: ID!, $gameType: String) {
        guildGetPlayers(serverId: $serverId, gameType: $gameType) {
          timestamp
          totalCount
          players {
            playerId
            playerName
            playerClanTag
            isVip
            kills
            deaths
            teamkills
          }
        }
      }
    `;
    const data = await this._graphqlRequest(query, { serverId: this.serverId, gameType: this.gameType });
    return data?.guildGetPlayers ?? null;
  }

  /** guildGetGameState — rate limit 1 req / 30s per server */
  async getGameState() {
    const query = `
      query GetGameState($serverId: ID!, $gameType: String) {
        guildGetGameState(serverId: $serverId, gameType: $gameType) {
          data
          timestamp
          matchTimeRemainingSeconds
        }
      }
    `;
    const data = await this._graphqlRequest(query, { serverId: this.serverId, gameType: this.gameType });
    return data?.guildGetGameState ?? null;
  }

  /** guildAddVip — rate limit 150 req / 5min per server */
  async addVip(playerId, playerName) {
    const query = `
      mutation AddVip($serverId: ID!, $playerId: String!, $playerName: String!, $gameType: String) {
        guildAddVip(serverId: $serverId, playerId: $playerId, playerName: $playerName, gameType: $gameType) {
          success
          message
        }
      }
    `;
    const data = await this._graphqlRequest(query, {
      serverId: this.serverId,
      playerId,
      playerName,
      gameType: this.gameType,
    });
    return data?.guildAddVip ?? null;
  }

  /** guildRemoveVip — rate limit 150 req / 5min per server */
  async removeVip(playerId) {
    const query = `
      mutation RemoveVip($serverId: ID!, $playerId: String!, $gameType: String) {
        guildRemoveVip(serverId: $serverId, playerId: $playerId, gameType: $gameType) {
          success
          message
        }
      }
    `;
    const data = await this._graphqlRequest(query, {
      serverId: this.serverId,
      playerId,
      gameType: this.gameType,
    });
    return data?.guildRemoveVip ?? null;
  }

  /** guildSendMessageToAll — rate limit 12 req / min per server, 200 char cap */
  async sendMessageToAll(message) {
    const query = `
      mutation SendMessageToAll($input: GuildSendMessageToAllInput!) {
        guildSendMessageToAll(input: $input) {
          success
          message
          playersNotified
          error
          timestamp
        }
      }
    `;
    const data = await this._graphqlRequest(query, {
      input: { serverId: this.serverId, message },
    });
    return data?.guildSendMessageToAll ?? null;
  }
}
