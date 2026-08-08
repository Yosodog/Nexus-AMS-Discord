import { DiscordRelaySigner } from '../DiscordRelaySigner.js';
import {
  CONNECTION_MODES,
  createConnectionContext,
  stableConnectionId,
} from './ConnectionContext.js';

const parseInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseCapabilities = (value) => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

/** Converts the legacy environment contract into an explicit connection. */
export const createDedicatedConnection = ({ config, logger = null } = {}) => {
  const applicationId = config?.discord?.clientId ?? process.env.DISCORD_CLIENT_ID;
  const guildId = config?.discord?.guildId ?? process.env.DISCORD_GUILD_ID;
  const endpointOrigin = config?.nexusApi?.baseUrl ?? process.env.NEXUS_API_URL ?? '';
  const explicitConnectionId = config?.nexusApi?.connectionId ?? process.env.NEXUS_DISCORD_CONNECTION_ID;
  const connectionId = explicitConnectionId || stableConnectionId({ applicationId, guildId, endpointOrigin });
  const protocolVersion = parseInteger(
    config?.nexusApi?.relayProtocolVersion ?? process.env.NEXUS_DISCORD_RELAY_PROTOCOL,
    1,
  );
  const generation = parseInteger(
    config?.nexusApi?.connectionGeneration ?? process.env.NEXUS_DISCORD_CONNECTION_GENERATION,
    1,
  );
  const keyId = config?.nexusApi?.relayKeyId
    || process.env.NEXUS_DISCORD_RELAY_KEY_ID
    || 'legacy-v1';
  const capabilities = config?.nexusApi?.capabilities
    ?? parseCapabilities(process.env.NEXUS_DISCORD_CAPABILITIES_JSON);

  const context = createConnectionContext({
    mode: CONNECTION_MODES.DEDICATED,
    protocolVersion,
    applicationId,
    guildId,
    connectionId,
    generation,
    keyId,
    endpointOrigin,
    capabilities,
    source: 'environment',
  });

  const relaySigner = new DiscordRelaySigner({
    privateKeyBase64: config?.nexusApi?.discordRelayPrivateKey
      ?? process.env.NEXUS_DISCORD_RELAY_PRIVATE_KEY,
    guildId: context.guildId,
    appId: context.applicationId,
    connectionId: context.connectionId,
    generation: context.generation,
    protocolVersion: context.protocolVersion,
    keyId: context.keyId,
    currentKeyId: config?.nexusApi?.relayCurrentKeyId ?? process.env.NEXUS_DISCORD_RELAY_CURRENT_KEY_ID,
    nextKeyId: config?.nexusApi?.relayNextKeyId ?? process.env.NEXUS_DISCORD_RELAY_NEXT_KEY_ID,
    nextPrivateKeyBase64: config?.nexusApi?.relayNextPrivateKey
      ?? process.env.NEXUS_DISCORD_RELAY_NEXT_PRIVATE_KEY,
  });

  const result = Object.freeze({ ...context, relaySigner });
  logger?.debug?.('Dedicated Discord connection configured', {
    applicationId: result.applicationId,
    guildId: result.guildId,
    connectionId: result.connectionId,
    generation: result.generation,
    protocolVersion: result.protocolVersion,
  });
  return result;
};
