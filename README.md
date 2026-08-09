# Nexus AMS Discord Bot

Discord integration for Nexus AMS. The bot provides account verification, application workflows, moderation and finance commands, and leased delivery of Nexus-generated Discord actions.

## Features

- Guild-scoped, ephemeral slash commands for accounts, deposits, withdrawals, transactions, requests, grants, loans, war aid, rebuilding, raids, wars, spy assignments, and applications, plus the existing operational commands.
- Nexus-backed authorization for sensitive commands; Nexus remains the permission authority.
- Application interview channels with recoverable Nexus metadata and text-only transcript forwarding.
- Leased queue delivery for alerts, private workflow DMs, member departures, role removal, and war-room creation/archive.
- Structured logging, bounded API retries, durable war-room checkpoints, and Discord nonce deduplication.
- Graceful process shutdown and fail-closed command loading/registration.

## Project Structure

- `src/bot.js` — boots Discord, services, listeners, and graceful shutdown handling.
- `src/commands/` — slash command modules.
- `src/listeners/` — Discord interaction and message listeners.
- `src/services/` — Nexus API transport, leased queue worker, stable dispatcher, and logging.
- `src/healthcheck.js` — validates the local process heartbeat without contacting Discord or Nexus.
- `src/services/queueActions/` — validated action modules; each exports `validate(payload)` and `execute(command, context)`.
- `src/utils/` — configuration, boundary validation, and channel identity helpers.
- `src/registerCommands.js` — publishes the command set globally for official-shared mode or to the configured guild for dedicated mode.

## Requirements and Configuration

- Node.js 22 or newer.
- A Discord application and bot user. Dedicated mode also configures one guild.
- A compatible Nexus deployment with the leased Discord queue APIs and migrations.

Create the local environment file:

```bash
cp .env.example .env
npm ci
```

Configure:

- `NODE_ENV`: use `production` on the production host.
- `LOG_LEVEL`: optional `DEBUG`, `INFO`, `WARN`, or `ERROR` threshold.
- `BOT_DEPLOYMENT_MODE`: `dedicated` by default, or `official-shared` for one bot serving explicit connection publications.
- `DISCORD_BOT_TOKEN`: bot token.
- `DISCORD_CLIENT_ID`: Discord application snowflake.
- `DISCORD_GUILD_ID`: the only accepted guild in dedicated mode.
- `NEXUS_API_URL`: Nexus base URL. Development may use HTTP; production startup requires HTTPS.
- `NEXUS_API_KEY`: shared bot credential issued by Nexus.
- `NEXUS_DISCORD_RELAY_PRIVATE_KEY`: base64 PKCS#8 Ed25519 private key used to sign the actual Gateway interaction identity and command sent to Nexus.
- `PROCESS_HEALTH_FILE`: local atomic readiness file; defaults to `data/process-health.json`.
- `PROCESS_HEALTH_INTERVAL_MS`: heartbeat interval; defaults to 15 seconds.
- `PROCESS_HEALTH_STALE_AFTER_MS`: maximum accepted heartbeat age; defaults to 45 seconds.
- `BUILD_COMMIT`: immutable source/image revision exposed in local build metadata.
- `NEXUS_RELEASE_ID`: server-assigned release identifier exposed in local build metadata.

Official-shared mode additionally supports:

- `DISCORD_CONNECTIONS_FILE`: preferred path to a complete JSON connection snapshot. A valid changed snapshot is activated without restarting the bot.
- `DISCORD_CONNECTION_REFRESH_MS`: snapshot refresh interval; defaults to 30 seconds.
- `DISCORD_CONNECTIONS_JSON`: static startup fallback using the same array shape. It remains supported for compatibility but is not refreshed.

### Official-shared connection snapshots

The publication file is a complete array, not a patch stream. Each entry binds one Discord application/guild to one Nexus endpoint, connection generation, relay key, capability set, expiry, and secret-backed service options:

```json
[
  {
    "applicationId": "123456789012345678",
    "guildId": "223456789012345678",
    "connectionId": "11111111-2222-4333-8444-555555555555",
    "generation": 8,
    "protocolVersion": 2,
    "keyId": "relay-k2",
    "endpointOrigin": "https://nexus.example",
    "expiresAt": "2026-08-08T19:00:00.000Z",
    "capabilities": {
      "commands": {
        "nexus": 1
      }
    },
    "serviceOptions": {
      "apiKey": "secret-store-value",
      "relayPrivateKey": "secret-store-value",
      "relayCurrentKeyId": "relay-k2"
    }
  }
]
```

Write a temporary file with restrictive permissions and atomically rename it over the configured path. Never expose the file through a web root or log its contents. Invalid JSON, duplicate keys, another Discord application, duplicate active guild routes, generation rollback, and same-generation identity replacement are rejected as a unit. The prior accepted snapshot remains usable only until each connection's `expiresAt`, so an unreadable control-plane source cannot extend routing indefinitely.

Removing a route fences its accepted generation. An explicit `[]` revokes all routes immediately; reactivation requires a higher generation. Updating credentials or the relay key for the same application/guild/connection/generation is accepted and clears cached clients without restarting. The bot's publication high-water mark is process-local; Nexus's accepted connection generation remains the authoritative cross-restart fence. Dedicated mode and static `DISCORD_CONNECTIONS_JSON` do not depend on this file or on Nexus Cloud.

Generate the asymmetric relay key pair once:

```bash
npm run keygen:relay
```

Store `NEXUS_DISCORD_RELAY_PRIVATE_KEY` only in the bot environment. Put the generated `DISCORD_RELAY_PUBLIC_KEY` in the Nexus environment. Do not reuse the Discord bot token or Discord application public key for this purpose.

Discord.js receives interactions through the Gateway, which does not include Discord's HTTP interaction signature headers. The relay proof is therefore generated from the Gateway interaction object inside the bot and signed with this dedicated private key. Nexus verifies the signature, guild, actor, interaction ID, freshness, and action before resolving permissions.

Startup rejects malformed URLs and Discord snowflakes. Dedicated traffic is constrained to `DISCORD_GUILD_ID`; official-shared traffic is constrained to the one current application/guild/connection/generation resolved from the accepted snapshot.

## Running and Commands

The expanded user-facing commands are `/accounts`, `/deposit`, `/withdraw`, `/transactions`, `/requests`, `/grant`, `/loan`, `/waraid`, `/rebuild`, `/raid`, `/war`, `/spy`, and `/applications`. They are registered as normal top-level Discord commands; domain commands use subcommands where appropriate. Nexus resolves the linked actor and remains authoritative for ownership, permissions, balances, eligibility, limits, and all state changes.

Register the validated command set after adding or changing commands:

```bash
npm run register
```

Start the bot:

```bash
npm start
```

Probe the already-running process without making a Discord or Nexus request:

```bash
npm run healthcheck
```

Command loading is atomic. An import failure, malformed command export, serialization error, or duplicate command name aborts startup/registration; the registration script never replaces Discord commands with a partial set.

## Application Transcripts

Application channels are identified by Nexus application/nation metadata, with exact legacy channel-name support during migration. Only messages from the interaction's resolved guild and verified application channels are forwarded.

Transcripts are intentionally text-only:

- Attachment-only and embed-only messages are ignored.
- Attachments are not uploaded or persisted by the bot.
- The bot sends message and author identifiers; Nexus derives staff status and deduplicates Discord message IDs.

## Queue Delivery and Recovery

The bot claims one queue item at a time through the leased Nexus queue API. Nexus issues a five-minute lease, and the bot renews active leases every 60 seconds. The worker does not claim another item until the current Discord work and completion/failure acknowledgement are resolved or the lease is no longer safe to use.

War-room creation checkpoints the Discord thread ID in Nexus before follow-up messages. Stable Discord nonces reduce duplicate messages when an acknowledged request is replayed. Delivery remains at-least-once: operators should investigate reconciliation logs after crashes or ambiguous Discord/API failures.

Nexus reaps expired leases every minute on one scheduler instance. Failed attempts retry after one and two minutes; the third failed/expired attempt becomes terminal. Keep the Nexus scheduler running in production.

Legacy rows already marked `processing` without a lease are never replayed automatically. Inspect them from the Nexus application first:

```bash
php artisan discord-queue:recover-legacy
```

After reviewing possible Discord side effects, explicitly requeue selected IDs only:

```bash
php artisan discord-queue:recover-legacy 550e8400-e29b-41d4-a716-446655440000 --requeue
```

Deploy Nexus queue migrations/APIs before deploying this bot version.

Private workflow notifications use the structured `PRIVATE_NOTIFICATION` queue action and are delivered only by DM. The bot accepts local allowlisted event templates, never arbitrary Nexus message text or URLs, and never falls back to a public channel. Nexus ships the alliance-wide notification master switch disabled; an administrator must enable it after both deployments are healthy. Linked users default to disabled and must opt in by category in Nexus.

Recommended rollout order:

1. Back up Nexus and deploy its code and migrations.
2. In dedicated mode, set matching `DISCORD_BOT_KEY`/`NEXUS_API_KEY` values and the same `DISCORD_GUILD_ID` in both services. In official-shared mode, prepare the complete connection snapshot after Nexus accepts the binding.
3. Generate each relay key pair, keep its private key with the bot connection secret, and put only its public key in the corresponding Nexus installation.
4. Keep the Nexus private-notification master switch disabled.
5. Deploy the bot, run `npm run register`, and restart the queue worker.
6. Smoke-test account reads, a deposit code, a within-limit withdrawal, an above-limit review case, and DM failure handling.
7. Enable private Discord notifications in Nexus when delivery results are healthy.

## Readiness and Build Metadata

The bot writes an atomic JSON heartbeat with mode `0600`. Readiness is reported
only after Discord emits `ClientReady` and the leased queue worker has started;
dedicated mode also requires its configured guild in the client cache. Missing,
malformed, future-dated, stale, stopping, stopped, failed-guild, stopped-worker,
and unhealthy-lease states all make `npm run healthcheck` exit nonzero.

The heartbeat contains the package version, sanitized build/release identifiers,
booleans and counters for the worker, active connection counts, and dedicated
guild availability. File-backed shared mode also reports bounded publication
refresh health without route or credential identifiers. It deliberately omits
guild IDs, worker IDs, queue IDs, lease tokens,
Nexus URLs, Discord/Nexus credentials, relay keys, command payloads, and API
responses. Place `PROCESS_HEALTH_FILE` on the writable runtime mount used by the
bot and run the probe as the same non-root user.

## Shutdown Behavior

`SIGTERM` or `SIGINT` stops new queue claims and stops scheduling lease
renewals, then lets an active item (or a claim already in flight) finish and
acknowledge only while its last confirmed five-minute lease remains safe to
use. The Discord client stays available during that bounded drain. A second
signal forces immediate termination. Process managers should allow at least
310 seconds before sending `SIGKILL`; most shutdowns finish immediately when
no item is active.

## Development and CI

```bash
npm run lint          # syntax-check src/ and test/
npm test              # run the Node test suite
npm run check         # lint, then run tests
npm run healthcheck   # validate the local running-process heartbeat
npm run test:coverage # full src/**/*.js coverage with enforced gates
npm audit --omit=dev --audit-level=high
```

Coverage gates are 80% lines, 65% branches, and 80% functions. GitHub Actions runs Node 22 with `npm ci`, lint, tests, coverage, and the high-severity production dependency audit on pushes to `main` and pull requests.

## Adding Commands

Create a `.js` file in `src/commands/` exporting:

- `data`: a serializable `SlashCommandBuilder` definition.
- `execute(interaction, context)`: the command handler.

Command names must be unique. Do not add Discord role allowlists for Nexus-authorized operations; keep Nexus as the authoritative permission boundary.

Logging redacts configured secrets, but code must still avoid logging credentials, raw API response bodies, or sensitive payloads.
