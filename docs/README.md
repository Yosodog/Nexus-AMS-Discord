# Setup and operations

Choose the guide that matches what you are trying to do.

| What you want to do | Guide |
| --- | --- |
| Add the Nexus hosted bot to an alliance server | [Invite the hosted bot](invite-hosted-bot.md) |
| Run your own bot for one Nexus installation | [Self-host the bot](self-hosting.md) |
| Fill in the bot and Nexus settings | [Configuration reference](configuration.md) |
| Run one bot application for several Nexus installations | [Operate the shared bot](shared-hosting.md) |
| Fix a setup or connection problem | [Troubleshooting](troubleshooting.md) |

## What works today

The dedicated setup is ready to use. In this setup, you run your own Discord application and connect it to one Nexus installation and one Discord server.

The shared runtime is also present. It lets the Nexus bot operator run one Discord application for several servers. Connections are loaded from a protected publication file.

Public onboarding for the Nexus hosted bot is not ready yet. Inviting the bot does not create a Nexus connection on its own. The OAuth setup, proof that the installer controls the Nexus installation, and the Cloud connection screen still need to be built. Until then, hosted-bot connections are limited to operator-managed pilots.

## A few terms used in these guides

- Discord application: The application created in the Discord Developer Portal. It owns the bot user, token, and install link.
- Dedicated bot: A bot process connected to one Discord server and one Nexus installation.
- Shared bot: A bot process that serves several Discord servers. Every server has a separate Nexus endpoint, credential, relay key, and connection generation.
- Connection publication: The protected JSON file that tells a shared bot which Discord server belongs to which Nexus installation.

Nexus remains responsible for user links, permissions, workflow rules, and private alliance data in every setup.
