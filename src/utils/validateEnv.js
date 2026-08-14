import {
  isDiscordSnowflake,
  isHttpUrl,
  isUuid,
  toPositiveInteger,
} from './boundaryValidators.js';
import { createPrivateKey } from 'node:crypto';

/**
 * Validate presence of required environment variables and exit with a clear message if any are missing.
 * @param {string[]} requiredKeys list of environment variable names that must be present
 * @param {{ error: Function }} [logger] optional logger with an error method; console.error is used otherwise
 */
export const validateEnv = (requiredKeys, logger) => {
  const missing = requiredKeys.filter((key) => !process.env[key] || process.env[key].trim() === '');
  const invalid = [];

  for (const key of ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID']) {
    const value = process.env[key];
    if (value && !isDiscordSnowflake(value)) {
      invalid.push(`${key} must be a Discord snowflake`);
    }
  }

  const nexusUrl = process.env.NEXUS_API_URL;
  if (nexusUrl) {
    if (!isHttpUrl(nexusUrl)) {
      invalid.push('NEXUS_API_URL must be a valid absolute http or https URL');
    } else if (process.env.NODE_ENV === 'production' && !isHttpUrl(nexusUrl, { httpsOnly: true })) {
      invalid.push('NEXUS_API_URL must use https in production');
    }
  }

  const relayPrivateKey = process.env.NEXUS_DISCORD_RELAY_PRIVATE_KEY;
  if (relayPrivateKey) {
    try {
      const key = createPrivateKey({
        key: Buffer.from(relayPrivateKey.trim(), 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
      if (key.asymmetricKeyType !== 'ed25519') {
        invalid.push('NEXUS_DISCORD_RELAY_PRIVATE_KEY must contain an Ed25519 private key');
      }
    } catch {
      invalid.push('NEXUS_DISCORD_RELAY_PRIVATE_KEY must be a base64 PKCS#8 Ed25519 private key');
    }
  }

  const relayProtocol = process.env.NEXUS_DISCORD_RELAY_PROTOCOL;
  if (relayProtocol && relayProtocol.trim() !== '2') {
    invalid.push('NEXUS_DISCORD_RELAY_PROTOCOL must be 2; relay protocol v1 is not supported');
  }

  const connectionId = process.env.NEXUS_DISCORD_CONNECTION_ID;
  if (connectionId && !isUuid(connectionId)) {
    invalid.push('NEXUS_DISCORD_CONNECTION_ID must be a UUID');
  }

  const connectionGeneration = process.env.NEXUS_DISCORD_CONNECTION_GENERATION;
  if (connectionGeneration && toPositiveInteger(connectionGeneration) === null) {
    invalid.push('NEXUS_DISCORD_CONNECTION_GENERATION must be a positive integer');
  }

  const relayKeyId = process.env.NEXUS_DISCORD_RELAY_KEY_ID;
  if (relayKeyId && !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(relayKeyId.trim().toLowerCase())) {
    invalid.push('NEXUS_DISCORD_RELAY_KEY_ID is invalid');
  }

  if (missing.length === 0 && invalid.length === 0) {
    return true;
  }

  const writer = logger?.error ? logger : console;
  const messages = [];
  if (missing.length > 0) {
    messages.push(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (invalid.length > 0) {
    messages.push(`Invalid environment configuration: ${invalid.join('; ')}`);
  }
  writer.error(`${messages.join('. ')}. Please correct the environment before starting the bot.`);

  // Exit gracefully so hosting environments can detect misconfiguration instead of crashing noisily.
  process.exit(1);
  return false;
};
