import 'dotenv/config';
import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './commands/index.js';
import { registerInteractionListener } from './listeners/interactionCreate.js';
import { registerMessageListener } from './listeners/messageCreate.js';
import { ApiService } from './services/ApiService.js';
import { DiscordRelaySigner } from './services/DiscordRelaySigner.js';
import { Logger } from './services/Logger.js';
import { ProcessHealth } from './services/ProcessHealth.js';
import { QueueDispatcher } from './services/QueueDispatcher.js';
import { QueueWorker } from './services/QueueWorker.js';
import { config } from './utils/config.js';
import { validateEnv } from './utils/validateEnv.js';

const requiredEnv = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'NEXUS_API_URL',
  'NEXUS_API_KEY',
  'NEXUS_DISCORD_RELAY_PRIVATE_KEY',
];

// Validate critical configuration before bootstrapping.
validateEnv(requiredEnv);

const logger = new Logger('Bot');

const bootstrap = async () => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [], repliedUser: false },
  });

  // Load commands and attach to the client for easy access by listeners.
  const { commands } = await loadCommands(logger);
  client.commands = new Collection(commands);

  // Service stubs are constructed up front so they can be wired into future features.
  const apiService = new ApiService({
    baseUrl: config.nexusApi.baseUrl,
    apiKey: config.nexusApi.apiKey,
    logger,
    relaySigner: new DiscordRelaySigner({
      privateKeyBase64: config.nexusApi.discordRelayPrivateKey,
      guildId: config.discord.guildId,
    }),
  });
  const queueDispatcher = new QueueDispatcher({
    client,
    logger: new Logger('QueueDispatcher'),
    guildId: config.discord.guildId,
    apiService,
  });

  const queueWorker = new QueueWorker({
    apiService,
    dispatcher: queueDispatcher,
    logger: new Logger('QueueWorker'),
  });
  const processHealth = new ProcessHealth({
    healthFile: config.processHealth.file,
    intervalMs: config.processHealth.intervalMs,
    staleAfterMs: config.processHealth.staleAfterMs,
    build: config.build,
    queueStatus: () => queueWorker.getHealthSnapshot(),
    scopeStatus: () => ({ guild_configured: client.guilds.cache.has(config.discord.guildId) }),
    logger: new Logger('ProcessHealth'),
  });

  const commandContext = { apiService, guildId: config.discord.guildId };

  registerInteractionListener(client, client.commands, logger, commandContext, config.discord.guildId);
  registerMessageListener(client, apiService, new Logger('MessageListener'), config.discord.guildId);

  await processHealth.start();

  let shutdownSignal = null;
  const shutdown = async (signal) => {
    if (shutdownSignal) {
      logger.error('Second shutdown signal received; forcing exit', { firstSignal: shutdownSignal, signal });
      process.exit(1);
    }

    shutdownSignal = signal;
    logger.info('Graceful shutdown started', { signal });
    let healthWritten = true;
    try {
      await processHealth.markStopping(signal);
    } catch {
      healthWritten = false;
      logger.error('Failed to mark Discord process as stopping', { errorCode: 'HEALTH_WRITE_FAILED' });
    }
    const { drained } = await queueWorker.stop();
    client.destroy();
    try {
      await processHealth.stop({ signal, drained });
    } catch {
      healthWritten = false;
      logger.error('Failed to write final Discord process health state', { errorCode: 'HEALTH_WRITE_FAILED' });
    }
    logger.info('Graceful shutdown finished', { signal, drained });
    process.exit(drained && healthWritten ? 0 : 1);
  };

  const handleShutdown = (signal) => {
    void shutdown(signal).catch(async () => {
      logger.error('Graceful shutdown failed', { errorCode: 'SHUTDOWN_FAILED' });
      client.destroy();
      await processHealth.stop({ signal, drained: false }).catch(() => undefined);
      process.exit(1);
    });
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  client.once(Events.ClientReady, () => {
    void (async () => {
      if (!client.guilds.cache.has(config.discord.guildId)) {
        logger.error('Configured Discord guild is unavailable; refusing readiness');
        await processHealth.failStartup().catch(() => undefined);
        client.destroy();
        process.exit(1);
      }

      queueWorker.start();
      await processHealth.markReady();
      logger.info('Bot Ready');
    })().catch(async () => {
      logger.error('Failed to publish Discord readiness', { errorCode: 'HEALTH_WRITE_FAILED' });
      await processHealth.failStartup().catch(() => undefined);
      client.destroy();
      process.exit(1);
    });
  });

  try {
    await client.login(config.discord.token);
    logger.info('Logged in to Discord.');
  } catch (error) {
    logger.error('Discord login failed', error);
    await processHealth.failStartup().catch(() => undefined);
    process.exit(1);
  }
};

bootstrap().catch((error) => {
  logger.error('Fatal startup error', error);
  process.exit(1);
});
