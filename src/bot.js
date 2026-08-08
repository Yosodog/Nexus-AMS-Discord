import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';
import { createDedicatedConnection } from './services/connection/DedicatedConnectionAdapter.js';
import {
  CONNECTION_MODES,
  createConnectionContext,
} from './services/connection/ConnectionContext.js';
import { ConnectionResolver } from './services/connection/ConnectionResolver.js';
import { FairScheduler } from './services/FairScheduler.js';
import { loadCommands } from './commands/index.js';
import { registerInteractionListener } from './listeners/interactionCreate.js';
import { registerMessageListener } from './listeners/messageCreate.js';
import { ApiService } from './services/ApiService.js';
import { DiscordRelaySigner } from './services/DiscordRelaySigner.js';
import { Logger } from './services/Logger.js';
import { ProcessHealth } from './services/ProcessHealth.js';
import { QueueDispatcher } from './services/QueueDispatcher.js';
import { QueueWorker } from './services/QueueWorker.js';
import { DiscordStatusService } from './services/status/DiscordStatusService.js';
import { alertRendererRegistry } from './services/queueActions/alertRendererRegistry.js';
import { config } from './utils/config.js';
import { validateEnv } from './utils/validateEnv.js';

const requiredEnv = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'];
if (config.discord.deploymentMode === CONNECTION_MODES.DEDICATED) {
  requiredEnv.push(
    'DISCORD_GUILD_ID',
    'NEXUS_API_URL',
    'NEXUS_API_KEY',
    'NEXUS_DISCORD_RELAY_PRIVATE_KEY',
  );
}

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

const rawSharedConnections = () => (
  config.discord.deploymentMode === CONNECTION_MODES.OFFICIAL_SHARED && Array.isArray(config.shared.connections)
    ? config.shared.connections
    : []
);

const buildSharedConnection = (raw) => createConnectionContext({
  ...raw,
  mode: CONNECTION_MODES.OFFICIAL_SHARED,
  applicationId: raw.applicationId ?? raw.app_id ?? config.discord.clientId,
  guildId: raw.guildId ?? raw.guild_id,
  connectionId: raw.connectionId ?? raw.connection_id,
  generation: raw.generation ?? 1,
  keyId: raw.keyId ?? raw.key_id ?? 'relay-current',
  endpointOrigin: raw.endpointOrigin ?? raw.baseUrl ?? raw.endpoint,
  capabilities: raw.capabilities ?? {},
  serviceOptions: raw.serviceOptions ?? {
    baseUrl: raw.baseUrl ?? raw.endpoint,
    apiKey: raw.apiKey,
    relayPrivateKey: raw.relayPrivateKey ?? raw.privateKeyBase64,
    relayNextPrivateKey: raw.relayNextPrivateKey,
    relayNextPublicKey: raw.relayNextPublicKey,
    relayCurrentKeyId: raw.relayCurrentKeyId ?? raw.key_id,
    relayNextKeyId: raw.relayNextKeyId,
    relayNextActivatesAt: raw.relayNextActivatesAt,
  },
});

const createConnectionServiceFactory = ({ logger: serviceLogger, config: runtimeConfig }) => {
  const cache = new Map();
  return (connection) => {
    if (!connection) return null;
    if (cache.has(connection.connectionId)) return cache.get(connection.connectionId);
    const options = connection.serviceOptions ?? {};
    const baseUrl = connection.endpointOrigin ?? options.baseUrl ?? runtimeConfig.nexusApi.baseUrl;
    if (!baseUrl) return null;

    let relaySigner = connection.relaySigner ?? null;
    if (!relaySigner && connection.protocolVersion === 2) {
      try {
        relaySigner = new DiscordRelaySigner({
          privateKeyBase64: options.relayPrivateKey ?? options.privateKeyBase64,
          guildId: connection.guildId,
          appId: connection.applicationId,
          connectionId: connection.connectionId,
          generation: connection.generation,
          protocolVersion: connection.protocolVersion,
          keyId: options.relayCurrentKeyId ?? connection.keyId,
          nextKeyId: options.relayNextKeyId,
          nextPrivateKeyBase64: options.relayNextPrivateKey,
          nextPublicKey: options.relayNextPublicKey,
          nextActivatesAt: options.relayNextActivatesAt,
        });
      } catch (error) {
        serviceLogger.warn('Connection credentials are not usable; keeping route fail-closed', {
          connectionId: connection.connectionId,
          generation: connection.generation,
          errorCode: error?.code ?? 'INVALID_RELAY_KEY',
        });
        return null;
      }
    }

    const service = new ApiService({
      baseUrl,
      apiKey: options.apiKey ?? runtimeConfig.nexusApi.apiKey ?? '',
      logger: serviceLogger,
      relaySigner,
      connectionContext: connection,
    });
    cache.set(connection.connectionId, service);
    return service;
  };
};

export const bootstrap = async () => {
  const clientOptions = {
    intents: [
      GatewayIntentBits.Guilds,
      ...(config.discord.intents.guildMembers ? [GatewayIntentBits.GuildMembers] : []),
      GatewayIntentBits.GuildMessages,
      ...(config.discord.intents.messageContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    allowedMentions: { parse: [], repliedUser: false },
    ...(config.discord.deploymentMode === CONNECTION_MODES.OFFICIAL_SHARED ? { shards: 'auto' } : {}),
  };
  const client = new Client(clientOptions);

  const { commands } = await loadCommands(logger);
  client.commands = new Collection(commands);

  let dedicatedConnection = null;
  if (config.discord.deploymentMode === CONNECTION_MODES.DEDICATED) {
    dedicatedConnection = createDedicatedConnection({ config, logger });
  }
  const sharedConnections = rawSharedConnections().map((raw) => {
    try {
      return buildSharedConnection(raw);
    } catch (error) {
      logger.error('Rejected shared connection publication during startup', {
        errorCode: error?.code ?? 'INVALID_CONNECTION',
      });
      return null;
    }
  }).filter(Boolean);
  const connectionResolver = new ConnectionResolver({
    mode: config.discord.deploymentMode,
    applicationId: config.discord.clientId,
    dedicatedContext: dedicatedConnection,
    connections: sharedConnections,
    logger,
  });
  const serviceFactory = createConnectionServiceFactory({ logger, config });
  const baseApiService = dedicatedConnection ? serviceFactory(dedicatedConnection) : null;

  let alertManifestResponse = null;
  let alertManifestStatus = config.discord.deploymentMode === CONNECTION_MODES.OFFICIAL_SHARED
    ? { valid: false, reason: 'per_connection_manifest_required' }
    : { valid: false, reason: 'alert_manifest_unverified' };
  if (baseApiService) {
    try {
      alertManifestResponse = await baseApiService.getAlertRendererManifest();
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
  }

  const manifestCapabilities = alertManifestResponse?.capabilities
    ?? alertManifestResponse?.data?.capabilities
    ?? alertManifestResponse?.manifest?.capabilities
    ?? alertManifestResponse?.data?.manifest?.capabilities
    ?? {};
  const laneAware = config.queue.laneAware
    && alertManifestStatus.valid
    && manifestCapabilities.queue_lanes === true;
  const dispatcherCache = new Map();
  const dispatcherFactory = (connection = dedicatedConnection) => {
    if (!connection) return null;
    const key = connection.connectionId;
    if (dispatcherCache.has(key)) return dispatcherCache.get(key);
    const connectionApi = serviceFactory(connection);
    const connectionAlertEnabled = connection.mode === CONNECTION_MODES.OFFICIAL_SHARED
      ? (connection.capabilities?.supported_queue_actions ?? []).includes('ALERT_DELIVERY_V1')
      : alertManifestStatus.valid;
    const dispatcher = new QueueDispatcher({
      client,
      logger: new Logger(`QueueDispatcher:${connection.guildId}`),
      guildId: connection.guildId,
      apiService: connectionApi,
      alertLaneEnabled: connectionAlertEnabled,
    });
    dispatcherCache.set(key, dispatcher);
    return dispatcher;
  };
  const baseDispatcher = dispatcherFactory(dedicatedConnection);

  const workerDefinitions = laneAware
    ? [
        { lane: 'side_effects', enabled: true },
        { lane: 'alerts', enabled: alertManifestStatus.valid },
        { lane: 'digests', enabled: alertManifestStatus.valid },
      ]
    : [{ lane: null, enabled: true }];
  const queueWorkers = workerDefinitions.map(({ lane, enabled }) => new QueueWorker({
    apiService: baseApiService,
    dispatcher: baseDispatcher,
    logger: new Logger(lane ? `QueueWorker:${lane}` : 'QueueWorker'),
    lane,
    enabled,
    connectionResolver: config.discord.deploymentMode === CONNECTION_MODES.OFFICIAL_SHARED ? connectionResolver : null,
    scheduler: config.discord.deploymentMode === CONNECTION_MODES.OFFICIAL_SHARED
      ? new FairScheduler({ quantum: config.shared.schedulerQuantum })
      : null,
    apiServiceFactory: serviceFactory,
    dispatcherFactory,
  }));
  const statusService = new DiscordStatusService({
    client,
    connectionResolver,
    config,
    queueWorkers,
  });

  const runtimeContext = {
    apiService: baseApiService,
    connectionResolver,
    connectionServiceFactory: serviceFactory,
    applicationId: config.discord.clientId,
    statusService,
  };
  registerInteractionListener(client, client.commands, logger, runtimeContext, config.discord.guildId);
  registerMessageListener(
    client,
    baseApiService,
    new Logger('MessageListener'),
    config.discord.guildId,
    {
      connectionResolver,
      applicationId: config.discord.clientId,
      connectionServiceFactory: serviceFactory,
    },
  );

  const processHealth = new ProcessHealth({
    healthFile: config.processHealth.file,
    intervalMs: config.processHealth.intervalMs,
    staleAfterMs: config.processHealth.staleAfterMs,
    build: config.build,
    queueStatus: () => aggregateQueueHealth(queueWorkers),
    scopeStatus: () => ({
      guild_configured: dedicatedConnection
        ? client.guilds.cache.has(dedicatedConnection.guildId)
        : undefined,
      active_connections: connectionResolver.listActive().length,
    }),
    logger: new Logger('ProcessHealth'),
  });

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
      if (dedicatedConnection && !client.guilds.cache.has(dedicatedConnection.guildId)) {
        logger.error('Configured Discord guild is unavailable; refusing readiness');
        await processHealth.failStartup().catch(() => undefined);
        client.destroy();
        process.exit(1);
      }

      queueWorkers.forEach((worker) => worker.start());
      await processHealth.markReady();
      logger.info('Bot Ready', {
        deploymentMode: config.discord.deploymentMode,
        activeConnections: connectionResolver.listActive().length,
      });
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  bootstrap().catch((error) => {
    logger.error('Fatal startup error', error);
    process.exit(1);
  });
}
