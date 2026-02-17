# Nexus AMS Discord Bot

Discord bot scaffolding for the Nexus AMS project. It currently ships a simple `/ping` check, `/verify` to link Nexus accounts, and a queue worker that polls Nexus for Discord-bound actions like war alerts.

## Features
- Slash command loader with a health-check `/ping`.
- Guild-scoped slash command registration script.
- Structured logging with basic secret scrubbing.
- Nexus API REST client with retries and queue polling worker.
- Queue dispatcher handlers for `WAR_ALERT`, `ALLIANCE_DEPARTURE`, and `INACTIVITY_ALERT` with status reporting to Nexus.

## Project Structure
- `src/bot.js` — bootstraps the client, wiring listeners and services.
- `src/commands/` — individual slash commands; add new files here.
- `src/listeners/` — Discord event listeners (e.g., `interactionCreate`).
- `src/services/` — shared services (API client, queue worker/dispatcher, logger).
- `src/utils/` — configuration and environment validation helpers.
- `src/registerCommands.js` — registers slash commands to a guild.

## Prerequisites
- Node.js 18+
- Discord application with a bot user and a test guild to deploy commands.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file based on `.env.example`:
   ```bash
   cp .env.example .env
   ```
3. Populate the environment variables:
   - `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
   - `NEXUS_API_URL`, `NEXUS_API_KEY`

## Running
- Start the bot:
  ```bash
  npm start
  ```
- Register slash commands to your configured guild (run after adding/updating commands):
  ```bash
  npm run register
  ```

## Adding Commands
Create a new file in `src/commands/` exporting `data` (a `SlashCommandBuilder`) and `execute`. The loader auto-registers any `.js` file in that folder except `index.js`.

## Notes
- Logging redacts known secrets; still avoid logging sensitive payloads directly.
