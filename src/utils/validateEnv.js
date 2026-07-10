import { isDiscordSnowflake, isHttpUrl } from './boundaryValidators.js';

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
