# Configuration reference

The bot and Nexus use different variable names for the same connection. Keep both `.env` files open while you configure them, and check every matching value before starting the bot.

Never commit either `.env` file. The repository ignores it by default.

## Configure a dedicated connection

Dedicated mode connects one bot process to one Discord server and one Nexus installation.

### Create the shared API credential

Generate a random value:

```bash
openssl rand -hex 32
```

Store that value in:

- `NEXUS_API_KEY` on the bot host.
- `DISCORD_BOT_KEY` on the Nexus host.

The values must match exactly.

### Create the relay key

From the bot repository:

```bash
umask 077
npm run keygen:relay > relay-keys.env
```

The file contains:

- `NEXUS_DISCORD_RELAY_PRIVATE_KEY`, which stays on the bot host.
- `DISCORD_RELAY_CURRENT_PUBLIC_KEY`, which goes to Nexus.

Delete `relay-keys.env` after both systems are configured, or store it in an encrypted secret manager.

### Dedicated relay v2

Relay v2 binds each signed request to the Discord application, server, connection ID, generation, HTTP method, request path, request body, action, actor, nonce, timestamp, and signing key.

Create a connection ID:

```bash
node -e "console.log(require('node:crypto').randomUUID())"
```

The generated `DISCORD_RELAY_CURRENT_PUBLIC_KEY` value is already the base64url-encoded raw Ed25519 public key required by Nexus v2; copy it without conversion.

Add these values to the bot `.env`:

```env
NEXUS_DISCORD_CONNECTION_ID=11111111-2222-4333-8444-555555555555
NEXUS_DISCORD_CONNECTION_GENERATION=1
NEXUS_DISCORD_RELAY_PROTOCOL=2
NEXUS_DISCORD_RELAY_KEY_ID=relay-k1
NEXUS_DISCORD_RELAY_CURRENT_KEY_ID=relay-k1
```

Add the matching values to the Nexus `.env`:

```env
DISCORD_CONNECTION_MODE=dedicated
DISCORD_CONNECTION_ID=11111111-2222-4333-8444-555555555555
DISCORD_CONNECTION_GENERATION=1
DISCORD_RELAY_PROTOCOL_VERSION=2
DISCORD_RELAY_CURRENT_KEY_ID=relay-k1
DISCORD_RELAY_CURRENT_PUBLIC_KEY=replace-with-the-base64url-public-key
DISCORD_RELAY_V1_READER_ENABLED=false
```

The connection ID, generation, key ID, application ID, and server ID must match on both sides. Nexus rejects a request when any one of them differs.

## Nexus capability settings

Nexus uses its connection capability list to decide which work it may send to the bot.

Current transport capabilities:

```env
DISCORD_CAPABILITY_VERSION=1
DISCORD_CAPABILITIES=relay.proof.v2,queue.leases.v1,queue.connection-context.v1,status.provider-diagnostics.v1
```

Current queue actions:

```env
DISCORD_SUPPORTED_QUEUE_ACTIONS=ALERT_DELIVERY_V1,APPLICATION_DISCORD_RECONCILE,WAR_ALERT,ALLIANCE_DEPARTURE,INACTIVITY_ALERT,MEMBER_PROFILE_SYNC,ALLIANCE_ROLE_REMOVAL,BEIGE_ALERT,CITY_TIER_SYNC,WAR_ROOM_CREATE,WAR_ROOM_ARCHIVE,PRIVATE_NOTIFICATION
```

Only advertise queue actions available in the bot version you are running. Feature switches and Nexus permissions still decide whether Nexus creates any work for those actions.

## Bot variable reference

### Core settings

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Production | Set to `production` on a live host. Production requires HTTPS for Nexus. |
| `LOG_LEVEL` | No | `DEBUG`, `INFO`, `WARN`, or `ERROR`. Production defaults to `INFO`. |
| `BOT_DEPLOYMENT_MODE` | Yes | Use `dedicated` for one server or `official-shared` for the operator-managed shared runtime. |
| `DISCORD_BOT_TOKEN` | Yes | Secret token from the Discord Developer Portal. |
| `DISCORD_CLIENT_ID` | Yes | Discord Application ID. |
| `DISCORD_GUILD_ID` | Dedicated | Discord server ID accepted by a dedicated bot. |

### Discord intents

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_GUILD_MEMBERS_INTENT` | `true` | Lets the bot fetch members and perform member and role workflows. The matching privileged intent must be enabled in Discord. |
| `DISCORD_MESSAGE_CONTENT_INTENT` | `true` | Lets the bot forward text from verified application channels. The matching privileged intent must be enabled in Discord. |

Set an intent to `false` only if you understand which features will stop working.

### Dedicated Nexus connection

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXUS_API_URL` | Dedicated | Base URL for Nexus. Production requires HTTPS, but a dedicated bot may use an address on its private network. |
| `NEXUS_API_KEY` | Dedicated | Must match `DISCORD_BOT_KEY` in Nexus. |
| `NEXUS_DISCORD_RELAY_PRIVATE_KEY` | Dedicated | Base64 PKCS#8 Ed25519 private key used to sign relay proofs. |
| `NEXUS_DISCORD_CONNECTION_ID` | Dedicated | Required connection UUID shared with Nexus. |
| `NEXUS_DISCORD_CONNECTION_GENERATION` | Dedicated | Required positive generation number shared with Nexus. |
| `NEXUS_DISCORD_RELAY_PROTOCOL` | No | `2` by default. Any other value is rejected at startup. |
| `NEXUS_DISCORD_RELAY_KEY_ID` | Dedicated | Required signing key ID accepted by Nexus. |
| `NEXUS_DISCORD_RELAY_CURRENT_KEY_ID` | Relay v2 | Current signing key ID. Keep it equal to `NEXUS_DISCORD_RELAY_KEY_ID`. |
| `NEXUS_DISCORD_CAPABILITIES_JSON` | No | Optional JSON capability object. Omit it in dedicated mode unless you need to limit command availability. |

### Shared runtime

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_CONNECTIONS_FILE` | Recommended | Path to the protected shared connection publication. |
| `DISCORD_CONNECTION_REFRESH_MS` | No | Refresh interval in milliseconds. Defaults to `30000`. |
| `DISCORD_CONNECTIONS_JSON` | No | Static startup fallback. It is not refreshed and is harder to protect than a file. |
| `DISCORD_SCHEDULER_QUANTUM` | No | Fair-scheduler quantum. Defaults to `1`. |

See [Operate the shared bot](shared-hosting.md) before using these settings.

### Health and release metadata

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROCESS_HEALTH_FILE` | `data/process-health.json` | Private heartbeat file used by the local health command. |
| `PROCESS_HEALTH_INTERVAL_MS` | `15000` | Time between heartbeat writes. |
| `PROCESS_HEALTH_STALE_AFTER_MS` | `45000` | Maximum heartbeat age accepted by the health command. |
| `BUILD_COMMIT` | `unknown` | Commit or image revision written to health metadata. |
| `NEXUS_RELEASE_ID` | `unknown` | Matching Nexus release identifier written to health metadata. |

## Settings that must match

| Bot | Nexus |
| --- | --- |
| `DISCORD_CLIENT_ID` | `DISCORD_APPLICATION_ID` |
| `DISCORD_GUILD_ID` | `DISCORD_GUILD_ID` |
| `NEXUS_API_KEY` | `DISCORD_BOT_KEY` |
| `NEXUS_DISCORD_CONNECTION_ID` | `DISCORD_CONNECTION_ID` |
| `NEXUS_DISCORD_CONNECTION_GENERATION` | `DISCORD_CONNECTION_GENERATION` |
| `NEXUS_DISCORD_RELAY_PROTOCOL` | `DISCORD_RELAY_PROTOCOL_VERSION` |
| `NEXUS_DISCORD_RELAY_KEY_ID` | `DISCORD_RELAY_CURRENT_KEY_ID` |
| Relay private key | Matching `DISCORD_RELAY_CURRENT_PUBLIC_KEY` |

## Protect the configuration

- Set `.env` and connection publication files to mode `0600` when possible.
- Run the bot under its own operating-system account.
- Keep the bot token, API credential, and relay private key out of logs, tickets, screenshots, and chat.
- Use separate API and relay credentials for every shared connection.
- Rotate a credential immediately if it may have been copied or exposed.
- Do not expose the connection publication from a web server or shared volume.
