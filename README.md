# TRR Bifrost Stats Bot

A background bot for The Rogue Regiment's Hell Let Loose server. Polls the
[Bifrost Gaming API](https://developer.bifrostgaming.com) every 30 seconds to
track live kills and deaths, announces the current kill leader in-game every
15 minutes, and automatically awards 7-day VIP at the end of each match to
the player(s) with the most kills and the player(s) with the most deaths.

## How it works

- **Polling (every 30s):** calls `guildGetPlayers` and `guildGetGameState`.
  Kills/deaths are tracked as **deltas from a per-match baseline**, so it
  works correctly whether the API's raw numbers are per-match or
  session-cumulative.
- **Match detection:** since Bifrost has no match-start/end webhook, a new
  match is detected when the reported map name changes, or when the match
  clock's time-remaining jumps up significantly (a fresh match starting).
- **Announcements (every 15 min):** posts the current match's kill leader(s)
  via `guildSendMessageToAll`, respecting the 200-character limit and tying
  players who are equal on kills.
- **VIP awards (at match end):** grants VIP via `guildAddVip` to every player
  tied for most kills, and separately to every player tied for most deaths.
  Bifrost's `guildAddVip` has no duration parameter, so this bot tracks its
  own 7-day expiry in SQLite and calls `guildRemoveVip` itself once expired
  (checked hourly).
- **Persistence:** all match/leaderboard/VIP state lives in a SQLite file so
  the bot can restart mid-match without losing progress.

## Local setup

```bash
npm install
cp .env.example .env
# fill in BIFROST_CLIENT_ID, BIFROST_CLIENT_SECRET, BIFROST_SERVER_ID in .env
npm start
```

Run the test suite (pure-logic tests, no network/API calls):

```bash
npm test
```

## Deploying to Render

1. Push this repo to GitHub.
2. In Render, create a new **Background Worker** and point it at the repo —
   `render.yaml` in this repo already describes the service, disk, and env
   var names, so Render will pick it up automatically via a Blueprint.
3. Fill in `BIFROST_CLIENT_ID`, `BIFROST_CLIENT_SECRET`, and
   `BIFROST_SERVER_ID` in the Render dashboard's environment variables
   (never commit these — `render.yaml` intentionally leaves them blank).
4. Deploy. `DB_PATH` is pre-set to `/data/trr-bot.db`, which lives on the
   attached persistent disk so state survives restarts/redeploys.

## Rate limits

Bifrost enforces per-endpoint rate limits. This bot's steady-state usage is
well within all of them:

| Call | Frequency | Bifrost limit |
|---|---|---|
| `guildGetPlayers` | every 30s | 1 / 30s per server |
| `guildGetGameState` | every 30s | 1 / 30s per server |
| `guildSendMessageToAll` | every 15 min (+ match end) | 12 / min per server |
| `guildAddVip` / `guildRemoveVip` | per match / hourly sweep | 150 / 5 min per server |

The Bifrost client also honors `429` responses' `retryAfter` value and
force-refreshes the OAuth token on a `401`, so transient rate-limit hits or
token expiry don't crash the process.
