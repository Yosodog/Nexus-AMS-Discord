# Troubleshooting

Start with the symptom you see. Check the bot logs and Nexus logs at the same time when a request crosses both systems.

Do not paste tokens, API credentials, relay keys, `.env` files, raw private messages, or connection publication contents into a support ticket.

## The bot is offline

Check:

1. The process is running.
2. `DISCORD_BOT_TOKEN` contains the current token from the correct Discord application.
3. The bot has outbound internet access to Discord.
4. The required privileged intents are enabled in both the Discord Developer Portal and the bot configuration.
5. The host is running Node.js 22 or newer.

Run:

```bash
node --version
npm start
```

An invalid token or disabled privileged intent normally appears during Discord login. Fix the Discord application setting before restarting repeatedly.

## Slash commands are missing

For a dedicated bot, confirm that `DISCORD_GUILD_ID` is the server where the application was installed. Then run:

```bash
npm run register
```

Dedicated commands are registered directly to one server. Shared commands are registered globally to the Discord application.

Also check that:

- `DISCORD_CLIENT_ID` belongs to the same application as `DISCORD_BOT_TOKEN`.
- The install used the `applications.commands` and `bot` scopes.
- You did not invite one application and register commands for another.
- Command registration completed without an import or validation error.

## Discord says the application did not respond

The bot may be stopped, unable to reach Nexus, or missing a valid server connection.

Check the bot log for the interaction time. Then check:

- `NEXUS_API_URL` is reachable from the bot host.
- The Nexus TLS certificate is valid.
- `NEXUS_API_KEY` matches `DISCORD_BOT_KEY` in Nexus.
- The Application ID and server ID match on both sides.
- The relay private key matches the public key stored in Nexus.
- Nexus has completed its migrations and its database, cache, and queue services are available.

Do not repeat a money-moving command until you know whether Nexus accepted the first request. Check the Nexus receipt or audit record first.

## `/nexus status` says the server is not configured

Dedicated mode:

- Check `BOT_DEPLOYMENT_MODE=dedicated`.
- Check `DISCORD_GUILD_ID` on both the bot and Nexus.
- Confirm the bot was invited to that server.

Shared mode:

- Confirm the publication contains the correct Application ID and server ID.
- Confirm the connection is `active` and has not expired.
- Check the publication refresh result in the process heartbeat and logs.
- Make sure there is exactly one current connection for the server.

An invite does not create a shared connection. The operator must publish it.

## Relay proof errors

### `invalid_discord_relay_proof`

The private and public relay keys may not match, or the signed request may have been changed in transit. Generate a fresh pair if you cannot prove where both values came from.

### `unknown_discord_relay_key`

The relay key ID sent by the bot is not accepted by Nexus. Compare:

- Bot `NEXUS_DISCORD_RELAY_KEY_ID` and `NEXUS_DISCORD_RELAY_CURRENT_KEY_ID`.
- Nexus `DISCORD_RELAY_CURRENT_KEY_ID`.
- The current and next key activation times during rotation.

### `stale_discord_connection_generation`

The bot and Nexus use different generations. Do not lower the Nexus generation. Update the stale side to the current generation and verify that the connection ID, Application ID, and server ID still match.

### `discord_connection_binding_mismatch`

The signed connection belongs to another Discord application or server. Check IDs carefully. Do not work around this error by copying a credential from the other connection.

## Nexus returns unauthorized or forbidden

Unauthorized usually means the API credential, relay proof, or linked Discord identity could not be verified.

Forbidden usually means Nexus identified the user but denied the operation. Discord roles do not grant Nexus permissions. Check the user's Nexus account, active Discord link, alliance membership, MFA requirement, and Nexus permissions.

## Verification does not work

1. Generate a new verification code in Nexus.
2. Run `/verify` from the configured Discord server.
3. Check that the Discord account is not already linked to a different active Nexus user.
4. Confirm the code has not expired or already been used.
5. Check the Nexus user verification page and audit log.

Do not post a verification code in a public channel.

## The bot cannot create an application channel

Check:

- The bot has Manage Channels.
- The configured category exists in the same server.
- The bot can view the category.
- The server has room for another channel.
- The applicant and staff role IDs belong to the same server.

The bot creates private channel permission overwrites. Do not manually copy an interview channel to another server.

## The bot cannot add or remove roles

Check:

- The bot has Manage Roles.
- The bot's highest role is above every Nexus-managed role.
- The target role is not managed by another integration.
- The target member is below the bot in Discord's role hierarchy.
- Server Members Intent is enabled if the workflow fetches the member list.

Moving the bot role above administrator or staff roles is not an acceptable fix. Move only the roles Nexus is supposed to manage below it.

## War-room creation or archive fails

Check:

- The bot can view the configured forum or channel.
- The bot has Send Messages in the forum and Send Messages in Threads.
- The bot has Manage Threads for rename, lock, and archive work.
- The configured forum tag IDs still exist.
- The Nexus queue item still has a valid lease.

If Discord created a thread but Nexus did not save the checkpoint, inspect the Nexus reconciliation record before retrying. A blind retry may create a second thread.

## Alerts or direct messages do not arrive

For direct messages:

- The user must allow direct messages from server members or otherwise permit the bot to message them.
- Private Nexus notifications must be enabled by the alliance administrator.
- The user must opt in to the relevant category in Nexus.

The bot does not fall back from a failed direct message to a public channel.

For channel alerts, confirm the channel still exists, belongs to the configured server, and allows the bot to view and send messages.

## The health check fails

Run:

```bash
npm run healthcheck
```

Common results:

| Reason | Meaning |
| --- | --- |
| `unavailable` | The heartbeat file is missing, unreadable, or not valid JSON. |
| `unsupported_contract` | The heartbeat was written by an incompatible service or schema version. |
| `not_ready` | The process is starting, stopping, stopped, degraded, or failed. |
| `missing_build_metadata` | Build or release metadata is malformed. |
| `runtime_not_ready` | The dedicated server is unavailable, the queue worker is stopped, or a lease is unhealthy. |
| `invalid_heartbeat` | The heartbeat timestamp cannot be read. |
| `future_heartbeat` | The host clocks are too far apart or the heartbeat is future-dated. |
| `stale_heartbeat` | The process stopped updating the file before the allowed age. |

Check that the service account can write the directory containing `PROCESS_HEALTH_FILE`.

The current CLI health contract is intended for dedicated mode. Shared-mode operators should also monitor publication refresh state and Discord gateway health rather than treating this command as their only readiness check.

## A shared publication is rejected

The log reports an error code but does not print the file contents. Check the candidate file locally for:

- Valid JSON with one top-level array.
- No duplicate object keys.
- A size below 1 MiB.
- The exact Discord Application ID for the hosted bot.
- One current active connection per server.
- A public HTTPS Nexus endpoint.
- A non-empty per-connection API credential.
- A valid base64 PKCS#8 Ed25519 relay private key.
- A generation that is not lower than the last accepted value.
- A relay key ID that matches `serviceOptions.relayCurrentKeyId`.

Do not log the file to diagnose it. Validate it on a protected host.

## Duplicate Discord delivery

Queue delivery is at least once. The bot uses Discord nonces, queue checkpoints, dedupe keys, and Nexus leases to reduce duplicates, but a crash can leave the final result uncertain.

Before replaying an item:

1. Check whether Discord already contains the expected channel, thread, role change, or message.
2. Check the Nexus queue checkpoint and delivery status.
3. Use the Nexus reconciliation workflow when one exists.
4. Requeue only after you know which steps completed.

## What to include in a support report

Include:

- The UTC time of the failure.
- The bot build commit and Nexus release ID.
- Dedicated or official-shared mode.
- The command or queue action name.
- The safe error code from the bot and Nexus logs.
- Whether the problem affects one server or every server.
- The steps already checked from this guide.

Do not include private message contents, financial data, application transcripts, credentials, relay signatures, or the connection publication.
