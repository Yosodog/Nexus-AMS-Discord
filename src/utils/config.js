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

/**
 * Centralized configuration wrapper so the rest of the app never reads
 * process.env directly. Expect dotenv to be loaded before importing this file.
 */
export const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN ?? '',
    clientId: process.env.DISCORD_CLIENT_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID ?? '',
  },
  nexusApi: {
    baseUrl: process.env.NEXUS_API_URL ?? '',
    apiKey: process.env.NEXUS_API_KEY ?? '',
    discordRelayPrivateKey: process.env.NEXUS_DISCORD_RELAY_PRIVATE_KEY ?? '',
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
