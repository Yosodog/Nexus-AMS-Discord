# Discord bot documentation

| What you want to do | Guide |
| --- | --- |
| Add the bot to a Nexus Setup installation | Create and invite a Discord application ([steps 2–5](self-hosting.md#2-create-the-discord-application)), then run `sudo nexus component install discord` or use **Admin → Settings → Software** |
| Run your own bot on a separate host or in a container | [Self-host the bot](self-hosting.md) |
| Look up a bot or Nexus setting | [Configuration reference](configuration.md) |
| Understand queue delivery, shutdown, and health checks | [How the bot works](how-it-works.md) |
| Fix a setup or connection problem | [Troubleshooting](troubleshooting.md) |
| Learn about the Nexus hosted bot | [The hosted bot](invite-hosted-bot.md) |
| Run one bot application for several Nexus installations | [Operate the shared bot](shared-hosting.md) |

## Deployment modes

- **Dedicated** (the normal setup): you run your own Discord application, and
  one bot process connects one Discord server to one Nexus installation.
  Nexus Setup installs this mode.
- **Shared**: one Discord application serves several servers, each connected
  to its own Nexus installation. It is used by the Nexus hosted bot. Public
  onboarding for the hosted bot is not available yet, so shared connections
  are set up by the bot operator.

Nexus is responsible for user links, permissions, workflow rules, and private
alliance data in both modes.

## Terms

- **Discord application:** the application created in the Discord Developer
  Portal. It owns the bot user, token, and install link.
- **Relay key:** an Ed25519 key pair. The bot signs requests with the private
  key; Nexus verifies them with the public key.
- **Connection ID and generation:** values shared by the bot and Nexus that
  identify one connection. Raising the generation retires the previous
  connection.
- **Connection publication:** the protected JSON file that tells a shared bot
  which Discord server belongs to which Nexus installation.
