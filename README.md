# Nexus AMS Discord Bot

The Discord bot for [Nexus AMS](https://github.com/Yosodog/Nexus-AMS). It lets
members use Nexus from Discord and lets Nexus act in your server: account
verification, banking and request commands, application interviews, alerts,
private notifications, role sync, and war rooms.

Nexus stays the source of truth. The bot forwards each command to Nexus, and
Nexus decides who is allowed to do what. Discord roles never grant Nexus
permissions.

## Features

- Slash commands for accounts, deposits, withdrawals, transactions, requests,
  grants, loans, war aid, rebuilding, builds, raids, wars, spy assignments, and
  applications. Responses are private to the user who ran them.
- Account linking with `/verify`.
- Application interview channels with text-only transcript forwarding to
  Nexus.
- Delivery of Nexus alerts, opt-in private DMs, member departures, role
  removal, city-tier roles, and war-room creation and archival.
- Automatic capture of pasted in-game intelligence reports.

## Install

Choose the path that matches your deployment:

| Deployment | Guide |
| --- | --- |
| Nexus installed with [Nexus Setup](https://github.com/Yosodog/Nexus-Setup) (recommended) | Create and invite a Discord application ([steps 2–5](docs/self-hosting.md#2-create-the-discord-application)), then run `sudo nexus component install discord` or use **Admin → Settings → Software** |
| Run the bot yourself on a separate host or in a container | [Self-host the bot](docs/self-hosting.md) |
| Every bot and Nexus setting | [Configuration reference](docs/configuration.md) |
| Something is not working | [Troubleshooting](docs/troubleshooting.md) |

With Nexus Setup you only enter the bot token, application ID, and server
(guild) ID. Setup generates the internal credentials, runs the bot as its own
service, registers the slash commands, and keeps the bot updated with
`nexus update`.

Each bot process serves **one Discord server and one Nexus installation**
(dedicated mode). A shared multi-server mode exists for the Nexus hosted bot,
but public onboarding for it is not available yet; see
[the hosted bot](docs/invite-hosted-bot.md).

## Requirements

- Node.js 22 or newer.
- A Discord application with a bot user, installed in your server.
- A Nexus AMS release that meets this bot's `nexus-core` requirement in
  [`nexus-release.requires.json`](nexus-release.requires.json). Nexus Setup
  checks this for you.

## Commands

| Area | Commands |
| --- | --- |
| Getting started | `/verify`, `/me`, `/help`, `/ping` |
| Banking | `/accounts`, `/deposit`, `/withdraw`, `/transactions` |
| Requests and programs | `/requests`, `/grant`, `/loan`, `/waraid`, `/rebuild` |
| Nation and audits | `/build`, `/audit`, `/alerts`, `/nation`, `/alliance`, `/who` |
| Military | `/war`, `/raid`, `/spy`, `/unblockade`, `/archivecounter` |
| Applications | `/apply`, `/applications`, `/approve`, `/deny` |
| Staff and administration | `/work`, `/sweepbank`, `/nexus status` |

Everyone sees the same command list, but Nexus decides what each user may do
with it: staff actions only work for users whose Nexus permissions allow them.
Run `/help` in Discord for details on any command.

## Documentation

- [Self-host the bot](docs/self-hosting.md)
- [Configuration reference](docs/configuration.md)
- [How the bot works](docs/how-it-works.md) — queue delivery, shutdown,
  health checks, transcripts, and release artifacts
- [Troubleshooting](docs/troubleshooting.md)
- [The hosted bot](docs/invite-hosted-bot.md) and
  [operating the shared bot](docs/shared-hosting.md)
- [Relay contracts](contracts/discord/README.md)

## Development

```bash
cp .env.example .env
npm ci
npm run check          # syntax-check, then run tests
npm run test:coverage  # tests with coverage gates (80% lines/functions, 65% branches)
npm run register       # register slash commands for the configured server
npm start
```

### Adding a command

Create a `.js` file in `src/commands/` that exports:

- `data`: a `SlashCommandBuilder` definition.
- `execute(interaction, context)`: the handler.

Command names must be unique. Loading is all-or-nothing: an import error,
malformed export, or duplicate name stops startup and registration, so Discord
never receives a partial command set.

Do not add Discord role checks for Nexus operations; let Nexus authorize them.
Logging redacts configured secrets, but do not log credentials, raw API
responses, or sensitive payloads.

### Project layout

- `src/bot.js` — starts Discord, services, listeners, and shutdown handling.
- `src/commands/` — slash commands.
- `src/listeners/` — interaction and message listeners.
- `src/services/` — Nexus API client, leased queue worker, and logging.
- `src/services/queueActions/` — queue actions; each exports
  `validate(payload)` and `execute(command, context)`.
- `src/utils/` — configuration and validation helpers.
- `src/registerCommands.js` — publishes the command set.
- `src/healthcheck.js` — checks the local process heartbeat.

## License

GNU GPL v3. See [LICENSE](LICENSE).
