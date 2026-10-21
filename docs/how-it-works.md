# How the bot works

Background for operators who want to know what the bot does behind the
scenes. You do not need this page to install the bot.

## Commands and authorization

Every command is forwarded to Nexus with the Discord user, server, and
interaction ID. Nexus resolves the linked account and decides ownership,
permissions, balances, eligibility, limits, and every state change. The bot
never trusts Discord roles for Nexus operations.

Discord delivers interactions to the bot over the Gateway, which does not
carry Discord's HTTP interaction signatures. Instead, the bot signs each
request with its own Ed25519 **relay key**. Nexus checks the signature,
server, actor, interaction ID, freshness, connection ID, and generation before
it looks at permissions. That is why the relay key and connection values in
the [configuration reference](configuration.md#settings-that-must-match) must
match on both sides.

## Queue delivery

Work that Nexus wants done in Discord — alerts, DMs, role changes, war rooms —
goes into a queue that the bot polls.

- The bot claims one item at a time. Nexus grants a five-minute lease, and the
  bot renews it every 60 seconds while it works.
- Nexus reaps expired leases every minute. A failed attempt retries after one
  and then two minutes; the third failed or expired attempt is final. **Keep
  the Nexus scheduler running**, or retries and reaping stop.
- War-room creation saves the Discord thread ID in Nexus before posting
  follow-up messages, and stable Discord nonces prevent most duplicate
  messages on replay.
- Delivery is at least once. After a crash or an ambiguous Discord or Nexus
  failure, check the result before replaying; see
  [duplicate Discord delivery](troubleshooting.md#duplicate-discord-delivery).

Private notifications are sent only by DM, using fixed templates in the bot.
They never fall back to a public channel. Nexus ships with private Discord
notifications switched off for the whole alliance; an administrator turns
them on, and each linked member opts in by category.

## Application transcripts

Application interview channels are identified by the Nexus metadata the bot
stores when it creates them. Only text messages from verified application
channels in the configured server are forwarded. Attachments and embeds are
ignored and never stored. Nexus works out which authors are staff and ignores
duplicate messages.

## Shutdown

On `SIGTERM` or `SIGINT` the bot stops claiming new queue items, lets the
current item finish while its lease is still valid, and then exits. A second
signal exits immediately. Give the process manager a stop timeout of at least
**320 seconds**; the provided systemd unit and Compose file already do. Most
shutdowns finish immediately when nothing is in progress.

## Health checks

The bot writes a heartbeat file (`PROCESS_HEALTH_FILE`, mode `0600`) every 15
seconds. It reports ready only after Discord is connected, the queue worker
has started, and, in dedicated mode, the configured server is available.

`npm run healthcheck` reads that file without contacting Discord or Nexus.
Run it as the same user as the bot. The result codes are listed in
[troubleshooting](troubleshooting.md#the-health-check-fails).

The heartbeat contains the bot version, build and release identifiers, worker
state, and counters. It never contains server IDs, URLs, credentials, relay
keys, queue payloads, or API responses. Nexus Setup reads it for the
component list.

The health command is designed for dedicated mode. Shared-mode operators
should also monitor the items in [operating the shared bot](shared-hosting.md#deploy-and-scale-carefully).

## Managed deployment

When Nexus Setup installs the bot, it runs from an immutable release
directory using the fixed unit in
[`deploy/systemd/nexus-discord.service`](../deploy/systemd/nexus-discord.service),
under the unprivileged `nexus-discord` account. Secrets are stored in
root-owned credential files and passed to the bot through the `*_FILE`
settings, so they never appear in command lines or the service environment.
Do not edit the unit by hand.

Each release is a deterministic `nexus-discord.tar.gz` built with
`npm ci --omit=dev --ignore-scripts` and published to GitHub Releases with
its `nexus-release.json` manifest. Nexus Setup verifies the download against
the SHA-256 digest published with the release.
