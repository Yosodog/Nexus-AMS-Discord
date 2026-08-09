# Invite the Nexus hosted bot

> Public setup is not available in the current release.

The bot can be installed in more than one Discord server, but the public connection screen has not been built yet. Inviting the bot only adds the Discord application to your server. It does not tell the bot which Nexus installation belongs to that server.

If you are not part of an approved pilot, use the [self-hosting guide](self-hosting.md) for now.

## What you will need

For a pilot connection, two people may be involved:

- A Discord member with the Manage Server permission installs the bot.
- A Nexus administrator approves the matching Nexus installation.

The same person can do both jobs if they have both sets of access.

A self-hosted Nexus installation also needs a public HTTPS address that the bot operator can verify. Local addresses, private network addresses, and plain HTTP addresses are not accepted by shared mode.

## Install the bot for a pilot

1. Get the official install link from the Nexus bot operator. Do not use an install link sent by an unknown account.
2. Open the link while signed in to Discord.
3. Choose "Add to server" and select the server you manage.
4. Review the requested permissions, then approve the install.
5. Open Server Settings, then Roles. Move the Nexus bot role above any roles the bot is expected to add or remove. Keep it below administrator and staff roles.
6. Tell the Nexus bot operator that the Discord install is complete. Share the server ID if they ask for it. A Discord server ID is not a secret.
7. Complete the separate Nexus ownership check with the operator. There is no public form for this step yet.

Never send a Discord bot token, Nexus API credential, relay private key, database password, or `.env` file to someone over Discord. The operator does not need your Discord bot token because the hosted application uses its own token.

## Check the connection

Run:

```text
/nexus status
```

Before a Nexus connection exists, only a Discord administrator or member with Manage Server can see the limited setup result. Once connected, Nexus decides who may view the full provider diagnostics.

If the command says the server is not configured, the Discord invite worked but the Nexus connection did not. The operator must finish or repair the connection publication.

## Remove the hosted bot

Removing the bot from Discord stops it from acting in the server, but the Nexus connection should also be revoked.

1. Ask the Nexus bot operator to revoke the connection.
2. Remove the app from the server in Discord Server Settings.
3. Confirm that the operator advanced the connection generation before any later reconnect.

Do not reuse a revoked API credential or relay key.

## Planned public setup

The finished onboarding flow is expected to ask a Nexus administrator to sign in, install the Discord app through OAuth, choose one Nexus installation, and confirm the connection. The control plane will publish routing details to the bot, while the selected Nexus installation will continue to authorize every command.

That flow is a product plan, not a feature in this release.

## Discord references

- [Installing a Discord application](https://docs.discord.com/developers/quick-start/getting-started)
- [Discord installation contexts](https://docs.discord.com/developers/resources/application#installation-context)
- [Discord permissions](https://docs.discord.com/developers/topics/permissions)
