# TRR Bifrost Stats Bot

A background bot for The Rogue Regiment's Hell Let Loose server. Polls the
[Bifrost Gaming API](https://developer.bifrostgaming.com) every 30 seconds to
track kills, deaths, combat score, and defense score, announces the current
leader in each category in-game every 15 minutes, and automatically awards
7-day VIP at the end of each match to the winner(s) of each category.

## How it works

- **Polling (every 30s):** calls `guildGetPlayers` and `guildGetGameState`.
  Kills/deaths/combat score/defense score are all tracked as **deltas from
  a per-match baseline**, so it works correctly whether the API's raw
  numbers are per-match or session-cumulative.
- **Match detection:** since Bifrost has no match-start/end webhook, a new
  match is detected when the reported map name changes, or when the match
  clock's time-remaining jumps up significantly (a fresh match starting).
- **Announcements (every 15 min):** posts one combined message via
  `guildSendMessageToAll` covering all four categories, e.g.:
  ```
  Killing Machine - Alice (22) Kills
  Having a day - Bob (15) Deaths
  Rambo (Combat) - Carl (450)
  Brick wall (Defence) - Dave (380)

  -BigChazzza Bot
  ```
  A category is omitted entirely if nobody has a nonzero value yet. Ties
  are listed as comma-separated names. If the message would exceed
  Bifrost's 200-character cap, tied-name lists are trimmed with "+N more"
  first, then (if still too long) whole categories are dropped starting
  with the lowest-priority one (Brick wall (Defence), then Rambo (Combat))
  — the header and signature are never touched.
- **VIP awards (at match end only):** grants VIP via `guildAddVip` to every
  player tied for the top spot in each of the four categories, then sends a
  "Congratulations!" announcement in the same format. Bifrost's
  `guildAddVip` has no duration parameter, so this bot tracks its own 7-day
  expiry in SQLite and calls `guildRemoveVip` itself once expired (checked
  hourly).
- **Pre-existing VIP is never touched:** if a player already has VIP before
  the bot ever grants them anything (e.g. an existing TRR clan member),
  they're still announced and "awarded" normally, but the bot permanently
  flags them as pre-existing and will **never** call `guildRemoveVip` for
  them. This check happens once per player, the first time they're ever
  considered for an award — a player the bot itself granted VIP to (who
  then shows `isVip: true` on later polls) is correctly recognised as
  bot-managed, not re-flagged as pre-existing, so their 7-day clock still
  expires and revokes normally on repeat wins.
- **Persistence:** all match/leaderboard/VIP state lives in a SQLite file
  (via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html)
  module — no native dependency to compile) so the bot can restart mid-match
  without losing progress. Schema migrations (new columns, dropping an
  outgrown `CHECK` constraint) run automatically and idempotently on every
  startup, so upgrading an already-deployed database is safe.

## Requirements

Node.js **v22.13.0 or later** (needed for `node:sqlite`, which ships in Node
itself with no native build step — this avoids the native-module compile
failures that occur with packages like `better-sqlite3` on newer Node/V8
versions in managed environments such as Render).

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

## Known documentation drift

Bifrost's public docs for `guildAddVip`/`guildRemoveVip` (as of writing) show
flat arguments and a `{success, message}` response, but the **live** schema
actually requires an `input: GuildAddVipInput!` / `input: GuildRemoveVipInput!`
wrapper object, and the response type (`GuildVipMutationResponse`) has no
`message` field — this was confirmed directly from a live 400 error's
GraphQL validation messages, which name the exact expected types. `guildAddVip`'s
fix is fully confirmed this way. `guildRemoveVip`'s input shape was inferred
by analogy (same pattern, `playerName` dropped) since no live error has been
seen for it yet — if the hourly VIP-expiry sweep ever logs a `guildRemoveVip`
failure, check Render logs for the exact validation error and adjust
`removeVip()` in `src/bifrostClient.js` accordingly.

## Unverified: multi-line message rendering in-game

The 15-minute and match-end announcements are built with embedded `\n`
newlines (see the example in "How it works" above). This has been verified
to survive intact through JSON serialization and the GraphQL request body
sent to Bifrost, but **whether Hell Let Loose's in-game chat actually
renders literal newlines as separate lines, or collapses/strips them into
one line, has not been confirmed against the live game client.** If
messages appear as one long run-on line in-game instead of four separate
lines, that's a Bifrost/game-client rendering behavior, not a bug in this
bot's message construction — the fix would be changing the separator in
`formatStatsMessage()` (`src/leaderboard.js`) to something the game does
render as a line break (e.g. a different delimiter), not changing how the
data is sent.
