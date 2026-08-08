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
import { alertRendererRegistry } from './services/queueActions/alertRendererRegistry.js';
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

const aggregateQueueHealth = (workers) => {
  const snapshots = workers.map((worker) => ({
    lane: worker.lane ?? 'compatibility',
    ...worker.getHealthSnapshot(),
  }));
  const leaseStates = snapshots
    .map((snapshot) => snapshot.lease_healthy)
    .filter((state) => state !== null);

  return {
    started: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.started),
    stopped: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.stopped),
    polling: snapshots.some((snapshot) => snapshot.polling),
    active_item: snapshots.some((snapshot) => snapshot.active_item),
    lease_healthy: leaseStates.includes(false)
      ? false
      : (leaseStates.includes(true) ? true : null),
    backoff_attempts: Math.max(0, ...snapshots.map((snapshot) => snapshot.backoff_attempts)),
    workers: snapshots,
  };
};

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

  let alertManifestResponse = null;
  let alertManifestStatus = { valid: false, reason: 'alert_manifest_unverified' };
  try {
    alertManifestResponse = await apiService.getAlertRendererManifest();
    alertManifestStatus = alertRendererRegistry.verifyManifest(alertManifestResponse);
    if (!alertManifestStatus.valid) {
      logger.error('Alert lane disabled because the renderer manifest did not verify', alertManifestStatus);
    } else {
      logger.info('Alert renderer manifest verified', {
        contractVersion: alertManifestStatus.contract_version,
      });
    }
  } catch (error) {
    logger.error('Alert lane disabled because the renderer manifest could not be fetched', {
      status: error?.response?.status ?? null,
      errorCode: error?.code ?? null,
    });
  }

  const manifestCapabilities = alertManifestResponse?.capabilities
    ?? alertManifestResponse?.data?.capabilities
    ?? alertManifestResponse?.manifest?.capabilities
    ?? alertManifestResponse?.data?.manifest?.capabilities
    ?? {};
  const laneAware = config.queue.laneAware
    && alertManifestStatus.valid
    && manifestCapabilities.queue_lanes === true;
  const queueDispatcher = new QueueDispatcher({
    client,
    logger: new Logger('QueueDispatcher'),
    guildId: config.discord.guildId,
    apiService,
    alertLaneEnabled: alertManifestStatus.valid,
  });

  const workerDefinitions = laneAware
    ? [
        { lane: 'side_effects', enabled: true },
        { lane: 'alerts', enabled: alertManifestStatus.valid },
        { lane: 'digests', enabled: alertManifestStatus.valid },
      ]
    : [{ lane: null, enabled: true }];
  const queueWorkers = workerDefinitions.map(({ lane, enabled }) => new QueueWorker({
    apiService,
    dispatcher: queueDispatcher,
    logger: new Logger(lane ? `QueueWorker:${lane}` : 'QueueWorker'),
    lane,
    enabled,
  }));
  const processHealth = new ProcessHealth({
    healthFile: config.processHealth.file,
    intervalMs: config.processHealth.intervalMs,
    staleAfterMs: config.processHealth.staleAfterMs,
    build: config.build,
    queueStatus: () => aggregateQueueHealth(queueWorkers),
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
    const results = await Promise.all(queueWorkers.map((worker) => worker.stop()));
    const drained = results.every(({ drained: workerDrained }) => workerDrained);
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

      queueWorkers.forEach((worker) => worker.start());
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
