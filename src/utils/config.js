import path from 'node:path';

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const safeIdentifier = (value, fallback = 'unknown') => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(normalized)
    ? normalized
    : fallback;
};

const parseMode = (value) => {
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (normalized === 'official-shared' || normalized === 'shared' || normalized === 'multi' || normalized === 'multi-alliance') {
    return 'official-shared';
  }
  return 'dedicated';
};

const parseJsonObject = (value, fallback = {}) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const parseJsonValue = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const deploymentMode = parseMode(
  process.env.BOT_DEPLOYMENT_MODE
    ?? process.env.DISCORD_DEPLOYMENT_MODE
    ?? (process.env.DISCORD_GUILD_ID ? 'dedicated' : 'official-shared'),
);

/**
 * Centralized configuration wrapper so the rest of the app never reads
 * process.env directly. Expect dotenv to be loaded before importing this file.
 */
export const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? '',
    deploymentMode,
    shardCount: positiveInteger(process.env.DISCORD_SHARD_COUNT, 0),
    intents: {
      names: ['Guilds', 'GuildMembers', 'GuildMessages', 'MessageContent'],
      messageContent: process.env.DISCORD_MESSAGE_CONTENT_INTENT !== 'false',
      guildMembers: process.env.DISCORD_GUILD_MEMBERS_INTENT !== 'false',
    },
  },
  nexusApi: {
    baseUrl: process.env.NEXUS_API_URL ?? '',
    apiKey: process.env.NEXUS_API_KEY ?? '',
    discordRelayPrivateKey: process.env.NEXUS_DISCORD_RELAY_PRIVATE_KEY ?? '',
    connectionId: process.env.NEXUS_DISCORD_CONNECTION_ID ?? '',
    connectionGeneration: process.env.NEXUS_DISCORD_CONNECTION_GENERATION ?? '1',
    relayProtocolVersion: process.env.NEXUS_DISCORD_RELAY_PROTOCOL ?? '1',
    relayKeyId: process.env.NEXUS_DISCORD_RELAY_KEY_ID ?? '',
    relayCurrentKeyId: process.env.NEXUS_DISCORD_RELAY_CURRENT_KEY_ID ?? '',
    relayNextKeyId: process.env.NEXUS_DISCORD_RELAY_NEXT_KEY_ID ?? '',
    relayNextPrivateKey: process.env.NEXUS_DISCORD_RELAY_NEXT_PRIVATE_KEY ?? '',
    capabilities: parseJsonObject(process.env.NEXUS_DISCORD_CAPABILITIES_JSON),
  },
  shared: {
    connectionsFile: process.env.DISCORD_CONNECTIONS_FILE ?? '',
    connections: parseJsonValue(process.env.DISCORD_CONNECTIONS_JSON, []),
    refreshIntervalMs: positiveInteger(process.env.DISCORD_CONNECTION_REFRESH_MS, 30_000),
    schedulerQuantum: positiveInteger(process.env.DISCORD_SCHEDULER_QUANTUM, 1),
  },
  processHealth: {
    file: process.env.PROCESS_HEALTH_FILE || path.resolve(process.cwd(), 'data/process-health.json'),
    intervalMs: positiveInteger(process.env.PROCESS_HEALTH_INTERVAL_MS, 15_000),
    staleAfterMs: positiveInteger(process.env.PROCESS_HEALTH_STALE_AFTER_MS, 45_000),
  },
  build: {
    commit: safeIdentifier(process.env.BUILD_COMMIT),
    release: safeIdentifier(process.env.NEXUS_RELEASE_ID),
  },
  queue: {
    laneAware: process.env.NEXUS_QUEUE_LANE_AWARE !== 'false',
  },
};
