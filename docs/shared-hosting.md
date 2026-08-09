# Operate the shared bot

This guide is for the team that runs the Nexus hosted Discord application. Alliance administrators should read [Invite the hosted bot](invite-hosted-bot.md) instead.

> Shared mode has a working runtime but no public onboarding service. Use it only for operator-managed pilots until the Cloud connection lifecycle is implemented and approved.

## How shared mode works

One Discord application can be installed in several servers. The bot resolves every interaction by its Discord Application ID and server ID, then selects one current Nexus connection.

Each connection has its own:

- Nexus HTTPS endpoint.
- API credential.
- Relay private key and key ID.
- Connection ID and generation.
- Expiration time and capability list.

Nexus still resolves the Discord user and checks permissions. The shared bot and Nexus Cloud do not decide whether a user may view or change private alliance data.

At launch, one Discord server may have one current primary Nexus connection. No connection or more than one current connection fails closed.

## Current limits

- Public Discord OAuth onboarding is not implemented.
- Proof that an installer controls a Nexus installation is not automated.
- The connection publication is written by the bot operator or trusted deployment automation.
- The current process uses Discord's automatic shard count inside one Node.js process. It does not coordinate shard ownership across several replicas.
- The built-in `npm run healthcheck` contract currently targets dedicated mode. Do not use it as the only readiness probe for a shared pilot. Monitor the process heartbeat, publication refresh status, Discord connection, and active connection count separately.

Do not market shared mode as self-service until these limits are removed.

## Configure the Discord application

Create one Discord application for the hosted service.

1. Enable Guild Install.
2. Use the `bot` and `applications.commands` scopes.
3. Request the permissions listed in [Choose Discord permissions](self-hosting.md#3-choose-discord-permissions).
4. Enable the Server Members and Message Content privileged intents used by the bot.
5. Configure a Discord Provided Link for pilot installs.
6. Keep the bot token in the hosting platform's secret store.

Run command registration in shared mode so commands are published globally:

```bash
BOT_DEPLOYMENT_MODE=official-shared npm run register
```

Global commands belong to the application. Do not register a separate command set for every pilot server.

## Configure the shared process

Example `.env`:

```env
NODE_ENV=production
LOG_LEVEL=INFO
BOT_DEPLOYMENT_MODE=official-shared

DISCORD_BOT_TOKEN=replace-with-the-hosted-bot-token
DISCORD_CLIENT_ID=123456789012345678
DISCORD_CONNECTIONS_FILE=/run/secrets/nexus-discord-connections.json
DISCORD_CONNECTION_REFRESH_MS=30000
DISCORD_SCHEDULER_QUANTUM=1

PROCESS_HEALTH_FILE=/var/lib/nexus-discord/process-health.json
PROCESS_HEALTH_INTERVAL_MS=15000
PROCESS_HEALTH_STALE_AFTER_MS=45000
BUILD_COMMIT=replace-with-the-deployed-commit
NEXUS_RELEASE_ID=replace-with-the-release-id
```

Do not set one global `NEXUS_API_URL`, `NEXUS_API_KEY`, or relay private key for shared tenants. Shared credentials belong inside each protected connection entry.

## Connection publication format

The publication is one complete JSON array. It is not a list of changes.

```json
[
  {
    "applicationId": "123456789012345678",
    "guildId": "223456789012345678",
    "connectionId": "11111111-2222-4333-8444-555555555555",
    "generation": 4,
    "protocolVersion": 2,
    "keyId": "relay-k1",
    "state": "active",
    "endpointOrigin": "https://nexus.example",
    "expiresAt": "2026-08-09T12:00:00.000Z",
    "capabilities": {
      "commands": {
        "help": 1,
        "me": 1,
        "nexus": 1
      },
      "supported_queue_actions": [
        "APPLICATION_DISCORD_RECONCILE",
        "PRIVATE_NOTIFICATION"
      ]
    },
    "serviceOptions": {
      "apiKey": "replace-with-this-installation-api-key",
      "relayPrivateKey": "replace-with-this-installation-private-key",
      "relayCurrentKeyId": "relay-k1"
    }
  }
]
```

The sample advertises only `/help`, `/me`, `/nexus`, and two queue actions. Add only the commands and queue actions supported by the matching Nexus release.

## Configure a standalone Nexus pilot

Use this environment setup when a self-hosted Nexus installation joins an operator-managed shared pilot and does not already have an active persisted Discord connection.

The Nexus administrator creates the API credential and stores it as `DISCORD_BOT_KEY`. The bot operator stores the same value as `serviceOptions.apiKey` in that installation's publication entry. Transfer the value through an approved secret manager, not a Discord message.

The bot operator creates the relay key pair. The private key stays in `serviceOptions.relayPrivateKey`. The Nexus administrator receives only the base64url public key.

Example Nexus `.env`:

```env
DISCORD_BOT_KEY=replace-with-this-installation-api-key
DISCORD_GUILD_ID=223456789012345678
DISCORD_APPLICATION_ID=123456789012345678
DISCORD_CONNECTION_MODE=official-shared
DISCORD_CONNECTION_ID=11111111-2222-4333-8444-555555555555
DISCORD_CONNECTION_GENERATION=4
DISCORD_RELAY_PROTOCOL_VERSION=2
DISCORD_RELAY_CURRENT_KEY_ID=relay-k1
DISCORD_RELAY_CURRENT_PUBLIC_KEY=replace-with-the-base64url-public-key
DISCORD_RELAY_V1_READER_ENABLED=false

DISCORD_CAPABILITY_VERSION=1
DISCORD_CAPABILITIES=relay.proof.v2,queue.leases.v1,queue.connection-context.v1,status.provider-diagnostics.v1
DISCORD_SUPPORTED_QUEUE_ACTIONS=APPLICATION_DISCORD_RECONCILE,PRIVATE_NOTIFICATION
```

Use the public-key conversion command in [Dedicated relay v2](configuration.md#dedicated-relay-v2). The Application ID, server ID, connection ID, generation, relay key ID, API credential, public key, commands, and queue actions must match the publication entry.

Nexus installations with active records in the `discord_connections` table use those records instead of the environment fallback. Update the active connection record through the owning Nexus provider rather than creating a competing environment connection.

Some compatibility endpoints may still require `DISCORD_LEGACY_UNSIGNED_QUEUE_ENABLED` at its default setting. Test the complete application and queue workflow before disabling it.

The file reader rejects:

- Files larger than 1 MiB.
- Invalid JSON and duplicate JSON keys.
- A value other than a top-level array.
- An entry for another Discord application.
- Missing application, generation, relay key, or capability context.
- An endpoint that fails shared-mode HTTPS and public-address checks.
- A missing API credential or an unusable relay signing key.
- More than one current connection for a server.
- A connection ID reused for another server.
- A generation rollback or same-generation identity replacement.

If a refresh is rejected, the previous accepted publication remains in memory. Its original expiration still applies, so it cannot remain trusted forever.

## Publish a file safely

Build and validate the complete replacement before touching the live path. Write the new file in the same directory, set restrictive permissions, then rename it over the live file.

```bash
umask 077
cp nexus-discord-connections.json /run/secrets/nexus-discord-connections.json.new
chmod 600 /run/secrets/nexus-discord-connections.json.new
mv /run/secrets/nexus-discord-connections.json.new /run/secrets/nexus-discord-connections.json
```

The rename must stay on the same filesystem. Do not write the live file one line at a time.

The bot checks the file at `DISCORD_CONNECTION_REFRESH_MS`. A valid changed file replaces all active routes and clears cached Nexus clients. An unchanged file does not rebuild clients.

## Add a pilot connection

1. Have a Discord administrator install the hosted application with the official link.
2. Confirm the Application ID and server ID from Discord.
3. Confirm that an authorized Nexus administrator controls the destination installation.
4. Verify that the Nexus endpoint is public HTTPS and passes the endpoint guard.
5. Create a unique connection UUID and generation `1`.
6. Create a separate API credential and relay key for this connection.
7. Configure the matching v2 connection in Nexus.
8. Add the complete entry to a new publication file.
9. Replace the live file atomically.
10. Run `/nexus status`, then test one read-only command with a linked user.

Do not accept a Nexus URL or credential sent by an unverified Discord account. The current pilot needs an out-of-band approval process because automated dual-control proof is not built yet.

## Rotate credentials

API credentials can be replaced at the same connection ID and generation without restarting the bot process. The current dedicated Nexus configuration accepts one bot API key at a time, so it does not provide a current-and-next overlap for this credential. Coordinate the Nexus and publication updates during a short maintenance window unless your credential provider supports both values during the change.

For relay-key rotation:

1. Create a new Ed25519 key pair and a new key ID.
2. Add the next public key and activation time to Nexus.
3. Add `relayNextKeyId`, `relayNextPrivateKey`, and `relayNextActivatesAt` to the connection's `serviceOptions`.
4. Publish the complete file.
5. Wait until the agreed activation time and confirm signed requests use the next key.
6. Promote the next key to current on both sides and remove the old key after the overlap period.

Key rotation does not require a connection generation change when the application, server, Nexus installation, and connection ID stay the same.

## Suspend, revoke, or replace a connection

To suspend or revoke one connection, publish the entry with `state` set to `suspended` or `revoked`, or remove it from the complete array. The route stops resolving.

Publishing an empty array revokes every route immediately:

```json
[]
```

Once a generation is removed, revoked, suspended, or observed as expired, the running process will not reactivate that generation. A reconnect must use a higher generation.

The bot's high-water record is stored in process memory. Nexus must keep the accepted generation as the authority across bot restarts.

## Deploy and scale carefully

Run one shared bot process unless shard ownership is assigned outside this repository. Starting several identical replicas with `shards: auto` would make each process attempt to own the same gateway shards.

The queue worker schedules claim opportunities fairly across active connections and removes inactive scheduler entries. A noisy installation cannot permanently remove claim opportunities from another active connection, but operators still need per-installation Nexus queue limits and monitoring.

Keep the connection publication available to the process before startup. If it is missing or invalid and no valid static fallback exists, the bot starts with no active routes.

## Migration from a dedicated bot

Do not run the dedicated bot and shared bot against the same active connection at the same time.

1. Upgrade Nexus and the dedicated bot to versions that understand explicit connection IDs and generations.
2. Record the current Application ID, server ID, Nexus endpoint, connection ID, generation, API credential, and relay key.
3. Install the shared Discord application in the server.
4. Create a new shared connection generation and configure it in Nexus.
5. Stop the dedicated bot.
6. Publish the shared route.
7. Register or verify the hosted application's global commands.
8. Test status, user linking, one read command, and one queue delivery.
9. Revoke the old dedicated credential and relay key.

Use a new generation when the Discord application changes. Do not copy the old connection generation to a different application identity.
