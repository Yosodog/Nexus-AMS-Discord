# Self-host the bot

Use this guide when you want to run your own Discord application for one Nexus installation and one Discord server. This is called dedicated mode.

You do not need Nexus Cloud for this setup.

## Before you start

You need:

- A server or virtual machine that can run Node.js 22 or newer.
- A working [Nexus AMS installation](https://github.com/Yosodog/Nexus-AMS).
- A Discord account that can create an application and install it in the server.
- An HTTPS address for Nexus that the bot host can reach. A dedicated setup may use a private network address.
- Access to edit the `.env` file for both the bot and Nexus.

The bot does not need an inbound public port. It opens an outgoing Discord Gateway connection and makes outgoing HTTPS requests to Nexus.

## 1. Download the bot

```bash
git clone https://github.com/Yosodog/Nexus-AMS-Discord.git
cd Nexus-AMS-Discord
npm ci
cp .env.example .env
chmod 600 .env
```

Run the bot as a normal service account, not as root. Keep the repository and `.env` file private to that account.

## 2. Create the Discord application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select "New Application" and give it a name.
3. Open the Bot page and create the bot user if Discord has not created one already.
4. Copy the bot token into a password manager. You will put it in `DISCORD_BOT_TOKEN` later.
5. Enable the Server Members Intent.
6. Enable the Message Content Intent if you use application transcript forwarding or message-based automation.
7. Open the Installation page.
8. Enable Guild Install. This bot does not use User Install.
9. For Guild Install, select the `bot` and `applications.commands` scopes.

Discord treats the bot token like a password. If it is exposed, reset it in the Developer Portal and update the bot host immediately.

## 3. Choose Discord permissions

Request only the permissions used by your Nexus features.

| Permission | Why the bot may need it |
| --- | --- |
| View Channels | Read configured channels and resolve queue targets |
| Send Messages | Reply in channels and create forum posts |
| Send Messages in Threads | Post war-room and workflow messages |
| Embed Links | Send formatted command and alert responses |
| Read Message History | Work with application and war-room channels |
| Manage Channels | Create, update, and remove application interview channels |
| Manage Roles | Create city roles and add or remove Nexus-managed roles |
| Manage Threads | Rename, archive, and lock war-room threads |

The bot does not need the Administrator permission.

If you enable role management, place the bot role above every role it is allowed to manage. Discord will refuse role changes when the target role is above the bot's highest role. Keep the bot below administrator and staff roles.

If Nexus mentions a staff or defense role, make that role mentionable. This avoids granting the bot the broad Mention Everyone permission.

## 4. Invite the bot

On the Discord Developer Portal Installation page, copy the Discord Provided Link.

1. Open the link in a browser.
2. Choose "Add to server."
3. Select the server you will connect to Nexus.
4. Review the permissions and approve the install.
5. Confirm that the bot appears in the member list.

The installing user must have Manage Server in the selected server.

## 5. Copy the Discord IDs

You need two IDs:

- The Application ID from the General Information page in the Developer Portal.
- The server ID for the Discord server.

To copy the server ID, enable Developer Mode in Discord, right-click the server, and choose "Copy Server ID."

These IDs are not secrets. The bot token is a secret.

## 6. Create the Nexus credentials

Generate a separate API credential for the bot:

```bash
openssl rand -hex 32
```

Save the value in your password manager. The same value goes in `NEXUS_API_KEY` on the bot and `DISCORD_BOT_KEY` in Nexus.

Generate the relay signing key:

```bash
umask 077
npm run keygen:relay > relay-keys.env
```

The output contains a private key for the bot and a public key for Nexus. Never copy the private key into Nexus. Never copy the public key into the bot token field.

The [configuration reference](configuration.md) has complete examples for the current compatible setup and relay protocol v2.

## 7. Configure the bot and Nexus

Edit the bot's `.env` file and set at least:

```env
NODE_ENV=production
BOT_DEPLOYMENT_MODE=dedicated
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
DISCORD_GUILD_ID=your-server-id
NEXUS_API_URL=https://your-nexus.example
NEXUS_API_KEY=the-shared-api-credential
NEXUS_DISCORD_RELAY_PRIVATE_KEY=the-generated-private-key
NEXUS_DISCORD_CONNECTION_ID=the-connection-uuid-from-nexus
NEXUS_DISCORD_CONNECTION_GENERATION=1
NEXUS_DISCORD_RELAY_PROTOCOL=2
NEXUS_DISCORD_RELAY_KEY_ID=relay-current
```

Then set the matching Discord values in the Nexus `.env` file. Follow [Configure a dedicated connection](configuration.md#configure-a-dedicated-connection) to avoid mixing the bot variable names with the Nexus variable names.

Run the required Nexus migrations and keep its scheduler and queue worker running. The bot depends on the leased Discord queue APIs in the matching Nexus release.

## 8. Register commands

Dedicated mode registers commands only in the configured server:

```bash
npm run register
```

Run this command after the first install and after a release adds, removes, or changes a command.

If command registration fails, Discord keeps the previous command set. The script does not publish a partial list.

## 9. Start and test the bot

Start the process:

```bash
npm start
```

In another terminal, check readiness:

```bash
npm run healthcheck
```

Then test these steps in Discord:

1. Run `/ping`.
2. Run `/nexus status` as an authorized administrator.
3. Generate a Discord verification code in Nexus and run `/verify`.
4. Run one read-only command such as `/me` or `/accounts`.
5. Test any enabled role, channel, alert, or war-room automation in a test server before using it in your main server.

## 10. Run it as a service

Use a process manager that restarts the bot after a failure and sends `SIGTERM` during shutdown. Allow at least 320 seconds before forcing the process to stop because an active queue item may still hold a five-minute lease.

Example systemd service:

```ini
[Unit]
Description=Nexus AMS Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nexus-discord
Group=nexus-discord
WorkingDirectory=/opt/nexus-ams-discord
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5
TimeoutStopSec=320
UMask=0077

[Install]
WantedBy=multi-user.target
```

Change the service account, working directory, and npm path to match your host.

Create `/opt/nexus-ams-discord/data` and make it writable by the service account. The rest of the application can remain read-only.

The repository does not currently ship a Docker image or Compose file. Do not assume that an unofficial container has the same shutdown, health, or secret-handling behavior.

## Updating the bot

Before an update:

1. Read the release notes and confirm the required Nexus version.
2. Deploy Nexus migrations and API changes first.
3. Stop the bot cleanly.
4. Update the checked-out revision and run `npm ci`.
5. Run `npm run check`.
6. Run `npm run register` if the command set changed.
7. Start the bot and run the smoke tests again.

Do not run two copies of the same dedicated bot at once. Both processes would poll the same Nexus queue and connect the same Discord application without a coordinated shard assignment.
