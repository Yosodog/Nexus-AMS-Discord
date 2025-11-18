import 'dotenv/config';
import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { registerInteractionListener } from './listeners/interactionCreate.js';
import { ApiService } from './services/ApiService.js';
import { ReverbService } from './services/ReverbService.js';
import { Logger } from './services/Logger.js';
import { config } from './utils/config.js';
import { validateEnv } from './utils/validateEnv.js';

const requiredEnv = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'NEXUS_API_URL',
  'NEXUS_API_KEY',
];

// Validate critical configuration before bootstrapping; Reverb is temporarily disabled so its env is optional.
validateEnv(requiredEnv);

const logger = new Logger('Bot');

const bootstrap = async () => {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // Load commands and attach to the client for easy access by listeners.
  const { commands } = await loadCommands(logger);
  client.commands = new Collection(commands);

  // Service stubs are constructed up front so they can be wired into future features.
  const apiService = new ApiService({
    baseUrl: config.nexusApi.baseUrl,
    apiKey: config.nexusApi.apiKey,
    logger,
  });

  const reverbService = new ReverbService({
    url: config.reverb.url,
    apiKey: config.reverb.apiKey,
    logger,
  });

  const commandContext = { apiService, reverbService };

  registerInteractionListener(client, client.commands, logger, commandContext);

  // Reverb connections are temporarily disabled per request; leave the service constructed for future use.
  logger.info('Reverb connection is currently disabled; skipping WebSocket connect.');

  client.once(Events.ClientReady, () => {
    logger.info('Bot Ready');
  });

  try {
    await client.login(config.discord.token);
    logger.info('Logged in to Discord.');
  } catch (error) {
    logger.error('Discord login failed', error);
    process.exit(1);
  }
};

bootstrap().catch((error) => {
  logger.error('Fatal startup error', error);
  process.exit(1);
});
